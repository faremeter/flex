use anchor_lang::prelude::*;

#[constant]
pub const MAX_SPLITS: u8 = 5;
#[constant]
pub const MAX_PENDING_LIMIT: u16 = u16::MAX;
#[constant]
pub const MAX_MINTS: u8 = 8;
#[constant]
pub const REPLAY_SHARD_COUNT: u16 = 16;

#[constant]
pub const MIN_DEADMAN_TIMEOUT_SLOTS: u64 = 1_000;
#[constant]
pub const MAX_REFUND_TIMEOUT_SLOTS: u64 = 1_296_000;
#[constant]
pub const MAX_DEADMAN_TIMEOUT_SLOTS: u64 = 2_592_000;

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

    pub pending_count: u16,
    pub max_pending: u16,
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
pub struct ReplayShard {
    pub version: u8,
    pub session_key: Pubkey,
    pub shard_index: u16,
    pub root: [u8; 32],
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
    pub splits: [SplitEntry; MAX_SPLITS as usize],
    pub bump: u8,
}
