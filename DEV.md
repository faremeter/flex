# Developer Notes

## Tools Required

- bun (v1.2 or newer)
- Rust (stable, via rustup)
- Anchor (v0.31 or newer)
- Solana CLI
- GNU make

## Setting Up Your Environment

0. Configure your git hooks:

```
git config core.hooksPath .githooks
```

1. Install TypeScript dependencies:

```
bun install
```

2. Build everything:

```
make
```

## Building

Build all packages (TypeScript and Anchor):

```
make build
```

Build TypeScript only:

```
make build-ts
```

Build Anchor program only:

```
make build-anchor
```

Build a specific TypeScript package:

```
make packages/<package-name>
```

## Linting

Run all lint checks:

```
make lint
```

TypeScript only:

```
make lint-ts
```

Rust only:

```
make lint-anchor
```

## Formatting

Auto-format all files:

```
make format
```

## Testing

Run all tests:

```
make test
```

TypeScript tests only:

```
make test-ts
```

Anchor tests only:

```
make test-anchor
```

## Clean

Remove build artifacts:

```
make clean
```

## Squads proposal lifecycle and time lock

- Squads v4 does NOT expire un-executed proposals. A fully approved proposal
  stays executable indefinitely unless cancelled. Multisig config changes
  invalidate un-approved proposals only; see "Vault-stale quirk" below.
- **Duplicate-proposal guard.** The guard in `bin/program-deploy`,
  `bin/program-rollback`, `bin/program-verify`, `bin/program-close`,
  and `bin/program-initial-deploy` aborts hard if any open vault
  proposal already targets the program upgrade authority. There is no
  override flag. Operators resolve the existing proposal (execute or
  cancel) via the Squads UI before retrying.
- **Vault-stale quirk.** Changing multisig membership or threshold invalidates
  only un-approved proposals. An already-approved vault proposal remains
  executable across config changes — `vault_transaction_execute` has no
  staleness check. The duplicate-proposal guard catches this as a backstop:
  it walks the full lifetime range and flags any stale-Approved proposal
  targeting the program. Operator hygiene is still to `proposal_cancel`
  before retiring members with in-flight upgrade approvals — surfacing the
  issue at decommission is cheaper than surfacing it at the next release.
- **Time lock semantics.** Per-multisig, expressed in seconds; gates the
  Approved → Executable transition. Mainnet default: 86400 (24h). Devnet
  default: 0. Maximum: 7,776,000 (90 days).

## Casting votes and executing proposals from the CLI

`bin/program-squads-approve` and `bin/program-squads-execute` are
thin operator-CLI wrappers around the `@sqds/multisig`
`proposalApprove` and `vaultTransactionExecute` SDK calls. They are
the terminal equivalents of "Approve" and "Execute" in the Squads
web UI — useful when an operator prefers the terminal, when a
deployment pipeline scripts approval explicitly, or when the Squads
UI is unavailable.

```
bin/program-squads-approve <cluster> <multisig> <tx-index>
bin/program-squads-execute <cluster> <multisig> <tx-index>
```

Both read `OPERATOR_PAYER_KEYPAIR` from the environment and accept
an optional `--rpc-url <url>` to override the cluster's default RPC
endpoint. Both emit a single JSON line on stdout describing the
transaction signature so the calling pipeline can capture and log it.

The operator-facing release flow (`bin/program-deploy`,
`bin/program-rollback`, `bin/program-verify`) deliberately stops
after submitting the proposal and prompts the operator to approve
and execute out-of-band. That prompt can be satisfied by:

1. **The Squads web UI** — the default for human-driven releases on
   mainnet. Each member opens the UI, casts a vote, then any member
   clicks Execute once the threshold and time lock allow.
2. **These bin scripts** — each member runs
   `bin/program-squads-approve <cluster> <multisig> <tx-index>` to
   record their vote, then any member (or a fee-paying automation
   keypair) runs `bin/program-squads-execute <cluster> <multisig>
<tx-index>`.

The two paths are interchangeable for any individual proposal; one
member can vote via the UI while another votes via the CLI. Once the
threshold count of approvals is reached (across any combination of
sources) and the time lock has elapsed, the proposal is executable
by any signer.

`bin/program-squads-execute` always sends the execute transaction
as a versioned-v0 message because the SDK may return
address-lookup-table accounts that the Squads program references at
execute time; legacy transactions cannot carry ALT references.

Membership is enforced on-chain by the Squads program. The bin
scripts do not pre-check the supplied keypair against the multisig's
member list; passing a non-member keypair to
`bin/program-squads-approve` produces a clear SDK error from the
on-chain rejection.

### Cancelling a stuck proposal

`bin/program-squads-cancel <cluster> <multisig> <tx-index>` casts a
Cancel vote on a vault proposal as `$OPERATOR_PAYER_KEYPAIR`. Squads
v4 counts Cancel votes against the same threshold as Approve votes:
once a threshold of members has voted Cancel, the proposal
transitions to the Cancelled state and is no longer executable.

The duplicate-proposal guard in `bin/program-deploy`,
`bin/program-rollback`, `bin/program-verify`, `bin/program-close`,
and `bin/program-initial-deploy` treats Draft / Active / Approved
proposals targeting the program as blocking — there is no override
flag. Cancelling a stuck proposal is how the operator clears that
guard. Use it when:

- A proposal was approved before a multisig config change
  (membership rotation, threshold change) staled it, and Squads v4's
  "vault-stale quirk" keeps it executable — leaving the
  duplicate-proposal guard to flag it at the next release attempt
  against this program. Cancel clears that flag.
- The team decided to abandon a proposed upgrade (e.g. composed
  against a stale `.so` or with the wrong tag) before a quorum
  signed off, but at least one approval has already been recorded.
- A devnet rehearsal needs to retire stranded proposals between
  iterations.

Cancel takes the same `--rpc-url <url>` override as approve and
execute, and emits a single JSON line with the transaction signature
on stdout.

## Provisioning the Squads multisigs

`scripts/src/squads.config.ts` ships with placeholder values for
`multisig`, `members`, `threshold`, `vaultIndex`, `verifyMode`, and
`timeLock` on both clusters. The placeholders satisfy
`assertValidConfig` at module load (so `tsc` and `make test-unit` pass
out of the box), but every value must be replaced with real,
operator-supplied configuration before invoking `bin/bootstrap-squads`
or any downstream release script.

The provisioning sequence per cluster is:

1. Replace the `members` array with the real signing keys for that
   cluster and set `threshold` to the agreed M-of-N. Set `vaultIndex`
   to `0` unless multiple vaults are intentional. Set `verifyMode` and
   `timeLock` per cluster policy (the defaults in this file are
   reasonable starting points: devnet `batched`/`0`, mainnet
   `separate`/`86400`).
2. Leave `multisig` as the placeholder for the first run — the value
   is unknown until the multisig exists. Run
   `bin/bootstrap-squads <cluster>`; the script prints
   `MULTISIG_ADDRESS=…` once the on-chain create lands.
3. Replace the cluster's `multisig` field with the printed address and
   commit the change. Downstream scripts (`bin/program-deploy`,
   `bin/program-rollback`, `bin/program-verify`) read this value as
   the upgrade authority.

`bin/bootstrap-squads` re-validates `timeLock` against `MAX_TIME_LOCK`
at runtime, so a value the schema would accept but the Squads program
rejects (e.g., a `timeLock` exceeding 90 days set after the file was
last imported) fails before the create transaction is signed.

## Initial program deploy: the four-phase procedure

The first deploy of the Flex program to a new cluster (devnet rehearsal,
then mainnet) is run as `bin/program-initial-deploy <cluster>`. The
script enforces a four-phase split between deploying the program,
handing upgrade authority to Squads, proving the new authority chain
works, and destroying the program keypair secret. Behaviour is
identical between devnet and mainnet; only the configured Squads
multisig address and vault index differ.

### Why one-step `--upgrade-authority <vault-pda>` is forbidden

`solana program deploy --upgrade-authority <vault-pda>` would assign
upgrade authority to the Squads vault PDA in the same transaction that
creates the program. This is permanently rejected by the script. A
mis-derived vault PDA (wrong multisig address, wrong vault index,
typo in a copy-pasted value, or stale data from an aborted
`bootstrap-squads` run) becomes the new authority instantly and
irrecoverably: no one can sign as the bogus PDA, and the program is
bricked. Splitting the procedure into a deploy-then-handoff sequence
gives the operator a recovery window in which the upgrade authority is
the operator's own payer; the handoff is gated by a strong
confirmation prompt that requires the operator to retype the vault PDA
before the `set-upgrade-authority` invocation runs.

### Phase 1 — Deploy with operator authority

The script invokes `solana program deploy` with the operator's payer
keypair (`OPERATOR_PAYER_KEYPAIR` environment variable) as both the
fee payer and the implicit upgrade authority. It then fetches the
deployed program bytes via the cluster RPC, sha256s them, and asserts
equality with the local `target/deploy/flex.so`. A mismatch aborts.

### Phase 2 — Hand-off to the Squads vault PDA

The vault PDA is re-derived locally from
`scripts/src/squads.config.ts` (multisig + vault index) via the
`getVaultPda` helper in `scripts/src/squads.ts` — not trusted from
any pasted value.
The script prints the derived PDA on a dedicated line and pauses for
a confirmation prompt that requires the operator to retype the PDA
exactly. Only on a match does the script invoke
`solana program set-upgrade-authority --new-upgrade-authority <pda>`.
After the invocation the script reads `ProgramData` from the cluster
and asserts that the on-chain `upgrade_authority` equals the derived
PDA; mismatch aborts.

### Phase 3 — Squads liveness test

The script writes an upgrade buffer with the same `.so` bytes via
`solana program write-buffer`, transfers buffer authority to the vault
PDA, composes a one-instruction upgrade proposal via the
`buildUpgradeIx` helper in `scripts/src/bpf-loader-ix.ts` and the
`createUpgradeProposal` helper in `scripts/src/squads.ts`, and submits
the proposal-creation transaction signed by the operator payer.

The proposal PDA, transaction PDA, buffer address, and Squads UI URL
are printed. The operator (with a quorum of co-signers) approves and
executes the proposal manually in the Squads UI. The script does not
poll Squads for approval state — that is a `bin/program-deploy`
responsibility. After the operator confirms execution, the script
polls the deployed program data sha until it matches the local `.so`
sha. Timeout aborts with the proposal PDA captured so the operator
can investigate.

A successful Phase 3 proves that:

- The Squads vault PDA holds upgrade authority.
- A multisig quorum can sign and execute an upgrade end-to-end.
- The on-chain bytes after a Squads-mediated upgrade match the
  locally built `.so`.

### Phase 4 — Witnessed key destruction (logged, not executed)

After Phase 3 succeeds, the script logs the witnessed key-destruction
procedure to stderr and prompts the operator to confirm they have
read it. The script does NOT destroy the keypair file; the lifecycle
of `target/deploy/flex-keypair.json` (relocation between Phases 1–3,
destruction after Phase 3) is the operator's responsibility.

The procedure is:

1. Identify the keypair file at `target/deploy/flex-keypair.json` (or
   wherever the operator relocated it). Confirm the file is the
   active program keypair, not an unrelated wallet file.

2. Conduct the destruction with a second team member present as
   witness.

3. Cryptographically wipe the file. Choose the command matching the
   host operating system:

   ```
   # Linux
   shred -uvz target/deploy/flex-keypair.json

   # macOS
   rm -P target/deploy/flex-keypair.json
   ```

4. Verify the file no longer exists:

   ```
   test ! -e target/deploy/flex-keypair.json && echo "destroyed"
   ```

5. Record in the operational runbook the date and time (UTC), the
   witness's name, the destruction method (`shred` or `rm -P`), the
   program ID, and the cluster of the initial deploy.

The committed pubkey under `keypairs/flex-program.pub` and the
`declare_id!` in `programs/flex/src/lib.rs` continue to reference the
destroyed keypair's public half; only the secret half is destroyed.
After Phase 4, Squads is the sole holder of upgrade authority, and
program-ID retirement becomes permanent — the program identity can
no longer be re-created from the original secret.

## Standard release procedure

> **Devnet is the proving ground.** Custody, procedure, and key shape
> on devnet match mainnet — no shortcuts. The operator-payer keypair,
> the three multisig members, the time-lock value, the verify mode,
> and the GPG signing key are all expected to be the same kind of
> long-lived, real-custody artifact on devnet as they are on mainnet.
> Throwaway airdrop-funded file keypairs are explicitly the wrong
> custody shape for devnet rehearsal: a rehearsal that skips the
> custody step does not actually rehearse the release.

After the initial deploy has succeeded and the Squads vault PDA holds
upgrade authority for both clusters, every subsequent release runs
through `bin/program-deploy <cluster>`. The script is the single entry
point; do not invoke `solana program upgrade`, `solana-verify`, or any
of the helper subcommands directly during a release.

### Invocation

```
OPERATOR_PAYER_KEYPAIR=/path/to/payer.json \
MAINNET_RPC_URL=https://my-paid-rpc.example.com/... \
FLEX_RELEASE_GPG_KEY=<key-id-or-fingerprint> \
bin/program-deploy mainnet
```

`FLEX_RELEASE_GPG_KEY` is required: `signArtifact` refuses to fall
back to gpg's default identity, because falling back would silently
sign release artifacts with whatever key the operator's gpg keyring
elects, producing an artifact whose signer is ambient rather than
committed. Use the key fingerprint or any unambiguous user-id that
`gpg --local-user` accepts. If the key is not available the
`publish-release` step (step 15) aborts before any artifact is
attached to the GitHub Release.

Available flags:

- `--verify-mode=batched|separate` — overrides the per-cluster default
  from `scripts/src/squads.config.ts`. Read the next subsection before
  changing this.
- `--payer <signer>` — any Solana signer URL (filesystem path,
  `usb://ledger?key=…`, or env-sourced). Defaults to
  `$OPERATOR_PAYER_KEYPAIR`.
- `--priority-fee <microlamports>` — overrides the sampled fee.
- `--rpc-url <url>` — overrides the per-cluster default.
- `--allow-downgrade` — skips the monotonic-version guard. Reserved
  for `bin/program-rollback`; do not pass it from `bin/program-deploy`
  in normal operation.
- `--tag <tag>` — release tag for the GitHub Release artifact set;
  defaults to the latest annotated git tag in the working tree.

### Phase-by-phase walkthrough

The script runs sixteen ordered phases, marked in
`scripts/src/deploy.ts` by `// ---- Step <N>: <name> ----` block
comments (Step 10 through Step 160 in increments of 10). The
operator-visible lifecycle is:

1. **Flag parsing and config resolution** — prints the cluster, RPC
   URL, program ID, multisig, vault PDA, verify mode, time-lock, and
   downgrade flag. State file path is announced (see below).
2. **Prerequisite check** — `solana`, `solana-verify`, `gpg`, and
   either `gh` or `GITHUB_TOKEN` must be available.
3. **Build** — `solana-verify build` produces
   `target/deploy/flex.so`.
4. **Local sha256** — recorded in the state file.
5. **Compare-to-deployed** — if the deployed program already matches
   the local `.so`, the script exits cleanly with no proposal
   creation.
6. **Duplicate-proposal guard** — hard abort if any vault proposal
   targeting the program is open (Draft / Active / Approved). There
   is no override flag; resolve the existing proposal in the Squads
   UI before retrying.
7. **Monotonic-version guard** — reads the deployed `FLEX_VERSION`
   string and asserts the local `Cargo.toml` version is strictly
   greater. Skipped only when `--allow-downgrade` is supplied.
8. **Priority-fee sampling** — `getRecentPrioritizationFees` is
   queried against the program, multisig, and vault PDA; the script
   uses the p75 of returned fees. Override with `--priority-fee`.
9. **Write buffer** — `solana program write-buffer` with the
   operator payer as the buffer authority. The buffer address is
   parsed from stdout.
10. **Transfer buffer authority** — `solana program
set-buffer-authority` reassigns the buffer to the Squads vault
    PDA.
11. **Assert buffer authority** — the script re-reads the buffer
    account and verifies the authority field equals the vault PDA.
12. **Size guard** — in batched mode, projects the execute-tx wire
    size and aborts if it exceeds 1100 bytes. See the next
    subsection.
13. **Compose proposal** — builds the upgrade (and, in batched mode,
    verify-init) instructions, wraps them via
    `createUpgradeProposal`, and prints the proposal PDA,
    transaction PDA, Squads UI URL, and the earliest legal execute
    time (now + multisig `timeLock`). The script then **pauses**:
    the operator must submit the proposal-creation transaction
    (signed by the proposer) and approve + execute the proposal in
    the Squads UI before typing `submitted` at the prompt.
14. **Polling** — after the operator confirms, the script polls the
    on-chain program data sha until it matches the local `.so` sha.
    The Squads tx signature is **not** a success signal; the
    post-execution sha match is. Backoff is exponential with full
    jitter, capped at 60 s, with a 30-minute overall deadline.
15. **Publish release** — GitHub Release is created with the `.so`,
    IDL JSON, sha256 file, state file, and release metadata, each
    accompanied by a detached GPG signature.
16. **OtterSec submission** — batched mode only. Separate mode
    leaves verify-init to `bin/program-verify <cluster>`.

### When to use `--verify-mode=separate`

The Solana hard transaction size limit is 1232 bytes. The Squads
execute wrapper adds signature and account-meta overhead beyond the
inner instructions, so `bin/program-deploy` enforces an 1100-byte
guard on the projected execute-tx size (132 bytes of headroom).

In batched mode the proposal carries three instructions: `upgrade`,
`close_buffer`, and `verify-init`. When `verify-init`'s account list
pushes the projected size over 1100 bytes, the script aborts with:

```
Projected execute-tx size: <N> bytes (limit: 1100). Re-run with --verify-mode=separate.
```

There is no silent fallback. The operator re-runs `bin/program-deploy
<cluster> --verify-mode=separate`. In separate mode the first
proposal carries only `upgrade` + `close_buffer`; after the
post-execution sha match, the OtterSec submission and the second
proposal carrying `verify-init` are handled by
`bin/program-verify <cluster>`.

### Priority-fee tuning

The default sampler queries `getRecentPrioritizationFees` against the
program, multisig, and vault PDA (the accounts the upgrade tx
write-locks) and uses the 75th percentile of returned fees. p50 is
too low under congestion (the upgrade lands intermittently); p99
over-pays without improving landing time.

Override manually via `--priority-fee <microlamports>` when:

- Recent fee samples are stale (the cluster has just resumed after an
  outage and the cache has not yet warmed up).
- The operator wants to land the buffer write deterministically
  during a known congestion event.

Symptoms that suggest raising the fee on retry: `write-buffer`
visibly dropping transactions in its log, or the Squads execute
transaction landing only after multiple submissions in the Squads
UI.

### RPC provider expectations

`scripts/src/cluster.config.ts` supplies the default URL per cluster.
`--rpc-url <url>` overrides per invocation.

- **Mainnet** requires a paid RPC provider with QUIC support. The
  `write-buffer` phase submits 250+ transactions and silently drops
  under congestion against the public RPC; running `bin/program-deploy
mainnet` against `api.mainnet-beta.solana.com` is not supported.
  Set `MAINNET_RPC_URL` in the environment, or pass `--rpc-url`.
- **Devnet** accepts the public RPC at `api.devnet.solana.com`. Paid
  providers still help under congestion but are not required.

### Partial-execution recovery

Every state transition is written to
`target/program-deploy/<cluster>-<timestamp>.state.json`. This file
is the forensic evidence the operator inspects when recovery is
necessary. Do not delete state files until the corresponding GitHub
Release has been verified end-to-end.

Failure modes and the matching recovery procedure:

#### Proposal stuck pre-execution

Symptom: the script exited at step 13 (`compose_proposal`) and a
proposal is sitting in the Squads UI awaiting approvals, or the
operator typed something other than `submitted` at the prompt.

Recovery:

1. Inspect `proposal_pda` and `squads_url` from the state file.
2. In the Squads UI, either gather the remaining approvals and
   execute, or cancel the proposal.
3. If executed: re-run `bin/program-deploy <cluster>` from scratch;
   the deploy gate at step 5 will detect that the program already
   matches the local `.so` and exit cleanly, the post-execution
   verify-init / OtterSec submission can be completed via
   `bin/program-verify`, and the GitHub Release can be published by
   re-running with `--tag <tag>` (the publish-release step is
   idempotent on the GitHub side if the assets are unchanged; if it
   reports an existing release, attach the missing artefacts
   manually via `gh release upload`).
4. If cancelled: re-run `bin/program-deploy <cluster>` cleanly.
   The duplicate-proposal guard at step 6 will block until the
   cancellation is fully on-chain.

#### Upgrade landed but verify-init failed in batched mode

Symptom: post-execution sha matched (step 14 succeeded) but the
OtterSec submission at step 16 returned an error, leaving the
program upgraded without an associated verify record.

Recovery:

1. Inspect `execution_slot` and the state file to confirm the
   upgrade actually landed.
2. Run `bin/program-verify <cluster>`. It re-runs the OtterSec
   submission against the same program ID and vault PDA.
3. If OtterSec submission keeps failing, contact OtterSec; the
   on-chain upgrade is unaffected.

#### Buffer write incomplete

Symptom: step 9 (`write-buffer`) aborted partway through. The
`solana program write-buffer` output may report a buffer address but
the buffer is not fully written.

Recovery:

1. Identify the partially-written buffer via the state file
   (`buffer_address`, if recorded) or `solana program show
--buffers --buffer-authority <operator-pubkey>`.
2. Reclaim the buffer rent: `solana program close <buffer-address>
--recipient <operator-pubkey>`.
3. Re-run `bin/program-deploy <cluster>`. Steps 1–8 will replay
   safely; step 9 will create a fresh buffer.

#### Vault-authority buffer left after an abandoned upgrade

Symptom: `bin/program-deploy` ran past step 11 (`transfer buffer
authority` → vault PDA) but the upgrade proposal was never executed
— it was cancelled, abandoned, or composed with the wrong bytes and
manually retired. The buffer remains on-chain, owned by the
upgradeable loader, with the vault PDA as its authority. The
operator's `solana program close` cannot reclaim it because the
operator is no longer the buffer authority.

Recovery:

1. Identify the orphaned buffer via the state file
   (`buffer_address`) or `solana program show --buffers
--buffer-authority <vault-pda>`.
2. Run `bin/program-close-buffer <cluster> <buffer-pubkey>`. The
   script composes a Squads vault proposal carrying a single
   `bpf_loader_upgradeable::Close` instruction (the 3-account
   buffer-close form) against the named buffer, with the vault PDA
   as both authority and rent recipient. The default recipient is
   the vault rather than an operator wallet so the reclaimed rent
   stays under multisig custody — drain it back to the payer (or any
   treasury) afterward via `bin/program-vault-drain`.
3. Approve and execute the proposal in the Squads UI or via
   `bin/program-squads-approve` + `bin/program-squads-execute`.

Pass `--recipient <pubkey>` if the rent should land somewhere other
than the vault (rare; the default is correct for most cleanups).
This is the only sanctioned path for closing a vault-authority
buffer — there is no operator-direct equivalent of `solana program
close` against a buffer the operator does not own.

#### Post-execution sha mismatch

Symptom: step 14 timed out without the deployed sha matching the
local `.so` sha. The proposal may have executed but the deployed
bytes differ from what was built locally.

Recovery:

1. Inspect the state file's `proposal_pda` and `local_sha`.
2. Re-read the deployed sha against the program ID via
   `bun scripts/src/deploy.ts compare-deployed <cluster>
<program-id> <expected-sha>`. If the comparison shows a different
   sha than the locally built one, the proposal upgraded the program
   to bytes other than what was built — this is the most serious
   recovery scenario.
3. Verify the local build is deterministic by re-running
   `solana-verify build` and recomputing the sha. If the
   reproducible-build sha differs, an external input changed (Rust
   toolchain, dependency lock, etc.); reproduce the original build
   from the tagged commit.
4. If the deployed bytes are objectively wrong (a third party
   approved a stale buffer), the correct response is a rollback
   proposal via `bin/program-rollback <cluster>` and a security
   review of the multisig membership.

## Rollback procedure

`bin/program-rollback <cluster> <tag> --yes-i-want-to-downgrade`
reverts the deployed Flex program to the `.so` published by a prior
GitHub Release. Rollback is the exception, not the norm; the
default response to a broken release is a forward-fix.

### Rollback vs. forward-fix

Prefer a forward-fix whenever the bug is correctable with code
changes:

1. Author the fix on `main`.
2. `bin/release patch` (or `minor`/`major` as appropriate) cuts a
   new tag whose version is higher than the broken one.
3. `bin/program-deploy <cluster>` deploys the new tag. The
   monotonic-version guard accepts the upgrade because the new
   `FLEX_VERSION` is strictly greater than the on-chain value.

A forward-fix preserves a clean, monotonic on-chain version history
and is the auditable, recoverable path for almost every defect.

`bin/program-rollback` is reserved for situations a forward-fix
cannot address quickly enough:

- A live incident where the current release is actively unsafe and
  there is no fix ready to ship in the time available.
- A regression discovered only after deploy that requires reverting
  to the last-known-good `.so` while the underlying issue is
  investigated.
- Recovery scenarios documented under "Post-execution sha mismatch"
  above, where the deployed bytes do not match what was built and
  the prior release's published `.so` is the trusted reference.

If a forward-fix is feasible within the incident's time budget,
take it. Rollback is intentionally inconvenient.

### `--allow-downgrade` is single-sourced through this script

`bin/program-deploy` exposes an `--allow-downgrade` flag that
skips the monotonic-version guard. That flag is **not** part of the
normal release flow and is undocumented in `bin/program-deploy`'s
help text as a normal-flow option. `bin/program-rollback` is the
only sanctioned caller; do not invoke `bin/program-deploy
--allow-downgrade` directly.

Single-sourcing keeps every downgrade routed through the same
gauntlet of banner, operator confirmation, artifact fetch, and
sha-verification controls. A downgrade that bypasses this script
bypasses those controls.

### What the version-guard skip means for audit trails

The on-chain `FLEX_VERSION` is embedded in the program by
`programs/flex/Cargo.toml` at build time. When a rollback lands,
that value moves **backward**: the version reported by the program
account becomes the version associated with the rollback tag,
which is older than the version that was previously deployed.

Consequences:

- A naive reader of the on-chain version cannot reconstruct
  history. The rollback tag's version equals some earlier release's
  version; the fact that the program was once at a higher version
  is not visible from program data alone.
- Reconstructing the full deploy history requires cross-referencing
  the GitHub Release timeline (tag creation order) with the rollback
  tag's `state.json` artifact (which captures the rollback's
  execution slot) and the prior forward tag's `state.json`.
- Always preserve the rollback's state file alongside the prior
  forward tag's state file in the incident record. Together they
  document "what version was on-chain before, what version is on-chain
  now, and when the transition happened."

### Operator-confirmation flow

The script will refuse to fetch the `.so`, refuse to invoke
`bin/program-deploy`, and refuse to make any network call without
the explicit `--yes-i-want-to-downgrade` flag. The flag is
intentionally verbose; muscle memory and abbreviated aliases should
not be able to trigger a downgrade.

Once confirmed, the script:

1. Prints a prominent downgrade banner naming the cluster, the
   rollback tag, and the fact that the monotonic-version guard is
   being skipped.
2. Fetches `flex.so` and `flex.so.sha256` from the named GitHub
   Release via `scripts/src/rollback-fetch.ts` (which delegates the
   network calls to `fetchArtifact` from
   `scripts/src/github-release.ts`).
3. Computes the sha256 of the downloaded bytes and compares it to
   the published value in `flex.so.sha256`. A mismatch is a hard
   abort with both shas reported in the error; there is no retry
   path and no override flag.
4. Re-prints the downgrade banner immediately before invoking
   `bin/program-deploy <cluster> --allow-downgrade --so-path
<verified-path> --tag <tag>`.
5. Logs the downgrade prominently at every step via
   `logger.warning` (the `@faremeter/logs` warning channel), so the
   operator's terminal scrollback unambiguously records that a
   downgrade — not a normal release — was performed.

### Replaying from a local artifact with --so-path

`--so-path <path>` substitutes step (2) above with a local file the
operator has already staged. The script still computes the sha256 of
the supplied bytes and logs it as part of the audit trail, but no
cross-check against a published `flex.so.sha256` is possible — the
operator is asserting these are the right bytes (a stronger version
of the `--yes-i-want-to-downgrade` gate).

This path is intended for:

- Replays from a mirror or operator backup when the GitHub Release
  has been deleted, made private, or is otherwise unreachable.
- Rollbacks against releases that predate the `publish-release`
  step in `bin/program-deploy` (no `flex.so.sha256` was ever
  published).
- Devnet dress rehearsals where no GitHub Release was published
  because the rehearsal program ID is throwaway.

Mainnet rollbacks for live incidents should still take the default
fetch path so the published sha256 cross-check runs. Reach for
`--so-path` only when fetching is not an option.

## Verifying a release with bin/program-verify

`bin/program-verify <cluster> --commit <rev>` is the operator-facing
entry point for the OtterSec verification step of a Flex program
release. It composes and submits a standalone Squads proposal carrying
only the `otter_verify::Initialize` instruction (signed by the
operator payer just like the upgrade proposal in `bin/program-deploy`),
polls for the resulting `otter_verify` PDA once the multisig members
approve and execute it, and then POSTs the verification job to
`verify.osec.io`. The script is intentionally separate from
`bin/program-deploy` so the verify step can be re-run independently
when it fails for transient reasons.

`--commit <rev>` is required and accepts any git revision (tag, full
sha, branch). The resolved commit hash is what OtterSec pins the
verification record to; an unpinned record (the original default of
empty-string) would drift as the branch advances, so the flag refuses
to default. For the standard release path, pass the tag that
`bin/program-deploy` published: `bin/program-verify mainnet --commit
v0.3.0`.

### When to run bin/program-verify directly

Three operator scenarios call for this script:

1. **Separate-mode follow-up.** `bin/program-deploy --verify-mode=separate`
   intentionally leaves the OtterSec submission for a later step so
   the upgrade proposal stays under the 1232-byte transaction-size
   limit. Once that upgrade proposal executes, run
   `bin/program-verify <cluster>` to land the standalone verify-init
   proposal and submit the job.
2. **Retry after a failed OtterSec submit.** If the HTTP call to
   `verify.osec.io/verify-with-signer` errored (network glitch,
   5xx, rate limit) after the verify-init proposal already
   executed, re-run `bin/program-verify <cluster>`. The script
   detects the existing `otter_verify` PDA, skips proposal
   composition, and re-issues the HTTP submit.
3. **Manually re-queueing verification.** If the verify-init
   proposal executed but the OtterSec worker never picked up the
   job (worker outage, queue backlog), re-run
   `bin/program-verify <cluster>` to re-issue the HTTP submit
   against the already-written PDA. No new proposal is composed.

### Program-state preconditions

The script does not touch program bytes or upgrade authority. It
relies on these preconditions being already satisfied:

- The deployed program at `programs/flex` has been upgraded to the
  release the operator intends to verify (run `bin/program-deploy`
  first, separately).
- The on-chain sha256 of the deployed program matches the local
  build, exactly as `bin/program-deploy` would compute it. The
  OtterSec worker fetches the deployed bytes itself; any drift
  between deployed and source will surface as a worker mismatch
  rather than a script failure.
- The Squads multisig and vault PDA derived from
  `scripts/src/squads.config.ts` for `<cluster>` are the upgrade
  authority of the program and the configured uploader for the
  `otter_verify` PDA. The PDA seeds are
  `["otter_verify", vault-pda, program-id]`; any other uploader
  produces a different PDA and the script's idempotency check
  will not detect it.

### Idempotency on re-runs

`bin/program-verify` reads the on-chain `otter_verify` PDA at
startup. If the PDA already exists for the vault uploader and
program id, the script:

- skips the duplicate-proposal guard,
- skips proposal composition entirely,
- jumps directly to the OtterSec HTTP submit.

If the PDA does not exist, the script first runs the
duplicate-proposal guard (rejecting if any open vault proposal
targets the program — that proposal must be resolved through the
Squads UI before retry), then composes a single-instruction
verify-init proposal, polls for execution, and finally submits the
OtterSec job.

## Retiring a program: bin/program-close

`bin/program-close <cluster> --i-want-to-close-this-program` composes
a Squads vault proposal that invokes
`bpf_loader_upgradeable::Close` against the Flex program's
program-data account. On execution the lamports backing program-data
are reclaimed to the multisig vault and the program becomes
**permanently uninvokable** — the program ID cannot be re-deployed
because the program-data PDA was consumed by the original deploy and
the loader refuses a fresh deploy under the same ID.

This is the terminal retirement primitive. The default release flow
never calls it. Reach for it only when:

- A devnet rehearsal program ID is being torn down at the end of the
  rehearsal (returns the rent so the next rehearsal starts with full
  payer balance).
- An old program ID is being sunset after migrating users to a new
  ID, and the operator deliberately wants to prevent any future
  invocation under the old ID.
- A security response requires permanent shutdown of a specific
  program ID — for example, the deployed bytes are known
  compromised, a forward-fix is not viable, and the rollback path is
  unsafe because no prior known-good `.so` exists for that ID.

The flow mirrors `bin/program-deploy`'s shape: hard preflight,
duplicate-proposal guard, proposal composition + submission,
operator confirmation that approve + execute has happened
(via the Squads UI or `bin/program-squads-approve` +
`bin/program-squads-execute`), then poll for the on-chain close to
land.

### Authority pre-check

`program-close` reads `ProgramData.upgrade_authority` on-chain and
asserts it equals the configured Squads vault PDA before composing
the proposal. A program whose authority is anything else cannot be
closed via this flow — there is no point composing a proposal the
multisig has no standing to execute. If the assertion fails the
script names both the expected vault PDA and the actual on-chain
authority in the error.

### Why the `recipient` is the vault, not an operator

`buildCloseProgramDataIx` takes a `recipient` that receives the
program-data rent on close. The script always supplies the vault PDA
as both the authority (Squads-signed) and the recipient. Routing the
rent to the multisig vault rather than an individual operator keeps
the reclaimed lamports under the same collective control as the
program had — there is no operator who personally collects a payout
from a multisig-governed close.

### The TERMINAL note

Once executed, the program is gone. There is no "un-close" — the
program-data PDA can never be re-allocated under the same program
ID. The `--i-want-to-close-this-program` flag is intentionally
verbose to defeat muscle memory and abbreviated aliases. Operators
who reach for this script should pair it with an out-of-band
witness, the same way `bin/program-initial-deploy` Phase 4 does for
keypair destruction.

## Reclaiming vault balance: bin/program-vault-drain

`bin/program-vault-drain <cluster> [--recipient <pubkey>]` composes
a Squads vault proposal containing a single
`SystemProgram.transfer` instruction moving the vault PDA's full
balance to the recipient. When `--recipient` is omitted, the
default is `$OPERATOR_PAYER_KEYPAIR`'s pubkey.

The vault PDA is system-owned with zero data, so a full-balance
drain is safe — there is no rent-exempt reserve to preserve. The
proposal still has to be approved and executed by the multisig's
threshold of members via `bin/program-squads-approve` and
`bin/program-squads-execute` (or the Squads UI).

The two operational scenarios are:

- **Post-close rent reclaim.** `bin/program-close` routes the
  released ProgramData rent into the vault (see "Why the recipient
  is the vault, not an operator" above). `bin/program-vault-drain`
  is the matching primitive for pulling that rent back to a
  human-controlled wallet once the close has executed.
- **Cleanup between operations.** Buffer writes during a release
  cycle accumulate rent in the vault until the upgrade executes (at
  which point the buffer is consumed) — but a release that ends in
  a vault-authority buffer needing `bin/program-close-buffer`
  recovery, or a devnet rehearsal that intentionally cycles through
  multiple buffer writes, leaves rent in the vault that the operator
  may want to recycle into the payer.

### No duplicate-proposal guard

Unlike `bin/program-deploy`, `bin/program-rollback`,
`bin/program-close`, `bin/program-verify`, and
`bin/program-initial-deploy` — all of which run
`guardNoOpenProposalsForProgram` to refuse composing a new proposal
while an open proposal targets the program — `bin/program-vault-drain`
has no equivalent guard. The
existing guards filter `listOpenProposals` by program id, and a
vault-drain proposal targets the vault account rather than any
program; the Squads SDK does not expose a "list all open proposals
on this multisig" query that the guard could use without that
filter.

Practical consequence: re-running `bin/program-vault-drain` while a
previous drain proposal is still pending composes a second pending
drain for the same balance. Both proposals would attempt to transfer
the entire vault on execute; one would succeed and the second would
land an empty transfer (zero lamports left to move). Resolve any
stuck pending drain via `bin/program-squads-cancel` or the Squads UI
before composing a new one.

### Recipient default and overrides

The recipient default is the operator payer because the most common
caller is an operator reclaiming their own deposited rent. Pass
`--recipient <pubkey>` when the lamports should land in a treasury
wallet, a different team member's keypair, or any address other
than the operator's. The recipient is validated as a base58 pubkey
before the proposal is composed; invalid input fails before any
on-chain transaction is sent.

## Using a Ledger as the operator payer

`OPERATOR_PAYER_KEYPAIR` accepts either a filesystem path (back-compat
with the file-keypair flow) or a Solana signer URL. The supported URL
forms are:

- `usb://ledger?key=N` — derivation path `44'/501'/N'` (the Solana CLI
  default for the same URL).
- `usb://ledger?key=N&change=M` — appends a fourth `/M'` level for
  operators who keep multiple deploy keys on the same device.
- `file:///path/to/keypair.json` — explicit file URL form; identical
  semantics to a plain path.

The same value passes verbatim through to the `solana` CLI shellouts
(`solana program write-buffer`, `set-buffer-authority`,
`set-upgrade-authority`, and `program deploy`), each of which natively
understands `usb://ledger?key=N`.

### Device prerequisites

1. Install the **Solana app** on the Ledger device (Ledger Live →
   "Manager" → install "Solana").
2. Open the Solana app on the device. The transport opens cleanly only
   while the app is running.
3. **Enable blind signing** in the Solana app's on-device settings:
   `Settings → Allow blind signing → Enabled`. The Ledger Solana app
   does not natively decode Squads instructions, so every release
   operation requires this setting. The first signing call without it
   fails with the human-readable message
   `Missing a parameter. Try enabling blind signature in the app`
   surfaced by `@ledgerhq/hw-app-solana`.

When `LedgerSigner.open` runs it reads the on-device blind-signing
flag via `getAppConfiguration` and prints a stderr warning at
transport-open time if the flag is off, so the operator catches the
misconfiguration before the first signing call rather than at the
device-confirm prompt.

### Cross-checking what the device shows

Before any LedgerSigner signing call, the release tooling prints a
verification block to stderr that mirrors what the Ledger Solana app
displays in blind-sign mode. The block looks like:

```
================ Ledger blind-sign verification ================
About to sign: vaultTransactionCreate + proposalCreate (initial-deploy)
Targeting Squads program: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf

Instructions (in order):
  1. SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf :: vaultTransactionCreate
  2. SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf :: proposalCreate

Multisig:        <multisig-pda>
Vault PDA:       <vault-pda>
Transaction PDA: <tx-pda>
Proposal PDA:    <proposal-pda>
Transaction index: 7

Compiled message sha256: f6d9...c4e2

Confirm this hash matches the one shown on your Ledger device.
================================================================
```

The `Compiled message sha256` is `sha256(message.serialize())` — the
same hash the Ledger Solana app computes for the bytes it is about to
sign. Visually comparing this hash against the device screen before
approving is the operator's defence against an attacker substituting
bytes between proposal composition and the device-confirm prompt.
This is the same posture Squads web-UI Ledger users have today, with
the addition that the CLI also names the multisig, vault PDA,
transaction index, and decoded instruction discriminator so the
operator can confirm "I am voting on tx #N for the right multisig"
rather than just "the hash is what I expect".

### Buffer-write expectations

`bin/program-deploy` and `bin/program-initial-deploy` submit 250+
write-buffer transactions during a release. Each transaction is a
separate `solana program write-buffer` chunk, and **each one prompts
the Ledger device for individual approval** when the keypair is a
Ledger URL. Expect to confirm every chunk by hand; if this is the
wrong UX for a particular operator, supply a file-keypair URL for
buffer writes and reserve the Ledger for the proposal-create signing.

Subsequent steps — `set-buffer-authority`, the proposal-create
transaction, and (eventually) `set-upgrade-authority` during the
initial deploy — are single-transaction signing events.

### Pinned Ledger SDK versions

The release tooling pins exact (no caret) versions of four official
`@ledgerhq/*` packages:

- `@ledgerhq/hw-app-solana@7.10.2`
- `@ledgerhq/hw-transport-node-hid@6.33.2`
- `@ledgerhq/hw-transport@6.35.2`
- `@ledgerhq/errors@6.35.0`

All four originate from the `LedgerHQ/ledger-live` monorepo, are
Apache-2.0 licensed, and are not deprecated. The `hw-transport-node-hid`
pin transitively pins `node-hid@2.1.2`, which fetches a prebuilt
native binary at install time. Prebuilts exist for `darwin-arm64`,
`darwin-x64`, and `linux-x64` (glibc, N-API v3); other targets fall
back to a `node-gyp rebuild` that requires Python and a C++ toolchain.

### Bun + node-hid troubleshooting

Bun (the runtime this repository uses) implements N-API and loads
`node-hid`'s native binding correctly in the current Bun version
recorded in `bun.lock`. If a future Bun upgrade regresses native-
binding resolution for `node-hid`, the documented fallback is to run
the affected CLI under Node directly:

```
cd scripts
npm install                                # forces prebuild-install under Node
node --experimental-vm-modules <script>
```

The `@ledgerhq/*` JavaScript is plain Node-compatible code; the only
Bun-specific risk is in `node-hid`'s `.node` binary resolution. Do not
substitute community node-hid forks (`node-hid-ng`, etc.) — they are
not Ledger-supported and the pin is intentional.

### HID permissions on Linux

Linux requires a udev rule granting the operator user read/write
access to the Ledger HID interface. Drop this file at
`/etc/udev/rules.d/20-ledger.rules` (the exact rules ship with Ledger
Live; this is one example):

```
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2c97", MODE="0660", \
  TAG+="uaccess", TAG+="udev-acl"
```

Then reload udev (`sudo udevadm control --reload-rules && sudo
udevadm trigger`) and replug the device. macOS and Windows have no
equivalent step.
