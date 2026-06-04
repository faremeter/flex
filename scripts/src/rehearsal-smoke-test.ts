// Devnet smoke test: confirms the rehearsal program is on-chain and
// invokable. Uses the Ledger as the escrow owner (and fee payer) so no
// devnet airdrop is needed — the operator's Ledger already holds
// devnet SOL. Generates a throwaway facilitator keypair (web3.js) for
// the close_escrow co-signature. Calls create_escrow + close_escrow,
// fetches the escrow account between the two to assert the on-chain
// state, then asserts the account is gone after close.
//
// Inputs (env):
//   REHEARSAL_PROGRAM_ID    base58 program ID of the deployed program
//   LEDGER_URL              defaults to usb://ledger?key=0
//   DEVNET_RPC_URL          defaults to api.devnet.solana.com
//
// Each step prints a one-line status; non-zero exit on any failure.

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  address,
  createNoopSigner,
  createSolanaRpc,
  isSignerRole,
  isWritableRole,
  type Instruction as KitInstruction,
} from "@solana/kit";
import {
  fetchEscrowAccount,
  getCloseEscrowInstruction,
  getCreateEscrowInstructionAsync,
} from "@faremeter/flex-solana";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { openLedgerSigner, parseLedgerURLSpec } from "./signer";

const REHEARSAL_PROGRAM_ID = process.env.REHEARSAL_PROGRAM_ID;
if (REHEARSAL_PROGRAM_ID === undefined || REHEARSAL_PROGRAM_ID.length === 0) {
  throw new Error("REHEARSAL_PROGRAM_ID env var is required");
}
const programAddress = address(REHEARSAL_PROGRAM_ID);

const LEDGER_URL = process.env.LEDGER_URL ?? "usb://ledger?key=0";
const RPC_URL = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

const connection = new Connection(RPC_URL, "confirmed");
const rpc = createSolanaRpc(RPC_URL);

// Convert a codama-built kit Instruction into a web3.js
// TransactionInstruction so the resulting tx can be signed by a
// LedgerSigner. The on-the-wire format is identical between the two
// libraries; this is purely a type bridge.
function kitIxToWeb3(ix: KitInstruction): TransactionInstruction {
  const accounts = ix.accounts ?? [];
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: accounts.map((acc) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: isSignerRole(acc.role),
      isWritable: isWritableRole(acc.role),
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

async function sendAndConfirm(
  tx: VersionedTransaction,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err !== null) {
    throw new Error(`tx ${sig} failed: ${JSON.stringify(result.value.err)}`);
  }
  return sig;
}

process.stdout.write(`[smoke] program: ${programAddress}\n`);
process.stdout.write(`[smoke] rpc:     ${RPC_URL}\n`);
process.stdout.write(`[smoke] ledger:  ${LEDGER_URL}\n`);

const { derivationPath } = parseLedgerURLSpec(LEDGER_URL);
const ledger = await openLedgerSigner(LEDGER_URL, derivationPath);

try {
  const ownerAddress = address(ledger.publicKey.toBase58());
  process.stdout.write(`[smoke] owner (Ledger): ${ownerAddress}\n`);

  // close_escrow requires the facilitator to be a signer. The Ledger
  // can't be the facilitator too (single device, single key) so we
  // generate a throwaway facilitator as a web3.js Keypair so it can
  // partial-sign the close tx without a kit→web3 secret-key bridge.
  const facilitatorKp = Keypair.generate();
  const facilitatorAddress = address(facilitatorKp.publicKey.toBase58());
  process.stdout.write(`[smoke] facilitator:    ${facilitatorAddress}\n`);

  // create_escrow: owner is the Ledger; we use a noop kit signer at
  // the codama level and sign with the Ledger at the web3.js level
  // after the tx is built.
  const ownerNoop = createNoopSigner(ownerAddress);

  process.stdout.write(`[smoke] calling create_escrow (index=0)...\n`);
  const createKit = await getCreateEscrowInstructionAsync(
    {
      owner: ownerNoop,
      index: 0,
      facilitator: facilitatorAddress,
      refundTimeoutSlots: 150,
      deadmanTimeoutSlots: 1000,
      maxSessionKeys: 10,
      maxPending: 16,
    },
    { programAddress },
  );
  const createIx = kitIxToWeb3(createKit);

  const { blockhash: bh1, lastValidBlockHeight: lvb1 } =
    await connection.getLatestBlockhash();
  const createMsg = new TransactionMessage({
    payerKey: ledger.publicKey,
    recentBlockhash: bh1,
    instructions: [createIx],
  }).compileToV0Message();
  const createTx = new VersionedTransaction(createMsg);
  await ledger.signVersionedTransaction(createTx);
  const createSig = await sendAndConfirm(createTx, bh1, lvb1);
  process.stdout.write(`[smoke] create_escrow sig: ${createSig}\n`);

  // The escrow PDA is the second account in the codama-built ix.
  const escrowMeta = createKit.accounts[1];
  if (escrowMeta === undefined) {
    throw new Error("create_escrow ix missing escrow account meta");
  }
  const escrowAddr = escrowMeta.address;
  process.stdout.write(`[smoke] escrow PDA: ${escrowAddr}\n`);

  process.stdout.write(`[smoke] fetching escrow account...\n`);
  const escrowData = await fetchEscrowAccount(rpc, escrowAddr);
  if (escrowData === null) {
    throw new Error(`escrow account ${escrowAddr} not found after create`);
  }
  if (escrowData.owner !== ownerAddress) {
    throw new Error(
      `escrow.owner ${escrowData.owner} != ledger address ${ownerAddress}`,
    );
  }
  if (escrowData.facilitator !== facilitatorAddress) {
    throw new Error(
      `escrow.facilitator ${escrowData.facilitator} != generated facilitator ${facilitatorAddress}`,
    );
  }
  process.stdout.write(
    `[smoke] escrow owner=${escrowData.owner} facilitator=${escrowData.facilitator}\n`,
  );

  process.stdout.write(`[smoke] calling close_escrow...\n`);
  const facilitatorNoop = createNoopSigner(facilitatorAddress);
  const closeKit = getCloseEscrowInstruction(
    {
      escrow: escrowAddr,
      owner: ownerNoop,
      facilitator: facilitatorNoop,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    { programAddress },
  );
  const closeIx = kitIxToWeb3(closeKit);

  const { blockhash: bh2, lastValidBlockHeight: lvb2 } =
    await connection.getLatestBlockhash();
  const closeMsg = new TransactionMessage({
    payerKey: ledger.publicKey,
    recentBlockhash: bh2,
    instructions: [closeIx],
  }).compileToV0Message();
  const closeTx = new VersionedTransaction(closeMsg);
  // Facilitator partial-signs first; Ledger fills the fee-payer slot.
  closeTx.sign([facilitatorKp]);
  await ledger.signVersionedTransaction(closeTx);
  const closeSig = await sendAndConfirm(closeTx, bh2, lvb2);
  process.stdout.write(`[smoke] close_escrow sig: ${closeSig}\n`);

  process.stdout.write(`[smoke] verifying escrow account is closed...\n`);
  const closed = await rpc
    .getAccountInfo(escrowAddr, { encoding: "base64" })
    .send();
  if (closed.value !== null) {
    throw new Error(`escrow account ${escrowAddr} still exists after close`);
  }

  process.stdout.write(`[smoke] OK — create_escrow + close_escrow succeeded\n`);
} finally {
  await ledger.close();
}
