//! Profile in native Rust (solana-program + Borsh): the usual native pattern, deserializing the whole account and
//! writing it back (Anchor's bytes).
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
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
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);

#[derive(BorshSerialize, BorshDeserialize)]
pub struct Profile {
    pub owner: Pubkey,
    pub bump: u8,
    pub name: String,
    pub tags: Vec<u64>,
    pub badge: Option<u64>,
    pub score: u64,
    pub updated: i64,
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, mut rest) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().unwrap();
    if disc == IX_CREATE {
        let name = String::deserialize(&mut rest).map_err(|_| ProgramError::InvalidInstructionData)?;
        return create(program_id, accounts, name);
    }
    if disc == IX_TOTAL {
        let [profile, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        let p = load(program_id, profile)?;
        let mut t = p.score;
        for x in &p.tags {
            t = t.checked_add(*x).ok_or(ProgramError::ArithmeticOverflow)?;
        }
        set_return_data(&t.to_le_bytes());
        return Ok(());
    }
    let [owner, profile, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !profile.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut p = load(program_id, profile)?;
    if p.owner != *owner.key {
        return Err(ProgramError::Custom(2001));
    }
    match disc {
        IX_BUMP => {
            let by = u64::deserialize(&mut rest).map_err(|_| ProgramError::InvalidInstructionData)?;
            p.score = p.score.checked_add(by).ok_or(ProgramError::ArithmeticOverflow)?;
            p.updated = p.updated.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
        }
        IX_RENAME => {
            let name = String::deserialize(&mut rest).map_err(|_| ProgramError::InvalidInstructionData)?;
            if name.len() > 32 {
                return Err(ProgramError::Custom(6000));
            }
            p.name = name;
        }
        IX_ADD_TAG => {
            let tag = u64::deserialize(&mut rest).map_err(|_| ProgramError::InvalidInstructionData)?;
            if p.tags.len() >= 8 {
                return Err(ProgramError::Custom(6000));
            }
            p.tags.push(tag);
        }
        IX_SET_BADGE => {
            p.badge = Option::<u64>::deserialize(&mut rest).map_err(|_| ProgramError::InvalidInstructionData)?;
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    let mut d = profile.try_borrow_mut_data()?;
    p.serialize(&mut &mut d[8..]).map_err(|_| ProgramError::AccountDataTooSmall)?;
    Ok(())
}

fn load(program_id: &Pubkey, profile: &AccountInfo) -> Result<Profile, ProgramError> {
    if profile.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let d = profile.try_borrow_data()?;
    if d.len() < 8 || d[..8] != DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Profile::deserialize(&mut &d[8..]).map_err(|_| ProgramError::InvalidAccountData)
}

fn create(program_id: &Pubkey, accounts: &[AccountInfo], name: String) -> ProgramResult {
    let [owner, profile, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !owner.is_writable || !profile.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.key != &SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    if name.len() > 32 {
        return Err(ProgramError::Custom(6000));
    }
    let (pda, bump) = Pubkey::find_program_address(&[b"profile", owner.key.as_ref()], program_id);
    if profile.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let lamports = Rent::get()?.minimum_balance(SIZE);
    let mut data = vec![0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(SIZE as u64).to_le_bytes());
    data[20..52].copy_from_slice(program_id.as_ref());
    let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*owner.key, true), AccountMeta::new(*profile.key, true)], data };
    invoke_signed(&ix, &[owner.clone(), profile.clone()], &[&[b"profile", owner.key.as_ref(), &[bump]]])?;
    let p = Profile { owner: *owner.key, bump, name, tags: vec![], badge: None, score: 0, updated: 0 };
    let mut d = profile.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC);
    p.serialize(&mut &mut d[8..]).map_err(|_| ProgramError::AccountDataTooSmall)?;
    Ok(())
}
