import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { generated as squadsGenerated } from "@sqds/multisig";
import {
  KeypairSigner,
  LedgerSigner,
  parseLedgerURLSpec,
  parseSignerURL,
  requireSignerURL,
  renderBlindSignContext,
} from "./signer";
import type Solana from "@ledgerhq/hw-app-solana";
import type Transport from "@ledgerhq/hw-transport";

function writeKeypairFile(kp: Keypair): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "flex-signer-")),
    "kp.json",
  );
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return file;
}

describe("parseLedgerURLSpec", () => {
  test("derives the standard Solana path for key=0", () => {
    expect(parseLedgerURLSpec("usb://ledger?key=0")).toEqual({
      url: "usb://ledger?key=0",
      derivationPath: "44'/501'/0'",
    });
  });

  test("derives the standard Solana path for key=3", () => {
    expect(parseLedgerURLSpec("usb://ledger?key=3").derivationPath).toBe(
      "44'/501'/3'",
    );
  });

  test("appends the change level when supplied", () => {
    expect(
      parseLedgerURLSpec("usb://ledger?key=0&change=7").derivationPath,
    ).toBe("44'/501'/0'/7'");
  });

  test("rejects a non-ledger host", () => {
    expect(() => parseLedgerURLSpec("usb://device?key=0")).toThrow(
      /unsupported usb:\/\/ host/,
    );
  });

  test("rejects when key is missing", () => {
    expect(() => parseLedgerURLSpec("usb://ledger")).toThrow(
      /must include \?key=N/,
    );
  });

  test("rejects a negative key", () => {
    expect(() => parseLedgerURLSpec("usb://ledger?key=-1")).toThrow(
      /non-negative integer/,
    );
  });

  test("rejects a non-numeric key", () => {
    expect(() => parseLedgerURLSpec("usb://ledger?key=foo")).toThrow(
      /non-negative integer/,
    );
  });

  test("rejects a fractional key", () => {
    expect(() => parseLedgerURLSpec("usb://ledger?key=1.5")).toThrow(
      /non-negative integer/,
    );
  });

  test("rejects a fractional change", () => {
    expect(() => parseLedgerURLSpec("usb://ledger?key=0&change=2.5")).toThrow(
      /non-negative integer/,
    );
  });
});

describe("parseSignerURL", () => {
  test("returns a KeypairSigner for a plain filesystem path", async () => {
    const kp = Keypair.generate();
    const file = writeKeypairFile(kp);
    try {
      const signer = await parseSignerURL(file);
      expect(signer).toBeInstanceOf(KeypairSigner);
      expect(signer.publicKey.equals(kp.publicKey)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });

  test("returns a KeypairSigner for a file:// URL", async () => {
    const kp = Keypair.generate();
    const file = writeKeypairFile(kp);
    try {
      const signer = await parseSignerURL(`file://${file}`);
      expect(signer).toBeInstanceOf(KeypairSigner);
      expect(signer.publicKey.equals(kp.publicKey)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });

  test("rejects an unknown URL scheme", async () => {
    let captured: unknown = null;
    try {
      await parseSignerURL("ssh://example/key");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(
      /unsupported signer URL scheme/,
    );
  });

  test("rejects an empty input", async () => {
    let captured: unknown = null;
    try {
      await parseSignerURL("  ");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/signer URL is empty/);
  });
});

describe("KeypairSigner", () => {
  test("signTransaction attaches a signature in the fee-payer slot", async () => {
    const kp = Keypair.generate();
    const signer = KeypairSigner.fromKeypair(kp);
    const tx = new Transaction({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
      feePayer: signer.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: PublicKey.default,
        lamports: 1n,
      }),
    );
    await signer.signTransaction(tx);
    expect(tx.signatures[0]?.publicKey.equals(signer.publicKey)).toBe(true);
    expect(tx.signatures[0]?.signature).not.toBeNull();
    expect(tx.verifySignatures()).toBe(true);
  });

  test("signVersionedTransaction attaches a verifiable signature", async () => {
    const kp = Keypair.generate();
    const signer = KeypairSigner.fromKeypair(kp);
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: PublicKey.default,
          lamports: 1n,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    await signer.signVersionedTransaction(tx);
    // V0 layout: signatures[i] corresponds to staticAccountKeys[i]; the
    // fee payer is index 0.
    expect(tx.signatures[0]).not.toEqual(new Uint8Array(64));
  });

  test("close is a no-op", async () => {
    const signer = KeypairSigner.fromKeypair(Keypair.generate());
    await signer.close();
  });
});

// LedgerSigner tests use a constructed instance with a mocked Solana
// app and a no-op transport. We cannot exercise the open() path
// without hardware, but we can exercise the message-handoff codepath
// that open() returns to.
function makeLedgerSignerForTest(args: {
  kp: Keypair;
  derivationPath?: string;
  signature?: Buffer;
  onSign?: (path: string, message: Buffer) => void;
}): LedgerSigner {
  const transport = { close: async () => undefined } as unknown as Transport;
  const recordedSignature = args.signature ?? Buffer.alloc(64, 0xab);
  const app = {
    signTransaction: async (devicePath: string, message: Buffer) => {
      args.onSign?.(devicePath, message);
      return { signature: recordedSignature };
    },
  } as unknown as Solana;
  const LedgerCtor = LedgerSigner as unknown as new (
    t: Transport,
    a: Solana,
    p: string,
    b: boolean,
    pk: Buffer,
    u: string,
  ) => LedgerSigner;
  return new LedgerCtor(
    transport,
    app,
    args.derivationPath ?? "44'/501'/0'",
    true,
    args.kp.publicKey.toBuffer(),
    "usb://ledger?key=0",
  );
}

describe("LedgerSigner", () => {
  test("publicKey, url, derivationPath, and blindSigningEnabled reflect the constructor", () => {
    const kp = Keypair.generate();
    const signer = makeLedgerSignerForTest({ kp });
    expect(signer.publicKey.equals(kp.publicKey)).toBe(true);
    expect(signer.url).toBe("usb://ledger?key=0");
    expect(signer.derivationPath).toBe("44'/501'/0'");
    expect(signer.blindSigningEnabled).toBe(true);
  });

  test("signTransaction hands the compiled message bytes to the device and attaches the returned signature", async () => {
    const kp = Keypair.generate();
    const fakeSig = Buffer.alloc(64, 0xcd);
    const handed: { path: string; message: Buffer }[] = [];
    const signer = makeLedgerSignerForTest({
      kp,
      signature: fakeSig,
      onSign: (devicePath, message) => {
        handed.push({ path: devicePath, message });
      },
    });
    const tx = new Transaction({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
      feePayer: signer.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: PublicKey.default,
        lamports: 1n,
      }),
    );
    const expectedMessage = Buffer.from(tx.compileMessage().serialize());
    await signer.signTransaction(tx);
    expect(handed).toHaveLength(1);
    const call = handed[0];
    if (call === undefined) {
      throw new Error("unreachable: length asserted above");
    }
    expect(call.path).toBe("44'/501'/0'");
    expect(call.message.equals(expectedMessage)).toBe(true);
    const sigSlot = tx.signatures[0];
    if (sigSlot?.signature == null) {
      throw new Error("transaction missing fee-payer signature slot");
    }
    expect(sigSlot.publicKey.equals(signer.publicKey)).toBe(true);
    expect(Buffer.from(sigSlot.signature).equals(fakeSig)).toBe(true);
  });

  test("signVersionedTransaction hands the v0 message bytes to the device and attaches the returned signature", async () => {
    const kp = Keypair.generate();
    const fakeSig = Buffer.alloc(64, 0xef);
    const handed: { path: string; message: Buffer }[] = [];
    const signer = makeLedgerSignerForTest({
      kp,
      signature: fakeSig,
      onSign: (devicePath, message) => {
        handed.push({ path: devicePath, message });
      },
    });
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: PublicKey.default,
          lamports: 1n,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const expectedMessage = Buffer.from(tx.message.serialize());
    await signer.signVersionedTransaction(tx);
    expect(handed).toHaveLength(1);
    const call = handed[0];
    if (call === undefined) {
      throw new Error("unreachable: length asserted above");
    }
    expect(call.message.equals(expectedMessage)).toBe(true);
    const sig0 = tx.signatures[0];
    if (sig0 === undefined) {
      throw new Error("v0 transaction missing fee-payer signature slot");
    }
    expect(Buffer.from(sig0).equals(fakeSig)).toBe(true);
  });
});

describe("requireSignerURL", () => {
  const VAR = "FLEX_SIGNER_URL_TEST_VAR";
  const original = process.env[VAR];

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, VAR);
    } else {
      process.env[VAR] = original;
    }
  });

  test("returns a usb://ledger URL without touching the filesystem", () => {
    process.env[VAR] = "usb://ledger?key=0";
    expect(requireSignerURL(VAR)).toBe("usb://ledger?key=0");
  });

  test("returns a file:// URL without further validation", () => {
    process.env[VAR] = "file:///nonexistent/path.json";
    expect(requireSignerURL(VAR)).toBe("file:///nonexistent/path.json");
  });

  test("returns a plain path when it exists on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex-signer-url-"));
    const file = path.join(dir, "kp.json");
    fs.writeFileSync(file, "[]");
    process.env[VAR] = file;
    try {
      expect(requireSignerURL(VAR)).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("throws when a plain path does not exist", () => {
    process.env[VAR] = "/nonexistent/path.json";
    expect(() => requireSignerURL(VAR)).toThrow(/does not point to a file/);
  });
});

describe("renderBlindSignContext", () => {
  function makeSquadsIx(
    discriminator: readonly number[],
    extraBytes = 0,
  ): TransactionInstruction {
    const data = Buffer.alloc(discriminator.length + extraBytes);
    Buffer.from(discriminator).copy(data, 0);
    return new TransactionInstruction({
      programId: squadsGenerated.PROGRAM_ID,
      keys: [],
      data,
    });
  }

  test("decodes the five Squads instructions and includes the message hash", () => {
    const kp = Keypair.generate();
    const signer = KeypairSigner.fromKeypair(kp);
    const message = Buffer.from("deadbeef", "hex");
    const multisig = new PublicKey(
      "So11111111111111111111111111111111111111112",
    );
    const out = renderBlindSignContext({
      signer,
      label: "vaultTransactionCreate + proposalCreate",
      message,
      instructions: [
        makeSquadsIx(
          squadsGenerated.vaultTransactionCreateInstructionDiscriminator,
          4,
        ),
        makeSquadsIx(squadsGenerated.proposalCreateInstructionDiscriminator),
      ],
      multisig,
      transactionIndex: 7n,
    });
    expect(out).toContain("vaultTransactionCreate + proposalCreate");
    expect(out).toContain("vaultTransactionCreate");
    expect(out).toContain("proposalCreate");
    expect(out).toContain("Multisig:        " + multisig.toBase58());
    expect(out).toContain("Transaction index: 7");
    // sha256 of 0xdeadbeef computed independently:
    //   printf '\xde\xad\xbe\xef' | shasum -a 256
    expect(out).toContain(
      "Compiled message sha256: 5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953",
    );
  });

  test("flags unrecognised Squads instructions with their hex prefix", () => {
    const kp = Keypair.generate();
    const signer = KeypairSigner.fromKeypair(kp);
    const unknownDisc = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = renderBlindSignContext({
      signer,
      label: "test",
      message: Buffer.from([]),
      instructions: [
        new TransactionInstruction({
          programId: squadsGenerated.PROGRAM_ID,
          keys: [],
          data: unknownDisc,
        }),
      ],
    });
    expect(out).toContain(
      "unrecognised Squads ix (discriminator=0102030405060708)",
    );
  });

  test("non-Squads instruction prints program ID for both sides", () => {
    const kp = Keypair.generate();
    const signer = KeypairSigner.fromKeypair(kp);
    const otherProgram = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const out = renderBlindSignContext({
      signer,
      label: "test",
      message: Buffer.from([]),
      instructions: [
        new TransactionInstruction({
          programId: otherProgram,
          keys: [],
          data: Buffer.from([0]),
        }),
      ],
    });
    expect(out).toContain(
      `1. ${otherProgram.toBase58()} :: ${otherProgram.toBase58()}`,
    );
  });
});
