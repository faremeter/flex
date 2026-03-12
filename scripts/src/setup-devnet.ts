import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createSignerFromKeyPair,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getAddressFromPublicKey,
  pipe,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { getRegisterSessionKeyInstructionAsync } from "@faremeter/flex-solana";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const GRACE_PERIOD_SLOTS = Number(process.env.GRACE_PERIOD_SLOTS ?? "300");
const OUTPUT_PATH =
  process.env.OUTPUT_PATH ??
  path.resolve(import.meta.dirname, "../../tmp/session-key.json");

const OLD_SESSION_KEY_PATH = process.env.SESSION_KEY_PATH ?? OUTPUT_PATH;

const OWNER_KEYPAIR_PATH = process.env.OWNER_KEYPAIR_PATH;

if (!OWNER_KEYPAIR_PATH) {
  console.error("OWNER_KEYPAIR_PATH is required (the escrow owner's keypair)");
  process.exit(1);
}

const oldData = JSON.parse(fs.readFileSync(OLD_SESSION_KEY_PATH, "utf-8")) as {
  escrow: string;
  vault: string;
  facilitator: string;
  mint: string;
  network: string;
};

async function loadKeypair(filePath: string): Promise<KeyPairSigner> {
  const resolved = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  sig: Signature,
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    const status = statuses[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Transaction confirmation timeout");
}

async function sendTx(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signedTx);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, sig);
}

const rpc = createSolanaRpc(RPC_URL);
const owner = await loadKeypair(OWNER_KEYPAIR_PATH);
const escrow = oldData.escrow;

console.log(`Owner:        ${owner.address}`);
console.log(`Escrow:       ${escrow}`);
console.log(`Grace period: ${GRACE_PERIOD_SLOTS} slots`);

const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]);
const sessionKeyAddress = await getAddressFromPublicKey(keyPair.publicKey);
const sessionKey = await createSignerFromKeyPair(keyPair);

const registerIx = await getRegisterSessionKeyInstructionAsync({
  owner,
  escrow: escrow as Parameters<
    typeof getRegisterSessionKeyInstructionAsync
  >[0]["escrow"],
  sessionKey: sessionKeyAddress,
  expiresAtSlot: null,
  revocationGracePeriodSlots: GRACE_PERIOD_SLOTS,
});

const sessionKeyAccountMeta = registerIx.accounts[2];
if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
const sessionKeyPDA = sessionKeyAccountMeta.address;

console.log(`Registering session key ${sessionKeyAddress}...`);
await sendTx(rpc, owner, [registerIx]);
console.log(`Session key registered: PDA ${sessionKeyPDA}`);

const privateJWK = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

const output = {
  address: sessionKeyAddress,
  jwk: privateJWK,
  escrow: oldData.escrow,
  vault: oldData.vault,
  sessionKeyPDA,
  facilitator: oldData.facilitator,
  mint: oldData.mint,
  network: oldData.network,
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`Written to ${OUTPUT_PATH}`);
