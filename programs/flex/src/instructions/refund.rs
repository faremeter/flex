use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::events::Refunded;
use crate::state::{EscrowAccount, PendingSettlement};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        has_one = facilitator,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub facilitator: Signer<'info>,

    #[account(
        mut,
        has_one = escrow,
        seeds = [b"pending", escrow.key().as_ref(), &pending.authorization_id.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingSettlement>,
}

pub fn refund(ctx: Context<Refund>, refund_amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let escrow_key = ctx.accounts.escrow.key();
    let refund_timeout_slots = ctx.accounts.escrow.refund_timeout_slots;

    let window_end = ctx
        .accounts
        .pending
        .submitted_at_slot
        .checked_add(refund_timeout_slots)
        .ok_or(error!(FlexError::RefundWindowExpired))?;

    require!(clock.slot < window_end, FlexError::RefundWindowExpired);
    require!(refund_amount > 0, FlexError::RefundAmountZero);
    require!(
        refund_amount <= ctx.accounts.pending.amount,
        FlexError::RefundExceedsAmount
    );

    ctx.accounts.pending.amount -= refund_amount;

    let authorization_id = ctx.accounts.pending.authorization_id;
    let remaining = ctx.accounts.pending.amount;

    ctx.accounts.escrow.last_activity_slot = clock.slot;

    emit!(Refunded {
        escrow: escrow_key,
        authorization_id,
        refund_amount,
        remaining_amount: remaining,
    });

    Ok(())
}
