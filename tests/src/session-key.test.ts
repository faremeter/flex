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
} from "@faremeter/flex-solana";
import {
  createRpc,
  sendTx,
  fundKeypair,
  createEscrowHelper,
  expectToFail,
  defined,
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
});

describe("revoke_session_key", () => {
  it("sets revoked fields correctly", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 200, {
      maxSessionKeys: 10,
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
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 100_000_000,
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
});
