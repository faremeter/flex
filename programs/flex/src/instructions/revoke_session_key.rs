use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::events::SessionKeyRevoked;
use crate::state::{EscrowAccount, SessionKey};

#[derive(Accounts)]
pub struct RevokeSessionKey<'info> {
    pub owner: Signer<'info>,

    #[account(
        has_one = owner,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        has_one = escrow,
        seeds = [b"session", escrow.key().as_ref(), session_key_account.key.as_ref()],
        bump = session_key_account.bump,
    )]
    pub session_key_account: Account<'info, SessionKey>,
}

pub fn revoke_session_key(ctx: Context<RevokeSessionKey>) -> Result<()> {
    let ska = &mut ctx.accounts.session_key_account;

    require!(ska.active, FlexError::SessionKeyRevoked);

    let clock = Clock::get()?;
    ska.active = false;
    ska.revoked_at_slot = Some(clock.slot);

    emit!(SessionKeyRevoked {
        escrow: ctx.accounts.escrow.key(),
        session_key: ska.key,
        revoked_at_slot: clock.slot,
    });

    Ok(())
}
