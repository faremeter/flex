use anchor_lang::prelude::*;

use crate::error::FlexError;
use crate::instructions::replay::replay_default_root;
use crate::state::{EscrowAccount, ReplayShard, SessionKey, REPLAY_SHARD_COUNT};

#[derive(Accounts)]
#[instruction(shard_index: u16)]
pub struct InitializeReplayShard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        has_one = escrow,
        seeds = [b"session", escrow.key().as_ref(), session_key.key.as_ref()],
        bump = session_key.bump,
    )]
    pub session_key: Account<'info, SessionKey>,

    #[account(
        init,
        payer = payer,
        space = 8 + ReplayShard::INIT_SPACE,
        seeds = [b"replay", session_key.key().as_ref(), &shard_index.to_le_bytes()],
        bump,
    )]
    pub replay_shard: Account<'info, ReplayShard>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_replay_shard(
    ctx: Context<InitializeReplayShard>,
    shard_index: u16,
) -> Result<()> {
    require!(
        shard_index < REPLAY_SHARD_COUNT,
        FlexError::InvalidReplayShard
    );

    let replay_shard = &mut ctx.accounts.replay_shard;
    replay_shard.version = 1;
    replay_shard.session_key = ctx.accounts.session_key.key();
    replay_shard.shard_index = shard_index;
    replay_shard.root = replay_default_root();
    replay_shard.bump = ctx.bumps.replay_shard;

    Ok(())
}
