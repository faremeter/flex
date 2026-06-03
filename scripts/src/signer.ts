// Signer abstraction for the release tooling.
//
// The release scripts compose Squads multisig proposals and send the
// resulting transactions signed by an operator key. That key may live
// on disk (a JSON keypair file) or on a Ledger device; both are valid
// operator postures. This module exposes a single `Signer` interface
// over both, plus a URL parser that picks the implementation.
//
// Conventions:
//
// - File path or `file://` URL  -> KeypairSigner (in-memory secret).
// - `usb://ledger?key=N` URL    -> LedgerSigner (USB HID transport).
// - Plus an optional `&change=M` query parameter for an explicit
//   fourth derivation level.
//
// LedgerSigner opens the USB HID transport lazily through `open(url)`,
// fetches the on-device public key, and reads `getAppConfiguration` so
// the operator can be warned if blind signing is not enabled before
// any signing call is attempted.

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import type Transport from "@ledgerhq/hw-transport";
import Solana from "@ledgerhq/hw-app-solana";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generated as squadsGenerated } from "@sqds/multisig";
import { requireEnv } from "./cli-helpers";

export interface Signer {
  readonly publicKey: PublicKey;
  readonly url: string;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<VersionedTransaction>;
  close(): Promise<void>;
}

export class KeypairSigner implements Signer {
  readonly publicKey: PublicKey;

  constructor(
    private readonly kp: Keypair,
    readonly url: string,
  ) {
    this.publicKey = kp.publicKey;
  }

  static async fromFile(filePath: string): Promise<KeypairSigner> {
    const resolved = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as number[];
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    return new KeypairSigner(kp, `file://${resolved}`);
  }

  // Test-only constructor for callers that already hold a Keypair in
  // memory (e.g. signer round-trip tests against a generated key).
  // Production callers should go through KeypairSigner.fromFile or
  // parseSignerURL so the operator-supplied URL flows through to the
  // signer's `url` field for logging and verification.
  static forTesting(kp: Keypair, url: string): KeypairSigner {
    return new KeypairSigner(kp, url);
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.partialSign(this.kp);
    return tx;
  }

  async signVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<VersionedTransaction> {
    tx.sign([this.kp]);
    return tx;
  }

  async close(): Promise<void> {
    // No transport to release.
  }
}

// Solana CLI default BIP32 derivation for `usb://ledger?key=N` is
// `44'/501'/N'`. The optional `&change=M` query parameter adds a
// fourth `/M'` level, matching the CLI's `?key=N/M` shorthand.
function deriveSolanaPath(key: number, change: number | null): string {
  const tail = change === null ? "" : `/${change.toString()}'`;
  return `44'/501'/${key.toString()}'${tail}`;
}

export class LedgerSigner implements Signer {
  readonly publicKey: PublicKey;

  private constructor(
    private readonly transport: Transport,
    private readonly app: Solana,
    public readonly derivationPath: string,
    public readonly blindSigningEnabled: boolean,
    pubkeyBytes: Buffer,
    readonly url: string,
  ) {
    this.publicKey = new PublicKey(pubkeyBytes);
  }

  static async open(
    url: string,
    derivationPath: string,
  ): Promise<LedgerSigner> {
    const supported = await TransportNodeHid.isSupported();
    if (!supported) {
      throw new Error(
        "Ledger USB HID transport is not supported on this host; " +
          "verify @ledgerhq/hw-transport-node-hid installed cleanly " +
          "(node-hid native binding present in node_modules/node-hid/build/Release/)",
      );
    }
    // open(null) picks the first attached Ledger; we deliberately do
    // not surface a path/device-id selector — the operator's release
    // procedure runs one device at a time and a second attached device
    // is operator error rather than a configuration option.
    const transport = await TransportNodeHid.open(null);
    let app: Solana;
    let address: { address: Buffer };
    let appConfig: { blindSigningEnabled: boolean; version: string };
    try {
      app = new Solana(transport);
      appConfig = await app.getAppConfiguration();
      address = await app.getAddress(derivationPath);
    } catch (err) {
      await transport.close();
      throw err;
    }
    if (!appConfig.blindSigningEnabled) {
      process.stderr.write(
        "WARNING: Ledger Solana app blind signing is DISABLED. " +
          "Squads instructions are not natively decoded by the app and will fail to sign " +
          "until you enable Settings -> Allow blind signing on the device.\n",
      );
    }
    return new LedgerSigner(
      transport,
      app,
      derivationPath,
      appConfig.blindSigningEnabled,
      address.address,
      url,
    );
  }

  // Test-only constructor that bypasses transport open/getAddress so
  // unit tests can exercise the message-handoff path with a mocked
  // Solana app and a no-op transport. Production callers must go
  // through LedgerSigner.open.
  static forTesting(args: {
    transport: Transport;
    app: Solana;
    derivationPath: string;
    blindSigningEnabled: boolean;
    pubkeyBytes: Buffer;
    url: string;
  }): LedgerSigner {
    return new LedgerSigner(
      args.transport,
      args.app,
      args.derivationPath,
      args.blindSigningEnabled,
      args.pubkeyBytes,
      args.url,
    );
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const messageBytes = tx.compileMessage().serialize();
    const { signature } = await this.app.signTransaction(
      this.derivationPath,
      messageBytes,
    );
    tx.addSignature(this.publicKey, signature);
    return tx;
  }

  async signVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<VersionedTransaction> {
    const messageBytes = Buffer.from(tx.message.serialize());
    const { signature } = await this.app.signTransaction(
      this.derivationPath,
      messageBytes,
    );
    tx.addSignature(this.publicKey, signature);
    return tx;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

// Parses a signer URL and opens the underlying signer. The caller is
// responsible for `await signer.close()` once it is done — for a
// LedgerSigner this releases the USB HID handle so Ledger Live or
// another shell can attach immediately afterwards.
//
// Only two forms are accepted: a plain filesystem path, or a
// `usb://ledger?key=N[&change=M]` URL. `file://` is intentionally not
// supported — the `solana` CLI does not accept it at `--keypair`, so
// shipping it as a TypeScript-only alias would create a quiet
// capability hole at the first shellout.
export async function parseSignerURL(spec: string): Promise<Signer> {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error("signer URL is empty");
  }
  if (trimmed.startsWith("usb://")) {
    return openLedgerSignerFromURL(trimmed);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `unsupported signer URL scheme: ${trimmed}; only file paths and usb://ledger?key=N are accepted`,
    );
  }
  return KeypairSigner.fromFile(trimmed);
}

// Splits `usb://ledger?key=N[&change=M]` into the URL and the BIP32
// derivation path. Exported as a separate pure function so callers can
// validate a Ledger URL without opening the USB transport — tests
// exercise this without hardware, and a future "list ledger devices"
// command can reuse it.
export function parseLedgerURLSpec(spec: string): {
  url: string;
  derivationPath: string;
} {
  const url = new URL(spec);
  if (url.host !== "ledger") {
    throw new Error(
      `unsupported usb:// host ${url.host}; expected usb://ledger?key=N`,
    );
  }
  const keyParam = url.searchParams.get("key");
  if (keyParam === null) {
    throw new Error(
      `${spec}: usb://ledger URL must include ?key=N (the Solana account index)`,
    );
  }
  const key = Number.parseInt(keyParam, 10);
  if (
    !Number.isInteger(key) ||
    key < 0 ||
    key > 2 ** 31 - 1 ||
    String(key) !== keyParam
  ) {
    throw new Error(
      `${spec}: usb://ledger key must be a non-negative integer; got ${keyParam}`,
    );
  }
  const changeParam = url.searchParams.get("change");
  let change: number | null = null;
  if (changeParam !== null) {
    const parsed = Number.parseInt(changeParam, 10);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 2 ** 31 - 1 ||
      String(parsed) !== changeParam
    ) {
      throw new Error(
        `${spec}: usb://ledger change must be a non-negative integer; got ${changeParam}`,
      );
    }
    change = parsed;
  }
  return { url: spec, derivationPath: deriveSolanaPath(key, change) };
}

async function openLedgerSignerFromURL(spec: string): Promise<Signer> {
  const { derivationPath } = parseLedgerURLSpec(spec);
  return LedgerSigner.open(spec, derivationPath);
}

// Env-var helper for an operator-payer signer URL. Accepted forms are
// a plain filesystem path (must exist on disk; legacy file-key flow)
// or a `usb://ledger?key=N[&change=M]` URL (passed through
// unchanged; transport validation defers to LedgerSigner.open).
export function requireSignerURL(name: string): string {
  const v = requireEnv(name);
  if (v.startsWith("usb://")) {
    return v;
  }
  if (!fs.existsSync(v)) {
    throw new Error(`${name} does not point to a file: ${v}`);
  }
  return v;
}

// ---- Blind-sign verification printer ----

// Mapping of Squads-program instruction discriminators (the first 8
// bytes of `instruction.data`) to human-readable names. We keep this
// to the five instructions the release tooling actually composes so an
// unrecognised one prints as a raw hex prefix the operator can search
// for in the SDK source.
const SQUADS_DISCRIMINATORS: { name: string; bytes: Buffer }[] = [
  {
    name: "vaultTransactionCreate",
    bytes: Buffer.from(
      squadsGenerated.vaultTransactionCreateInstructionDiscriminator,
    ),
  },
  {
    name: "proposalCreate",
    bytes: Buffer.from(squadsGenerated.proposalCreateInstructionDiscriminator),
  },
  {
    name: "proposalApprove",
    bytes: Buffer.from(squadsGenerated.proposalApproveInstructionDiscriminator),
  },
  {
    name: "proposalCancelV2",
    bytes: Buffer.from(
      squadsGenerated.proposalCancelV2InstructionDiscriminator,
    ),
  },
  {
    name: "vaultTransactionExecute",
    bytes: Buffer.from(
      squadsGenerated.vaultTransactionExecuteInstructionDiscriminator,
    ),
  },
];

const SQUADS_PROGRAM_ID = squadsGenerated.PROGRAM_ID;

function decodeInstructionName(ix: TransactionInstruction): string {
  if (!ix.programId.equals(SQUADS_PROGRAM_ID)) {
    return "(non-Squads instruction)";
  }
  const head = Buffer.from(ix.data.subarray(0, Math.min(8, ix.data.length)));
  for (const entry of SQUADS_DISCRIMINATORS) {
    if (head.equals(entry.bytes)) {
      return entry.name;
    }
  }
  return `unrecognised Squads ix (discriminator=${head.toString("hex")})`;
}

export interface BlindSignContext {
  signer: Signer;
  label: string;
  message: Buffer;
  instructions: TransactionInstruction[];
  multisig?: PublicKey;
  vaultPDA?: PublicKey;
  proposalPDA?: PublicKey;
  transactionPDA?: PublicKey;
  transactionIndex?: bigint;
}

// Builds the verification block as a string. Tests can assert against
// the returned text without having to capture stderr; the runtime
// helper below writes the same string to stderr immediately before any
// LedgerSigner-backed signing call.
export function renderBlindSignContext(ctx: BlindSignContext): string {
  const lines: string[] = [];
  lines.push(
    "================ Ledger blind-sign verification ================",
  );
  lines.push(`About to sign: ${ctx.label}`);
  lines.push(`Targeting Squads program: ${SQUADS_PROGRAM_ID.toBase58()}`);
  lines.push("");
  lines.push("Instructions (in order):");
  ctx.instructions.forEach((ix, i) => {
    const name = decodeInstructionName(ix);
    lines.push(
      `  ${(i + 1).toString()}. ${ix.programId.toBase58()} :: ${name}`,
    );
  });
  lines.push("");
  if (ctx.multisig !== undefined) {
    lines.push(`Multisig:        ${ctx.multisig.toBase58()}`);
  }
  if (ctx.vaultPDA !== undefined) {
    lines.push(`Vault PDA:       ${ctx.vaultPDA.toBase58()}`);
  }
  if (ctx.transactionPDA !== undefined) {
    lines.push(`Transaction PDA: ${ctx.transactionPDA.toBase58()}`);
  }
  if (ctx.proposalPDA !== undefined) {
    lines.push(`Proposal PDA:    ${ctx.proposalPDA.toBase58()}`);
  }
  if (ctx.transactionIndex !== undefined) {
    lines.push(`Transaction index: ${ctx.transactionIndex.toString()}`);
  }
  lines.push("");
  const hash = createHash("sha256").update(ctx.message).digest("hex");
  lines.push(`Compiled message sha256: ${hash}`);
  lines.push("");
  lines.push("Confirm this hash matches the one shown on your Ledger device.");
  lines.push(
    "================================================================",
  );
  return lines.join("\n") + "\n";
}

export function printBlindSignContext(ctx: BlindSignContext): void {
  if (!(ctx.signer instanceof LedgerSigner)) {
    return;
  }
  process.stderr.write(renderBlindSignContext(ctx));
}
