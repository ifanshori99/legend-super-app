// KirimDev's inbound WhatsApp webhook route (AUTH-02, adapted per
// docs/plan/providers.md; AUTH-03).
//
// Server-to-server: no session, no Origin, no tenant middleware. The tenant is
// resolved from the receiving WhatsApp number inside the service, after the
// signature verifies. The raw request bytes are read for the HMAC — never a
// re-serialized body — and nothing is processed without a valid signature.
//
// Without KIRIM_WEBHOOK_SECRET the route answers 503 and processes nothing
// (fail closed), the same shape 119connect used.

import express, { Router, type RequestHandler } from "express";
import { CoreError } from "@starter/shared/core";
import {
  KIRIM_EVENT_ID_HEADER,
  KIRIM_SIGNATURE_HEADER,
  verifyKirimWebhook,
} from "@starter/shared/adapters";
import { env } from "../config/env";
import { BODY_LIMIT_BYTES } from "../middleware/body";
import { HttpError } from "../lib/http-error";
import {
  parseKirimdevPayload,
  processInboundWhatsApp,
} from "../services/identity-wa-inbound.service";

/** Mounted at /api/webhooks/whatsapp. */
export function createWhatsAppWebhookRouter(options?: {
  /** Test override; production reads KIRIM_WEBHOOK_SECRET. */
  secrets?: readonly string[];
}) {
  const router = Router();
  const secretsOf = () => options?.secrets ?? env.KIRIM_WEBHOOK_SECRET;

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

  router.post("/", rawBody, async (req, res) => {
    const secrets = secretsOf();
    if (secrets.length === 0)
      throw new CoreError(
        "SERVICE_UNAVAILABLE",
        "Webhook WhatsApp belum dikonfigurasi.",
      );
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Throws UNAUTHORIZED (one message, no oracle) for a missing, malformed,
    // stale or wrong signature; the payload is only parsed after this.
    await verifyKirimWebhook({
      rawBody: raw,
      // Only the headers the verification reads, so a proxy cannot smuggle a
      // second value through the Record form.
      headers: {
        [KIRIM_SIGNATURE_HEADER]: req.get(KIRIM_SIGNATURE_HEADER) ?? undefined,
        [KIRIM_EVENT_ID_HEADER]: req.get(KIRIM_EVENT_ID_HEADER) ?? undefined,
      },
      secrets,
    });
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Send valid JSON.");
    }
    const messages = parseKirimdevPayload(payload);
    const results = [];
    for (const message of messages)
      results.push(await processInboundWhatsApp(message));
    res.json({
      data: {
        received: results.length,
        duplicates: results.filter((result) => result.duplicate).length,
        completed: results.filter((result) => result.kind === "login").length,
      },
    });
  });

  return router;
}
