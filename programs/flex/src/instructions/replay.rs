use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use crate::error::FlexError;
use crate::state::REPLAY_SHARD_COUNT;

pub const REPLAY_TREE_DEPTH: usize = 64;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReplayProof {
    pub sibling_mask: u64,
    pub siblings: Vec<[u8; 32]>,
}

pub fn replay_shard_index(authorization_id: u64) -> u16 {
    (authorization_id % u64::from(REPLAY_SHARD_COUNT)) as u16
}

pub fn replay_default_root() -> [u8; 32] {
    let mut default_hash = replay_empty_hash();
    for _ in 0..REPLAY_TREE_DEPTH {
        default_hash = replay_node_hash(default_hash, default_hash);
    }
    default_hash
}

pub fn consume_replay_proof(
    root: [u8; 32],
    authorization_id: u64,
    proof: &ReplayProof,
) -> Result<[u8; 32]> {
    require!(
        proof.siblings.len() <= REPLAY_TREE_DEPTH,
        FlexError::InvalidReplayProof
    );

    let mut sibling_index = 0;
    let mut default_hash = replay_empty_hash();
    let mut empty_path = default_hash;
    let mut inserted_path = replay_leaf_hash(authorization_id);

    for level in 0..REPLAY_TREE_DEPTH {
        let sibling = if (proof.sibling_mask >> level) & 1 == 1 {
            let provided = proof
                .siblings
                .get(sibling_index)
                .ok_or(error!(FlexError::InvalidReplayProof))?;
            sibling_index += 1;
            *provided
        } else {
            default_hash
        };

        if (authorization_id >> level) & 1 == 1 {
            empty_path = replay_node_hash(sibling, empty_path);
            inserted_path = replay_node_hash(sibling, inserted_path);
        } else {
            empty_path = replay_node_hash(empty_path, sibling);
            inserted_path = replay_node_hash(inserted_path, sibling);
        }

        default_hash = replay_node_hash(default_hash, default_hash);
    }

    require!(
        sibling_index == proof.siblings.len(),
        FlexError::InvalidReplayProof
    );
    require!(empty_path == root, FlexError::AuthorizationReplay);

    Ok(inserted_path)
}

fn replay_leaf_hash(authorization_id: u64) -> [u8; 32] {
    hashv(&[
        b"flex:replay:leaf".as_ref(),
        &authorization_id.to_le_bytes(),
    ])
    .to_bytes()
}

fn replay_node_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    hashv(&[b"flex:replay:node".as_ref(), &left, &right]).to_bytes()
}

fn replay_empty_hash() -> [u8; 32] {
    hashv(&[b"flex:replay:empty".as_ref()]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_proof_consumes_first_authorization() {
        let proof = ReplayProof {
            sibling_mask: 0,
            siblings: Vec::new(),
        };

        let root = replay_default_root();
        let next_root = consume_replay_proof(root, 42, &proof).unwrap();

        assert_ne!(root, next_root);
    }

    #[test]
    fn empty_proof_cannot_replay_authorization() {
        let proof = ReplayProof {
            sibling_mask: 0,
            siblings: Vec::new(),
        };

        let root = replay_default_root();
        let next_root = consume_replay_proof(root, 42, &proof).unwrap();
        let replay = consume_replay_proof(next_root, 42, &proof);

        assert!(replay.is_err());
    }

    #[test]
    fn proof_can_insert_adjacent_authorization_out_of_order() {
        let empty_proof = ReplayProof {
            sibling_mask: 0,
            siblings: Vec::new(),
        };

        let root = replay_default_root();
        let root_after_42 = consume_replay_proof(root, 42, &empty_proof).unwrap();

        let proof_for_43 = ReplayProof {
            sibling_mask: 1,
            siblings: vec![replay_leaf_hash(42)],
        };
        let root_after_43 = consume_replay_proof(root_after_42, 43, &proof_for_43).unwrap();

        assert_ne!(root_after_42, root_after_43);
    }
}
