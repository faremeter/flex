use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::TokenAccount;

const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

use crate::error::FlexError;
use crate::events::AuthorizationSubmitted;
use crate::state::{
    EscrowAccount, PendingSettlement, SessionKey, SplitEntry, MAX_PENDING, MAX_SPLITS,
};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PaymentAuthorization {
    pub program_id: Pubkey,
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub max_amount: u64,
    pub authorization_id: u64,
    pub expires_at_slot: u64,
    pub splits: Vec<SplitEntry>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey, max_amount: u64, settle_amount: u64, authorization_id: u64, expires_at_slot: u64)]
pub struct SubmitAuthorization<'info> {
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
        has_one = escrow,
        seeds = [b"session", escrow.key().as_ref(), session_key.key.as_ref()],
        bump = session_key.bump,
    )]
    pub session_key: Account<'info, SessionKey>,

    #[account(
        token::mint = mint,
        token::authority = escrow,
        seeds = [b"token", escrow.key().as_ref(), mint.as_ref()],
        bump,
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = facilitator,
        space = 8 + PendingSettlement::INIT_SPACE,
        seeds = [b"pending", escrow.key().as_ref(), &authorization_id.to_le_bytes()],
        bump,
    )]
    pub pending: Account<'info, PendingSettlement>,

    /// CHECK: Validated by address constraint against sysvar::instructions::ID
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

fn verify_ed25519_introspection(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(FlexError::InvalidEd25519Instruction))?;

    require!(current_index > 0, FlexError::InvalidEd25519Instruction);

    let ed25519_ix = load_instruction_at_checked((current_index - 1) as usize, instructions_sysvar)
        .map_err(|_| error!(FlexError::InvalidEd25519Instruction))?;

    require!(
        ed25519_ix.program_id == ED25519_PROGRAM_ID,
        FlexError::InvalidEd25519Instruction
    );

    let ix_data = &ed25519_ix.data;

    // Header: num_signatures (u8) + padding (u8) = 2 bytes
    // Each entry: 7 x u16 = 14 bytes
    require!(ix_data.len() >= 16, FlexError::InvalidEd25519Instruction);
    require!(ix_data[0] >= 1, FlexError::InvalidEd25519Instruction);

    // Parse first signature entry starting at offset 2
    let sig_ix_idx = u16::from_le_bytes([ix_data[4], ix_data[5]]);
    let pk_offset = u16::from_le_bytes([ix_data[6], ix_data[7]]) as usize;
    let pk_ix_idx = u16::from_le_bytes([ix_data[8], ix_data[9]]);
    let msg_offset = u16::from_le_bytes([ix_data[10], ix_data[11]]) as usize;
    let msg_size = u16::from_le_bytes([ix_data[12], ix_data[13]]) as usize;
    let msg_ix_idx = u16::from_le_bytes([ix_data[14], ix_data[15]]);

    // All data must be inline in the Ed25519 instruction
    require!(sig_ix_idx == 0xFFFF, FlexError::InvalidEd25519Instruction);
    require!(pk_ix_idx == 0xFFFF, FlexError::InvalidEd25519Instruction);
    require!(msg_ix_idx == 0xFFFF, FlexError::InvalidEd25519Instruction);

    // Extract and compare pubkey
    require!(
        pk_offset
            .checked_add(32)
            .is_some_and(|end| end <= ix_data.len()),
        FlexError::InvalidEd25519Instruction
    );
    let extracted_pubkey = &ix_data[pk_offset..pk_offset + 32];
    require!(
        extracted_pubkey == expected_pubkey.as_ref(),
        FlexError::InvalidSignature
    );

    // Extract and compare message
    require!(
        msg_offset
            .checked_add(msg_size)
            .is_some_and(|end| end <= ix_data.len()),
        FlexError::InvalidEd25519Instruction
    );
    let extracted_message = &ix_data[msg_offset..msg_offset + msg_size];
    require!(
        extracted_message == expected_message,
        FlexError::InvalidSignature
    );

    Ok(())
}

#[allow(clippy::too_many_lines)]
pub fn submit_authorization(
    ctx: Context<SubmitAuthorization>,
    mint: Pubkey,
    max_amount: u64,
    settle_amount: u64,
    authorization_id: u64,
    expires_at_slot: u64,
    splits: Vec<SplitEntry>,
) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let session_key = &ctx.accounts.session_key;
    let clock = Clock::get()?;

    require!(
        (escrow.pending_count as usize) < MAX_PENDING,
        FlexError::PendingLimitReached
    );

    require!(
        clock.slot < expires_at_slot,
        FlexError::AuthorizationExpired
    );
    require!(
        expires_at_slot <= clock.slot + escrow.refund_timeout_slots,
        FlexError::ExpiryTooFar
    );

    require!(settle_amount > 0, FlexError::SettleAmountZero);
    require!(settle_amount <= max_amount, FlexError::SettleExceedsMax);

    // Session key validity: revoked keys are usable within grace period
    if !session_key.active {
        if let Some(revoked_at) = session_key.revoked_at_slot {
            let grace_end = revoked_at
                .checked_add(session_key.revocation_grace_period_slots)
                .ok_or(error!(FlexError::SessionKeyRevoked))?;
            require!(clock.slot < grace_end, FlexError::SessionKeyRevoked);
        } else {
            return err!(FlexError::SessionKeyRevoked);
        }
    }

    if let Some(expires_at) = session_key.expires_at_slot {
        require!(clock.slot < expires_at, FlexError::SessionKeyExpired);
    }

    require!(
        ctx.accounts.token_account.amount >= settle_amount,
        FlexError::InsufficientBalance
    );

    let authorization = PaymentAuthorization {
        program_id: crate::ID,
        escrow: escrow.key(),
        mint,
        max_amount,
        authorization_id,
        expires_at_slot,
        splits: splits.clone(),
    };
    let expected_message = authorization
        .try_to_vec()
        .map_err(|_| error!(FlexError::InvalidSignature))?;

    verify_ed25519_introspection(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &session_key.key,
        &expected_message,
    )?;

    require!(
        !splits.is_empty() && splits.len() <= MAX_SPLITS,
        FlexError::InvalidSplitCount
    );

    let mut bps_sum: u16 = 0;
    for entry in &splits {
        require!(entry.bps > 0, FlexError::SplitBpsZero);
        bps_sum = bps_sum
            .checked_add(entry.bps)
            .ok_or(error!(FlexError::InvalidSplitBps))?;
    }
    require!(bps_sum == 10_000, FlexError::InvalidSplitBps);

    for i in 0..splits.len() {
        for j in (i + 1)..splits.len() {
            require!(
                splits[i].recipient != splits[j].recipient,
                FlexError::DuplicateSplitRecipient
            );
        }
    }

    let pending = &mut ctx.accounts.pending;
    pending.version = 1;
    pending.escrow = escrow.key();
    pending.mint = mint;
    pending.amount = settle_amount;
    pending.original_amount = settle_amount;
    pending.max_amount = max_amount;
    pending.authorization_id = authorization_id;
    pending.expires_at_slot = expires_at_slot;
    pending.submitted_at_slot = clock.slot;
    pending.session_key = session_key.key;
    pending.split_count = splits.len() as u8;

    let mut fixed_splits = [SplitEntry::default(); MAX_SPLITS];
    for (i, entry) in splits.iter().enumerate() {
        fixed_splits[i] = *entry;
    }
    pending.splits = fixed_splits;
    pending.bump = ctx.bumps.pending;

    let escrow = &mut ctx.accounts.escrow;
    escrow.last_activity_slot = clock.slot;
    escrow.pending_count = escrow
        .pending_count
        .checked_add(1)
        .ok_or(error!(FlexError::PendingLimitReached))?;

    emit!(AuthorizationSubmitted {
        escrow: escrow.key(),
        authorization_id,
        expires_at_slot,
        mint,
        splits,
        max_amount,
        settle_amount,
        session_key: ctx.accounts.session_key.key,
    });

    Ok(())
}
