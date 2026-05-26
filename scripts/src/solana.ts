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
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { clusterRpcUrl, type Cluster } from "./cluster.config";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

/**
 * Resolve the canonical https://github.com/<owner>/<repo> URL for the
 * current working tree, used by solana-verify and OtterSec submissions
 * to identify the source repository. Accepts both ssh and https forms
 * of git's remote.origin.url and normalises away a trailing .git suffix.
 */
export function detectRepoURL(): string {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git config --get remote.origin.url failed: ${result.stderr}`,
    );
  }
  const raw = result.stdout.trim();
  if (raw.length === 0) {
    throw new Error("remote.origin.url is empty");
  }
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }
  const httpsMatch = /^(https?:\/\/github\.com\/[^/]+\/.+?)(?:\.git)?$/.exec(
    raw,
  );
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }
  throw new Error(`unable to normalize git remote URL: ${raw}`);
}

/**
 * Resolve a git revision (commit, tag, branch) to its commit hash.
 * Used by OtterSec verification to pin a verification record to the
 * exact commit being deployed: the verify-init proposal records this
 * hash on-chain so the OtterSec worker can match the deployed bytes
 * against that commit rather than against a moving HEAD.
 */
export function gitResolveCommit(rev: string): string {
  const result = spawnSync("git", ["rev-parse", `${rev}^{}`], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git rev-parse failed to resolve ${rev}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Web3.js Connection for the given cluster, used by Squads-touching code.
 * Kit-native code uses `createSolanaRpc(clusterRpcUrl(cluster))` instead.
 */
export function connectionFor(cluster: Cluster, override?: string): Connection {
  const url =
    override !== undefined && override.length > 0
      ? override
      : clusterRpcUrl(cluster);
  return new Connection(url, { commitment: "confirmed" });
}

/**
 * Load a Solana keypair from a JSON secret-key file as a web3.js `Keypair`.
 * The kit-typed `loadKeypair` below remains available for non-Squads code
 * (e.g., the devnet escrow setup script that predates this branch).
 */
export function loadWeb3Keypair(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Send a legacy web3.js transaction signed by `feePayer`, awaiting
 * confirmation. Used by code that builds instructions via `@sqds/multisig`
 * (which is web3.js-native).
 */
export async function sendWeb3Tx(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [feePayer]);
}

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
