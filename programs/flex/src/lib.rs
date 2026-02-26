use anchor_lang::prelude::*;

mod error;
mod events;
mod instructions;
mod state;

pub use error::*;
pub use events::*;
pub use state::*;

use instructions::*;

declare_id!("EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS");

#[program]
pub mod flex {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        index: u64,
        facilitator: Pubkey,
        refund_timeout_slots: u64,
        deadman_timeout_slots: u64,
        max_session_keys: u8,
    ) -> Result<()> {
        instructions::create_escrow(
            ctx,
            index,
            facilitator,
            refund_timeout_slots,
            deadman_timeout_slots,
            max_session_keys,
        )
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit(ctx, amount)
    }

    pub fn close_escrow<'info>(ctx: Context<'_, '_, '_, 'info, CloseEscrow<'info>>) -> Result<()> {
        instructions::close_escrow(ctx)
    }

    pub fn void_pending(ctx: Context<VoidPending>) -> Result<()> {
        instructions::void_pending(ctx)
    }

    pub fn emergency_close<'info>(
        ctx: Context<'_, '_, '_, 'info, EmergencyClose<'info>>,
    ) -> Result<()> {
        instructions::emergency_close(ctx)
    }

    pub fn force_close<'info>(ctx: Context<'_, '_, '_, 'info, ForceClose<'info>>) -> Result<()> {
        instructions::force_close(ctx)
    }
}
