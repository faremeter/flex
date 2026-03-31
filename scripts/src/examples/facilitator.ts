import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createFacilitatorRoutes } from "@faremeter/facilitator";
import { createFacilitatorHandler } from "@faremeter/flex-solana/facilitator";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  address,
} from "@solana/kit";
import { lookupKnownSPLToken } from "@faremeter/info/solana";
import { configureApp, getLogger } from "@faremeter/logs";
import fs from "fs";

await configureApp();
const logger = await getLogger(["flex", "facilitator"]);

const keypairPath = process.env.FLEX_FACILITATOR_KEYPAIR_PATH;

if (!keypairPath) {
  logger.error("Set FLEX_FACILITATOR_KEYPAIR_PATH in your environment");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8")) as number[];
const facilitatorSigner = await createKeyPairSignerFromBytes(
  Uint8Array.from(raw),
);

const network = "devnet";
const rpc = createSolanaRpc("https://api.devnet.solana.com");

const usdcInfo = lookupKnownSPLToken(network, "USDC");
if (!usdcInfo) {
  throw new Error(`Could not look up USDC on ${network}`);
}

const handler = await createFacilitatorHandler(
  network,
  rpc,
  facilitatorSigner,
  {
    supportedMints: [address(usdcInfo.address)],
    defaultSplits: [{ recipient: facilitatorSigner.address, bps: 300 }],
  },
);

const port = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const app = new Hono();

app.route(
  "/",
  createFacilitatorRoutes({
    handlers: [handler],
    timeout: { getRequirements: 5000 },
  }),
);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info(`Flex facilitator listening on port ${info.port}`);
});
