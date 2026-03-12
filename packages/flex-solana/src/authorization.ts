import { type Address, type Instruction, address } from "@solana/kit";

import { writeAddress, writeU16LE, writeU32LE, writeU64LE } from "./codec";

const ED25519_PROGRAM_ID = address(
  "Ed25519SigVerify111111111111111111111111111",
);

export type SplitInput = {
  recipient: Address;
  bps: number;
};

export type SerializePaymentAuthorizationArgs = {
  programId: Address;
  escrow: Address;
  mint: Address;
  maxAmount: bigint;
  authorizationId: bigint;
  expiresAtSlot: bigint;
  splits: SplitInput[];
};

export function serializePaymentAuthorization(
  args: SerializePaymentAuthorizationArgs,
): Uint8Array {
  const splitCount = args.splits.length;
  const size = 32 + 32 + 32 + 8 + 8 + 8 + 4 + 34 * splitCount;
  const buf = new Uint8Array(size);

  let offset = 0;
  offset = writeAddress(buf, offset, args.programId);
  offset = writeAddress(buf, offset, args.escrow);
  offset = writeAddress(buf, offset, args.mint);
  offset = writeU64LE(buf, offset, args.maxAmount);
  offset = writeU64LE(buf, offset, args.authorizationId);
  offset = writeU64LE(buf, offset, args.expiresAtSlot);
  offset = writeU32LE(buf, offset, splitCount);

  for (const split of args.splits) {
    offset = writeAddress(buf, offset, split.recipient);
    offset = writeU16LE(buf, offset, split.bps);
  }

  return buf;
}

export async function signPaymentAuthorization(args: {
  message: Uint8Array;
  keyPair: CryptoKeyPair;
}): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    args.keyPair.privateKey,
    args.message,
  );
  return new Uint8Array(signature);
}

/**
 * Builds the instruction data for the Ed25519 precompile program.
 *
 * Header layout:
 *   u8   num_signatures = 1
 *   u8   padding = 0
 *
 * Entry layout (one per signature):
 *   u16  signature_offset
 *   u16  signature_instruction_index = 0xFFFF (inline)
 *   u16  public_key_offset
 *   u16  public_key_instruction_index = 0xFFFF (inline)
 *   u16  message_data_offset
 *   u16  message_data_size
 *   u16  message_instruction_index = 0xFFFF (inline)
 *
 * Data:
 *   [64 bytes] signature
 *   [32 bytes] public_key
 *   [N bytes]  message
 */
export function createEd25519VerifyInstruction(args: {
  publicKey: Address;
  message: Uint8Array;
  signature: Uint8Array;
}): Instruction {
  const HEADER_SIZE = 2;
  const ENTRY_SIZE = 14;
  const dataStart = HEADER_SIZE + ENTRY_SIZE;

  const signatureOffset = dataStart;
  const publicKeyOffset = signatureOffset + 64;
  const messageOffset = publicKeyOffset + 32;
  const messageSize = args.message.length;

  const totalSize = messageOffset + messageSize;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Header
  data[0] = 1; // num_signatures
  data[1] = 0; // padding

  // Entry
  let off = 2;
  view.setUint16(off, signatureOffset, true);
  off += 2;
  view.setUint16(off, 0xffff, true); // sig_ix_idx = inline
  off += 2;
  view.setUint16(off, publicKeyOffset, true);
  off += 2;
  view.setUint16(off, 0xffff, true); // pk_ix_idx = inline
  off += 2;
  view.setUint16(off, messageOffset, true);
  off += 2;
  view.setUint16(off, messageSize, true);
  off += 2;
  view.setUint16(off, 0xffff, true); // msg_ix_idx = inline

  // Data: signature
  data.set(args.signature.subarray(0, 64), signatureOffset);

  // Data: public key
  writeAddress(data, publicKeyOffset, args.publicKey);

  // Data: message
  data.set(args.message, messageOffset);

  return {
    programAddress: ED25519_PROGRAM_ID,
    data,
  };
}
