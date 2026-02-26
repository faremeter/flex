use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::FlexError;
use crate::events::Finalized;
use crate::state::{EscrowAccount, PendingSettlement, SplitEntry};

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(
        mut,
        has_one = facilitator,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Receives rent from closed pending. Validated via has_one on escrow.
    #[account(mut)]
    pub facilitator: UncheckedAccount<'info>,

    #[account(
        mut,
        close = facilitator,
        has_one = escrow,
        seeds = [b"pending", escrow.key().as_ref(), &pending.nonce.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingSettlement>,

    #[account(
        mut,
        token::mint = pending.mint,
        token::authority = escrow,
        seeds = [b"token", escrow.key().as_ref(), pending.mint.as_ref()],
        bump,
    )]
    pub token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn finalize<'info>(ctx: Context<'_, '_, '_, 'info, Finalize<'info>>) -> Result<()> {
    let clock = Clock::get()?;

    let escrow_key = ctx.accounts.escrow.key();
    let escrow_owner = ctx.accounts.escrow.owner;
    let escrow_index = ctx.accounts.escrow.index;
    let escrow_bump = ctx.accounts.escrow.bump;
    let pending_count = ctx.accounts.escrow.pending_count;
    let refund_timeout_slots = ctx.accounts.escrow.refund_timeout_slots;

    let total_amount = ctx.accounts.pending.amount;
    let nonce = ctx.accounts.pending.nonce;
    let mint = ctx.accounts.pending.mint;
    let split_count = ctx.accounts.pending.split_count as usize;
    let splits_fixed = ctx.accounts.pending.splits;

    let window_end = ctx
        .accounts
        .pending
        .submitted_at_slot
        .checked_add(refund_timeout_slots)
        .ok_or(error!(FlexError::RefundWindowNotExpired))?;

    require!(clock.slot >= window_end, FlexError::RefundWindowNotExpired);

    require!(
        ctx.remaining_accounts.len() == split_count,
        FlexError::InvalidSplitRecipient
    );

    for (i, split) in splits_fixed.iter().enumerate().take(split_count) {
        let recipient_info = &ctx.remaining_accounts[i];
        require!(
            recipient_info.key() == split.recipient,
            FlexError::InvalidSplitRecipient
        );

        let data = recipient_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let recipient_token = TokenAccount::try_deserialize(&mut slice)
            .map_err(|_| error!(FlexError::InvalidSplitRecipient))?;
        require!(
            recipient_token.mint == mint,
            FlexError::InvalidSplitRecipient
        );
    }

    let index_bytes = escrow_index.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"escrow",
        escrow_owner.as_ref(),
        &index_bytes,
        &[escrow_bump],
    ];

    let mut cumulative: u64 = 0;

    for (i, split) in splits_fixed.iter().enumerate().take(split_count) {
        let amount = if i == split_count - 1 {
            total_amount - cumulative
        } else {
            total_amount
                .checked_mul(split.bps as u64)
                .and_then(|v| v.checked_div(10_000))
                .ok_or(error!(FlexError::InvalidSplitRecipient))?
        };

        cumulative += amount;

        if amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.token_account.to_account_info(),
                        to: ctx.remaining_accounts[i].clone(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                )
                .with_signer(&[signer_seeds]),
                amount,
            )?;
        }
    }

    let splits: Vec<SplitEntry> = splits_fixed[..split_count].to_vec();

    ctx.accounts.escrow.pending_count = pending_count
        .checked_sub(1)
        .ok_or(error!(FlexError::PendingCountMismatch))?;

    emit!(Finalized {
        escrow: escrow_key,
        nonce,
        mint,
        splits,
        total_amount,
    });

    Ok(())
}
