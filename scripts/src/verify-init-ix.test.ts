import { describe, test, expect } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { decodePayload } from "./verify-init-ix";

describe("decodePayload (verify-init)", () => {
  test("decodes a valid base58 payload to its underlying bytes", () => {
    // Encode known bytes to base58, then assert decodePayload returns them.
    const sample = Uint8Array.of(1, 2, 3, 4, 5, 0xaa, 0xff);
    const decoder = getBase58Decoder();
    // Build the b58 string by round-tripping: the decoder takes bytes
    // and returns the printable string form.
    const b58 = decoder.decode(sample);
    expect(decodePayload(b58)).toEqual(sample);
  });

  test("tolerates surrounding whitespace (trim)", () => {
    expect(decodePayload("\n  3DZBuV  \n")).toEqual(decodePayload("3DZBuV"));
  });

  test("throws loud on an empty payload", () => {
    expect(() => decodePayload("")).toThrow(/empty payload/);
    expect(() => decodePayload("   \n  ")).toThrow(/empty payload/);
  });

  test("throws loud on non-base58 characters", () => {
    // '0', 'O', 'I', 'l' are not in the base58 alphabet.
    expect(() => decodePayload("0OIl")).toThrow(/not base58/);
    // base64-with-padding payload (contains '=' which base58 lacks)
    expect(() => decodePayload("aGVsbG8=")).toThrow(/not base58/);
    // Whitespace inside the payload also disqualifies it.
    expect(() => decodePayload("abc def")).toThrow(/not base58/);
  });
});
