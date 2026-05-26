import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { deriveProgramDataAddress } from "./bpf-loader-pda";
import { findSection, parseELFHeader } from "./elf";

const PROGRAM_DATA_DISCRIMINATOR = 3;
const PROGRAM_DATA_HEADER_NONE = 13;
const PROGRAM_DATA_HEADER_SOME = 45;

const FLEX_VERSION_SENTINEL = "FLEX_VERSION=";

async function fetchProgramDataBytes(
  connection: Connection,
  programId: PublicKey,
): Promise<Uint8Array> {
  const programDataAddress = deriveProgramDataAddress(programId);
  const info = await connection.getAccountInfo(programDataAddress, "confirmed");

  if (info === null) {
    throw new Error(
      `ProgramData account ${programDataAddress.toBase58()} for program ${programId.toBase58()} not found`,
    );
  }

  return Uint8Array.from(info.data);
}

/**
 * Read the `slot` field from a ProgramData account's bincode header.
 * This is the slot at which the program was last deployed/upgraded —
 * the load-bearing value for release-metadata bookkeeping. Reading
 * the cluster's current slot at sha-match-detection time is racy and
 * publishes a different number than the one the chain recorded.
 */
export async function readProgramDataSlot(
  connection: Connection,
  programId: PublicKey,
): Promise<bigint> {
  return parseProgramDataSlot(
    await fetchProgramDataBytes(connection, programId),
  );
}

export function parseProgramDataSlot(accountBytes: Uint8Array): bigint {
  if (accountBytes.byteLength < 12) {
    throw new Error(
      `ProgramData account too short for slot field: ${accountBytes.byteLength} bytes`,
    );
  }
  const view = new DataView(
    accountBytes.buffer,
    accountBytes.byteOffset,
    accountBytes.byteLength,
  );
  const discriminator = view.getUint32(0, true);
  if (discriminator !== PROGRAM_DATA_DISCRIMINATOR) {
    throw new Error(
      `ProgramData discriminator mismatch: expected ${PROGRAM_DATA_DISCRIMINATOR}, got ${discriminator}`,
    );
  }
  return view.getBigUint64(4, true);
}

/**
 * Read the current `upgrade_authority` from a ProgramData account.
 * Returns `null` if the program is frozen (no authority set).
 * Used by the initial-deploy script's Phase 2 hand-off check before
 * the operator types in the vault PDA.
 */
export async function readUpgradeAuthority(
  connection: Connection,
  programId: PublicKey,
): Promise<PublicKey | null> {
  return parseUpgradeAuthority(
    await fetchProgramDataBytes(connection, programId),
  );
}

export function parseUpgradeAuthority(
  accountBytes: Uint8Array,
): PublicKey | null {
  if (accountBytes.byteLength < PROGRAM_DATA_HEADER_NONE) {
    throw new Error(
      `ProgramData account too short for header: ${accountBytes.byteLength} bytes`,
    );
  }
  const view = new DataView(
    accountBytes.buffer,
    accountBytes.byteOffset,
    accountBytes.byteLength,
  );
  const discriminator = view.getUint32(0, true);
  if (discriminator !== PROGRAM_DATA_DISCRIMINATOR) {
    throw new Error(
      `ProgramData discriminator mismatch: expected ${PROGRAM_DATA_DISCRIMINATOR}, got ${discriminator}`,
    );
  }
  const tag = view.getUint8(12);
  if (tag === 0) {
    return null;
  }
  if (tag !== 1) {
    throw new Error(
      `ProgramData upgrade_authority Option tag invalid: expected 0 or 1, got ${tag}`,
    );
  }
  if (accountBytes.byteLength < PROGRAM_DATA_HEADER_SOME) {
    throw new Error(
      `ProgramData account too short for Some(authority) header: ${accountBytes.byteLength} < ${PROGRAM_DATA_HEADER_SOME}`,
    );
  }
  const authorityBytes = accountBytes.subarray(13, PROGRAM_DATA_HEADER_SOME);
  return new PublicKey(authorityBytes);
}

export function skipProgramDataHeader(accountBytes: Uint8Array): Uint8Array {
  if (accountBytes.byteLength < 4) {
    throw new Error(
      `ProgramData account too short for discriminator: ${accountBytes.byteLength} bytes`,
    );
  }

  const view = new DataView(
    accountBytes.buffer,
    accountBytes.byteOffset,
    accountBytes.byteLength,
  );

  const discriminator = view.getUint32(0, true);
  if (discriminator !== PROGRAM_DATA_DISCRIMINATOR) {
    throw new Error(
      `ProgramData discriminator mismatch: expected ${PROGRAM_DATA_DISCRIMINATOR}, got ${discriminator}`,
    );
  }

  if (accountBytes.byteLength < 13) {
    throw new Error(
      `ProgramData account too short for header: ${accountBytes.byteLength} bytes`,
    );
  }

  const upgradeAuthorityTag = view.getUint8(12);
  let headerSize: number;
  if (upgradeAuthorityTag === 0) {
    headerSize = PROGRAM_DATA_HEADER_NONE;
  } else if (upgradeAuthorityTag === 1) {
    headerSize = PROGRAM_DATA_HEADER_SOME;
  } else {
    throw new Error(
      `ProgramData upgrade_authority Option tag invalid: expected 0 or 1, got ${upgradeAuthorityTag}`,
    );
  }

  if (accountBytes.byteLength < headerSize) {
    throw new Error(
      `ProgramData account too short for ${upgradeAuthorityTag === 0 ? "None" : "Some"} header: ${accountBytes.byteLength} < ${headerSize}`,
    );
  }

  return accountBytes.subarray(headerSize);
}

export function extractFlexVersion(rodata: Uint8Array): string {
  const sentinelBytes = new TextEncoder().encode(FLEX_VERSION_SENTINEL);

  outer: for (
    let i = 0;
    i + sentinelBytes.byteLength <= rodata.byteLength;
    i++
  ) {
    for (let j = 0; j < sentinelBytes.byteLength; j++) {
      if (rodata[i + j] !== sentinelBytes[j]) {
        continue outer;
      }
    }
    const start = i + sentinelBytes.byteLength;
    let end = start;
    while (end < rodata.byteLength && rodata[end] !== 0) {
      end++;
    }
    if (end >= rodata.byteLength) {
      throw new Error(
        `FLEX_VERSION sentinel found at offset ${i} but no terminating NUL before end of .rodata`,
      );
    }
    return new TextDecoder("utf-8").decode(rodata.subarray(start, end));
  }

  throw new Error(
    `FLEX_VERSION= sentinel not found in .rodata; program was built without the embedded version marker`,
  );
}

export async function readDeployedVersion(
  connection: Connection,
  programId: PublicKey,
): Promise<string> {
  const accountBytes = await fetchProgramDataBytes(connection, programId);
  const elfBytes = skipProgramDataHeader(accountBytes);
  const header = parseELFHeader(elfBytes);
  const rodataSection = findSection(elfBytes, header, ".rodata");

  if (rodataSection.offset + rodataSection.size > elfBytes.byteLength) {
    throw new Error(
      `.rodata section extends beyond ELF buffer: offset=${rodataSection.offset}, size=${rodataSection.size}, elf-size=${elfBytes.byteLength}`,
    );
  }

  const rodata = elfBytes.subarray(
    rodataSection.offset,
    rodataSection.offset + rodataSection.size,
  );
  return extractFlexVersion(rodata);
}

// `expectedSize` must be the byte length of the local .so the caller
// is comparing against. ProgramData is allocated with `--max-len`
// worth of space and the trailing portion is zero-padded; hashing
// past `expectedSize` produces a sha that depends on the padding
// length rather than the deployed program, so the result would never
// match the local file. The parameter is required for that reason.
export async function sha256OfDeployedProgram(
  connection: Connection,
  programId: PublicKey,
  expectedSize: number,
): Promise<string> {
  const accountBytes = await fetchProgramDataBytes(connection, programId);
  const elfBytes = skipProgramDataHeader(accountBytes);
  const bytesToHash = elfBytes.subarray(0, expectedSize);
  return createHash("sha256").update(bytesToHash).digest("hex");
}
