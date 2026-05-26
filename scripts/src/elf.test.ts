import { describe, test, expect } from "bun:test";
import { findSection, parseELFHeader } from "./elf";

export type SectionDef = {
  name: string;
  contents: Uint8Array;
};

export type BuildELFOptions = {
  sections: SectionDef[];
  shstrndxOverride?: number;
  classByteOverride?: number;
  magicOverride?: Uint8Array;
  shentsizeOverride?: number;
};

const ELF_HEADER_SIZE = 0x40;
const SECTION_ENTRY_SIZE = 64;

/**
 * Programmatic synthetic-ELF builder used by every test that needs a
 * well-formed (or deliberately malformed) ELF64-little-endian buffer to
 * exercise the parser. Exported so `program-version.test.ts` can build
 * the same fixtures without re-implementing them.
 */
export function buildELF(opts: BuildELFOptions): Uint8Array {
  const sectionsWithNull: SectionDef[] = [
    { name: "", contents: new Uint8Array(0) },
    ...opts.sections,
  ];

  const shstrtabBytes: number[] = [];
  const nameOffsets: number[] = [];
  for (const s of sectionsWithNull) {
    nameOffsets.push(shstrtabBytes.length);
    for (const ch of new TextEncoder().encode(s.name)) {
      shstrtabBytes.push(ch);
    }
    shstrtabBytes.push(0);
  }
  const shstrtabContents = Uint8Array.from(shstrtabBytes);

  const allSections: SectionDef[] = [
    ...sectionsWithNull,
    { name: ".shstrtab", contents: shstrtabContents },
  ];
  nameOffsets.push(shstrtabBytes.length);
  for (const ch of new TextEncoder().encode(".shstrtab")) {
    shstrtabBytes.push(ch);
  }
  shstrtabBytes.push(0);
  const finalShstrtab = Uint8Array.from(shstrtabBytes);
  allSections[allSections.length - 1] = {
    name: ".shstrtab",
    contents: finalShstrtab,
  };

  const sectionOffsets: number[] = [];
  let cursor = ELF_HEADER_SIZE;
  for (const [i, section] of allSections.entries()) {
    if (i === 0) {
      sectionOffsets.push(0);
      continue;
    }
    sectionOffsets.push(cursor);
    cursor += section.contents.byteLength;
  }

  const shoff = cursor;
  const totalSize = shoff + allSections.length * SECTION_ENTRY_SIZE;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  const magic = opts.magicOverride ?? new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  buf.set(magic, 0);
  buf[4] = opts.classByteOverride ?? 2;
  buf[5] = 1;
  buf[6] = 1;

  view.setBigUint64(0x28, BigInt(shoff), true);
  view.setUint16(0x3a, opts.shentsizeOverride ?? SECTION_ENTRY_SIZE, true);
  view.setUint16(0x3c, allSections.length, true);
  const shstrndx = opts.shstrndxOverride ?? allSections.length - 1;
  view.setUint16(0x3e, shstrndx, true);

  for (const [i, section] of allSections.entries()) {
    const sectionOffset = sectionOffsets[i];
    const nameOffset = nameOffsets[i];
    if (sectionOffset === undefined || nameOffset === undefined) {
      throw new Error(`buildELF: missing offset for section index ${i}`);
    }
    if (i !== 0) {
      buf.set(section.contents, sectionOffset);
    }

    const entryOff = shoff + i * SECTION_ENTRY_SIZE;
    view.setUint32(entryOff + 0x00, nameOffset, true);
    view.setUint32(entryOff + 0x04, i === 0 ? 0 : 1, true);
    view.setBigUint64(entryOff + 0x08, 0n, true);
    view.setBigUint64(entryOff + 0x10, 0n, true);
    view.setBigUint64(entryOff + 0x18, BigInt(sectionOffset), true);
    view.setBigUint64(
      entryOff + 0x20,
      BigInt(section.contents.byteLength),
      true,
    );
    view.setUint32(entryOff + 0x28, 0, true);
    view.setUint32(entryOff + 0x2c, 0, true);
    view.setBigUint64(entryOff + 0x30, 0n, true);
    view.setBigUint64(entryOff + 0x38, 0n, true);
  }

  return buf;
}

function rodataWithSentinel(version: string): Uint8Array {
  return new TextEncoder().encode(`FLEX_VERSION=${version}\0`);
}

describe("parseELFHeader", () => {
  test("throws on bad magic", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithSentinel("1.0.0") }],
      magicOverride: new Uint8Array([0x7f, 0x45, 0x4c, 0x47]),
    });
    expect(() => parseELFHeader(elf)).toThrow(/magic/i);
  });

  test("throws on class != 2", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithSentinel("1.0.0") }],
      classByteOverride: 1,
    });
    expect(() => parseELFHeader(elf)).toThrow(/class/i);
  });

  test("throws on SHN_XINDEX", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithSentinel("1.0.0") }],
      shstrndxOverride: 0xffff,
    });
    expect(() => parseELFHeader(elf)).toThrow(/SHN_XINDEX/);
  });

  test("throws on shstrndx >= shnum", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithSentinel("1.0.0") }],
      shstrndxOverride: 99,
    });
    expect(() => parseELFHeader(elf)).toThrow(/shstrndx/);
  });

  test("throws on shentsize != 64", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithSentinel("1.0.0") }],
      shentsizeOverride: 32,
    });
    expect(() => parseELFHeader(elf)).toThrow(/shentsize/);
  });
});

describe("findSection", () => {
  test("throws when the requested section is absent", () => {
    const elf = buildELF({
      sections: [{ name: ".text", contents: new Uint8Array([0xaa, 0xbb]) }],
    });
    const header = parseELFHeader(elf);
    expect(() => findSection(elf, header, ".rodata")).toThrow(/\.rodata/);
  });
});
