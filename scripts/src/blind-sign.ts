// Operator-facing verification block for Squads blind-sign signing.
//
// The Ledger Solana app does not decode Squads instructions; signing a
// Squads proposal on-device is a blind-sign. To compensate, this module
// prints a cross-checkable block to stderr before any LedgerSigner
// signing call. The block names the targeted Squads program, the
// decoded discriminator for each instruction we recognise, the
// multisig/vault/proposal/transaction PDAs, the transaction index, and
// the sha256 of the serialised message — the same hash the Ledger
// Solana app displays in blind-sign mode for sight-comparison against
// the device screen.

import {
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { generated as squadsGenerated } from "@sqds/multisig";
import type { Signer } from "./signer";

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
    return ix.programId.toBase58();
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
  cosignerPubkeys?: PublicKey[];
  multisig?: PublicKey;
  vaultPDA?: PublicKey;
  proposalPDA?: PublicKey;
  transactionPDA?: PublicKey;
  transactionIndex?: bigint;
}

// Builds the verification block as a string. Tests can assert against
// the returned text without having to capture stderr; the runtime
// helper below writes the same string to stderr immediately before any
// Ledger-backed signing call.
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
  lines.push(`Fee payer:       ${ctx.signer.publicKey.toBase58()}`);
  if (ctx.cosignerPubkeys !== undefined && ctx.cosignerPubkeys.length > 0) {
    ctx.cosignerPubkeys.forEach((pk, i) => {
      lines.push(`Cosigner ${(i + 1).toString()}:      ${pk.toBase58()}`);
    });
  }
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
  // KeypairSigner doesn't blind-sign; only the Ledger path needs the
  // cross-checkable block.
  if (ctx.signer.url.startsWith("usb://")) {
    process.stderr.write(renderBlindSignContext(ctx));
  }
}
