import { describe, test, expect } from "bun:test";
import { createHash } from "crypto";
import { findSection, parseELFHeader } from "./elf";
import { buildELF } from "./elf.test";
import {
  extractFlexVersion,
  parseProgramDataSlot,
  parseUpgradeAuthority,
  skipProgramDataHeader,
} from "./program-version";

type BuildProgramDataOptions = {
  elfBytes: Uint8Array;
  upgradeAuthority?: "none" | "some";
  discriminatorOverride?: number;
  optionTagOverride?: number;
};

function buildProgramData(opts: BuildProgramDataOptions): Uint8Array {
  const authority = opts.upgradeAuthority ?? "none";
  const headerSize = authority === "none" ? 13 : 45;
  const out = new Uint8Array(headerSize + opts.elfBytes.byteLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, opts.discriminatorOverride ?? 3, true);
  view.setBigUint64(4, 12345n, true);
  const tag = opts.optionTagOverride ?? (authority === "none" ? 0 : 1);
  out[12] = tag;
  if (authority === "some" && opts.optionTagOverride === undefined) {
    for (let i = 0; i < 32; i++) {
      out[13 + i] = i + 1;
    }
  }
  out.set(opts.elfBytes, headerSize);
  return out;
}

function rodataWithVersion(version: string): Uint8Array {
  return new TextEncoder().encode(`FLEX_VERSION=${version}\0`);
}

describe("skipProgramDataHeader", () => {
  test("strips 13-byte None-authority header", () => {
    const elf = new Uint8Array([1, 2, 3, 4]);
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
    });
    expect(skipProgramDataHeader(account)).toEqual(elf);
  });

  test("strips 45-byte Some-authority header", () => {
    const elf = new Uint8Array([9, 8, 7, 6, 5]);
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "some",
    });
    expect(skipProgramDataHeader(account)).toEqual(elf);
  });

  test("throws on discriminator != 3", () => {
    const elf = new Uint8Array([0]);
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
      discriminatorOverride: 2,
    });
    expect(() => skipProgramDataHeader(account)).toThrow(/discriminator/i);
  });

  test("throws on invalid Option tag", () => {
    const elf = new Uint8Array([0]);
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
      optionTagOverride: 7,
    });
    expect(() => skipProgramDataHeader(account)).toThrow(/Option tag/i);
  });
});

describe("extractFlexVersion happy paths", () => {
  test("None-authority ProgramData ELF returns version 1.2.3", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.2.3") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
    });
    const elfBytes = skipProgramDataHeader(account);
    const header = parseELFHeader(elfBytes);
    const section = findSection(elfBytes, header, ".rodata");
    const rodata = elfBytes.subarray(
      section.offset,
      section.offset + section.size,
    );
    expect(extractFlexVersion(rodata)).toBe("1.2.3");
  });

  test("Some-authority ProgramData ELF returns embedded version", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("9.8.7") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "some",
    });
    const elfBytes = skipProgramDataHeader(account);
    const header = parseELFHeader(elfBytes);
    const section = findSection(elfBytes, header, ".rodata");
    const rodata = elfBytes.subarray(
      section.offset,
      section.offset + section.size,
    );
    expect(extractFlexVersion(rodata)).toBe("9.8.7");
  });

  test("throws when FLEX_VERSION= sentinel missing from .rodata", () => {
    const elf = buildELF({
      sections: [
        {
          name: ".rodata",
          contents: new TextEncoder().encode("nothing-to-see-here\0"),
        },
      ],
    });
    const header = parseELFHeader(elf);
    const section = findSection(elf, header, ".rodata");
    const rodata = elf.subarray(section.offset, section.offset + section.size);
    expect(() => extractFlexVersion(rodata)).toThrow(/FLEX_VERSION/);
  });

  test("sentinel in another section is not picked up", () => {
    const fakeSymtab = new TextEncoder().encode(
      "FLEX_VERSION=should-not-find\0",
    );
    const realRodata = new TextEncoder().encode("nope\0");
    const elf = buildELF({
      sections: [
        { name: ".rodata", contents: realRodata },
        { name: ".symtab", contents: fakeSymtab },
      ],
    });
    const header = parseELFHeader(elf);
    const section = findSection(elf, header, ".rodata");
    const rodata = elf.subarray(section.offset, section.offset + section.size);
    expect(() => extractFlexVersion(rodata)).toThrow(/FLEX_VERSION/);
  });

  test("throws when sentinel found but no terminating NUL", () => {
    const rodata = new TextEncoder().encode("FLEX_VERSION=1.0.0");
    expect(() => extractFlexVersion(rodata)).toThrow(/NUL/);
  });
});

describe("parseProgramDataSlot", () => {
  test("returns the bincode-encoded slot field", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
    });
    // buildProgramData hard-codes the slot field to 12345
    expect(parseProgramDataSlot(account)).toBe(12345n);
  });

  test("throws on discriminator mismatch", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      discriminatorOverride: 7,
    });
    expect(() => parseProgramDataSlot(account)).toThrow(
      /discriminator mismatch/,
    );
  });

  test("throws when account is shorter than 12 bytes", () => {
    expect(() => parseProgramDataSlot(new Uint8Array(8))).toThrow(
      /too short for slot field/,
    );
  });
});

describe("parseUpgradeAuthority", () => {
  test("returns null for None-authority header", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "none",
    });
    expect(parseUpgradeAuthority(account)).toBeNull();
  });

  test("returns the decoded authority PublicKey for Some-authority header", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "some",
    });
    // buildProgramData fills the 32-byte authority slot with [1, 2, 3, ..., 32]
    const result = parseUpgradeAuthority(account);
    expect(result).not.toBeNull();
    expect(result?.toBytes()).toEqual(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
    );
  });

  test("throws on invalid Option tag", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "some",
      optionTagOverride: 42,
    });
    expect(() => parseUpgradeAuthority(account)).toThrow(/Option tag invalid/);
  });

  test("throws on discriminator mismatch", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("1.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      discriminatorOverride: 7,
    });
    expect(() => parseUpgradeAuthority(account)).toThrow(
      /discriminator mismatch/,
    );
  });

  test("throws when account is shorter than the None-authority header", () => {
    expect(() => parseUpgradeAuthority(new Uint8Array(10))).toThrow(
      /too short for header/,
    );
  });
});

describe("sha256 verification surface", () => {
  test("sha256 hashes ELF bytes after header skip, not raw account bytes", () => {
    const elf = buildELF({
      sections: [{ name: ".rodata", contents: rodataWithVersion("2.0.0") }],
    });
    const account = buildProgramData({
      elfBytes: elf,
      upgradeAuthority: "some",
    });

    const elfBytes = skipProgramDataHeader(account);
    const elfHash = createHash("sha256").update(elfBytes).digest("hex");
    const accountHash = createHash("sha256").update(account).digest("hex");
    const directElfHash = createHash("sha256").update(elf).digest("hex");

    expect(elfHash).toBe(directElfHash);
    expect(elfHash).not.toBe(accountHash);
  });
});
