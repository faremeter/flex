// Hand-rolled instruction builders for the BPF Loader Upgradeable program.
//
// No published TypeScript client builds these instructions canonically:
//
// - `@solana/web3.js` v1 exports `BpfLoader` and `Loader` for the older,
//   non-upgradeable loaders, but no helper for the upgradeable variant.
// - `@solana-program/solana-loader-v3` (under the official solana-program
//   org) does generate kit-native builders for this program. At the time
//   of writing it sat at v0.3.0 with low adoption and no production-
//   readiness statement; taking a pre-1.0 dependency on a load-bearing
//   mainnet release tool means accepting upstream API drift we can't
//   predict. If that client reaches 1.0 with broad adoption, revisit
//   this file and consider migrating to it.
//
// The underlying on-chain program has not changed in years, so the
// byte encoding here is permanent. Forty lines of explicit bytes is
// the smaller maintenance burden compared to tracking a 0.x client.

import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  deriveProgramDataAddress,
} from "./bpf-loader-pda";

// Re-export so existing `import { BPF_LOADER_UPGRADEABLE_PROGRAM_ID }
// from "./bpf-loader-ix"` call sites continue to work.
export { BPF_LOADER_UPGRADEABLE_PROGRAM_ID };

const UPGRADE_DISCRIMINATOR = Buffer.from([0x03, 0x00, 0x00, 0x00]);
const CLOSE_DISCRIMINATOR = Buffer.from([0x05, 0x00, 0x00, 0x00]);

export type BuildUpgradeIxArgs = {
  programId: PublicKey;
  bufferAccount: PublicKey;
  authority: PublicKey;
};

export function buildUpgradeIx(
  args: BuildUpgradeIxArgs,
): TransactionInstruction {
  const programData = deriveProgramDataAddress(args.programId);
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: args.programId, isSigner: false, isWritable: true },
      { pubkey: args.bufferAccount, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: UPGRADE_DISCRIMINATOR,
  });
}

export type BuildCloseBufferIxArgs = {
  bufferAccount: PublicKey;
  authority: PublicKey;
  recipient: PublicKey;
};

export function buildCloseBufferIx(
  args: BuildCloseBufferIxArgs,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    keys: [
      { pubkey: args.bufferAccount, isSigner: false, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: CLOSE_DISCRIMINATOR,
  });
}

export type BuildCloseProgramDataIxArgs = {
  programId: PublicKey;
  authority: PublicKey;
  recipient: PublicKey;
};

// The BPF Loader Upgradeable Close instruction has two account-list
// shapes that share the same 0x05 discriminator:
//
//   3 accounts -> close a Buffer (recipient receives rent; buffer is
//                 deallocated). Implemented by buildCloseBufferIx above.
//   4 accounts -> close a ProgramData (recipient receives rent;
//                 ProgramData becomes Uninitialized; the associated
//                 Program account is marked uninvokable). The 4th
//                 account is the Program itself, which must be
//                 writable so the loader can update its state to
//                 reflect the closed program-data.
//
// Closing a ProgramData is a TERMINAL operation: once executed the
// program ID can never be re-deployed because the ProgramData PDA was
// consumed by the original deploy and on-chain state will refuse a
// fresh deploy under the same program ID. Use with care.
export function buildCloseProgramDataIx(
  args: BuildCloseProgramDataIxArgs,
): TransactionInstruction {
  const programData = deriveProgramDataAddress(args.programId);
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.programId, isSigner: false, isWritable: true },
    ],
    data: CLOSE_DISCRIMINATOR,
  });
}
