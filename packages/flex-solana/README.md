# @faremeter/flex-solana

Flex Payment Scheme SDK for Solana. Provides instruction generation, account queries, payment authorization, and client/facilitator handlers for integrating with the Flex escrow program.

## Installation

```bash
bun add @faremeter/flex-solana
```

## API Reference

<!-- TSDOC_START -->

## Functions

- [serializePaymentAuthorization](#serializepaymentauthorization)
- [signPaymentAuthorization](#signpaymentauthorization)
- [createEd25519VerifyInstruction](#createed25519verifyinstruction)
- [fetchEscrowAccount](#fetchescrowaccount)
- [fetchSessionKey](#fetchsessionkey)
- [fetchPendingSettlement](#fetchpendingsettlement)
- [findEscrowsByOwner](#findescrowsbyowner)
- [findEscrowsByFacilitator](#findescrowsbyfacilitator)
- [findPendingSettlementsByEscrow](#findpendingsettlementsbyescrow)
- [createPaymentHandler](#createpaymenthandler)
- [fetchEscrowAccounting](#fetchescrowaccounting)
- [createFacilitatorHandler](#createfacilitatorhandler)

### serializePaymentAuthorization

Serializes a payment authorization into the binary format expected
by the Flex on-chain program for Ed25519 signature verification.

| Function                        | Type                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `serializePaymentAuthorization` | `(args: SerializePaymentAuthorizationArgs) => Uint8Array<ArrayBuffer>` |

Parameters:

- `args`: - Authorization fields to serialize

Returns:

The serialized message bytes

### signPaymentAuthorization

Signs a serialized payment authorization using the Web Crypto Ed25519 API.

| Function                   | Type                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `signPaymentAuthorization` | `(args: { message: Uint8Array<ArrayBuffer>; keyPair: CryptoKeyPair; }) => Promise<Uint8Array<ArrayBuffer>>` |

Parameters:

- `args`: - The message bytes and the session key pair

Returns:

The 64-byte Ed25519 signature

### createEd25519VerifyInstruction

Builds an Ed25519 precompile instruction that verifies a payment
authorization signature inline within a Solana transaction.

Header layout:
u8 num_signatures = 1
u8 padding = 0

Entry layout (one per signature):
u16 signature_offset
u16 signature_instruction_index = 0xFFFF (inline)
u16 public_key_offset
u16 public_key_instruction_index = 0xFFFF (inline)
u16 message_data_offset
u16 message_data_size
u16 message_instruction_index = 0xFFFF (inline)

Data:
[64 bytes] signature
[32 bytes] public_key
[N bytes] message

| Function                         | Type                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `createEd25519VerifyInstruction` | `(args: { publicKey: Address; message: Uint8Array<ArrayBufferLike>; signature: Uint8Array<ArrayBufferLike>; }) => Instruction<...>` |

### fetchEscrowAccount

Fetches a single escrow account by address.

| Function             | Type                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `fetchEscrowAccount` | `(rpc: Rpc<SolanaRpcApi>, addr: Address) => Promise<EscrowAccountData or null>` |

Parameters:

- `rpc`: - Solana RPC client
- `addr`: - On-chain address of the escrow PDA

Returns:

The decoded account data, or `null` if it does not exist

### fetchSessionKey

Fetches a single session key account by address.

| Function          | Type                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `fetchSessionKey` | `(rpc: Rpc<SolanaRpcApi>, addr: Address) => Promise<SessionKeyData or null>` |

Parameters:

- `rpc`: - Solana RPC client
- `addr`: - On-chain address of the session key PDA

Returns:

The decoded session key data, or `null` if it does not exist

### fetchPendingSettlement

Fetches a single pending settlement account by address.

| Function                 | Type                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `fetchPendingSettlement` | `(rpc: Rpc<SolanaRpcApi>, addr: Address) => Promise<PendingSettlementData or null>` |

Parameters:

- `rpc`: - Solana RPC client
- `addr`: - On-chain address of the pending settlement PDA

Returns:

The decoded settlement data, or `null` if it does not exist

### findEscrowsByOwner

Finds all escrow accounts owned by a given wallet using
`getProgramAccounts` with a discriminator + owner filter.

| Function             | Type                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `findEscrowsByOwner` | `(rpc: Rpc<SolanaRpcApi>, owner: Address) => Promise<{ address: Address; account: EscrowAccountData; }[]>` |

Parameters:

- `rpc`: - Solana RPC client
- `owner`: - Wallet address of the escrow owner

Returns:

Array of escrow addresses and their decoded data

### findEscrowsByFacilitator

Finds all escrow accounts managed by a given facilitator using
`getProgramAccounts` with a discriminator + facilitator filter.

| Function                   | Type                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `findEscrowsByFacilitator` | `(rpc: Rpc<SolanaRpcApi>, facilitator: Address) => Promise<{ address: Address; account: EscrowAccountData; }[]>` |

Parameters:

- `rpc`: - Solana RPC client
- `facilitator`: - Address of the facilitator

Returns:

Array of escrow addresses and their decoded data

### findPendingSettlementsByEscrow

Finds all pending settlement accounts belonging to an escrow using
`getProgramAccounts` with a discriminator + escrow filter.

| Function                         | Type                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `findPendingSettlementsByEscrow` | `(rpc: Rpc<SolanaRpcApi>, escrow: Address) => Promise<{ address: Address; account: PendingSettlementData; }[]>` |

Parameters:

- `rpc`: - Solana RPC client
- `escrow`: - Address of the parent escrow PDA

Returns:

Array of pending settlement addresses and their decoded data

### createPaymentHandler

Creates a client-side `PaymentHandler` that signs Flex payment
authorizations against compatible x402 requirements.

| Function               | Type                                                     |
| ---------------------- | -------------------------------------------------------- |
| `createPaymentHandler` | `(opts: CreateFlexPaymentHandlerOpts) => PaymentHandler` |

Parameters:

- `opts`: - Escrow, session key, and RPC configuration

Returns:

A handler that produces signed payment payloads

### fetchEscrowAccounting

Fetches a full accounting snapshot for an escrow: vault balances,
on-chain pending settlements, and the available capacity per mint.

| Function                | Type                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `fetchEscrowAccounting` | `(rpc: Rpc<SolanaRpcApi>, escrowAddress: Address, mints: Address[]) => Promise<EscrowAccounting>` |

Parameters:

- `rpc`: - Solana RPC client
- `escrowAddress`: - Address of the escrow PDA
- `mints`: - Token mints to query vault balances for

Returns:

An `EscrowAccounting` snapshot

### createFacilitatorHandler

Creates a facilitator handler that verifies Flex payment authorizations,
manages in-memory holds, and submits/finalizes settlements on-chain.

Starts a background interval that periodically flushes settled holds
and finalizes confirmed transactions. Call `stop()` to clear it.

| Function                   | Type                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createFacilitatorHandler` | `(network: string, rpc: Rpc<SolanaRpcApi>, facilitatorSigner: TransactionSigner, config: FlexFacilitatorConfig) => Promise<...>` |

Parameters:

- `network`: - Solana cluster name (e.g. "mainnet", "devnet")
- `rpc`: - Solana RPC client
- `facilitatorSigner`: - Transaction signer for the facilitator
- `config`: - Supported mints, splits, and timing configuration

Returns:

A `FlexFacilitator` with verify/settle/flush/stop methods

## Constants

- [FLEX_SCHEME](#flex_scheme)
- [FlexSplitEntry](#flexsplitentry)
- [FlexPaymentPayload](#flexpaymentpayload)
- [FlexPaymentRequirementsExtra](#flexpaymentrequirementsextra)
- [MAX_PENDING_SETTLEMENTS](#max_pending_settlements)

### FLEX_SCHEME

Scheme identifier used in x402 payment requirements for Flex.

| Constant      | Type                |
| ------------- | ------------------- |
| `FLEX_SCHEME` | `"@faremeter/flex"` |

### FlexSplitEntry

Runtime validator for a single split entry in a Flex payment payload.

| Constant         | Type                                            |
| ---------------- | ----------------------------------------------- |
| `FlexSplitEntry` | `Type<{ recipient: string; bps: number; }, {}>` |

### FlexPaymentPayload

Runtime validator for the client-submitted Flex payment payload.

| Constant             | Type                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FlexPaymentPayload` | `Type<{ escrow: string; mint: string; maxAmount: string; authorizationId: string; expiresAtSlot: string; splits: { recipient: string; bps: number; }[]; sessionKey: string; signature: string; }, {}>` |

### FlexPaymentRequirementsExtra

Runtime validator for the `extra` field in Flex payment requirements.

| Constant                       | Type                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlexPaymentRequirementsExtra` | `Type<{ facilitator: string; supportedMints: string[]; splits: { recipient: string; bps: number; }[]; escrow?: string or undefined; minGracePeriodSlots?: string or undefined; }, {}>` |

### MAX_PENDING_SETTLEMENTS

Maximum number of concurrent pending settlements an escrow supports.

| Constant                  | Type |
| ------------------------- | ---- |
| `MAX_PENDING_SETTLEMENTS` | `16` |

## Types

- [SplitInput](#splitinput)
- [SerializePaymentAuthorizationArgs](#serializepaymentauthorizationargs)
- [FlexSplitEntry](#flexsplitentry)
- [FlexPaymentPayload](#flexpaymentpayload)
- [FlexPaymentRequirementsExtra](#flexpaymentrequirementsextra)
- [EscrowAccountData](#escrowaccountdata)
- [SessionKeyData](#sessionkeydata)
- [PendingSettlementData](#pendingsettlementdata)
- [CreateFlexPaymentHandlerOpts](#createflexpaymenthandleropts)
- [HoldEntry](#holdentry)
- [EscrowAccounting](#escrowaccounting)
- [FlushResult](#flushresult)
- [FlexFacilitator](#flexfacilitator)

### SplitInput

A single split directing a share of a settlement to a token account.

| Type         | Type                                   |
| ------------ | -------------------------------------- |
| `SplitInput` | `{ recipient: Address; bps: number; }` |

### SerializePaymentAuthorizationArgs

Arguments for `serializePaymentAuthorization`.

| Type                                | Type                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SerializePaymentAuthorizationArgs` | `{ programId: Address; escrow: Address; mint: Address; maxAmount: bigint; authorizationId: bigint; expiresAtSlot: bigint; splits: SplitInput[]; }` |

### FlexSplitEntry

Runtime validator for a single split entry in a Flex payment payload.

| Type             | Type                          |
| ---------------- | ----------------------------- |
| `FlexSplitEntry` | `typeof FlexSplitEntry.infer` |

### FlexPaymentPayload

Runtime validator for the client-submitted Flex payment payload.

| Type                 | Type                              |
| -------------------- | --------------------------------- |
| `FlexPaymentPayload` | `typeof FlexPaymentPayload.infer` |

### FlexPaymentRequirementsExtra

Runtime validator for the `extra` field in Flex payment requirements.

| Type                           | Type                                        |
| ------------------------------ | ------------------------------------------- |
| `FlexPaymentRequirementsExtra` | `typeof FlexPaymentRequirementsExtra.infer` |

### EscrowAccountData

Decoded on-chain state of a Flex escrow account.

| Type                | Type                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EscrowAccountData` | `{ version: number; owner: Address; facilitator: Address; index: bigint; pendingCount: bigint; mintCount: bigint; refundTimeoutSlots: bigint; deadmanTimeoutSlots: bigint; lastActivitySlot: bigint; maxSessionKeys: number; sessionKeyCount: number; bump: number; }` |

### SessionKeyData

Decoded on-chain state of a session key registered to an escrow.

| Type             | Type                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionKeyData` | `{ version: number; escrow: Address; key: Address; createdAtSlot: bigint; expiresAtSlot: bigint or null; active: boolean; revokedAtSlot: bigint or null; revocationGracePeriodSlots: bigint; bump: number; }` |

### PendingSettlementData

Decoded on-chain state of a pending settlement awaiting finalization.

| Type                    | Type                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PendingSettlementData` | `{ version: number; escrow: Address; mint: Address; amount: bigint; originalAmount: bigint; maxAmount: bigint; authorizationId: bigint; expiresAtSlot: bigint; submittedAtSlot: bigint; sessionKey: Address; splitCount: number; splits: { recipient: Address; bps: number }[]; bump: number; }` |

### CreateFlexPaymentHandlerOpts

Configuration for `createPaymentHandler`.

| Type                           | Type                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateFlexPaymentHandlerOpts` | `{ network: string; escrow: Address; mint: Address; sessionKeyPair: CryptoKeyPair; sessionKeyAddress: Address; rpc: Rpc and SlotProvider; programAddress?: Address; }` |

### HoldEntry

A single on-chain pending settlement as seen by the accounting view.

| Type        | Type                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HoldEntry` | `{ authorizationId: bigint; mint: Address; amount: bigint; maxAmount: bigint; submittedAtSlot: bigint; sessionKey: Address; splits: { recipient: Address; bps: number }[]; pendingAddress: Address; }` |

### EscrowAccounting

Snapshot of an escrow's vault balances, pending settlements, and available capacity.

| Type               | Type                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EscrowAccounting` | `{ escrow: Address; vaultBalances: Map<Address, bigint>; holds: HoldEntry[]; totalPendingByMint: Map<Address, bigint>; pendingCount: bigint; maxPending: number; availableByMint: Map<Address, bigint>; canSubmit: boolean; }` |

### FlushResult

Outcome of submitting a single hold to the on-chain program.

| Type          | Type                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `FlushResult` | `{ authorizationId: bigint; success: boolean; transaction?: string; error?: string; }` |

### FlexFacilitator

Extended `FacilitatorHandler` with Flex-specific lifecycle
methods for flushing holds to chain and inspecting the hold manager.

| Type              | Type                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `FlexFacilitator` | `FacilitatorHandler and { flush(): Promise<FlushResult[]>; getHoldManager(): HoldManager; stop(): void; }` |

<!-- TSDOC_END -->
