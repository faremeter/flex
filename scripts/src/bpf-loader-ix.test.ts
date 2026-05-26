import { describe, test, expect } from "bun:test";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  buildCloseBufferIx,
  buildCloseProgramDataIx,
  buildUpgradeIx,
} from "./bpf-loader-ix";

// Neutral well-known addresses used as test stand-ins. The test does not
// invoke chain, so any valid Solana address suffices. Avoid the project's
// own program ID here so the test does not have to be touched on every
// program-ID rotation.
const SAMPLE_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const SAMPLE_BUFFER = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
const SAMPLE_AUTHORITY = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const SAMPLE_RECIPIENT = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// Externally-verified ProgramData PDA fixture: the Squads v4 multisig
// program ID and the ProgramData PDA the BPF Loader Upgradeable
// assigns to it. PDA derivation is a pure function of the program ID
// and the loader, so the pair is the canonical answer regardless of
// cluster; a match here proves our derivation agrees with the
// canonical `[program_id]` seeding rather than an accidental variant
// (e.g. `["ProgramData", program_id]`).
const CANONICAL_PROGRAM = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);
const CANONICAL_PROGRAM_DATA = new PublicKey(
  "Fy3YMJCvwbAXUgUM5b91ucUVA3jYzwWLHL3MwBqKsh8n",
);

describe("buildUpgradeIx", () => {
  test("targets bpf_loader_upgradeable with discriminator 3 (u32 LE)", () => {
    const ix = buildUpgradeIx({
      programId: SAMPLE_PROGRAM_ID,
      bufferAccount: SAMPLE_BUFFER,
      authority: SAMPLE_AUTHORITY,
    });
    expect(ix.programId.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)).toBe(true);
    expect(ix.data).toEqual(Buffer.from([0x03, 0x00, 0x00, 0x00]));
  });

  test("emits the seven-account upgrade layout in the documented order", () => {
    const ix = buildUpgradeIx({
      programId: SAMPLE_PROGRAM_ID,
      bufferAccount: SAMPLE_BUFFER,
      authority: SAMPLE_AUTHORITY,
    });
    expect(ix.keys).toHaveLength(7);

    // ProgramData PDA is derived; just assert it's writable and non-signer.
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[0]?.isSigner).toBe(false);

    expect(ix.keys[1]?.pubkey.equals(SAMPLE_PROGRAM_ID)).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(SAMPLE_BUFFER)).toBe(true);
    expect(ix.keys[3]?.pubkey.equals(SAMPLE_AUTHORITY)).toBe(true); // spill
    expect(ix.keys[4]?.pubkey.equals(SYSVAR_RENT_PUBKEY)).toBe(true);
    expect(ix.keys[5]?.pubkey.equals(SYSVAR_CLOCK_PUBKEY)).toBe(true);
    expect(ix.keys[6]?.pubkey.equals(SAMPLE_AUTHORITY)).toBe(true);
    expect(ix.keys[6]?.isSigner).toBe(true);
  });

  test("places the canonical ProgramData PDA in keys[0]", () => {
    // Same external-ground-truth assertion as the close-program-data
    // test below: a wrong PDA here would produce upgrade transactions
    // that reference a non-existent account and fail on-chain.
    const ix = buildUpgradeIx({
      programId: CANONICAL_PROGRAM,
      bufferAccount: SAMPLE_BUFFER,
      authority: SAMPLE_AUTHORITY,
    });
    expect(ix.keys[0]?.pubkey.equals(CANONICAL_PROGRAM_DATA)).toBe(true);
  });
});

describe("buildCloseBufferIx", () => {
  test("targets bpf_loader_upgradeable with discriminator 5 (u32 LE)", () => {
    const ix = buildCloseBufferIx({
      bufferAccount: SAMPLE_BUFFER,
      authority: SAMPLE_AUTHORITY,
      recipient: SAMPLE_RECIPIENT,
    });
    expect(ix.programId.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)).toBe(true);
    expect(ix.data).toEqual(Buffer.from([0x05, 0x00, 0x00, 0x00]));
  });

  test("emits the three-account close layout: buffer, recipient, authority", () => {
    const ix = buildCloseBufferIx({
      bufferAccount: SAMPLE_BUFFER,
      authority: SAMPLE_AUTHORITY,
      recipient: SAMPLE_RECIPIENT,
    });
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0]?.pubkey.equals(SAMPLE_BUFFER)).toBe(true);
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[1]?.pubkey.equals(SAMPLE_RECIPIENT)).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(SAMPLE_AUTHORITY)).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
    expect(ix.keys[2]?.isWritable).toBe(false);
  });
});

describe("buildCloseProgramDataIx", () => {
  test("targets bpf_loader_upgradeable with discriminator 5 (u32 LE)", () => {
    const ix = buildCloseProgramDataIx({
      programId: SAMPLE_PROGRAM_ID,
      authority: SAMPLE_AUTHORITY,
      recipient: SAMPLE_RECIPIENT,
    });
    expect(ix.programId.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)).toBe(true);
    // Same discriminator as close-buffer; the on-chain dispatcher
    // distinguishes by account count, not by data prefix.
    expect(ix.data).toEqual(Buffer.from([0x05, 0x00, 0x00, 0x00]));
  });

  test("emits the four-account program-data close layout in spec order", () => {
    const ix = buildCloseProgramDataIx({
      programId: SAMPLE_PROGRAM_ID,
      authority: SAMPLE_AUTHORITY,
      recipient: SAMPLE_RECIPIENT,
    });
    expect(ix.keys).toHaveLength(4);

    // ProgramData PDA is derived from the program ID; assert structure
    // only (writable, non-signer).
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[0]?.isSigner).toBe(false);

    expect(ix.keys[1]?.pubkey.equals(SAMPLE_RECIPIENT)).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(true);

    expect(ix.keys[2]?.pubkey.equals(SAMPLE_AUTHORITY)).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
    expect(ix.keys[2]?.isWritable).toBe(false);

    // The program account is the 4-account form's distinguishing slot;
    // it must be writable so the loader can mark it uninvokable.
    expect(ix.keys[3]?.pubkey.equals(SAMPLE_PROGRAM_ID)).toBe(true);
    expect(ix.keys[3]?.isWritable).toBe(true);
    expect(ix.keys[3]?.isSigner).toBe(false);
  });

  test("derives the canonical ProgramData PDA for the given program ID", () => {
    // The BPF Loader Upgradeable derives ProgramData from a single seed:
    // `[program_id.as_ref()]`. The mainnet pair below is independent
    // ground truth (see CANONICAL_PROGRAM / CANONICAL_PROGRAM_DATA),
    // so a mismatch here means the derivation has acquired a spurious
    // extra seed (the historical regression this test guards against).
    const ix = buildCloseProgramDataIx({
      programId: CANONICAL_PROGRAM,
      authority: SAMPLE_AUTHORITY,
      recipient: SAMPLE_RECIPIENT,
    });
    expect(ix.keys[0]?.pubkey.equals(CANONICAL_PROGRAM_DATA)).toBe(true);
  });
});
