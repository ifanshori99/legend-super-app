// Caddy's on-demand TLS ask gate (PRD v1.7 §3 F4 "Domain ... dengan TLS
// otomatis"). Caddy asks this endpoint before issuing a certificate for a host
// it has not seen; only 2xx issues one. The answer therefore is a bare yes/no
// and never a body.
//
// The ask request comes from the reverse proxy, not a browser: there is no
// Origin to check. When TLS_ASK_TOKEN is configured Caddy must send it as
// X-Tls-Ask-Token, so a client cannot use the endpoint as a certificate-issue
// oracle; without the variable only a non-production runtime (local
// development) runs the host check alone. Production without the variable
// fails closed: no certificate is issued until the secret is configured.
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";

export function tlsAskGuard(
  configured = env.TLS_ASK_TOKEN,
  production = env.NODE_ENV === "production",
): RequestHandler {
  return (req, _res, next) => {
    if (!configured) {
      if (production)
        throw new HttpError(403, "FORBIDDEN", "TLS ask is not configured.");
      return next();
    }
    const supplied = Buffer.from(req.get("x-tls-ask-token") ?? "");
    const expected = Buffer.from(configured);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(403, "FORBIDDEN", "TLS ask is not authorized.");
    next();
  };
}

// The ask bridge is reachable only from Caddy's loopback listener, but every
// unknown SNI still costs one registry lookup. Cap lookups per window so a
// flood of random hostnames (e.g. direct-to-origin traffic that slipped past
// the firewall) cannot turn certificate asks into database load. Over the cap
// the answer is 429, which Caddy treats as "do not issue"; a legitimate domain
// is simply asked again on its next handshake (legend-7bd review).
export function tlsAskRateLimit({
  limit = 60,
  windowMs = 60_000,
  now = Date.now,
}: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
} = {}): RequestHandler {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return (_req, res, next) => {
    const at = now();
    if (at - windowStart >= windowMs) {
      windowStart = at;
      count = 0;
    }
    count += 1;
    if (count > limit) {
      res.status(429).end();
      return;
    }
    next();
  };
}
