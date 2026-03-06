import { describe, it, expect, beforeAll } from "bun:test";
import {
  type Address,
  type KeyPairSigner,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  type TransactionSigner,
  generateKeyPairSigner,
  isSolanaError,
  unwrapSimulationError,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchEscrowAccount,
  getDepositInstructionAsync,
  getCloseEscrowInstruction,
  getRegisterSessionKeyInstructionAsync,
  FLEX_ERROR__MINT_LIMIT_REACHED,
  FLEX_ERROR__PENDING_SETTLEMENTS_EXIST,
  FLEX_ERROR__DUPLICATE_ACCOUNTS,
  FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR,
} from "@faremeter/flex-solana";
import {
  createRpc,
  sendTx,
  fundKeypair,
  createTestMint,
  createFundedTokenAccount,
  createEscrowHelper,
  submitAuthorizationHelper,
  fetchTokenBalance,
  expectToFail,
  withRemainingAccounts,
  defined,
} from "./helpers";

const ANCHOR_ERROR__ACCOUNT_NOT_SIGNER = 3010;

describe("create_escrow", () => {
  const rpc = createRpc();
  const owner = generateKeyPairSigner();
  const facilitator = generateKeyPairSigner();

  let ownerSigner: KeyPairSigner;
  let facilitatorSigner: KeyPairSigner;

  beforeAll(async () => {
    ownerSigner = await owner;
    facilitatorSigner = await facilitator;
    await fundKeypair(rpc, ownerSigner);
  });

  it("creates account with correct fields", async () => {
    const escrowPDA = await createEscrowHelper(
      rpc,
      ownerSigner,
      facilitatorSigner,
      0,
      {
        refundTimeoutSlots: 200,
        deadmanTimeoutSlots: 500,
        maxSessionKeys: 5,
      },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrow.version).toBe(1);
    expect(escrow.owner).toBe(ownerSigner.address);
    expect(escrow.facilitator).toBe(facilitatorSigner.address);
    expect(Number(escrow.index)).toBe(0);
    expect(Number(escrow.lastNonce)).toBe(0);
    expect(Number(escrow.pendingCount)).toBe(0);
    expect(Number(escrow.mintCount)).toBe(0);
    expect(Number(escrow.refundTimeoutSlots)).toBe(200);
    expect(Number(escrow.deadmanTimeoutSlots)).toBe(500);
    expect(escrow.maxSessionKeys).toBe(5);
    expect(escrow.sessionKeyCount).toBe(0);
    expect(escrow.bump).toBeGreaterThan(0);
    expect(Number(escrow.lastActivitySlot)).toBeGreaterThan(0);
  });

  it("creates multiple escrows for the same owner", async () => {
    const escrowPDA1 = await createEscrowHelper(
      rpc,
      ownerSigner,
      facilitatorSigner,
      10,
    );
    const escrowPDA2 = await createEscrowHelper(
      rpc,
      ownerSigner,
      facilitatorSigner,
      11,
    );

    const e1 = defined(await fetchEscrowAccount(rpc, escrowPDA1));
    const e2 = defined(await fetchEscrowAccount(rpc, escrowPDA2));
    expect(Number(e1.index)).toBe(10);
    expect(Number(e2.index)).toBe(11);
  });
});

describe("deposit", () => {
  const rpc = createRpc();

  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, payer);
  });

  it("deposits to a single mint and creates a vault", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 20);
    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 500_000,
    });
    await sendTx(rpc, owner, [depositIx]);

    const vaultAddress = defined(depositIx.accounts[3]).address;

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrow.mintCount)).toBe(1);

    const balance = await fetchTokenBalance(rpc, vaultAddress);
    expect(balance).toBe(500_000n);
  });

  it("deposits multiple mints up to the limit", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 21);

    for (let i = 0; i < 8; i++) {
      const mint = await createTestMint(rpc, payer);
      const source = await createFundedTokenAccount(
        rpc,
        mint.address,
        owner.address,
        payer,
        1_000n,
      );

      const depositIx = await getDepositInstructionAsync({
        depositor: owner,
        escrow: escrowPDA,
        mint: mint.address,
        source: source.address,
        amount: 1_000,
      });
      await sendTx(rpc, owner, [depositIx]);
    }

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrow.mintCount)).toBe(8);
  }, 30_000);

  it("rejects the 9th mint", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 22);

    for (let i = 0; i < 8; i++) {
      const mint = await createTestMint(rpc, payer);
      const source = await createFundedTokenAccount(
        rpc,
        mint.address,
        owner.address,
        payer,
        1_000n,
      );

      const depositIx = await getDepositInstructionAsync({
        depositor: owner,
        escrow: escrowPDA,
        mint: mint.address,
        source: source.address,
        amount: 1_000,
      });
      await sendTx(rpc, owner, [depositIx]);
    }

    const ninthMint = await createTestMint(rpc, payer);
    const ninthSource = await createFundedTokenAccount(
      rpc,
      ninthMint.address,
      owner.address,
      payer,
      1_000n,
    );

    await expectToFail(async () => {
      const depositIx = await getDepositInstructionAsync({
        depositor: owner,
        escrow: escrowPDA,
        mint: ninthMint.address,
        source: ninthSource.address,
        amount: 1_000,
      });
      await sendTx(rpc, owner, [depositIx]);
    }, FLEX_ERROR__MINT_LIMIT_REACHED);
  }, 30_000);

  it("reuses an existing vault on second deposit", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 23);
    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      2_000_000n,
    );

    const depositIx1 = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 700_000,
    });
    await sendTx(rpc, owner, [depositIx1]);

    const depositIx2 = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 300_000,
    });
    await sendTx(rpc, owner, [depositIx2]);

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrow.mintCount)).toBe(1);

    const vaultAddress = defined(depositIx1.accounts[3]).address;
    const balance = await fetchTokenBalance(rpc, vaultAddress);
    expect(balance).toBe(1_000_000n);
  });
});

describe("close_escrow", () => {
  const rpc = createRpc();

  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("transfers balances and closes the escrow", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 30);

    const mintA = await createTestMint(rpc, payer);
    const mintB = await createTestMint(rpc, payer);

    const sourceA = await createFundedTokenAccount(
      rpc,
      mintA.address,
      owner.address,
      payer,
      1_000_000n,
    );
    const sourceB = await createFundedTokenAccount(
      rpc,
      mintB.address,
      owner.address,
      payer,
      2_000_000n,
    );

    const depositIxA = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mintA.address,
      source: sourceA.address,
      amount: 1_000_000,
    });
    await sendTx(rpc, owner, [depositIxA]);

    const depositIxB = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mintB.address,
      source: sourceB.address,
      amount: 2_000_000,
    });
    await sendTx(rpc, owner, [depositIxB]);

    const vaultA = defined(depositIxA.accounts[3]).address;
    const vaultB = defined(depositIxB.accounts[3]).address;

    const destA = await createFundedTokenAccount(
      rpc,
      mintA.address,
      owner.address,
      payer,
      0n,
    );
    const destB = await createFundedTokenAccount(
      rpc,
      mintB.address,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getCloseEscrowInstruction({
      escrow: escrowPDA,
      owner,
      facilitator,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [
      vaultA,
      destA.address,
      vaultB,
      destB.address,
    ]);
    await sendTx(rpc, owner, [ix]);

    const destABalance = await fetchTokenBalance(rpc, destA.address);
    expect(destABalance).toBe(1_000_000n);

    const destBBalance = await fetchTokenBalance(rpc, destB.address);
    expect(destBBalance).toBe(2_000_000n);

    const vaultAInfo = await rpc
      .getAccountInfo(vaultA, { encoding: "base64" })
      .send();
    expect(vaultAInfo.value).toBeNull();

    const vaultBInfo = await rpc
      .getAccountInfo(vaultB, { encoding: "base64" })
      .send();
    expect(vaultBInfo.value).toBeNull();

    const escrowInfo = await rpc
      .getAccountInfo(escrowPDA, { encoding: "base64" })
      .send();
    expect(escrowInfo.value).toBeNull();
  }, 30_000);

  it("fails with pending settlements", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 34);

    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 500_000,
    });
    const vaultPDA = defined(depositIx.accounts[3]).address;

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyPDA = defined(registerIx.accounts[2]).address;

    await sendTx(rpc, owner, [depositIx, registerIx]);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint.address,
      facilitator.address,
      payer,
      0n,
    );

    await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint.address,
      vaultPDA,
      1,
      100_000,
      [{ recipient: recipient.address, bps: 10_000 }],
    );

    const dest = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__PENDING_SETTLEMENTS_EXIST);
  }, 30_000);

  it("fails without facilitator signature", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 31);

    try {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        // Pass address only so the facilitator does not sign the transaction
        facilitator: facilitator.address as Address & TransactionSigner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await sendTx(rpc, owner, [baseIx]);
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const cause = unwrapSimulationError(err);
      expect(
        isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM),
      ).toBe(true);
      if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
        expect(cause.context.code).toBe(ANCHOR_ERROR__ACCOUNT_NOT_SIGNER);
      }
    }
  });

  it("fails with duplicate mints in remaining accounts", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 32);

    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 500_000,
    });
    const vaultPDA = defined(depositIx.accounts[3]).address;
    await sendTx(rpc, owner, [depositIx]);

    const mint2 = await createTestMint(rpc, payer);
    const source2 = await createFundedTokenAccount(
      rpc,
      mint2.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIx2 = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint2.address,
      source: source2.address,
      amount: 500_000,
    });
    await sendTx(rpc, owner, [depositIx2]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [
        vaultPDA,
        dest.address,
        vaultPDA,
        dest.address,
      ]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__DUPLICATE_ACCOUNTS);
  });

  it("fails with wrong remaining accounts count", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 33);

    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 500_000,
    });
    await sendTx(rpc, owner, [depositIx]);

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await sendTx(rpc, owner, [baseIx]);
    }, FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR);
  });
});
