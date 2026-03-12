use anchor_lang::prelude::*;

pub const MAX_SPLITS: usize = 5;
pub const MAX_PENDING: usize = 16;
pub const MAX_MINTS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct SplitEntry {
    pub recipient: Pubkey,
    pub bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub version: u8,
    pub owner: Pubkey,
    pub facilitator: Pubkey,
    pub index: u64,

    pub pending_count: u64,
    pub mint_count: u64,
    pub refund_timeout_slots: u64,
    pub deadman_timeout_slots: u64,
    pub last_activity_slot: u64,
    pub max_session_keys: u8,
    pub session_key_count: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SessionKey {
    pub version: u8,
    pub escrow: Pubkey,
    pub key: Pubkey,
    pub created_at_slot: u64,
    pub expires_at_slot: Option<u64>,
    pub active: bool,
    pub revoked_at_slot: Option<u64>,
    pub revocation_grace_period_slots: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PendingSettlement {
    pub version: u8,
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub original_amount: u64,
    pub max_amount: u64,
    pub authorization_id: u64,
    pub expires_at_slot: u64,
    pub submitted_at_slot: u64,
    pub session_key: Pubkey,
    pub split_count: u8,
    pub splits: [SplitEntry; MAX_SPLITS],
    pub bump: u8,
}
