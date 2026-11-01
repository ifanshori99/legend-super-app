// Caddy's on-demand TLS ask gate (PRD v1.7 §3 F4 "Domain ... dengan TLS
// otomatis"). Caddy asks this endpoint before issuing a certificate for a host
// it has not seen; only 2xx issues one. The answer therefore is a bare yes/no
// and never a body.
//
// The ask request comes from the reverse proxy, not a browser: there is no
// Origin to check. When TLS_ASK_TOKEN is configured Caddy must send it as
// X-Tls-Ask-Token, so a client cannot use the endpoint as a certificate-issue
// oracle; without the variable (local development) the host check alone runs.
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";

export function tlsAskGuard(configured = env.TLS_ASK_TOKEN): RequestHandler {
  return (req, _res, next) => {
    if (!configured) return next();
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
