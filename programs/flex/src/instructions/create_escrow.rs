use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::events::EscrowCreated;
use crate::state::{
    EscrowAccount, MAX_DEADMAN_TIMEOUT_SLOTS, MAX_PENDING_LIMIT, MAX_REFUND_TIMEOUT_SLOTS,
    MIN_DEADMAN_TIMEOUT_SLOTS, MIN_REFUND_TIMEOUT_SLOTS,
};

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", owner.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub system_program: Program<'info, System>,
}

pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    index: u64,
    facilitator: Pubkey,
    refund_timeout_slots: u64,
    deadman_timeout_slots: u64,
    max_session_keys: u8,
    max_pending: u16,
) -> Result<()> {
    require!(
        refund_timeout_slots >= MIN_REFUND_TIMEOUT_SLOTS,
        FlexError::RefundTimeoutTooShort
    );
    require!(
        refund_timeout_slots <= MAX_REFUND_TIMEOUT_SLOTS,
        FlexError::RefundTimeoutTooLong
    );
    require!(
        deadman_timeout_slots >= MIN_DEADMAN_TIMEOUT_SLOTS,
        FlexError::DeadmanTimeoutTooShort
    );
    require!(
        deadman_timeout_slots <= MAX_DEADMAN_TIMEOUT_SLOTS,
        FlexError::DeadmanTimeoutTooLong
    );
    require!(
        deadman_timeout_slots >= 2 * refund_timeout_slots,
        FlexError::DeadmanTooCloseToRefund
    );
    require!(max_pending >= 1, FlexError::MaxPendingZero);
    // Currently tautological (MAX_PENDING_LIMIT == u16::MAX and max_pending is u16),
    // but enforced explicitly so the constraint survives if the limit is tightened.
    #[allow(clippy::absurd_extreme_comparisons)]
    {
        require!(
            max_pending <= MAX_PENDING_LIMIT,
            FlexError::MaxPendingTooLarge
        );
    }

    let escrow = &mut ctx.accounts.escrow;
    escrow.version = 1;
    escrow.owner = ctx.accounts.owner.key();
    escrow.facilitator = facilitator;
    escrow.index = index;
    escrow.pending_count = 0;
    escrow.max_pending = max_pending;
    escrow.mint_count = 0;
    escrow.refund_timeout_slots = refund_timeout_slots;
    escrow.deadman_timeout_slots = deadman_timeout_slots;
    escrow.last_activity_slot = Clock::get()?.slot;
    escrow.max_session_keys = max_session_keys;
    escrow.session_key_count = 0;
    escrow.bump = ctx.bumps.escrow;

    emit!(EscrowCreated {
        escrow: escrow.key(),
        owner: escrow.owner,
        facilitator: escrow.facilitator,
        index,
        refund_timeout_slots,
        deadman_timeout_slots,
        max_pending,
    });

    Ok(())
}
