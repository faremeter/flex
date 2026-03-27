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
    let pending_count = ctx.accounts.escrow.pending_count;
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

    if remaining == 0 {
        let pending_info = ctx.accounts.pending.to_account_info();
        let facilitator_info = ctx.accounts.facilitator.to_account_info();

        **facilitator_info.lamports.borrow_mut() += pending_info.lamports();
        **pending_info.lamports.borrow_mut() = 0;
        pending_info.assign(&anchor_lang::solana_program::system_program::ID);
        pending_info.resize(0)?;

        ctx.accounts.escrow.pending_count = pending_count
            .checked_sub(1)
            .ok_or(error!(FlexError::PendingCountMismatch))?;
    }

    ctx.accounts.escrow.last_activity_slot = clock.slot;

    emit!(Refunded {
        escrow: escrow_key,
        authorization_id,
        refund_amount,
        remaining_amount: remaining,
    });

    Ok(())
}
