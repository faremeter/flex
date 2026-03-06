import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type Base58EncodedBytes,
  getAddressEncoder,
  getBase58Decoder,
} from "@solana/kit";

import {
  fetchMaybeEscrowAccount,
  fetchMaybePendingSettlement,
  fetchMaybeSessionKey,
  getEscrowAccountDecoder,
  getEscrowAccountDiscriminatorBytes,
  getPendingSettlementDecoder,
  getPendingSettlementDiscriminatorBytes,
  FLEX_PROGRAM_ADDRESS,
  type EscrowAccount,
  type PendingSettlement,
  type SessionKey,
} from "./generated";
import type {
  EscrowAccountData,
  PendingSettlementData,
  SessionKeyData,
} from "./types";
type FlexRpc = Rpc<SolanaRpcApi>;

function toBase58Filter(bytes: Uint8Array): Base58EncodedBytes {
  return getBase58Decoder().decode(bytes) as Base58EncodedBytes;
}

function decodeBase64AccountData(data: [string, string]): Uint8Array {
  const binary = atob(data[0]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function convertEscrowAccount(raw: EscrowAccount): EscrowAccountData {
  return {
    version: raw.version,
    owner: raw.owner,
    facilitator: raw.facilitator,
    index: raw.index,
    lastNonce: raw.lastNonce,
    pendingCount: raw.pendingCount,
    mintCount: raw.mintCount,
    refundTimeoutSlots: raw.refundTimeoutSlots,
    deadmanTimeoutSlots: raw.deadmanTimeoutSlots,
    lastActivitySlot: raw.lastActivitySlot,
    maxSessionKeys: raw.maxSessionKeys,
    sessionKeyCount: raw.sessionKeyCount,
    bump: raw.bump,
  };
}

function convertSessionKey(raw: SessionKey): SessionKeyData {
  return {
    version: raw.version,
    escrow: raw.escrow,
    key: raw.key,
    createdAtSlot: raw.createdAtSlot,
    expiresAtSlot:
      raw.expiresAtSlot.__option === "Some" ? raw.expiresAtSlot.value : null,
    active: raw.active,
    revokedAtSlot:
      raw.revokedAtSlot.__option === "Some" ? raw.revokedAtSlot.value : null,
    revocationGracePeriodSlots: raw.revocationGracePeriodSlots,
    bump: raw.bump,
  };
}

function convertPendingSettlement(
  raw: PendingSettlement,
): PendingSettlementData {
  return {
    version: raw.version,
    escrow: raw.escrow,
    mint: raw.mint,
    amount: raw.amount,
    originalAmount: raw.originalAmount,
    maxAmount: raw.maxAmount,
    nonce: raw.nonce,
    submittedAtSlot: raw.submittedAtSlot,
    sessionKey: raw.sessionKey,
    splitCount: raw.splitCount,
    splits: raw.splits.slice(0, raw.splitCount).map((s) => ({
      recipient: s.recipient,
      bps: s.bps,
    })),
    bump: raw.bump,
  };
}

export async function fetchEscrowAccount(
  rpc: FlexRpc,
  addr: Address,
): Promise<EscrowAccountData | null> {
  const result = await fetchMaybeEscrowAccount(rpc, addr);
  if (!result.exists) return null;
  return convertEscrowAccount(result.data);
}

export async function fetchSessionKey(
  rpc: FlexRpc,
  addr: Address,
): Promise<SessionKeyData | null> {
  const result = await fetchMaybeSessionKey(rpc, addr);
  if (!result.exists) return null;
  return convertSessionKey(result.data);
}

export async function fetchPendingSettlement(
  rpc: FlexRpc,
  addr: Address,
): Promise<PendingSettlementData | null> {
  const result = await fetchMaybePendingSettlement(rpc, addr);
  if (!result.exists) return null;
  return convertPendingSettlement(result.data);
}

export async function findEscrowsByOwner(
  rpc: FlexRpc,
  owner: Address,
): Promise<{ address: Address; account: EscrowAccountData }[]> {
  const addressEncoder = getAddressEncoder();
  const results = await rpc
    .getProgramAccounts(FLEX_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: toBase58Filter(
              new Uint8Array(getEscrowAccountDiscriminatorBytes()),
            ),
            encoding: "base58",
          },
        },
        {
          memcmp: {
            offset: 9n,
            bytes: toBase58Filter(new Uint8Array(addressEncoder.encode(owner))),
            encoding: "base58",
          },
        },
      ],
    })
    .send();

  const escrowDecoder = getEscrowAccountDecoder();
  return results.map((r) => ({
    address: r.pubkey,
    account: convertEscrowAccount(
      escrowDecoder.decode(decodeBase64AccountData(r.account.data)),
    ),
  }));
}

export async function findEscrowsByFacilitator(
  rpc: FlexRpc,
  facilitator: Address,
): Promise<{ address: Address; account: EscrowAccountData }[]> {
  const addressEncoder = getAddressEncoder();
  const results = await rpc
    .getProgramAccounts(FLEX_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: toBase58Filter(
              new Uint8Array(getEscrowAccountDiscriminatorBytes()),
            ),
            encoding: "base58",
          },
        },
        {
          memcmp: {
            offset: 41n,
            bytes: toBase58Filter(
              new Uint8Array(addressEncoder.encode(facilitator)),
            ),
            encoding: "base58",
          },
        },
      ],
    })
    .send();

  const escrowDecoder = getEscrowAccountDecoder();
  return results.map((r) => ({
    address: r.pubkey,
    account: convertEscrowAccount(
      escrowDecoder.decode(decodeBase64AccountData(r.account.data)),
    ),
  }));
}

export async function findPendingSettlementsByEscrow(
  rpc: FlexRpc,
  escrow: Address,
): Promise<{ address: Address; account: PendingSettlementData }[]> {
  const addressEncoder = getAddressEncoder();
  const results = await rpc
    .getProgramAccounts(FLEX_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: toBase58Filter(
              new Uint8Array(getPendingSettlementDiscriminatorBytes()),
            ),
            encoding: "base58",
          },
        },
        {
          memcmp: {
            offset: 9n,
            bytes: toBase58Filter(
              new Uint8Array(addressEncoder.encode(escrow)),
            ),
            encoding: "base58",
          },
        },
      ],
    })
    .send();

  const pendingDecoder = getPendingSettlementDecoder();
  return results.map((r) => ({
    address: r.pubkey,
    account: convertPendingSettlement(
      pendingDecoder.decode(decodeBase64AccountData(r.account.data)),
    ),
  }));
}
