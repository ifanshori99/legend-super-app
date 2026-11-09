// Delivery platform webhook route (bead legend-5bn3 D3; PRD v1.7 §3.23).
// `POST /:platform` (gofood | grabfood | shopeefood).
//
// Server-to-server like routes/identity-wa-webhook.routes.ts: no session, no
// Origin, no tenant middleware. The signature is verified over the RAW bytes
// first; only then is the payload parsed, the tenant and outlet resolved from
// the platform's store id (`delivery_store_index`) and the order imported
// idempotently (services/delivery-ingest.service.ts). A platform without a
// configured secret is disabled: it answers 503 and processes nothing.
// Mounted in app.ts at /api/webhooks/delivery, before /api.
import express, { Router, type RequestHandler } from "express";
import { CoreError } from "@starter/shared/core";
import {
  deliveryWebhookPayloadSchema,
  verifyDeliveryWebhook,
  DELIVERY_SIGNATURE_HEADER,
} from "@starter/shared/adapters";
import {
  deliveryPlatformSchema,
  type DeliveryPlatform,
} from "@starter/shared/delivery";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { BODY_LIMIT_BYTES } from "../middleware/body";
import { ingestDeliveryWebhook } from "../services/delivery-ingest.service";

type DeliverySecrets = Partial<Record<DeliveryPlatform, readonly string[]>>;

const envSecrets = (platform: DeliveryPlatform): readonly string[] => {
  switch (platform) {
    case "gofood":
      return env.DELIVERY_GOFOOD_WEBHOOK_SECRET;
    case "grabfood":
      return env.DELIVERY_GRABFOOD_WEBHOOK_SECRET;
    case "shopeefood":
      return env.DELIVERY_SHOPEEFOOD_WEBHOOK_SECRET;
  }
};

/** Mounted at /api/webhooks/delivery. */
export function createDeliveryWebhookRouter(options?: {
  /** Test override; production reads DELIVERY_<PLATFORM>_WEBHOOK_SECRET. */
  secrets?: DeliverySecrets;
}) {
  const router = Router();
  const secretsOf = (platform: DeliveryPlatform) =>
    options?.secrets?.[platform] ?? envSecrets(platform);

  // The signature covers the exact bytes, so this route reads them raw.
  const rawBody: RequestHandler = (req, res, next) => {
    const contentType = req
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json")
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Send an application/json body.",
      );
    express.raw({ type: () => true, limit: BODY_LIMIT_BYTES })(req, res, next);
  };

  router.post("/:platform", rawBody, async (req, res) => {
    const platform = deliveryPlatformSchema.safeParse(req.params.platform);
    if (!platform.success)
      throw new HttpError(404, "NOT_FOUND", "Platform tidak dikenal.");
    const secrets = secretsOf(platform.data);
    if (secrets.length === 0)
      throw new CoreError(
        "SERVICE_UNAVAILABLE",
        "Webhook platform ini belum dikonfigurasi.",
      );
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Throws UNAUTHORIZED (one message, no oracle) for a missing, malformed,
    // stale or wrong signature; the payload is only parsed after this.
    const { signedAt } = await verifyDeliveryWebhook({
      rawBody: raw,
      // Only the header the verification reads.
      headers: {
        [DELIVERY_SIGNATURE_HEADER]:
          req.get(DELIVERY_SIGNATURE_HEADER) ?? undefined,
      },
      secrets,
    });
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Send valid JSON.");
    }
    const payload = deliveryWebhookPayloadSchema.safeParse(json);
    if (!payload.success)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Isi webhook pesanan platform tidak valid.",
      );
    // The signed instant orders deliveries of one order (older ones ignored).
    const result = await ingestDeliveryWebhook(platform.data, payload.data, raw, {
      signedAt: new Date(signedAt * 1000),
    });
    res.json({ data: result });
  });

  return router;
}

export const deliveryWebhookRouter = createDeliveryWebhookRouter();
