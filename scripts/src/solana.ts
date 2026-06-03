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
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { clusterRpcUrl, type Cluster } from "./cluster.config";
import { KeypairSigner, printBlindSignContext, type Signer } from "./signer";
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
 *
 * The fee payer is a `Signer` so this works equally for an in-memory
 * keypair and a Ledger device. `cosigners` covers the rare case where
 * a second short-lived `Keypair` (e.g. the ephemeral `createKey` in
 * `bootstrap-multisig`) must also sign the same transaction; a Ledger
 * cannot be a cosigner because that ephemeral key is generated inside
 * the program.
 *
 * `blindSign` lets call sites pass the metadata the Ledger blind-sign
 * verification block needs (multisig PDA, vault PDA, transaction
 * index, etc.) so the operator can cross-check what the device
 * displays. The block is suppressed for `KeypairSigner` payers.
 */
export interface BlindSignSendOptions {
  label: string;
  multisig?: import("@solana/web3.js").PublicKey;
  vaultPDA?: import("@solana/web3.js").PublicKey;
  proposalPDA?: import("@solana/web3.js").PublicKey;
  transactionPDA?: import("@solana/web3.js").PublicKey;
  transactionIndex?: bigint;
}

export async function sendWeb3Tx(
  connection: Connection,
  feePayer: Signer,
  instructions: TransactionInstruction[],
  options?: {
    cosigners?: Keypair[];
    blindSign?: BlindSignSendOptions;
  },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: feePayer.publicKey,
  }).add(...instructions);
  for (const co of options?.cosigners ?? []) {
    tx.partialSign(co);
  }
  if (options?.blindSign !== undefined) {
    printBlindSignContext({
      signer: feePayer,
      label: options.blindSign.label,
      message: Buffer.from(tx.compileMessage().serialize()),
      instructions,
      ...(options.blindSign.multisig !== undefined && {
        multisig: options.blindSign.multisig,
      }),
      ...(options.blindSign.vaultPDA !== undefined && {
        vaultPDA: options.blindSign.vaultPDA,
      }),
      ...(options.blindSign.proposalPDA !== undefined && {
        proposalPDA: options.blindSign.proposalPDA,
      }),
      ...(options.blindSign.transactionPDA !== undefined && {
        transactionPDA: options.blindSign.transactionPDA,
      }),
      ...(options.blindSign.transactionIndex !== undefined && {
        transactionIndex: options.blindSign.transactionIndex,
      }),
    });
  }
  await feePayer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err !== null) {
    throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}

/**
 * Send a versioned-v0 transaction signed by `feePayer`. The
 * `vaultTransactionExecute` path returns address-lookup-table accounts
 * that legacy transactions cannot reference, so the Squads execute
 * step builds a v0 message and routes it through this helper.
 */
export async function sendVersionedWeb3Tx(
  connection: Connection,
  feePayer: Signer,
  instruction: TransactionInstruction,
  lookupTableAccounts: AddressLookupTableAccount[],
  blindSign?: BlindSignSendOptions,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(message);
  if (blindSign !== undefined) {
    printBlindSignContext({
      signer: feePayer,
      label: blindSign.label,
      message: Buffer.from(tx.message.serialize()),
      instructions: [instruction],
      ...(blindSign.multisig !== undefined && {
        multisig: blindSign.multisig,
      }),
      ...(blindSign.vaultPDA !== undefined && {
        vaultPDA: blindSign.vaultPDA,
      }),
      ...(blindSign.proposalPDA !== undefined && {
        proposalPDA: blindSign.proposalPDA,
      }),
      ...(blindSign.transactionPDA !== undefined && {
        transactionPDA: blindSign.transactionPDA,
      }),
      ...(blindSign.transactionIndex !== undefined && {
        transactionIndex: blindSign.transactionIndex,
      }),
    });
  }
  await feePayer.signVersionedTransaction(tx);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err !== null) {
    throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}

/**
 * Load a Keypair from a JSON secret-key file as a Signer. Convenience
 * wrapper for call sites that have a known file path; for env-driven
 * call sites prefer `parseSignerURL` so the operator can substitute a
 * Ledger URL.
 */
export async function loadKeypairSignerFromFile(
  filePath: string,
): Promise<Signer> {
  return KeypairSigner.fromFile(filePath);
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
