use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::events::SessionKeyRegistered;
use crate::state::{EscrowAccount, SessionKey};

#[derive(Accounts)]
#[instruction(session_key: Pubkey)]
pub struct RegisterSessionKey<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + SessionKey::INIT_SPACE,
        seeds = [b"session", escrow.key().as_ref(), session_key.as_ref()],
        bump,
    )]
    pub session_key_account: Account<'info, SessionKey>,

    pub system_program: Program<'info, System>,
}

pub fn register_session_key(
    ctx: Context<RegisterSessionKey>,
    session_key: Pubkey,
    expires_at_slot: Option<u64>,
    revocation_grace_period_slots: u64,
) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let escrow_key = escrow.key();

    require!(
        escrow.max_session_keys == 0 || escrow.session_key_count < escrow.max_session_keys,
        FlexError::SessionKeyLimitReached
    );

    let new_count = escrow
        .session_key_count
        .checked_add(1)
        .ok_or(error!(FlexError::SessionKeyLimitReached))?;

    let clock = Clock::get()?;
    let ska = &mut ctx.accounts.session_key_account;
    ska.version = 1;
    ska.escrow = escrow_key;
    ska.key = session_key;
    ska.created_at_slot = clock.slot;
    ska.expires_at_slot = expires_at_slot;
    ska.active = true;
    ska.revoked_at_slot = None;
    ska.revocation_grace_period_slots = revocation_grace_period_slots;
    ska.bump = ctx.bumps.session_key_account;

    ctx.accounts.escrow.session_key_count = new_count;

    emit!(SessionKeyRegistered {
        escrow: escrow_key,
        session_key,
        expires_at_slot,
    });

    Ok(())
}
