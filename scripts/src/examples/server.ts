import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMiddleware } from "@faremeter/middleware/hono";
import { lookupKnownSPLToken, clusterToCAIP2 } from "@faremeter/info/solana";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { configureApp, getLogger } from "@faremeter/logs";
import fs from "fs";

await configureApp();
const logger = await getLogger(["flex", "server"]);

const { PAYTO_KEYPAIR_PATH } = process.env;
if (!PAYTO_KEYPAIR_PATH) {
  throw new Error("PAYTO_KEYPAIR_PATH must be set in your environment");
}

const raw = JSON.parse(
  fs.readFileSync(PAYTO_KEYPAIR_PATH, "utf-8"),
) as number[];
const payToSigner = await createKeyPairSignerFromBytes(Uint8Array.from(raw));
const payTo = payToSigner.address;

const network = "devnet";
const usdcInfo = lookupKnownSPLToken(network, "USDC");
if (!usdcInfo) {
  throw new Error(`Could not look up USDC on ${network}`);
}

const solanaNetwork = clusterToCAIP2(network);

const app = new Hono();

app.get(
  "/protected",
  await createMiddleware({
    facilitatorURL: "http://localhost:4000",
    supportedVersions: { x402v2: true },
    accepts: [
      {
        scheme: "@faremeter/flex",
        network: solanaNetwork.caip2,
        maxAmountRequired: usdcInfo.toUnit("10000"),
        payTo,
        asset: usdcInfo.address,
        maxTimeoutSeconds: 60,
      },
    ],
  }),
  (c) => c.json({ msg: "success" }),
);

serve(app, (info) => {
  logger.info(
    `Flex resource server listening on http://localhost:${info.port}`,
  );
});
