import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createUptoHandler } from "@faremeter/flex-solana/hono";
import { UPTO_SCHEME } from "@faremeter/flex-solana";
import { lookupKnownSPLToken, clusterToCAIP2 } from "@faremeter/info/solana";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { configureApp, getLogger } from "@faremeter/logs";
import fs from "fs";

await configureApp();
const logger = await getLogger(["flex", "upto-server"]);

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

const PRICE_PER_TOKEN = 10n;

const app = new Hono();

app.post(
  "/v1/chat/completions",
  createUptoHandler({
    facilitatorURL: "http://localhost:4000",
    accepts: [
      {
        scheme: UPTO_SCHEME,
        network: solanaNetwork.caip2,
        amount: usdcInfo.toUnit("10000"),
        asset: usdcInfo.address,
        payTo,
        maxTimeoutSeconds: 60,
      },
    ],

    authorize: (body) => {
      const b = body as { max_tokens?: number };
      return BigInt(b.max_tokens ?? 1024) * PRICE_PER_TOKEN;
    },

    handle: async (body, settle) => {
      const b = body as { max_tokens?: number };
      const tokensUsed = Math.floor(Math.random() * (b.max_tokens ?? 1024));
      const cost = BigInt(tokensUsed) * PRICE_PER_TOKEN;

      logger.info(`Tokens used: ${tokensUsed}, cost: ${cost}`);

      const settlement = await settle(cost);

      return Response.json({
        choices: [{ message: { content: "Hello from upto server!" } }],
        usage: { total_tokens: tokensUsed },
        payment: settlement,
      });
    },
  }),
);

serve(app, (info) => {
  logger.info(
    `Flex upto resource server listening on http://localhost:${info.port}`,
  );
});
