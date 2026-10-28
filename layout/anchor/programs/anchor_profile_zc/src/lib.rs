// Layout experiment: Anchor's fast path, a zero-copy account (AccountLoader) with a fixed layout — the same bytes
// as TypeSOL's FixedString / FixedVec / Option.
use anchor_lang::prelude::*;

declare_id!("EaiwmXTVEwU6sh1wAizeXHmPkHS4s6HaHr4EX3vZ6kJq");

#[program]
pub mod anchor_profile_zc {
    use super::*;

    pub fn create(ctx: Context<Create>, name: String) -> Result<()> {
        require!(name.len() <= 32, ProfileError::Full);
        let mut p = ctx.accounts.profile.load_init()?;
        p.bump = ctx.bumps.profile;
        p.owner = ctx.accounts.owner.key();
        p.name_len = name.len() as u32;
        p.name[..name.len()].copy_from_slice(name.as_bytes());
        Ok(())
    }

    pub fn bump(ctx: Context<Owned>, by: u64) -> Result<()> {
        let mut p = ctx.accounts.profile.load_mut()?;
        p.score = { p.score }.checked_add(by).unwrap();
        p.updated = { p.updated }.checked_add(1).unwrap();
        Ok(())
    }

    pub fn rename(ctx: Context<Owned>, name: String) -> Result<()> {
        require!(name.len() <= 32, ProfileError::Full);
        let mut p = ctx.accounts.profile.load_mut()?;
        p.name_len = name.len() as u32;
        p.name = [0; 32];
        p.name[..name.len()].copy_from_slice(name.as_bytes());
        Ok(())
    }

    pub fn add_tag(ctx: Context<Owned>, tag: u64) -> Result<()> {
        let mut p = ctx.accounts.profile.load_mut()?;
        let n = p.tags_len as usize;
        require!(n < 8, ProfileError::Full);
        p.tags[n] = tag;
        p.tags_len = n as u32 + 1;
        Ok(())
    }

    pub fn set_badge(ctx: Context<Owned>, badge: Option<u64>) -> Result<()> {
        let mut p = ctx.accounts.profile.load_mut()?;
        p.badge_some = badge.is_some() as u8;
        p.badge = badge.unwrap_or(0);
        Ok(())
    }

    pub fn total(ctx: Context<Read>) -> Result<u64> {
        let p = ctx.accounts.profile.load()?;
        let mut t = p.score;
        let tags = p.tags;
        for x in &tags[..(p.tags_len as usize).min(8)] {
            t = t.checked_add(*x).unwrap();
        }
        Ok(t)
    }
}

#[account(zero_copy(unsafe))]
#[repr(packed)]
pub struct Profile {
    pub owner: Pubkey,
    pub bump: u8,
    pub name_len: u32,
    pub name: [u8; 32],
    pub tags_len: u32,
    pub tags: [u64; 8],
    pub badge_some: u8,
    pub badge: u64,
    pub score: u64,
    pub updated: i64,
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + 162, seeds = [b"profile", owner.key().as_ref()], bump)]
    pub profile: AccountLoader<'info, Profile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Owned<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub profile: AccountLoader<'info, Profile>,
}

#[derive(Accounts)]
pub struct Read<'info> {
    pub profile: AccountLoader<'info, Profile>,
}

#[error_code]
pub enum ProfileError {
    Full,
}
