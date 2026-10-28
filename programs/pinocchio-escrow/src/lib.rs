//! Escrow in Pinocchio: the same instructions, account layout and errors as examples/escrow.ts.
//! SPL Token instructions are built by hand (Transfer = 3, CloseAccount = 9). Account data is read without borrow
//! tracking (`borrow_unchecked`): no other borrow of these accounts is alive at those points.
use pinocchio::{
    address::Address,
    cpi::{invoke_signed, Seed, Signer},
    entrypoint,
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};

entrypoint!(process);

const IX_MAKE: [u8; 8] = [138, 227, 232, 77, 223, 166, 96, 197];
const IX_TAKE: [u8; 8] = [149, 226, 52, 104, 6, 142, 230, 39];
const IX_REFUND: [u8; 8] = [2, 96, 183, 251, 63, 208, 46, 46];
const DISC: [u8; 8] = [215, 88, 60, 71, 170, 162, 73, 229];
/// discriminator, maker, mint_a, mint_b, vault, amount_a, want_b, seed, bump
const SIZE: usize = 8 + 32 * 4 + 8 * 3 + 1;
const SYSTEM: Address = Address::new_from_array([0; 32]);
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const TOKEN: Address = Address::new_from_array([
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

fn process(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
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
fn token_account(a: &AccountView) -> ProgramResult {
    if !a.owned_by(&TOKEN) || a.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if unsafe { a.borrow_unchecked() }[108] == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(())
}

/// The fields of an offer account: owned by this program, right size and discriminator.
struct Offer {
    maker: [u8; 32],
    mint_a: [u8; 32],
    mint_b: [u8; 32],
    vault: [u8; 32],
    amount_a: u64,
    want_b: u64,
    seed: [u8; 8],
    bump: u8,
}

fn load_offer(program_id: &Address, offer: &AccountView) -> Result<Offer, ProgramError> {
    if !offer.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let d = unsafe { offer.borrow_unchecked() };
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(Offer {
        maker: d[8..40].try_into().unwrap(),
        mint_a: d[40..72].try_into().unwrap(),
        mint_b: d[72..104].try_into().unwrap(),
        vault: d[104..136].try_into().unwrap(),
        amount_a: u64_at(&d, 136),
        want_b: u64_at(&d, 144),
        seed: d[152..160].try_into().unwrap(),
        bump: d[160],
    })
}

fn transfer(from: &AccountView, to: &AccountView, authority: &AccountView, amount: u64, signers: &[Signer]) -> ProgramResult {
    let mut data = [3u8; 9];
    data[1..].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    invoke_signed(&InstructionView { program_id: &TOKEN, data: &data, accounts: &metas }, &[from, to, authority], signers)
}

fn close_token_account(account: &AccountView, dest: &AccountView, authority: &AccountView, signers: &[Signer]) -> ProgramResult {
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(dest.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    invoke_signed(&InstructionView { program_id: &TOKEN, data: &[9], accounts: &metas }, &[account, dest, authority], signers)
}

/// Pay out the vault to `to`, close it and the offer, all rent to the maker.
fn settle(offer: &AccountView, o: &Offer, vault: &AccountView, to: &AccountView, maker: &AccountView) -> ProgramResult {
    let bump = [o.bump];
    let seeds = [Seed::from(b"offer"), Seed::from(&o.maker), Seed::from(&o.seed), Seed::from(&bump)];
    let signer = [Signer::from(&seeds)];
    transfer(vault, to, offer, o.amount_a, &signer)?;
    close_token_account(vault, maker, offer, &signer)?;
    maker.set_lamports(maker.lamports().checked_add(offer.lamports()).ok_or(ProgramError::ArithmeticOverflow)?);
    offer.set_lamports(0);
    offer.close()
}

fn make(program_id: &Address, accounts: &[AccountView], args: &[u8]) -> ProgramResult {
    let [maker, offer, maker_token_a, vault, system, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.len() < 56 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: [u8; 8] = args[..8].try_into().unwrap();
    let amount_a = u64_at(args, 8);
    let want_b = u64_at(args, 16);
    if !maker.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !maker.is_writable() || !offer.is_writable() || !maker_token_a.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.address() != &SYSTEM || token.address() != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    token_account(maker_token_a)?;
    token_account(vault)?;
    let (pda, bump) = Address::find_program_address(&[b"offer", maker.address().as_ref(), &seed], program_id);
    if offer.address() != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if amount_a == 0 || want_b == 0 {
        return Err(ProgramError::Custom(ZERO_AMOUNT));
    }
    let mint_a: [u8; 32] = {
        let v = unsafe { vault.borrow_unchecked() };
        let a = unsafe { maker_token_a.borrow_unchecked() };
        if &v[32..64] != pda.as_ref() || v[..32] != a[..32] || u64_at(&v, 64) != 0 {
            return Err(ProgramError::Custom(BAD_VAULT));
        }
        a[..32].try_into().unwrap()
    };

    // System CreateAccount: u32 tag 0, lamports, space, owner.
    let lamports = Rent::get()?.try_minimum_balance(SIZE)?;
    let mut ix = [0u8; 52];
    ix[4..12].copy_from_slice(&lamports.to_le_bytes());
    ix[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    ix[20..52].copy_from_slice(program_id.as_ref());
    let metas = [InstructionAccount::writable_signer(maker.address()), InstructionAccount::writable_signer(offer.address())];
    let bump_seed = [bump];
    let seeds = [Seed::from(b"offer"), Seed::from(maker.address().as_ref()), Seed::from(&seed), Seed::from(&bump_seed)];
    invoke_signed(&InstructionView { program_id: &SYSTEM, data: &ix, accounts: &metas }, &[maker, offer], &[Signer::from(&seeds)])?;

    transfer(maker_token_a, vault, maker, amount_a, &[])?;

    let d = unsafe { offer.borrow_unchecked_mut() };
    d[..8].copy_from_slice(&DISC);
    d[8..40].copy_from_slice(maker.address().as_ref());
    d[40..72].copy_from_slice(&mint_a);
    d[72..104].copy_from_slice(&args[24..56]);
    d[104..136].copy_from_slice(vault.address().as_ref());
    d[136..144].copy_from_slice(&amount_a.to_le_bytes());
    d[144..152].copy_from_slice(&want_b.to_le_bytes());
    d[152..160].copy_from_slice(&seed);
    d[160] = bump;
    Ok(())
}

fn take(program_id: &Address, accounts: &[AccountView]) -> ProgramResult {
    let [taker, maker, offer, taker_token_a, taker_token_b, maker_token_b, vault, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !taker.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    for a in [taker, maker, offer, taker_token_a, taker_token_b, maker_token_b, vault] {
        if !a.is_writable() {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if token.address() != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    for a in [taker_token_a, taker_token_b, maker_token_b, vault] {
        token_account(a)?;
    }
    let o = load_offer(program_id, offer)?;
    if maker.address().as_ref() != o.maker {
        return Err(ProgramError::Custom(WRONG_MAKER));
    }
    if vault.address().as_ref() != o.vault {
        return Err(ProgramError::Custom(WRONG_VAULT));
    }
    {
        let ta = unsafe { taker_token_a.borrow_unchecked() };
        let tb = unsafe { taker_token_b.borrow_unchecked() };
        let mb = unsafe { maker_token_b.borrow_unchecked() };
        if ta[..32] != o.mint_a || tb[..32] != o.mint_b || mb[..32] != o.mint_b {
            return Err(ProgramError::Custom(WRONG_MINT));
        }
        if mb[32..64] != o.maker {
            return Err(ProgramError::Custom(WRONG_RECIPIENT));
        }
    }
    transfer(taker_token_b, maker_token_b, taker, o.want_b, &[])?;
    settle(offer, &o, vault, taker_token_a, maker)
}

fn refund(program_id: &Address, accounts: &[AccountView]) -> ProgramResult {
    let [maker, offer, maker_token_a, vault, token, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !maker.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !maker.is_writable() || !offer.is_writable() || !maker_token_a.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if token.address() != &TOKEN {
        return Err(ProgramError::IncorrectProgramId);
    }
    token_account(maker_token_a)?;
    token_account(vault)?;
    let o = load_offer(program_id, offer)?;
    if maker.address().as_ref() != o.maker {
        return Err(ProgramError::Custom(WRONG_MAKER));
    }
    if vault.address().as_ref() != o.vault {
        return Err(ProgramError::Custom(WRONG_VAULT));
    }
    if unsafe { maker_token_a.borrow_unchecked() }[..32] != o.mint_a {
        return Err(ProgramError::Custom(WRONG_MINT));
    }
    settle(offer, &o, vault, maker_token_a, maker)
}
