use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::state::{EscrowAccount, PendingSettlement};

#[derive(Accounts)]
pub struct VoidPending<'info> {
    #[account(
        mut,
        has_one = facilitator,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub authority: Signer<'info>,

    /// CHECK: Receives rent from closed pending. Validated via has_one on escrow.
    #[account(mut)]
    pub facilitator: UncheckedAccount<'info>,

    #[account(
        mut,
        close = facilitator,
        has_one = escrow,
        seeds = [b"pending", escrow.key().as_ref(), &pending.authorization_id.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingSettlement>,
}

pub fn void_pending(ctx: Context<VoidPending>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let authority_key = ctx.accounts.authority.key();
    let clock = Clock::get()?;

    require!(
        authority_key == escrow.owner || authority_key == escrow.facilitator,
        FlexError::InvalidVoidAuthority
    );

    let deadman_expired = escrow
        .last_activity_slot
        .checked_add(escrow.deadman_timeout_slots)
        .is_some_and(|timeout_slot| clock.slot > timeout_slot);

    let deadline_passed = ctx
        .accounts
        .pending
        .submitted_at_slot
        .checked_add(escrow.refund_timeout_slots)
        .and_then(|v| v.checked_add(escrow.deadman_timeout_slots))
        .is_some_and(|deadline| clock.slot > deadline);

    require!(
        deadman_expired || deadline_passed,
        FlexError::VoidConditionNotMet
    );

    ctx.accounts.escrow.pending_count = escrow
        .pending_count
        .checked_sub(1)
        .ok_or(error!(FlexError::PendingCountMismatch))?;

    Ok(())
}
