import "dotenv/config";
import { createSolanaRpc, getAddressFromPublicKey, address } from "@solana/kit";
import {
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
} from "@faremeter/flex-solana";
import { lookupKnownSPLToken } from "@faremeter/info/solana";
import { configureApp, getLogger } from "@faremeter/logs";
import { loadKeypair, sendTx } from "./solana";
import fs from "fs";
import path from "path";

await configureApp();
const logger = await getLogger(["flex", "create-escrow"]);

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ESCROW_INDEX = Number(process.env.ESCROW_INDEX ?? "0");
const DEPOSIT_AMOUNT = Number(process.env.DEPOSIT_AMOUNT ?? "5000000");
const REFUND_TIMEOUT_SLOTS = 300;
const DEADMAN_TIMEOUT_SLOTS = 100_000;
const MAX_SESSION_KEYS = 10;
const GRACE_PERIOD_SLOTS = 300;
const OUTPUT_PATH =
  process.env.OUTPUT_PATH ??
  path.resolve(import.meta.dirname, "../../tmp/session-key.json");

const OWNER_KEYPAIR_PATH = process.env.OWNER_KEYPAIR_PATH;
const FACILITATOR_KEYPAIR_PATH = process.env.FACILITATOR_KEYPAIR_PATH;

if (!OWNER_KEYPAIR_PATH || !FACILITATOR_KEYPAIR_PATH) {
  logger.error(
    "Required environment variables:\n" +
      "  OWNER_KEYPAIR_PATH       - escrow owner keypair (pays for transactions)\n" +
      "  FACILITATOR_KEYPAIR_PATH - facilitator keypair",
  );
  process.exit(1);
}

const network = "devnet";
const rpc = createSolanaRpc(RPC_URL);
const owner = await loadKeypair(OWNER_KEYPAIR_PATH);
const facilitator = await loadKeypair(FACILITATOR_KEYPAIR_PATH);

const usdcInfo = lookupKnownSPLToken(network, "USDC");
if (!usdcInfo) {
  throw new Error(`Could not look up USDC on ${network}`);
}
const mintAddress = address(usdcInfo.address);

logger.info(`Owner:        ${owner.address}`);
logger.info(`Facilitator:  ${facilitator.address}`);
logger.info(`Mint:         ${mintAddress} (USDC)`);
logger.info(`Escrow index: ${ESCROW_INDEX}`);
logger.info(`Deposit:      ${DEPOSIT_AMOUNT / 1_000_000} USDC`);

const { value: tokenAccounts } = await rpc
  .getTokenAccountsByOwner(
    owner.address,
    { mint: mintAddress },
    { encoding: "base64" },
  )
  .send();

const firstAccount = tokenAccounts[0];
if (!firstAccount) {
  logger.error(
    "No USDC token account found for the owner.\n" +
      "Get devnet USDC from https://faucet.circle.com (select Solana devnet).",
  );
  process.exit(1);
}

const sourceTokenAccount = firstAccount.pubkey;
const { value: balance } = await rpc
  .getTokenAccountBalance(sourceTokenAccount)
  .send();

logger.info(
  `Source USDC:  ${sourceTokenAccount} (${balance.uiAmountString} USDC)`,
);

if (Number(balance.amount) < DEPOSIT_AMOUNT) {
  logger.error(
    `Insufficient USDC. Need ${DEPOSIT_AMOUNT / 1_000_000}, have ${balance.uiAmountString}.\n` +
      "Get devnet USDC from https://faucet.circle.com (select Solana devnet).",
  );
  process.exit(1);
}

logger.info("Creating escrow...");
const createIx = await getCreateEscrowInstructionAsync({
  owner,
  index: ESCROW_INDEX,
  facilitator: facilitator.address,
  refundTimeoutSlots: REFUND_TIMEOUT_SLOTS,
  deadmanTimeoutSlots: DEADMAN_TIMEOUT_SLOTS,
  maxSessionKeys: MAX_SESSION_KEYS,
});
await sendTx(rpc, owner, [createIx]);

const escrowMeta = createIx.accounts[1];
if (!escrowMeta) throw new Error("escrow account meta missing");
const escrowAddress = escrowMeta.address;
logger.info(`Escrow: ${escrowAddress}`);

logger.info(`Depositing ${DEPOSIT_AMOUNT / 1_000_000} USDC...`);
const depositIx = await getDepositInstructionAsync({
  depositor: owner,
  escrow: escrowAddress,
  mint: mintAddress,
  source: sourceTokenAccount,
  amount: DEPOSIT_AMOUNT,
});
await sendTx(rpc, owner, [depositIx]);

const vaultMeta = depositIx.accounts[3];
if (!vaultMeta) throw new Error("vault account meta missing");
const vaultAddress = vaultMeta.address;
logger.info(`Vault: ${vaultAddress}`);

logger.info("Registering session key...");
const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const sessionKeyAddress = await getAddressFromPublicKey(keyPair.publicKey);

const registerIx = await getRegisterSessionKeyInstructionAsync({
  owner,
  escrow: escrowAddress,
  sessionKey: sessionKeyAddress,
  expiresAtSlot: null,
  revocationGracePeriodSlots: GRACE_PERIOD_SLOTS,
});
await sendTx(rpc, owner, [registerIx]);

const sessionKeyMeta = registerIx.accounts[2];
if (!sessionKeyMeta) throw new Error("session key account meta missing");
const sessionKeyPDA = sessionKeyMeta.address;
logger.info(`Session key: ${sessionKeyAddress} (PDA: ${sessionKeyPDA})`);

const privateJWK = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

const output = {
  address: sessionKeyAddress,
  jwk: privateJWK,
  escrow: escrowAddress,
  vault: vaultAddress,
  sessionKeyPDA,
  facilitator: facilitator.address,
  mint: usdcInfo.address,
  network: "solana-devnet",
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
logger.info(`Written to ${OUTPUT_PATH}`);
