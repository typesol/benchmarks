//! Vault in native Rust (solana-program): the same instructions, account layout and errors as examples/vault.ts.
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};

entrypoint!(process);

const IX_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const IX_SHUT: [u8; 8] = [255, 174, 90, 159, 118, 51, 114, 43];
const DISC: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
/// discriminator, owner, deposited, withdrawn, bump
const SIZE: usize = 8 + 32 + 8 + 8 + 1;
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
const NOT_OWNER: u32 = 6000;
const ZERO_AMOUNT: u32 = 6001;
const INSUFFICIENT: u32 = 6002;
const OVERFLOW: u32 = 6003;

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, rest) = data.split_at(8);
    if disc == IX_OPEN {
        open(program_id, accounts)
    } else if disc == IX_DEPOSIT {
        deposit(program_id, accounts, amount(rest)?)
    } else if disc == IX_WITHDRAW {
        withdraw(program_id, accounts, amount(rest)?)
    } else if disc == IX_SHUT {
        shut(program_id, accounts)
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn amount(args: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(args.get(..8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))
}

/// The signer owner and its vault: signer, writable, owned by this program, right discriminator, owner field matches.
fn checked(program_id: &Pubkey, owner: &AccountInfo, vault: &AccountInfo) -> ProgramResult {
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !owner.is_writable || !vault.is_writable || vault.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let d = vault.try_borrow_data()?;
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    if &d[8..40] != owner.key.as_ref() {
        return Err(ProgramError::Custom(NOT_OWNER));
    }
    Ok(())
}

fn add_at(d: &mut [u8], at: usize, amount: u64) -> ProgramResult {
    let v = u64::from_le_bytes(d[at..at + 8].try_into().unwrap()).checked_add(amount).ok_or(ProgramError::Custom(OVERFLOW))?;
    d[at..at + 8].copy_from_slice(&v.to_le_bytes());
    Ok(())
}

fn open(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [owner, vault, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !owner.is_writable || !vault.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.key != &SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (pda, bump) = Pubkey::find_program_address(&[b"vault", owner.key.as_ref()], program_id);
    if vault.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let lamports = Rent::get()?.minimum_balance(SIZE);
    let mut data = vec![0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    data[20..52].copy_from_slice(program_id.as_ref());
    let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*owner.key, true), AccountMeta::new(*vault.key, true)], data };
    invoke_signed(&ix, &[owner.clone(), vault.clone()], &[&[b"vault", owner.key.as_ref(), &[bump]]])?;

    let mut d = vault.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC);
    d[8..40].copy_from_slice(owner.key.as_ref());
    d[56] = bump;
    Ok(())
}

fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let [owner, vault, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if amount == 0 {
        return Err(ProgramError::Custom(ZERO_AMOUNT));
    }
    checked(program_id, owner, vault)?;
    if system.key != &SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    // System Transfer: u32 tag 2, lamports.
    let mut data = vec![0u8; 12];
    data[0] = 2;
    data[4..12].copy_from_slice(&amount.to_le_bytes());
    let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*owner.key, true), AccountMeta::new(*vault.key, false)], data };
    invoke(&ix, &[owner.clone(), vault.clone()])?;
    add_at(&mut vault.try_borrow_mut_data()?, 40, amount)
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let [owner, vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if amount == 0 {
        return Err(ProgramError::Custom(ZERO_AMOUNT));
    }
    checked(program_id, owner, vault)?;
    let floor = Rent::get()?.minimum_balance(vault.data_len());
    let remaining = vault.lamports().checked_sub(amount).ok_or(ProgramError::Custom(OVERFLOW))?;
    if remaining < floor {
        return Err(ProgramError::Custom(INSUFFICIENT));
    }
    **vault.try_borrow_mut_lamports()? = remaining;
    let next = owner.lamports().checked_add(amount).ok_or(ProgramError::Custom(OVERFLOW))?;
    **owner.try_borrow_mut_lamports()? = next;
    add_at(&mut vault.try_borrow_mut_data()?, 48, amount)
}

fn shut(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [owner, vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    checked(program_id, owner, vault)?;
    let total = owner.lamports().checked_add(vault.lamports()).ok_or(ProgramError::Custom(OVERFLOW))?;
    **owner.try_borrow_mut_lamports()? = total;
    **vault.try_borrow_mut_lamports()? = 0;
    vault.assign(&SYSTEM);
    vault.resize(0)
}
