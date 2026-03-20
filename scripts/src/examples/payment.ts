import "dotenv/config";
import { createPaymentHandler } from "@faremeter/flex-solana/client";
import { wrap as wrapFetch } from "@faremeter/fetch";
import { createSolanaRpc, address } from "@solana/kit";
import { configureApp, getLogger } from "@faremeter/logs";
import fs from "fs";

await configureApp();
const logger = await getLogger(["flex", "payment"]);

const SESSION_KEY_PATH = process.env.SESSION_KEY_PATH ?? "tmp/session-key.json";

if (!fs.existsSync(SESSION_KEY_PATH)) {
  throw new Error(
    `Session key file not found: ${SESSION_KEY_PATH}\n` +
      "Run the setup-devnet script first.",
  );
}

type Ed25519JWK = {
  kty: string;
  crv: string;
  x: string;
  d: string;
  key_ops: string[];
  ext: boolean;
};

type SessionKeyFile = {
  address: string;
  jwk: Ed25519JWK;
  escrow: string;
  mint: string;
  network: string;
};

const sessionKeyData = JSON.parse(
  fs.readFileSync(SESSION_KEY_PATH, "utf-8"),
) as SessionKeyFile;

const { jwk } = sessionKeyData;

const privateKey = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, [
  "sign",
]);

const { d: _d, key_ops: _ops, ...publicJWK } = jwk;

const publicKey = await crypto.subtle.importKey(
  "jwk",
  { ...publicJWK, key_ops: ["verify"] as const },
  "Ed25519",
  true,
  ["verify"],
);

const rpc = createSolanaRpc("https://api.devnet.solana.com");

const handler = createPaymentHandler({
  network: sessionKeyData.network,
  escrow: address(sessionKeyData.escrow),
  mint: address(sessionKeyData.mint),
  sessionKeyPair: { privateKey, publicKey },
  sessionKeyAddress: address(sessionKeyData.address),
  rpc,
});

const fetchWithPayer = wrapFetch(fetch, { handlers: [handler] });

const res = await fetchWithPayer("http://127.0.0.1:3000/protected");

logger.info(`Status: ${res.status}`);
logger.info("Headers:", Object.fromEntries(res.headers));
logger.info("Response:", (await res.json()) as Record<string, unknown>);
