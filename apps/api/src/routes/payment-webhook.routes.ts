// Payment provider webhook routes (PAY-02/03, F13).
//
// Server-to-server: no session, no Origin, no tenant middleware. The tenant is
// named in the URL, but nothing is trusted until the service verifies the
// signature against that tenant's own DOIT secrets. The signature covers the
// exact bytes, so the body is read raw, never re-serialized. The raw body and
// the signature header are never logged.

import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import { CoreError } from "@starter/shared/core";
import { MINUTE_MS } from "@starter/shared/identity";
import { BODY_LIMIT_BYTES } from "../middleware/body";
import { HttpError } from "../lib/http-error";
import { receiveDoitWebhook } from "../services/payment-webhook.service";

const DOIT_SIGNATURE_HEADER = "PayBridge-Signature";
const UNAUTHORIZED_MESSAGE = "Tanda tangan webhook tidak valid.";
const RATE_LIMITED_MESSAGE = "Terlalu banyak permintaan. Coba lagi sebentar.";
const tenantIdSchema = z.string().uuid();

/** Failed verifications (401) allowed per IP and tenant per minute before 429. */
export const WEBHOOK_FAILED_VERIFICATIONS_PER_IP = 30;
const RATE_LIMIT_CAPACITY = 20_000;

// Process-local fixed window of failed verifications per (IP, tenant). Only a
// 401 answer is counted, so a correctly signed delivery never consumes it. DOIT
// delivers every tenant's webhooks from the same egress IP, so a bucket keyed
// by IP alone would let one tenant with a mismatched secret lock every tenant
// out. The tenant id from the URL is part of the key: a tenant's own failures
// only throttle that tenant on that IP. The bucket is checked before the body
// is read and before any signature check, so a (IP, tenant) pair that already
// failed more than the limit gets 429 even for a correctly signed request until
// its window ends. A caller rotating tenant ids gets a fresh bucket per id; the
// map is capped (RATE_LIMIT_CAPACITY) and each id costs one tenant lookup.
type FailureWindow = { windowStart: number; count: number };
const failedByIp = new Map<string, FailureWindow>();
let limiterNow: () => number = Date.now;

/** Test seam: fresh windows, and optionally a fake clock. */
export function resetPaymentWebhookRateLimits(now?: () => number) {
  limiterNow = now ?? Date.now;
  failedByIp.clear();
}

function limiterKey(req: Parameters<RequestHandler>[0], tenantId: string) {
  // req.ip honours the app's trust proxy setting; a raw X-Forwarded-For is
  // never read. Only called with a validated tenant UUID, lower-cased so the
  // letter case of the URL cannot open a second bucket.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return `${ip}|${tenantId.toLowerCase()}`;
}

/** Seconds left in the window when the IP is over its limit, else null. */
function failedRetryAfter(key: string, now: number): number | null {
  const hit = failedByIp.get(key);
  if (!hit) return null;
  if (now - hit.windowStart >= MINUTE_MS) {
    failedByIp.delete(key);
    return null;
  }
  if (hit.count <= WEBHOOK_FAILED_VERIFICATIONS_PER_IP) return null;
  return Math.max(1, Math.ceil((hit.windowStart + MINUTE_MS - now) / 1000));
}

function recordFailedVerification(key: string, now: number) {
  let hit = failedByIp.get(key);
  if (!hit || now - hit.windowStart >= MINUTE_MS) {
    if (!hit && failedByIp.size >= RATE_LIMIT_CAPACITY) {
      const oldest = failedByIp.keys().next().value;
      if (oldest !== undefined) failedByIp.delete(oldest);
    }
    hit = { windowStart: now, count: 0 };
  }
  hit.count += 1;
  // Move the active key to the end so churn evicts the least recent one.
  failedByIp.delete(key);
  failedByIp.set(key, hit);
}

function rejectRateLimited(res: Parameters<RequestHandler>[1], retry: number) {
  res.setHeader("Retry-After", String(retry));
  res.setHeader("Cache-Control", "no-store");
  throw new HttpError(429, "RATE_LIMITED", RATE_LIMITED_MESSAGE);
}

/** Mounted at /api/webhooks/payments. */
export function createPaymentWebhookRouter(options?: {
  /** Test override; production uses the real service. */
  receive?: typeof receiveDoitWebhook;
}) {
  const router = Router();
  const receive = options?.receive ?? receiveDoitWebhook;

  const rawBody: RequestHandler = (req, res, next) => {
    // A malformed tenant id is a plain 404 with no body echo.
    const tenant = tenantIdSchema.safeParse(req.params.tenantId);
    if (!tenant.success) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Tidak ditemukan." },
      });
      return;
    }
    // Throttle (IP, tenant) pairs with too many failed verifications before
    // the body is read.
    const retry = failedRetryAfter(limiterKey(req, tenant.data), limiterNow());
    if (retry !== null) rejectRateLimited(res, retry);
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

  router.post("/doit/:tenantId", rawBody, async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const result = await receive({
        tenantId: String(req.params.tenantId),
        rawBody: raw,
        // Only the one header the verification reads.
        signatureHeader: req.get(DOIT_SIGNATURE_HEADER) ?? undefined,
      });
      // A stored `failed` row (e.g. paid without an amount, reference not
      // known yet) answers 500 so DOIT retries; the row stays for the worker.
      if (result.status === "failed")
        throw new HttpError(
          500,
          "INTERNAL_ERROR",
          "Webhook belum dapat diproses. Coba lagi.",
        );
      res.status(200).json({ received: true, status: result.status });
    } catch (error) {
      // One fixed message for every verification failure (no oracle).
      if (error instanceof CoreError && error.code === "UNAUTHORIZED") {
        recordFailedVerification(
          limiterKey(req, String(req.params.tenantId)),
          limiterNow(),
        );
        throw new HttpError(401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);
      }
      throw error;
    }
  });

  return router;
}
