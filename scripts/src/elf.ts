// Minimal ELF64 parser tailored to one task: finding `.rodata` in a Solana
// SBF program so the downgrade guard can scan it for the FLEX_VERSION
// sentinel. It deliberately does not pull in a general ELF library
// (`elfy`, `@types/elf-tools`, etc.) because the only consumer reads one
// section out of one well-formed shape — a 64-bit little-endian ELF
// produced by `solana-verify build` — and a vendor-grade parser would
// import order-of-magnitude more code, plus a transitive dependency
// surface, to enable cases this codebase will never hit. Pulling that in
// for thirty lines of section-table walking is not a trade we want.
//
// In return for that simplicity, this module is NOT a general ELF
// implementation:
//
// - It rejects anything that is not ELF64 little-endian.
// - It rejects `SHN_XINDEX` (extended section indexing) rather than
//   resolving the real string-table index from `section[0].sh_link`.
// - It exposes only the fields and operations the downgrade-guard flow
//   needs: a minimal `ELFHeader`, a minimal `ELFSection` (name offset,
//   byte offset, size), and a section lookup by name.
// - It does not parse program headers, relocations, the symbol table,
//   dynamic linking, or note sections. It will not help with debugging
//   or instrumentation tasks that need any of those.
//
// If a future task needs more of ELF than this surface, prefer adding a
// scoped helper alongside the existing functions over expanding this
// module's coverage in passing. If broader ELF support becomes
// load-bearing, revisit the dependency question rather than letting this
// file drift into a half-implementation.

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
const ELF_CLASS_64 = 2;
const ELF_DATA_LE = 1;
const ELF_SHENTSIZE_64 = 64;
const SHN_XINDEX = 0xffff;

export type ELFHeader = {
  shoff: number;
  shentsize: number;
  shnum: number;
  shstrndx: number;
};

export type ELFSection = {
  nameOffset: number;
  offset: number;
  size: number;
};

export function parseELFHeader(elfBytes: Uint8Array): ELFHeader {
  if (elfBytes.byteLength < 0x40) {
    throw new Error(
      `ELF too short for 64-bit header: ${elfBytes.byteLength} bytes`,
    );
  }

  for (let i = 0; i < ELF_MAGIC.length; i++) {
    const expected = ELF_MAGIC[i];
    const actual = elfBytes[i];
    if (expected === undefined) {
      throw new Error(`ELF magic table index ${i} out of range`);
    }
    if (actual !== expected) {
      throw new Error(
        `ELF magic mismatch at offset ${i}: expected 0x${expected.toString(16)}, got 0x${(actual ?? 0).toString(16)}`,
      );
    }
  }

  const classByte = elfBytes[4];
  if (classByte !== ELF_CLASS_64) {
    throw new Error(
      `ELF class unsupported: expected ${ELF_CLASS_64} (64-bit), got ${classByte}`,
    );
  }

  const dataByte = elfBytes[5];
  if (dataByte !== ELF_DATA_LE) {
    throw new Error(
      `ELF encoding unsupported: expected ${ELF_DATA_LE} (little-endian), got ${dataByte}`,
    );
  }

  const view = new DataView(
    elfBytes.buffer,
    elfBytes.byteOffset,
    elfBytes.byteLength,
  );

  const shoffBig = view.getBigUint64(0x28, true);
  if (shoffBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ELF e_shoff exceeds safe integer range: ${shoffBig}`);
  }
  const shoff = Number(shoffBig);
  const shentsize = view.getUint16(0x3a, true);
  const shnum = view.getUint16(0x3c, true);
  const shstrndx = view.getUint16(0x3e, true);

  if (shentsize !== ELF_SHENTSIZE_64) {
    throw new Error(
      `ELF e_shentsize mismatch: expected ${ELF_SHENTSIZE_64}, got ${shentsize}`,
    );
  }

  if (shstrndx === SHN_XINDEX) {
    throw new Error(
      `ELF e_shstrndx is SHN_XINDEX (0xFFFF); extended section indexing is not supported`,
    );
  }

  if (shstrndx >= shnum) {
    throw new Error(
      `ELF e_shstrndx (${shstrndx}) >= e_shnum (${shnum}); section header string table index out of range`,
    );
  }

  return { shoff, shentsize, shnum, shstrndx };
}

function readSectionEntry(
  elfBytes: Uint8Array,
  header: ELFHeader,
  index: number,
): ELFSection {
  const entryOffset = header.shoff + index * header.shentsize;
  if (entryOffset + header.shentsize > elfBytes.byteLength) {
    throw new Error(
      `ELF section header entry ${index} out of bounds at offset ${entryOffset}`,
    );
  }
  const view = new DataView(
    elfBytes.buffer,
    elfBytes.byteOffset,
    elfBytes.byteLength,
  );

  const nameOffset = view.getUint32(entryOffset + 0x00, true);
  const offsetBig = view.getBigUint64(entryOffset + 0x18, true);
  const sizeBig = view.getBigUint64(entryOffset + 0x20, true);

  if (
    offsetBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    sizeBig > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      `ELF section entry ${index} has offset or size exceeding safe integer range`,
    );
  }

  return {
    nameOffset,
    offset: Number(offsetBig),
    size: Number(sizeBig),
  };
}

function readCString(bytes: Uint8Array, start: number): string {
  let end = start;
  while (end < bytes.byteLength && bytes[end] !== 0) {
    end++;
  }
  if (end >= bytes.byteLength) {
    throw new Error(
      `ELF string table read at offset ${start} has no terminating NUL`,
    );
  }
  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

export function findSection(
  elfBytes: Uint8Array,
  header: ELFHeader,
  sectionName: string,
): ELFSection {
  const shstrEntry = readSectionEntry(elfBytes, header, header.shstrndx);
  if (shstrEntry.offset + shstrEntry.size > elfBytes.byteLength) {
    throw new Error(
      `ELF section header string table extends beyond ELF buffer`,
    );
  }
  const shstrBytes = elfBytes.subarray(
    shstrEntry.offset,
    shstrEntry.offset + shstrEntry.size,
  );

  for (let i = 0; i < header.shnum; i++) {
    const entry = readSectionEntry(elfBytes, header, i);
    if (entry.nameOffset >= shstrBytes.byteLength) {
      continue;
    }
    const name = readCString(shstrBytes, entry.nameOffset);
    if (name === sectionName) {
      return entry;
    }
  }

  throw new Error(`ELF section ${sectionName} not found`);
}
