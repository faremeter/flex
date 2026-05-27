import { describe, test, expect } from "bun:test";
import { parsePublishedSha } from "./rollback";

const SAMPLE_SHA =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("parsePublishedSha", () => {
  test("returns the 64-hex sha from a plain hash-only line", () => {
    expect(parsePublishedSha(SAMPLE_SHA)).toBe(SAMPLE_SHA);
  });

  test("returns the sha from a sha256sum-style line with the expected filename", () => {
    expect(parsePublishedSha(`${SAMPLE_SHA}  flex.so`)).toBe(SAMPLE_SHA);
  });

  test("normalises CRLF and trailing whitespace before parsing", () => {
    expect(parsePublishedSha(`${SAMPLE_SHA}  flex.so\r\n\n`)).toBe(SAMPLE_SHA);
  });

  test("only considers the first line; trailing lines are ignored", () => {
    const text = `${SAMPLE_SHA}  flex.so\nGARBAGE`;
    expect(parsePublishedSha(text)).toBe(SAMPLE_SHA);
  });

  test("lower-cases the hex so callers can compare verbatim against sha256OfBuffer", () => {
    expect(parsePublishedSha(SAMPLE_SHA.toUpperCase())).toBe(SAMPLE_SHA);
  });

  test("throws loud on empty input", () => {
    expect(() => parsePublishedSha("")).toThrow(/empty/);
    expect(() => parsePublishedSha("\n\n  ")).toThrow(/empty/);
  });

  test("throws loud when the first line is not <64-hex>[  <filename>]", () => {
    expect(() => parsePublishedSha("not-a-sha")).toThrow(/not "<64-hex>/);
    // 63 hex characters
    expect(() => parsePublishedSha("a".repeat(63))).toThrow(/not "<64-hex>/);
    // 65 hex characters
    expect(() => parsePublishedSha("a".repeat(65))).toThrow(/not "<64-hex>/);
    // 64 hex but trailing non-space junk
    expect(() => parsePublishedSha(`${SAMPLE_SHA}garbage`)).toThrow(
      /not "<64-hex>/,
    );
  });

  test("throws loud when the line names a filename other than flex.so", () => {
    expect(() => parsePublishedSha(`${SAMPLE_SHA}  somethingelse.so`)).toThrow(
      /names filename/,
    );
  });
});
