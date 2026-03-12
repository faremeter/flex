import {
  type Address,
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  type TransactionSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";

import type {
  x402PaymentRequirements,
  x402PaymentPayload,
  x402SettleResponse,
  x402SupportedKind,
  x402VerifyResponse,
} from "@faremeter/types/x402v2";
import type {
  FacilitatorHandler,
  GetRequirementsArgs,
} from "@faremeter/types/facilitator";
import { lookupX402Network } from "@faremeter/info/solana";
import { isValidationError } from "@faremeter/types";
import { generateMatcher, FLEX_SCHEME } from "../common";
import { FlexPaymentPayload } from "../types";
import {
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  type SplitInput,
} from "../authorization";
import {
  fetchEscrowAccount,
  fetchSessionKey,
  findPendingSettlementsByEscrow,
} from "../query";
import {
  getSubmitAuthorizationInstructionAsync,
  FLEX_PROGRAM_ADDRESS,
} from "../generated";
import { logger } from "../logger";
import { createHoldManager, type Hold, type HoldManager } from "./hold-manager";
import type { EscrowAccountData, SessionKeyData } from "../types";

const MS_PER_SLOT = 400;
const DEFAULT_MIN_GRACE_PERIOD_SLOTS = 150n;
const DEFAULT_CONFIRMATION_BUFFER_SLOTS = 20n;
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 10_000;

type FlexFacilitatorConfig = {
  supportedMints: Address[];
  defaultSplits: { recipient: string; bps: number }[];
  facilitatorFeeBps?: number;
  maxSubmitRetries?: number;
  submitRetryDelayMs?: number;
  minGracePeriodSlots?: bigint;
  confirmationBufferSlots?: bigint;
  snapshotMaxAgeMs?: number;
  flushIntervalMs?: number;
};

type EscrowSnapshot = {
  account: EscrowAccountData;
  vaultByMint: Map<Address, bigint>;
  onChainCommittedByMint: Map<Address, bigint>;
  fetchedAtMs: number;
};

type CachedSessionKey = {
  data: SessionKeyData;
  fetchedAtMs: number;
};

export type FlushResult = {
  authorizationId: bigint;
  success: boolean;
  transaction?: string;
  error?: string;
};

export type FlexFacilitator = FacilitatorHandler & {
  flush(): Promise<FlushResult[]>;
  getHoldManager(): HoldManager;
  stop(): void;
};

export const createFacilitatorHandler = async (
  network: string,
  rpc: Rpc<SolanaRpcApi>,
  facilitatorSigner: TransactionSigner,
  config: FlexFacilitatorConfig,
): Promise<FlexFacilitator> => {
  const { maxSubmitRetries = 30, submitRetryDelayMs = 1000 } = config;
  const minGracePeriodSlots =
    config.minGracePeriodSlots ?? DEFAULT_MIN_GRACE_PERIOD_SLOTS;
  const confirmationBufferSlots =
    config.confirmationBufferSlots ?? DEFAULT_CONFIRMATION_BUFFER_SLOTS;
  const snapshotMaxAgeMs =
    config.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
  const facilitatorFeeBps = config.facilitatorFeeBps ?? 0;
  const facilitatorAddress = facilitatorSigner.address;

  const solanaNetwork = lookupX402Network(network);
  const networkId = solanaNetwork.caip2;

  const matchers = config.supportedMints.map((mint) =>
    generateMatcher(network, mint),
  );

  const holdManager = createHoldManager();
  const escrowSnapshots = new Map<Address, EscrowSnapshot>();
  const sessionKeyCache = new Map<Address, CachedSessionKey>();

  let lastKnownSlot = 0n;
  let lastSlotFetchedAtMs = 0;

  async function refreshSlot(): Promise<bigint> {
    lastKnownSlot = await rpc.getSlot().send();
    lastSlotFetchedAtMs = Date.now();
    return lastKnownSlot;
  }

  function estimateCurrentSlot(): bigint {
    if (lastKnownSlot === 0n) return 0n;
    const elapsedMs = Date.now() - lastSlotFetchedAtMs;
    return lastKnownSlot + BigInt(Math.floor(elapsedMs / MS_PER_SLOT));
  }

  async function getCachedSessionKey(
    pda: Address,
  ): Promise<SessionKeyData | null> {
    const cached = sessionKeyCache.get(pda);
    if (cached && Date.now() - cached.fetchedAtMs < 30_000) {
      return cached.data;
    }
    const data = await fetchSessionKey(rpc, pda);
    if (data) {
      sessionKeyCache.set(pda, { data, fetchedAtMs: Date.now() });
    } else {
      sessionKeyCache.delete(pda);
    }
    return data;
  }

  function isSessionKeyUsable(
    key: SessionKeyData,
    atSlot: bigint,
  ): { usable: true } | { usable: false; reason: string } {
    if (!key.active) {
      if (key.revokedAtSlot === null) {
        return { usable: false, reason: "Session key is not active" };
      }
      const graceEnd = key.revokedAtSlot + key.revocationGracePeriodSlots;
      if (atSlot >= graceEnd) {
        return {
          usable: false,
          reason: "Session key revocation grace period has expired",
        };
      }
    }

    if (key.expiresAtSlot !== null && atSlot >= key.expiresAtSlot) {
      return { usable: false, reason: "Session key has expired" };
    }

    return { usable: true };
  }

  function computeHoldDeadline(
    key: SessionKeyData,
    currentSlot: bigint,
  ): bigint | null {
    const deadlines: bigint[] = [];

    if (key.expiresAtSlot !== null) {
      deadlines.push(key.expiresAtSlot);
    }

    if (key.active) {
      if (key.revocationGracePeriodSlots > 0n) {
        deadlines.push(currentSlot + key.revocationGracePeriodSlots);
      }
    } else if (key.revokedAtSlot !== null) {
      deadlines.push(key.revokedAtSlot + key.revocationGracePeriodSlots);
    }

    if (deadlines.length === 0) return null;

    const earliest = deadlines.reduce((a, b) => (a < b ? a : b));
    return earliest - confirmationBufferSlots;
  }

  async function snapshotEscrow(
    escrowAddress: Address,
  ): Promise<EscrowSnapshot> {
    const [account, pendingResults] = await Promise.all([
      fetchEscrowAccount(rpc, escrowAddress),
      findPendingSettlementsByEscrow(rpc, escrowAddress),
      refreshSlot(),
    ]);

    if (!account) {
      throw new Error("Escrow account not found");
    }

    const vaultByMint = new Map<Address, bigint>();
    const onChainCommittedByMint = new Map<Address, bigint>();

    for (const p of pendingResults) {
      const current = onChainCommittedByMint.get(p.account.mint) ?? 0n;
      onChainCommittedByMint.set(p.account.mint, current + p.account.amount);
    }

    const balancePromises = config.supportedMints.map(async (mint) => {
      const [vault] = await deriveVaultPDA(escrowAddress, mint);
      try {
        const balance = await rpc.getTokenAccountBalance(vault).send();
        return { mint, amount: BigInt(balance.value.amount) };
      } catch {
        return { mint, amount: 0n };
      }
    });

    for (const { mint, amount } of await Promise.all(balancePromises)) {
      vaultByMint.set(mint, amount);
    }

    const snapshot: EscrowSnapshot = {
      account,
      vaultByMint,
      onChainCommittedByMint,
      fetchedAtMs: Date.now(),
    };
    escrowSnapshots.set(escrowAddress, snapshot);
    return snapshot;
  }

  function buildSplits(payTo: string): { recipient: string; bps: number }[] {
    if (!payTo) return config.defaultSplits;
    if (facilitatorFeeBps === 0) return [{ recipient: payTo, bps: 10_000 }];
    return [
      { recipient: payTo, bps: 10_000 - facilitatorFeeBps },
      { recipient: facilitatorAddress, bps: facilitatorFeeBps },
    ];
  }

  const isMatchingRequirement = (req: {
    scheme: string;
    network: string;
    asset: string;
  }) => matchers.some((m) => m.isMatchingRequirement(req));

  const getSupported = (): Promise<x402SupportedKind>[] => [
    Promise.resolve({
      x402Version: 2 as const,
      scheme: FLEX_SCHEME,
      network: networkId,
      extra: {
        facilitator: facilitatorAddress,
        supportedMints: config.supportedMints,
        splits: config.defaultSplits,
        minGracePeriodSlots: minGracePeriodSlots.toString(),
      },
    }),
  ];

  const getRequirements = async (
    args: GetRequirementsArgs,
  ): Promise<x402PaymentRequirements[]> =>
    args.accepts.filter(isMatchingRequirement).map((r) => ({
      ...r,
      extra: {
        facilitator: facilitatorAddress,
        supportedMints: config.supportedMints,
        splits: buildSplits(r.payTo),
        minGracePeriodSlots: minGracePeriodSlots.toString(),
      },
    }));

  const addressEncoder = getAddressEncoder();
  const u64Encoder = getU64Encoder();
  const textEncoder = new TextEncoder();

  const deriveSessionKeyPDA = (escrow: Address, sessionKey: Address) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("session"),
        addressEncoder.encode(escrow),
        addressEncoder.encode(sessionKey),
      ],
    });

  const deriveVaultPDA = (escrow: Address, mint: Address) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("token"),
        addressEncoder.encode(escrow),
        addressEncoder.encode(mint),
      ],
    });

  const derivePendingPDA = (escrow: Address, authorizationId: bigint) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("pending"),
        addressEncoder.encode(escrow),
        u64Encoder.encode(authorizationId),
      ],
    });

  const parseAndVerifyPayload = async (payment: x402PaymentPayload) => {
    const parseResult = FlexPaymentPayload(payment.payload);
    if (isValidationError(parseResult)) {
      return { error: `Invalid flex payload: ${parseResult.summary}` };
    }

    const escrowAddress = address(parseResult.escrow);
    const mint = address(parseResult.mint);
    const maxAmount = BigInt(parseResult.maxAmount);
    const authorizationId = BigInt(parseResult.authorizationId);
    const expiresAtSlot = BigInt(parseResult.expiresAtSlot);
    const sessionKeyAddress = address(parseResult.sessionKey);

    const signatureBytes = Uint8Array.from(atob(parseResult.signature), (c) =>
      c.charCodeAt(0),
    );

    const splits: SplitInput[] = parseResult.splits.map((s) => ({
      recipient: address(s.recipient),
      bps: s.bps,
    }));

    const cached = escrowSnapshots.get(escrowAddress);
    const snapshot =
      cached && Date.now() - cached.fetchedAtMs < snapshotMaxAgeMs
        ? cached
        : await snapshotEscrow(escrowAddress);

    if (snapshot.account.facilitator !== facilitatorAddress) {
      return { error: "Escrow facilitator does not match" };
    }

    const [sessionKeyPDA] = await deriveSessionKeyPDA(
      escrowAddress,
      sessionKeyAddress,
    );
    const sessionKeyData = await getCachedSessionKey(sessionKeyPDA);
    if (!sessionKeyData) {
      return { error: "Session key not found" };
    }

    if (sessionKeyData.revocationGracePeriodSlots < minGracePeriodSlots) {
      return {
        error: `Session key grace period ${sessionKeyData.revocationGracePeriodSlots} below minimum ${minGracePeriodSlots}`,
      };
    }

    const currentSlot = estimateCurrentSlot();
    const usability = isSessionKeyUsable(sessionKeyData, currentSlot);
    if (!usability.usable) {
      sessionKeyCache.delete(sessionKeyPDA);
      return { error: usability.reason };
    }

    if (currentSlot >= expiresAtSlot) {
      return { error: "Authorization has already expired" };
    }

    if (expiresAtSlot > currentSlot + snapshot.account.refundTimeoutSlots) {
      return { error: "Authorization expiry exceeds refund timeout" };
    }

    const validUntilSlot = computeHoldDeadline(sessionKeyData, currentSlot);
    if (validUntilSlot !== null && currentSlot >= validUntilSlot) {
      return {
        error: "Session key validity window too short for settlement",
      };
    }

    const [vault] = await deriveVaultPDA(escrowAddress, mint);
    const vaultAmount = snapshot.vaultByMint.get(mint) ?? 0n;
    const onChainCommitted = snapshot.onChainCommittedByMint.get(mint) ?? 0n;

    const message = serializePaymentAuthorization({
      programId: FLEX_PROGRAM_ADDRESS,
      escrow: escrowAddress,
      mint,
      maxAmount,
      authorizationId,
      expiresAtSlot,
      splits,
    });

    const publicKeyBytes = addressEncoder.encode(sessionKeyAddress);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      "Ed25519",
      false,
      ["verify"],
    );
    const isValid = await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      signatureBytes,
      message,
    );

    if (!isValid) {
      return { error: "Ed25519 signature verification failed" };
    }

    return {
      escrowAddress,
      escrowAccount: snapshot.account,
      mint,
      maxAmount,
      authorizationId,
      expiresAtSlot,
      sessionKeyAddress,
      sessionKeyPDA,
      vault,
      splits,
      signatureBytes,
      message,
      payer: snapshot.account.owner,
      vaultAmount,
      onChainCommitted,
      validUntilSlot,
    };
  };

  const handleVerify = async (
    requirements: x402PaymentRequirements,
    payment: x402PaymentPayload,
  ): Promise<x402VerifyResponse | null> => {
    if (!isMatchingRequirement(requirements)) {
      return null;
    }

    const result = await parseAndVerifyPayload(payment);

    if ("error" in result) {
      return { isValid: false, invalidReason: result.error };
    }

    return { isValid: true };
  };

  const handleSettle = async (
    requirements: x402PaymentRequirements,
    payment: x402PaymentPayload,
  ): Promise<x402SettleResponse | null> => {
    if (!isMatchingRequirement(requirements)) {
      return null;
    }

    const errorResponse = (msg: string): x402SettleResponse => {
      logger.error(msg);
      return {
        success: false,
        errorReason: msg,
        transaction: "",
        network: networkId,
      };
    };

    const result = await parseAndVerifyPayload(payment);

    if ("error" in result) {
      return errorResponse(result.error);
    }

    const settleAmount = BigInt(requirements.amount);

    if (settleAmount > result.maxAmount) {
      return errorResponse("Settle amount exceeds client-authorized maxAmount");
    }

    const holdResult = holdManager.tryHold(
      {
        escrow: result.escrowAddress,
        mint: result.mint,
        settleAmount,
        maxAmount: result.maxAmount,
        authorizationId: result.authorizationId,
        expiresAtSlot: result.expiresAtSlot,
        sessionKeyAddress: result.sessionKeyAddress,
        sessionKeyPDA: result.sessionKeyPDA,
        vault: result.vault,
        splits: result.splits,
        signatureBytes: result.signatureBytes,
        message: result.message,
        payer: result.payer,
        validUntilSlot: result.validUntilSlot,
      },
      result.vaultAmount,
      result.onChainCommitted,
    );

    if (!holdResult.ok) {
      return errorResponse(holdResult.reason);
    }

    return {
      success: true,
      transaction: result.authorizationId.toString(),
      network: networkId,
      payer: result.payer,
    };
  };

  async function submitHold(hold: Hold): Promise<FlushResult> {
    const [pending] = await derivePendingPDA(hold.escrow, hold.authorizationId);

    const ed25519Ix = createEd25519VerifyInstruction({
      publicKey: hold.sessionKeyAddress,
      message: hold.message,
      signature: hold.signatureBytes,
    });

    const submitIx = await getSubmitAuthorizationInstructionAsync({
      escrow: hold.escrow,
      facilitator: facilitatorSigner,
      sessionKey: hold.sessionKeyPDA,
      tokenAccount: hold.vault,
      pending,
      mint: hold.mint,
      maxAmount: hold.maxAmount,
      settleAmount: hold.settleAmount,
      authorizationId: hold.authorizationId,
      expiresAtSlot: hold.expiresAtSlot,
      splits: hold.splits.map((s) => ({
        recipient: s.recipient,
        bps: s.bps,
      })),
      signature: hold.signatureBytes.subarray(0, 64),
    });

    const {
      value: { blockhash, lastValidBlockHeight },
    } = await rpc.getLatestBlockhash().send();

    const txMessage = appendTransactionMessageInstructions(
      [ed25519Ix, submitIx],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight },
        setTransactionMessageFeePayer(
          facilitatorSigner.address,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const txSignature = getSignatureFromTransaction(signedTx);

    const wireTransaction = getBase64EncodedWireTransaction(signedTx);
    await rpc.sendTransaction(wireTransaction, { encoding: "base64" }).send();

    for (let i = 0; i < maxSubmitRetries; i++) {
      const status = await rpc.getSignatureStatuses([txSignature]).send();
      const statusValue = status.value[0];
      if (statusValue?.err) {
        return {
          authorizationId: hold.authorizationId,
          success: false,
          error: `Transaction failed: ${JSON.stringify(statusValue.err)}`,
        };
      }
      if (
        statusValue?.confirmationStatus === "confirmed" ||
        statusValue?.confirmationStatus === "finalized"
      ) {
        return {
          authorizationId: hold.authorizationId,
          success: true,
          transaction: txSignature,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, submitRetryDelayMs));
    }

    return {
      authorizationId: hold.authorizationId,
      success: false,
      error: "Transaction confirmation timeout",
    };
  }

  async function flush(): Promise<FlushResult[]> {
    const currentSlot = estimateCurrentSlot();
    const expired = holdManager.sweepExpired(currentSlot);
    for (const h of expired) {
      logger.warning(
        `hold expired before flush: authorizationId=${h.authorizationId} validUntilSlot=${h.validUntilSlot}`,
      );
    }

    const batch = holdManager.drainSubmittable(currentSlot);
    if (batch.length === 0) return [];

    const escrowsToRefresh = new Set<Address>();

    const settled = await Promise.allSettled(
      batch.map(async (hold): Promise<FlushResult> => {
        try {
          return await submitHold(hold);
        } catch (cause) {
          return {
            authorizationId: hold.authorizationId,
            success: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Unknown submission error",
          };
        }
      }),
    );

    const results: FlushResult[] = [];
    for (const [i, hold] of batch.entries()) {
      const outcome = settled[i];
      const result: FlushResult =
        outcome?.status === "fulfilled"
          ? outcome.value
          : {
              authorizationId: hold.authorizationId,
              success: false,
              error:
                outcome?.status === "rejected" &&
                outcome.reason instanceof Error
                  ? outcome.reason.message
                  : "Unknown submission error",
            };
      results.push(result);

      if (result.success) {
        holdManager.markSubmitted(hold.escrow, hold.authorizationId);
        escrowsToRefresh.add(hold.escrow);
      } else {
        logger.error(
          `submission failed for authorizationId ${hold.authorizationId}: ${result.error}`,
        );
        holdManager.releaseHold(hold.escrow, hold.authorizationId);
        escrowSnapshots.delete(hold.escrow);
      }
    }

    await Promise.all(
      [...escrowsToRefresh].map((escrow) => snapshotEscrow(escrow)),
    );

    return results;
  }

  const flushIntervalMs = config.flushIntervalMs ?? 2000;
  const interval = setInterval(() => {
    void flush().then(
      (results) => {
        for (const r of results) {
          if (r.success) {
            logger.info(
              `flushed authorizationId=${r.authorizationId} tx=${r.transaction}`,
            );
          } else {
            logger.error(
              `flush failed authorizationId=${r.authorizationId}: ${r.error}`,
            );
          }
        }
      },
      (cause: unknown) => {
        logger.error(
          `flush interval error: ${cause instanceof Error ? cause.message : cause}`,
        );
      },
    );
  }, flushIntervalMs);

  const stop = () => clearInterval(interval);

  return {
    getSupported,
    getRequirements,
    handleVerify,
    handleSettle,
    flush,
    getHoldManager: () => holdManager,
    stop,
  };
};
