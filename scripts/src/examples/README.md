# Flex Examples

End-to-end examples of the Flex Payment Scheme on Solana devnet.

Three scripts demonstrate the full payment flow:

- **facilitator.ts** -- Settlement server that validates and settles flex payments
- **server.ts** -- Resource server with a `/protected` endpoint behind flex middleware
- **payment.ts** -- Client that pays for access using a session key

## Setup

All commands run from the repository root.

### 1. Create keypairs

You need three Solana keypairs. Put them wherever you like.

```sh
solana-keygen new -o tmp/keypairs/owner.json        # Escrow owner, pays tx fees
solana-keygen new -o tmp/keypairs/facilitator.json   # Facilitator server identity
solana-keygen new -o tmp/keypairs/receiver.json      # Resource server payment recipient
```

### 2. Fund the owner and facilitator

The owner needs devnet SOL (for transaction fees) and devnet USDC (to deposit into the escrow).
The facilitator needs devnet SOL to submit settlement transactions.

```sh
solana airdrop 2 $(solana address -k tmp/keypairs/owner.json) --url devnet
solana airdrop 1 $(solana address -k tmp/keypairs/facilitator.json) --url devnet
```

For USDC, visit [faucet.circle.com](https://faucet.circle.com), select **Solana** and **Devnet**, and send USDC to the owner's address.

### 3. Create token accounts for split recipients

The on-chain finalize instruction transfers USDC to split recipients, so their token accounts must exist beforehand. Create them for the facilitator and receiver using `spl-token`:

```sh
USDC=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

spl-token create-account $USDC \
  --owner tmp/keypairs/facilitator.json \
  --fee-payer tmp/keypairs/owner.json \
  --url devnet

spl-token create-account $USDC \
  --owner tmp/keypairs/receiver.json \
  --fee-payer tmp/keypairs/owner.json \
  --url devnet
```

### 4. Create the escrow

This creates an escrow account, deposits USDC, and registers a session key.
The output is written to `tmp/session-key.json`.

```sh
OWNER_KEYPAIR_PATH=tmp/keypairs/owner.json \
FACILITATOR_KEYPAIR_PATH=tmp/keypairs/facilitator.json \
  bun scripts/src/create-devnet-escrow.ts
```

Optional env vars: `ESCROW_INDEX` (default 0), `DEPOSIT_AMOUNT` (default 5000000 = 5 USDC), `RPC_URL`.

## Running the examples

Start the facilitator and resource server, then run the payment client.

**Terminal 1 -- Facilitator** (port 4000):

```sh
FLEX_FACILITATOR_KEYPAIR_PATH=tmp/keypairs/facilitator.json \
FLEX_SPLIT_RECIPIENT=$(solana address -k tmp/keypairs/facilitator.json) \
  bun scripts/src/examples/facilitator.ts
```

**Terminal 2 -- Resource server** (port 3000):

```sh
PAYTO_KEYPAIR_PATH=tmp/keypairs/receiver.json \
  bun scripts/src/examples/server.ts
```

**Terminal 3 -- Payment**:

```sh
bun scripts/src/examples/payment.ts
```

You should see `Status: 200` and `{"msg":"success"}`.

## Refreshing the session key

If the session key expires or you want a new one without recreating the escrow:

```sh
OWNER_KEYPAIR_PATH=tmp/keypairs/owner.json \
  bun scripts/src/setup-devnet.ts
```
