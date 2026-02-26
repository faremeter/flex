use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::events::SessionKeyClosed;
use crate::state::{EscrowAccount, SessionKey};

#[derive(Accounts)]
pub struct CloseSessionKey<'info> {
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
        mut,
        close = owner,
        has_one = escrow,
        seeds = [b"session", escrow.key().as_ref(), session_key_account.key.as_ref()],
        bump = session_key_account.bump,
    )]
    pub session_key_account: Account<'info, SessionKey>,
}

pub fn close_session_key(ctx: Context<CloseSessionKey>) -> Result<()> {
    let ska = &ctx.accounts.session_key_account;
    let session_key = ska.key;

    require!(!ska.active, FlexError::SessionKeyStillActive);

    let revoked_at_slot = ska
        .revoked_at_slot
        .ok_or(error!(FlexError::SessionKeyStillActive))?;
    let grace_end = revoked_at_slot
        .checked_add(ska.revocation_grace_period_slots)
        .ok_or(error!(FlexError::SessionKeyGracePeriodActive))?;

    let clock = Clock::get()?;
    require!(
        clock.slot >= grace_end,
        FlexError::SessionKeyGracePeriodActive
    );

    let escrow_key = ctx.accounts.escrow.key();
    let new_count = ctx
        .accounts
        .escrow
        .session_key_count
        .checked_sub(1)
        .ok_or(error!(FlexError::SessionKeyCountUnderflow))?;

    ctx.accounts.escrow.session_key_count = new_count;

    emit!(SessionKeyClosed {
        escrow: escrow_key,
        session_key,
    });

    Ok(())
}
