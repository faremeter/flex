use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::state::{EscrowAccount, PendingSettlement};

#[derive(Accounts)]
pub struct VoidPending<'info> {
    #[account(
        mut,
        has_one = owner,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        has_one = escrow,
        seeds = [b"pending", escrow.key().as_ref(), &pending.nonce.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingSettlement>,
}

pub fn void_pending(ctx: Context<VoidPending>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let clock = Clock::get()?;

    let timeout_slot = escrow
        .last_activity_slot
        .checked_add(escrow.deadman_timeout_slots)
        .ok_or(error!(FlexError::DeadmanNotExpired))?;

    require!(clock.slot > timeout_slot, FlexError::DeadmanNotExpired);

    ctx.accounts.escrow.pending_count = escrow
        .pending_count
        .checked_sub(1)
        .ok_or(error!(FlexError::PendingCountMismatch))?;

    Ok(())
}
