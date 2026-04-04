# The Flex Payment Scheme

Flex is Faremeter's answer to agentic payment flows:

- **No latency bottleneck** -- prepaid escrow accounts mean no slow on-chain transactions per request. Access is granted by settlement policy (e.g. optimistically) and actual usage is settled in batches after the fact. The payment hot path is pure compute.
- **Pay only for what you use** -- costs are determined by real consumption, not estimates. An AI agent that burns 10k tokens pays for 10k tokens, not the 100k ceiling it authorized. Streaming, metered APIs, and variable-cost operations all work naturally.
- **Cheap at scale** -- authorizations are signed off-chain, settlement is batched on-chain. Transaction costs are amortized across many payments.
- **Smart wallet native** -- works with smart wallets, multisigs, and custodial setups out of the box. No per-request owner signatures required.

Built-in safety mechanisms protect both sides:

- **Dual authorization** -- every transfer requires both client and facilitator signatures. Neither party can move funds unilaterally, and the client's signature locks in exactly who gets paid and how much.
- **Split payments** -- a single authorization can distribute funds across multiple recipients: platform fees, referral commissions, facilitator cuts, royalties. Proportions are locked in by the client's signature.
- **Refund windows** -- every pending settlement has a configurable timeout before it finalizes. During that window the facilitator can reduce or cancel the charge, giving real recourse for failed deliveries or disputes.
- **Deadman switch** -- if the facilitator disappears, the client can unilaterally recover all escrowed funds after a timeout. No trust required, no support tickets.

## Repository

This repo contains the Solana implementation of the Flex scheme:

- [**programs/flex**](programs/flex) -- Anchor program implementing escrow accounts, session keys, authorizations, and settlement
- [**packages/flex-solana**](packages/flex-solana) -- TypeScript client library for interacting with the on-chain program
- [**tests/**](tests) -- Integration and scenario tests
- [**fuzz/**](fuzz) -- Cargo-fuzz harnesses
- [**docs/**](docs) -- Design and implementation documentation
- [**scripts/**](scripts) -- Utility scripts

## Documentation

- [Protocol Architecture](docs/flex-arch.md) -- full protocol specification, security model, and design rationale
- [Solana Implementation](docs/flex-solana.md) -- on-chain program architecture, account structures, and instruction details
- [Development Setup](DEV.md) -- build instructions and local development
- [Conventions](CONVENTIONS.md) -- coding standards and contribution guidelines

## Why Flex

Per-request on-chain payment schemes have two fundamental problems for agentic workflows:

**Variable costs require upfront knowledge.** The client must know the exact payment amount before making a request. This works for fixed-price resources, but breaks down when the cost depends on request content (token count for AI inference), response content (data transfer size), or metered usage over time (streaming, long-running operations). The service either overcharges to cover the worst case or undercharges and absorbs the loss.

**On-chain confirmation adds latency to every request.** Each request requires a separate on-chain transaction that must confirm before the service responds. For high-frequency, low-value interactions -- the common case in agentic workflows -- this per-request overhead dominates total response time and makes the payment layer the bottleneck.

**Prepaid escrow with off-chain authorization.** Flex eliminates both problems. Clients fund an escrow account once and authorize payments off-chain using Ed25519 session keys. The facilitator validates authorizations, grants access according to its settlement policy, and settles actual usage on-chain in batches after the work is done. The payment path drops out of the critical request loop entirely.

**Dual authorization and session keys.** The escrow contract requires signatures from both the client (via session key) and the facilitator for any transfer. Neither party can move funds unilaterally. Session keys are registered on-chain and can be revoked with a grace period, making them safe for delegation. Because session keys are separate from the account owner's key, Flex works naturally with smart wallets, multisigs, and custodial setups that cannot sign arbitrary off-chain messages on every request.

**Split payments.** Each authorization specifies a token mint, an amount ceiling, and a splits vector describing how funds are distributed among recipients at finalization. Splits are part of the client-signed message -- the facilitator cannot alter who gets paid or in what proportion. This enables platform fees, referral commissions, and multi-party revenue sharing within a single atomic settlement, without requiring separate transactions for each recipient.

**Refund windows.** When the facilitator submits an authorization on-chain, it enters a pending state with a configurable refund timeout. During that window the facilitator can reduce or cancel the pending amount -- for example, if the service was not delivered or the client disputes the charge. Once the window closes, the settlement finalizes and funds transfer to the recipients according to the signed splits. This refund mechanism is enforced on-chain, not by facilitator policy.

**Deadman switch.** If the facilitator becomes unresponsive -- no settlements, no activity -- the client can invoke a deadman switch after a configurable timeout to unilaterally recover all escrowed funds. Any pending settlements the facilitator failed to finalize are voided. This guarantees that funds are never permanently locked, regardless of facilitator behavior.
