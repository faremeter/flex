import { describe, test, expect } from "bun:test";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { generated as squadsGenerated } from "@sqds/multisig";
import { renderBlindSignContext } from "./blind-sign";
import { createKeypairSigner } from "./signer";

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
    const signer = createKeypairSigner(kp, "file:///test");
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
    const signer = createKeypairSigner(kp, "file:///test");
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
    const signer = createKeypairSigner(kp, "file:///test");
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
