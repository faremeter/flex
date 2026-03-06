import { type Address, getAddressEncoder } from "@solana/kit";

export function writeU16LE(buf: Uint8Array, offset: number, value: number) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(offset, value, true);
  return offset + 2;
}

export function writeU32LE(buf: Uint8Array, offset: number, value: number) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(offset, value, true);
  return offset + 4;
}

export function writeU64LE(buf: Uint8Array, offset: number, value: bigint) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(offset, value, true);
  return offset + 8;
}

export function writeAddress(buf: Uint8Array, offset: number, addr: Address) {
  buf.set(getAddressEncoder().encode(addr), offset);
  return offset + 32;
}
