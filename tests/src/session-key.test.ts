import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchSessionKey,
  getRegisterSessionKeyInstructionAsync,
  getRevokeSessionKeyInstruction,
  getCloseSessionKeyInstruction,
  FLEX_ERROR__SESSION_KEY_LIMIT_REACHED,
  FLEX_ERROR__SESSION_KEY_REVOKED,
  FLEX_ERROR__SESSION_KEY_STILL_ACTIVE,
  FLEX_ERROR__SESSION_KEY_GRACE_PERIOD_ACTIVE,
  FLEX_ERROR__SESSION_KEYS_EXIST,
  FLEX_ERROR__SESSION_KEY_ALREADY_EXPIRED,
  FLEX_ERROR__GRACE_PERIOD_EXCEEDS_REFUND_TIMEOUT,
  getCloseEscrowInstruction,
} from "@faremeter/flex-solana";
import {
  createRpc,
  sendTx,
  fundKeypair,
  createEscrowHelper,
  expectToFail,
  expectToFailWithAnchorError,
  ANCHOR_ERROR__CONSTRAINT_HAS_ONE,
  defined,
  waitForSlot,
} from "./helpers";

const rpc = createRpc();

let owner: KeyPairSigner;
let facilitator: KeyPairSigner;

beforeAll(async () => {
  owner = await generateKeyPairSigner();
  facilitator = await generateKeyPairSigner();
  await fundKeypair(rpc, owner);
});

describe("register_session_key", () => {
  it("creates PDA and increments session key count", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 100, {
      maxSessionKeys: 10,
      refundTimeoutSlots: 2000,
      deadmanTimeoutSlots: 4000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 1000,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const ska = defined(await fetchSessionKey(rpc, skPDA));
    expect(ska.version).toBe(1);
    expect(ska.active).toBe(true);
    expect(ska.escrow).toBe(escrowPDA);
    expect(ska.key).toBe(sessionKey.address);
    expect(ska.expiresAtSlot).toBeNull();
    expect(ska.revokedAtSlot).toBeNull();
    expect(Number(ska.revocationGracePeriodSlots)).toBe(1000);
    expect(Number(ska.createdAtSlot)).toBeGreaterThan(0);
    expect(ska.bump).toBeGreaterThan(0);

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrow.sessionKeyCount).toBe(1);
  }, 30_000);

  it("respects max_session_keys limit", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 101, {
      maxSessionKeys: 1,
    });

    const sk1 = await generateKeyPairSigner();
    const registerIx1 = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sk1.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    await sendTx(rpc, owner, [registerIx1]);

    const sk2 = await generateKeyPairSigner();
    const registerIx2 = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sk2.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });

    await expectToFail(
      () => sendTx(rpc, owner, [registerIx2]),
      FLEX_ERROR__SESSION_KEY_LIMIT_REACHED,
    );
  }, 15_000);

  it("stores a non-null expires_at_slot", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 102, {
      maxSessionKeys: 10,
      refundTimeoutSlots: 1000,
      deadmanTimeoutSlots: 2000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: 999_999,
      revocationGracePeriodSlots: 500,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const ska = defined(await fetchSessionKey(rpc, skPDA));
    expect(Number(ska.expiresAtSlot)).toBe(999_999);
    expect(Number(ska.revocationGracePeriodSlots)).toBe(500);
  }, 15_000);

  it("rejects already-expired expires_at_slot", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 105, {
      maxSessionKeys: 10,
    });

    const sessionKey = await generateKeyPairSigner();

    // Use slot 0, which is unambiguously in the past
    await expectToFailWithAnchorError(async () => {
      const registerIx = await getRegisterSessionKeyInstructionAsync({
        owner,
        escrow: escrowPDA,
        sessionKey: sessionKey.address,
        expiresAtSlot: 0,
        revocationGracePeriodSlots: 100,
      });
      await sendTx(rpc, owner, [registerIx]);
    }, FLEX_ERROR__SESSION_KEY_ALREADY_EXPIRED);
  }, 15_000);

  it("rejects grace period > refund timeout", async () => {
    const refundTimeout = 150;
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 106, {
      maxSessionKeys: 10,
      refundTimeoutSlots: refundTimeout,
    });

    const sessionKey = await generateKeyPairSigner();

    // Grace period greater than refund timeout should fail
    await expectToFailWithAnchorError(async () => {
      const registerIx = await getRegisterSessionKeyInstructionAsync({
        owner,
        escrow: escrowPDA,
        sessionKey: sessionKey.address,
        expiresAtSlot: null,
        revocationGracePeriodSlots: refundTimeout + 1,
      });
      await sendTx(rpc, owner, [registerIx]);
    }, FLEX_ERROR__GRACE_PERIOD_EXCEEDS_REFUND_TIMEOUT);

    // Grace period equal to refund timeout should succeed
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: refundTimeout,
    });
    await sendTx(rpc, owner, [registerIx]);

    // Grace period less than refund timeout should also succeed
    const sessionKey2 = await generateKeyPairSigner();
    const registerIx2 = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey2.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: refundTimeout - 1,
    });
    await sendTx(rpc, owner, [registerIx2]);
  }, 15_000);

  it("allows unlimited keys when maxSessionKeys is 0", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 103, {
      maxSessionKeys: 0,
    });

    for (let i = 0; i < 3; i++) {
      const sk = await generateKeyPairSigner();
      const registerIx = await getRegisterSessionKeyInstructionAsync({
        owner,
        escrow: escrowPDA,
        sessionKey: sk.address,
        expiresAtSlot: null,
        revocationGracePeriodSlots: 0,
      });
      await sendTx(rpc, owner, [registerIx]);
    }

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrow.sessionKeyCount).toBe(3);
  }, 15_000);

  it("fails with non-owner signer", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 104, {
      maxSessionKeys: 10,
    });

    const wrongOwner = await generateKeyPairSigner();
    await fundKeypair(rpc, wrongOwner);

    const sessionKey = await generateKeyPairSigner();
    await expectToFailWithAnchorError(async () => {
      const registerIx = await getRegisterSessionKeyInstructionAsync({
        owner: wrongOwner,
        escrow: escrowPDA,
        sessionKey: sessionKey.address,
        expiresAtSlot: null,
        revocationGracePeriodSlots: 0,
      });
      await sendTx(rpc, wrongOwner, [registerIx]);
    }, ANCHOR_ERROR__CONSTRAINT_HAS_ONE);
  }, 15_000);
});

describe("revoke_session_key", () => {
  it("sets revoked fields correctly", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 200, {
      maxSessionKeys: 10,
      refundTimeoutSlots: 2000,
      deadmanTimeoutSlots: 4000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 1000,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    const ska = defined(await fetchSessionKey(rpc, skPDA));
    expect(ska.active).toBe(false);
    expect(ska.revokedAtSlot).not.toBeNull();
    expect(Number(defined(ska.revokedAtSlot))).toBeGreaterThan(0);
  });

  it("fails for an already-revoked key", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 201, {
      maxSessionKeys: 10,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    await expectToFail(async () => {
      const revokeIx2 = getRevokeSessionKeyInstruction({
        owner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, owner, [revokeIx2]);
    }, FLEX_ERROR__SESSION_KEY_REVOKED);
  });

  it("fails with non-owner signer", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 202, {
      maxSessionKeys: 10,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const wrongOwner = await generateKeyPairSigner();
    await fundKeypair(rpc, wrongOwner);

    await expectToFailWithAnchorError(async () => {
      const revokeIx = getRevokeSessionKeyInstruction({
        owner: wrongOwner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, wrongOwner, [revokeIx]);
    }, ANCHOR_ERROR__CONSTRAINT_HAS_ONE);
  });
});

describe("close_session_key", () => {
  it("fails for an active (non-revoked) session key", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 300, {
      maxSessionKeys: 10,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    await expectToFail(async () => {
      const closeIx = getCloseSessionKeyInstruction({
        owner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, owner, [closeIx]);
    }, FLEX_ERROR__SESSION_KEY_STILL_ACTIVE);
  });

  it("closes after grace period elapses", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 301, {
      maxSessionKeys: 10,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    const closeIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [closeIx]);

    const info = await rpc.getAccountInfo(skPDA, { encoding: "base64" }).send();
    expect(info.value).toBeNull();
  });

  it("fails during grace period", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 302, {
      maxSessionKeys: 10,
      refundTimeoutSlots: 1_000_000,
      deadmanTimeoutSlots: 2_000_000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 500_000,
    });
    const sessionKeyAccountMeta = registerIx.accounts[2];
    if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
    const skPDA = sessionKeyAccountMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    await expectToFail(async () => {
      const closeIx = getCloseSessionKeyInstruction({
        owner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, owner, [closeIx]);
    }, FLEX_ERROR__SESSION_KEY_GRACE_PERIOD_ACTIVE);
  });

  it("decrements session_key_count on close", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 303, {
      maxSessionKeys: 10,
    });

    const sk1 = await generateKeyPairSigner();
    const registerIx1 = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sk1.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sk1Meta = registerIx1.accounts[2];
    if (!sk1Meta) throw new Error("session key meta missing");
    const sk1PDA = sk1Meta.address;

    const sk2 = await generateKeyPairSigner();
    const registerIx2 = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sk2.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    await sendTx(rpc, owner, [registerIx1, registerIx2]);

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowBefore.sessionKeyCount).toBe(2);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sk1PDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    const closeIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sk1PDA,
    });
    await sendTx(rpc, owner, [closeIx]);

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.sessionKeyCount).toBe(1);
  });

  it("closes active key in deadman mode after timeout expires", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 304, {
      deadmanTimeoutSlots: 1000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 100,
    });
    const skMeta = registerIx.accounts[2];
    if (!skMeta) throw new Error("session key meta missing");
    const skPDA = skMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    // Key is active and not revoked — normal close should fail
    await expectToFail(async () => {
      const closeIx = getCloseSessionKeyInstruction({
        owner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, owner, [closeIx]);
    }, FLEX_ERROR__SESSION_KEY_STILL_ACTIVE);

    // Wait for deadman timeout
    const currentSlot = await rpc.getSlot().send();
    await waitForSlot(rpc, currentSlot + 1100n);

    // Deadman mode: close active key directly
    const closeIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [closeIx]);

    const info = await rpc.getAccountInfo(skPDA, { encoding: "base64" }).send();
    expect(info.value).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.sessionKeyCount).toBe(0);
  });

  it("closes revoked key in grace period via deadman mode", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 305, {
      deadmanTimeoutSlots: 1000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 100,
    });
    const skMeta = registerIx.accounts[2];
    if (!skMeta) throw new Error("session key meta missing");
    const skPDA = skMeta.address;
    await sendTx(rpc, owner, [registerIx]);

    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    // Normal close should fail: grace period hasn't elapsed
    await expectToFail(async () => {
      const closeIx = getCloseSessionKeyInstruction({
        owner,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      });
      await sendTx(rpc, owner, [closeIx]);
    }, FLEX_ERROR__SESSION_KEY_GRACE_PERIOD_ACTIVE);

    // Wait for deadman timeout
    const currentSlot = await rpc.getSlot().send();
    await waitForSlot(rpc, currentSlot + 1100n);

    // Deadman mode bypasses grace period check
    const closeIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: skPDA,
    });
    await sendTx(rpc, owner, [closeIx]);

    const info = await rpc.getAccountInfo(skPDA, { encoding: "base64" }).send();
    expect(info.value).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.sessionKeyCount).toBe(0);
  });
});

describe("close_escrow requires session key cleanup", () => {
  it("rejects close_escrow when session keys exist", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 310);

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    await sendTx(rpc, owner, [registerIx]);

    await expectToFailWithAnchorError(async () => {
      const closeIx = getCloseEscrowInstruction({
        owner,
        facilitator,
        escrow: escrowPDA,
      });
      await sendTx(rpc, owner, [closeIx]);
    }, FLEX_ERROR__SESSION_KEYS_EXIST);
  });
});
