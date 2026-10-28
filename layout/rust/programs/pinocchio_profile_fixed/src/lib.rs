//! Profile in Pinocchio, zero-copy fixed layout (the same bytes as TypeSOL's FixedString / FixedVec / Option):
//! disc | owner 32 | bump | name u32 + 32 | tags u32 + 8×8 | badge u8 + u64 | score u64 | updated i64.
use pinocchio::{
    address::Address,
    cpi::{invoke_signed, set_return_data, Seed, Signer},
    entrypoint,
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};

entrypoint!(process);

const IX_CREATE: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];
const IX_BUMP: [u8; 8] = [102, 163, 91, 221, 146, 88, 184, 142];
const IX_RENAME: [u8; 8] = [98, 63, 129, 146, 24, 170, 185, 45];
const IX_ADD_TAG: [u8; 8] = [104, 103, 92, 4, 25, 211, 151, 90];
const IX_SET_BADGE: [u8; 8] = [68, 217, 139, 87, 4, 162, 174, 239];
const IX_TOTAL: [u8; 8] = [136, 16, 234, 122, 170, 199, 84, 169];
const DISC: [u8; 8] = [184, 101, 165, 188, 95, 63, 127, 188];
const SIZE: usize = 170;
const SYSTEM: Address = Address::new_from_array([0; 32]);
const NAME: usize = 41;
const TAGS: usize = 77;
const BADGE: usize = 145;
const SCORE: usize = 154;
const UPDATED: usize = 162;

fn rd64(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn rd32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
}

fn process(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, rest) = data.split_at(8);
    match disc.try_into().unwrap() {
        IX_CREATE => create(program_id, accounts, rest),
        IX_TOTAL => total(program_id, accounts),
        d => owned(program_id, accounts, d, rest),
    }
}

fn string_arg(args: &[u8]) -> Result<&[u8], ProgramError> {
    let n = u32::from_le_bytes(args.get(..4).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()) as usize;
    let s = args.get(4..4 + n).ok_or(ProgramError::InvalidInstructionData)?;
    core::str::from_utf8(s).map_err(|_| ProgramError::InvalidInstructionData)?;
    if n > 32 {
        return Err(ProgramError::Custom(6000));
    }
    Ok(s)
}

fn create(program_id: &Address, accounts: &[AccountView], args: &[u8]) -> ProgramResult {
    let [owner, profile, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !owner.is_writable() || !profile.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.address() != &SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let name = string_arg(args)?;
    let (pda, bump) = Address::find_program_address(&[b"profile", owner.address().as_ref()], program_id);
    if profile.address() != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let lamports = Rent::get()?.try_minimum_balance(SIZE)?;
    let mut ix = [0u8; 52];
    ix[4..12].copy_from_slice(&lamports.to_le_bytes());
    ix[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    ix[20..52].copy_from_slice(program_id.as_ref());
    let metas = [InstructionAccount::writable_signer(owner.address()), InstructionAccount::writable_signer(profile.address())];
    let bump_seed = [bump];
    let seeds = [Seed::from(b"profile"), Seed::from(owner.address().as_ref()), Seed::from(&bump_seed)];
    invoke_signed(&InstructionView { program_id: &SYSTEM, data: &ix, accounts: &metas }, &[owner, profile], &[Signer::from(&seeds)])?;
    let mut d = profile.try_borrow_mut()?;
    d[..8].copy_from_slice(&DISC);
    d[8..40].copy_from_slice(owner.address().as_ref());
    d[40] = bump;
    d[NAME..NAME + 4].copy_from_slice(&(name.len() as u32).to_le_bytes());
    d[NAME + 4..NAME + 4 + name.len()].copy_from_slice(name);
    Ok(())
}

fn owned(program_id: &Address, accounts: &[AccountView], disc: [u8; 8], args: &[u8]) -> ProgramResult {
    let [owner, profile, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !profile.is_writable() || !profile.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut d = profile.try_borrow_mut()?;
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    if &d[8..40] != owner.address().as_ref() {
        return Err(ProgramError::Custom(2001));
    }
    let arg64 = || -> Result<u64, ProgramError> { Ok(u64::from_le_bytes(args.get(..8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap())) };
    match disc {
        IX_BUMP => {
            let by = arg64()?;
            let score = rd64(&d, SCORE).checked_add(by).ok_or(ProgramError::ArithmeticOverflow)?;
            d[SCORE..SCORE + 8].copy_from_slice(&score.to_le_bytes());
            let updated = (rd64(&d, UPDATED) as i64).checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
            d[UPDATED..UPDATED + 8].copy_from_slice(&updated.to_le_bytes());
        }
        IX_RENAME => {
            let name = string_arg(args)?;
            d[NAME..NAME + 4].copy_from_slice(&(name.len() as u32).to_le_bytes());
            d[NAME + 4..NAME + 4 + 32].fill(0);
            d[NAME + 4..NAME + 4 + name.len()].copy_from_slice(name);
        }
        IX_ADD_TAG => {
            let tag = arg64()?;
            let n = rd32(&d, TAGS) as usize;
            if n >= 8 {
                return Err(ProgramError::Custom(6000));
            }
            d[TAGS + 4 + 8 * n..TAGS + 12 + 8 * n].copy_from_slice(&tag.to_le_bytes());
            d[TAGS..TAGS + 4].copy_from_slice(&(n as u32 + 1).to_le_bytes());
        }
        IX_SET_BADGE => {
            let some = *args.first().ok_or(ProgramError::InvalidInstructionData)?;
            if some > 1 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let v = if some == 1 { arg64_at(args, 1)? } else { 0 };
            d[BADGE] = some;
            d[BADGE + 1..BADGE + 9].copy_from_slice(&v.to_le_bytes());
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    Ok(())
}

fn arg64_at(args: &[u8], at: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(args.get(at..at + 8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))
}

fn total(program_id: &Address, accounts: &[AccountView]) -> ProgramResult {
    let [profile, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !profile.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountData);
    }
    let d = profile.try_borrow()?;
    if d.len() < SIZE || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut t = rd64(&d, SCORE);
    for i in 0..(rd32(&d, TAGS) as usize).min(8) {
        t = t.checked_add(rd64(&d, TAGS + 4 + 8 * i)).ok_or(ProgramError::ArithmeticOverflow)?;
    }
    set_return_data(&t.to_le_bytes());
    Ok(())
}
