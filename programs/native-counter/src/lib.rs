//! Counter in native Rust (solana-program): the same instructions, account layout and errors as examples/counter.ts.
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};

entrypoint!(process);

const IX_INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
const IX_INCREMENT: [u8; 8] = [11, 18, 104, 9, 104, 174, 59, 33];
const DISC: [u8; 8] = [255, 176, 4, 245, 188, 253, 124, 25];
/// discriminator, authority, count, bump
const SIZE: usize = 8 + 32 + 8 + 1;
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
const UNAUTHORIZED: u32 = 6000;
const OVERFLOW: u32 = 6002;

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, rest) = data.split_at(8);
    if disc == IX_INITIALIZE {
        initialize(program_id, accounts)
    } else if disc == IX_INCREMENT {
        increment(program_id, accounts, rest)
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [authority, counter, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable || !counter.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.key != &SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (pda, bump) = Pubkey::find_program_address(&[b"counter", authority.key.as_ref()], program_id);
    if counter.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // System CreateAccount: u32 tag 0, lamports, space, owner.
    let lamports = Rent::get()?.minimum_balance(SIZE);
    let mut data = vec![0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    data[20..52].copy_from_slice(program_id.as_ref());
    let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*authority.key, true), AccountMeta::new(*counter.key, true)], data };
    invoke_signed(&ix, &[authority.clone(), counter.clone()], &[&[b"counter", authority.key.as_ref(), &[bump]]])?;

    let mut d = counter.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC);
    d[8..40].copy_from_slice(authority.key.as_ref());
    d[40..48].copy_from_slice(&0u64.to_le_bytes());
    d[48] = bump;
    Ok(())
}

fn increment(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [authority, counter, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !counter.is_writable || counter.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let by = u64::from_le_bytes(args.get(..8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap());
    let mut d = counter.try_borrow_mut_data()?;
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    if &d[8..40] != authority.key.as_ref() {
        return Err(ProgramError::Custom(UNAUTHORIZED));
    }
    let count = u64::from_le_bytes(d[40..48].try_into().unwrap());
    let next = count.checked_add(by).ok_or(ProgramError::Custom(OVERFLOW))?;
    d[40..48].copy_from_slice(&next.to_le_bytes());
    Ok(())
}
