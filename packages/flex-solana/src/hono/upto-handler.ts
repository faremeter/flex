import type { Context, Handler } from "hono";
import {
  handleMiddlewareRequest,
  createPaymentRequiredResponseCache,
  resolveSupportedVersions,
  type SettleResultV2,
  type MiddlewareBodyContext,
  type RelaxedRequirements,
  type createPaymentRequiredResponseCacheOpts,
} from "@faremeter/middleware/common";
import type { x402SettleResponse } from "@faremeter/types/x402v2";

export type UptoAccept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
};

export type SettleFunction = (amount: bigint) => Promise<x402SettleResponse>;

export type CreateUptoHandlerOpts = {
  facilitatorURL: string;
  accepts: UptoAccept[];
  authorize: (body: unknown) => bigint | Promise<bigint>;
  handle: (body: unknown, settle: SettleFunction) => Promise<Response>;
  cacheConfig?: createPaymentRequiredResponseCacheOpts;
  fetch?: typeof fetch;
};

export function createUptoHandler(opts: CreateUptoHandlerOpts): Handler {
  const supportedVersions = resolveSupportedVersions({
    x402v1: false,
    x402v2: true,
  });
  const { getPaymentRequiredResponse, getPaymentRequiredResponseV2 } =
    createPaymentRequiredResponseCache(opts.cacheConfig);
  const middlewareAccepts: RelaxedRequirements[] = opts.accepts.map(
    ({ amount, ...rest }) => ({
      ...rest,
      maxAmountRequired: amount,
    }),
  );

  return async (c: Context) => {
    const args = {
      facilitatorURL: opts.facilitatorURL,
      accepts: middlewareAccepts,
      supportedVersions,
      resource: c.req.url,
      getHeader: (key: string) => c.req.header(key),
      setResponseHeader: (key: string, value: string) => c.header(key, value),
      getPaymentRequiredResponse,
      getPaymentRequiredResponseV2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      sendJSONResponse: (
        status: 400 | 402,
        jsonBody?: object,
        headers?: Record<string, string>,
      ) => {
        c.status(status);
        if (headers) {
          for (const [key, value] of Object.entries(headers)) {
            c.header(key, value);
          }
        }
        return jsonBody ? c.json(jsonBody) : c.body(null);
      },
      body: async (ctx: MiddlewareBodyContext<Response>) => {
        if (ctx.protocolVersion !== 2) {
          return c.json({ error: "upto requires x402 v2" }, 400);
        }

        const verifyResult = await ctx.verify();
        if (!verifyResult.success) return verifyResult.errorResponse;

        const body: unknown = await c.req.json();
        const ceiling = await opts.authorize(body);

        let settled = false;
        const settle: SettleFunction = async (amount) => {
          if (settled) {
            throw new Error("settle() has already been called");
          }
          if (amount < 0n) {
            throw new Error("Settle amount must be non-negative");
          }
          if (amount > ceiling) {
            throw new Error(
              `Settle amount ${amount} exceeds authorized ceiling ${ceiling}`,
            );
          }
          settled = true;
          // XXX - Mutate in place: ctx.settle() closes over the original object reference
          ctx.paymentRequirements.amount = amount.toString();
          const result: SettleResultV2<Response> = await ctx.settle();
          if (!result.success) {
            throw new Error(
              `Settlement failed for amount ${amount} (ceiling ${ceiling})`,
            );
          }
          return result.facilitatorResponse;
        };

        return opts.handle(body, settle);
      },
    };

    return handleMiddlewareRequest<Response>(args);
  };
}
