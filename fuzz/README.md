# Fuzz Testing

Fuzz targets for the Flex escrow program using cargo-fuzz and libfuzzer.

## Prerequisites

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

The program must be built before fuzzing (the stateful target embeds the compiled `.so`):

```bash
anchor build
```

## Targets

### ed25519_parser

Fuzzes the Ed25519 instruction data parser (`validate_ed25519_ix_data`) with random byte arrays, pubkeys, and messages. This function manually parses untrusted byte data with offset arithmetic.

```bash
cd fuzz
cargo +nightly fuzz run ed25519_parser -- -max_total_time=300
```

### split_arithmetic

Fuzzes the split amount calculation (`compute_split_amounts`) with random total amounts and bps distributions. Checks that split amounts sum to exactly the total (no dust lost), no individual amount exceeds the total, and the function never panics.

```bash
cd fuzz
cargo +nightly fuzz run split_arithmetic -- -max_total_time=300
```

### stateful_sequence

Generates random sequences of all 12 program instructions across two mints and multiple session keys, executing them against LiteSVM. Exercises deposit, submit authorization (single and multi-split), refund, finalize, void pending, session key registration/revocation/closure, close escrow, emergency close, force close, and slot advancement.

After each instruction, checks six state invariants:

1. **Vault solvency** (per-mint): vault token balance >= sum of pending settlement amounts
2. **Value conservation** (per-mint): total deposited == vault balance + total finalized out
3. **Pending count consistency**: on-chain `pending_count` matches shadow model
4. **Session key count consistency**: on-chain `session_key_count` matches shadow model
5. **Last activity slot consistency**: on-chain `last_activity_slot` matches shadow model
6. **Per-pending amount consistency**: each on-chain `PendingSettlement.amount` matches shadow

On successful operations, checks ten security properties:

1. Finalize only succeeds after the refund window expires
2. Refund only succeeds within the refund window
3. Refund never increases a pending settlement's amount
4. Finalize distributes exactly the pending amount from the vault
5. Emergency close only succeeds after the deadman timeout with no pending
6. Force close only succeeds after 2x the deadman timeout
7. Void pending only succeeds after the deadman timeout
8. After any close, vault PDAs are destroyed (funds go home)
9. Escrow configuration (owner, facilitator, timeouts) is immutable after creation
10. Submitted_at_slots and pending state are cleaned up consistently

```bash
cd fuzz
cargo +nightly fuzz run stateful_sequence \
  --no-default-features --features stateful \
  -- -max_total_time=300 -max_len=8192
```

The stateful target uses v3 solana crates to match litesvm 0.11.0 and defines its own borsh-serializable mirror structs for instruction data. It loads the program as a compiled `.so` and does not depend on the `flex` crate, avoiding the Anchor v2/v3 type conflict.

## Useful flags

- `-max_total_time=N` -- run for N seconds
- `-max_len=N` -- limit input size in bytes
- `-jobs=N` -- run N parallel fuzzing jobs
- `-fork=N` -- fork N parallel processes (useful for the stateful target)

## Artifacts

Crash inputs are saved to `fuzz/artifacts/<target>/` and can be replayed:

```bash
cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<crash_file>
```

Corpus inputs are saved to `fuzz/corpus/<target>/` and persist across runs.
