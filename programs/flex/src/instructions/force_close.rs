use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::error::FlexError;
use crate::events::EscrowClosed;
use crate::state::EscrowAccount;

use super::close_token_accounts::{close_token_accounts, CloseTokenAccountsParams};

#[derive(Accounts)]
pub struct ForceClose<'info> {
    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn force_close<'info>(ctx: Context<'_, '_, '_, 'info, ForceClose<'info>>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let clock = Clock::get()?;

    let double_timeout = escrow
        .deadman_timeout_slots
        .checked_mul(2)
        .ok_or(error!(FlexError::ForceCloseTimeoutNotExpired))?;
    let timeout_slot = escrow
        .last_activity_slot
        .checked_add(double_timeout)
        .ok_or(error!(FlexError::ForceCloseTimeoutNotExpired))?;

    require!(
        clock.slot > timeout_slot,
        FlexError::ForceCloseTimeoutNotExpired
    );

    close_token_accounts(CloseTokenAccountsParams {
        remaining_accounts: ctx.remaining_accounts,
        escrow_account_info: &escrow.to_account_info(),
        escrow_owner_info: &ctx.accounts.owner.to_account_info(),
        escrow_owner: &escrow.owner,
        escrow_index: escrow.index,
        escrow_bump: escrow.bump,
        mint_count: escrow.mint_count,
        token_program: &ctx.accounts.token_program.to_account_info(),
        program_id: ctx.program_id,
    })?;

    emit!(EscrowClosed {
        escrow: escrow.key(),
        owner: escrow.owner,
        index: escrow.index,
        emergency: true,
    });

    Ok(())
}
