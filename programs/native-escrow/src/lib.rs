//! Escrow in native Rust (solana-program): the same instructions, account layout and errors as examples/escrow.ts.
//! SPL Token instructions are built by hand (Transfer = 3, CloseAccount = 9).
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

const IX_MAKE: [u8; 8] = [138, 227, 232, 77, 223, 166, 96, 197];
const IX_TAKE: [u8; 8] = [149, 226, 52, 104, 6, 142, 230, 39];
const IX_REFUND: [u8; 8] = [2, 96, 183, 251, 63, 208, 46, 46];
const DISC: [u8; 8] = [215, 88, 60, 71, 170, 162, 73, 229];
/// discriminator, maker, mint_a, mint_b, vault, amount_a, want_b, seed, bump
const SIZE: usize = 8 + 32 * 4 + 8 * 3 + 1;
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const TOKEN: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133,
    126, 255, 0, 169,
]);
/// SPL token account: mint[0..32] owner[32..64] amount[64..72] ... state[108]
const TOKEN_ACCOUNT_LEN: usize = 165;
const ZERO_AMOUNT: u32 = 6000;
const BAD_VAULT: u32 = 6001;
const WRONG_MAKER: u32 = 6002;
const WRONG_VAULT: u32 = 6003;
const WRONG_MINT: u32 = 6004;
const WRONG_RECIPIENT: u32 = 6005;

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, rest) = data.split_at(8);
    if disc == IX_MAKE {
        make(program_id, accounts, rest)
    } else if disc == IX_TAKE {
        take(program_id, accounts)
    } else if disc == IX_REFUND {
        refund(program_id, accounts)
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}

/// An initialized SPL Token account.
fn token_account(a: &AccountInfo) -> ProgramResult {
    if a.owner != &TOKEN || a.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if a.try_borrow_data()?[108] == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(())
}

/// The fields of an offer account: owned by this program, right size and discriminator.
struct Offer {
    maker: Pubkey,
    mint_a: [u8; 32],
    mint_b: [u8; 32],
    vault: [u8; 32],
    amount_a: u64,
    want_b: u64,
    seed: [u8; 8],
    bump: u8,
}

fn load_offer(program_id: &Pubkey, offer: &AccountInfo) -> Result<Offer, ProgramError> {
    if offer.owner != program_id {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let d = offer.try_borrow_data()?;
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(Offer {
        maker: Pubkey::new_from_array(d[8..40].try_into().unwrap()),
        mint_a: d[40..72].try_into().unwrap(),
        mint_b: d[72..104].try_into().unwrap(),
        vault: d[104..136].try_into().unwrap(),
        amount_a: u64_at(&d, 136),
        want_b: u64_at(&d, 144),
        seed: d[152..160].try_into().unwrap(),
        bump: d[160],
    })
}

fn transfer<'a>(from: &AccountInfo<'a>, to: &AccountInfo<'a>, authority: &AccountInfo<'a>, amount: u64, seeds: &[&[&[u8]]]) -> ProgramResult {
    let mut data = vec![3u8; 9];
    data[1..].copy_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(*from.key, false), AccountMeta::new(*to.key, false), AccountMeta::new_readonly(*authority.key, true)],
        data,
    };
    invoke_signed(&ix, &[from.clone(), to.clone(), authority.clone()], seeds)
}

/// Pay out the vault to `to`, close it and the offer, all rent to the maker.
fn settle<'a>(offer: &AccountInfo<'a>, o: &Offer, vault: &AccountInfo<'a>, to: &AccountInfo<'a>, maker: &AccountInfo<'a>) -> ProgramResult {
    let seeds: &[&[u8]] = &[b"offer", o.maker.as_ref(), &o.seed, &[o.bump]];
    transfer(vault, to, offer, o.amount_a, &[seeds])?;
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(*vault.key, false), AccountMeta::new(*maker.key, false), AccountMeta::new_readonly(*offer.key, true)],
        data: vec![9],
    };
    invoke_signed(&ix, &[vault.clone(), maker.clone(), offer.clone()], &[seeds])?;
    let total = maker.lamports().checked_add(offer.lamports()).ok_or(ProgramError::ArithmeticOverflow)?;
    **maker.try_borrow_mut_lamports()? = total;
    **offer.try_borrow_mut_lamports()? = 0;
    offer.assign(&SYSTEM);
    offer.resize(0)
}

fn make(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [maker, offer, maker_token_a, vault, system, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.len() < 56 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: [u8; 8] = args[..8].try_into().unwrap();
    let amount_a = u64_at(args, 8);
    let want_b = u64_at(args, 16);
    if !maker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !maker.is_writable || !offer.is_writable || !maker_token_a.is_writable || !vault.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.key != &SYSTEM || token.key != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    token_account(maker_token_a)?;
    token_account(vault)?;
    let (pda, bump) = Pubkey::find_program_address(&[b"offer", maker.key.as_ref(), &seed], program_id);
    if offer.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if amount_a == 0 || want_b == 0 {
        return Err(ProgramError::Custom(ZERO_AMOUNT));
    }
    let mint_a: [u8; 32] = {
        let v = vault.try_borrow_data()?;
        let a = maker_token_a.try_borrow_data()?;
        if &v[32..64] != pda.as_ref() || v[..32] != a[..32] || u64_at(&v, 64) != 0 {
            return Err(ProgramError::Custom(BAD_VAULT));
        }
        a[..32].try_into().unwrap()
    };

    // System CreateAccount: u32 tag 0, lamports, space, owner.
    let lamports = Rent::get()?.minimum_balance(SIZE);
    let mut data = vec![0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    data[20..52].copy_from_slice(program_id.as_ref());
    let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*maker.key, true), AccountMeta::new(*offer.key, true)], data };
    invoke_signed(&ix, &[maker.clone(), offer.clone()], &[&[b"offer", maker.key.as_ref(), &seed, &[bump]]])?;

    let mut data = vec![3u8; 9];
    data[1..].copy_from_slice(&amount_a.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(*maker_token_a.key, false), AccountMeta::new(*vault.key, false), AccountMeta::new_readonly(*maker.key, true)],
        data,
    };
    invoke(&ix, &[maker_token_a.clone(), vault.clone(), maker.clone()])?;

    let mut d = offer.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC);
    d[8..40].copy_from_slice(maker.key.as_ref());
    d[40..72].copy_from_slice(&mint_a);
    d[72..104].copy_from_slice(&args[24..56]);
    d[104..136].copy_from_slice(vault.key.as_ref());
    d[136..144].copy_from_slice(&amount_a.to_le_bytes());
    d[144..152].copy_from_slice(&want_b.to_le_bytes());
    d[152..160].copy_from_slice(&seed);
    d[160] = bump;
    Ok(())
}

fn take(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [taker, maker, offer, taker_token_a, taker_token_b, maker_token_b, vault, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !taker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    for a in [taker, maker, offer, taker_token_a, taker_token_b, maker_token_b, vault] {
        if !a.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if token.key != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    for a in [taker_token_a, taker_token_b, maker_token_b, vault] {
        token_account(a)?;
    }
    let o = load_offer(program_id, offer)?;
    if maker.key != &o.maker {
        return Err(ProgramError::Custom(WRONG_MAKER));
    }
    if vault.key.as_ref() != o.vault {
        return Err(ProgramError::Custom(WRONG_VAULT));
    }
    {
        let ta = taker_token_a.try_borrow_data()?;
        let tb = taker_token_b.try_borrow_data()?;
        let mb = maker_token_b.try_borrow_data()?;
        if ta[..32] != o.mint_a || tb[..32] != o.mint_b || mb[..32] != o.mint_b {
            return Err(ProgramError::Custom(WRONG_MINT));
        }
        if &mb[32..64] != o.maker.as_ref() {
            return Err(ProgramError::Custom(WRONG_RECIPIENT));
        }
    }
    transfer(taker_token_b, maker_token_b, taker, o.want_b, &[])?;
    settle(offer, &o, vault, taker_token_a, maker)
}

fn refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [maker, offer, maker_token_a, vault, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !maker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !maker.is_writable || !offer.is_writable || !maker_token_a.is_writable || !vault.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if token.key != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    token_account(maker_token_a)?;
    token_account(vault)?;
    let o = load_offer(program_id, offer)?;
    if maker.key != &o.maker {
        return Err(ProgramError::Custom(WRONG_MAKER));
    }
    if vault.key.as_ref() != o.vault {
        return Err(ProgramError::Custom(WRONG_VAULT));
    }
    if maker_token_a.try_borrow_data()?[..32] != o.mint_a {
        return Err(ProgramError::Custom(WRONG_MINT));
    }
    settle(offer, &o, vault, maker_token_a, maker)
}
