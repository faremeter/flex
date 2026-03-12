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

    pub fn register_session_key(
        ctx: Context<RegisterSessionKey>,
        session_key: Pubkey,
        expires_at_slot: Option<u64>,
        revocation_grace_period_slots: u64,
    ) -> Result<()> {
        instructions::register_session_key(
            ctx,
            session_key,
            expires_at_slot,
            revocation_grace_period_slots,
        )
    }

    pub fn revoke_session_key(ctx: Context<RevokeSessionKey>) -> Result<()> {
        instructions::revoke_session_key(ctx)
    }

    pub fn close_session_key(ctx: Context<CloseSessionKey>) -> Result<()> {
        instructions::close_session_key(ctx)
    }

    pub fn close_escrow<'info>(ctx: Context<'_, '_, '_, 'info, CloseEscrow<'info>>) -> Result<()> {
        instructions::close_escrow(ctx)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_authorization(
        ctx: Context<SubmitAuthorization>,
        mint: Pubkey,
        max_amount: u64,
        settle_amount: u64,
        authorization_id: u64,
        expires_at_slot: u64,
        splits: Vec<state::SplitEntry>,
        signature: [u8; 64],
    ) -> Result<()> {
        instructions::submit_authorization(
            ctx,
            mint,
            max_amount,
            settle_amount,
            authorization_id,
            expires_at_slot,
            splits,
            signature,
        )
    }

    pub fn void_pending(ctx: Context<VoidPending>) -> Result<()> {
        instructions::void_pending(ctx)
    }

    pub fn refund(ctx: Context<Refund>, refund_amount: u64) -> Result<()> {
        instructions::refund(ctx, refund_amount)
    }

    pub fn finalize<'info>(ctx: Context<'_, '_, '_, 'info, Finalize<'info>>) -> Result<()> {
        instructions::finalize(ctx)
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
