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
const logger = await getLogger(["flex", "upto-streaming"]);

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

function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

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
      const maxTokens = b.max_tokens ?? 1024;
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          let tokens = 0;
          const words = ["Hello", "from", "the", "upto", "streaming", "server"];

          for (const word of words) {
            tokens += 1;
            controller.enqueue(
              encoder.encode(
                formatSSE({
                  choices: [{ delta: { content: word + " " } }],
                }),
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          const cost = BigInt(Math.min(tokens, maxTokens)) * PRICE_PER_TOKEN;
          logger.info(`Stream complete: ${tokens} tokens, cost: ${cost}`);

          const settlement = await settle(cost);
          controller.enqueue(encoder.encode(formatSSE({ settlement })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  }),
);

serve(app, (info) => {
  logger.info(
    `Flex upto streaming server listening on http://localhost:${info.port}`,
  );
});
