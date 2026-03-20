import {
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  pipe,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import fs from "fs";
import path from "path";

export async function loadKeypair(filePath: string): Promise<KeyPairSigner> {
  const resolved = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

export async function confirmSignature(
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

export async function sendTx(
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
