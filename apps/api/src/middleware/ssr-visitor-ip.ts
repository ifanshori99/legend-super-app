// Visitor IP forwarded by the SSR web server (bead legend-moe5).
//
// The web server calls this API from its own address, so every SSR read looks
// like one client. It forwards the visitor's address in `x-starter-visitor-ip`,
// next to `x-starter-ssr-auth` (the SSR_SHARED_SECRET both apps hold). The API
// trusts the address only when the secret matches: a browser that sends the
// header itself is ignored, so it can neither pick its own bucket nor spend
// another visitor's.
//
// With no secret configured the feature is off and nothing changes. In every
// case both headers are removed before any later code can read them.
// Mount before publicRateLimit; that limiter then charges the per-IP bucket
// with `req.ssrVisitorIp`.

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import { env } from "../config/env";

export const SSR_AUTH_HEADER = "x-starter-ssr-auth";
export const SSR_VISITOR_IP_HEADER = "x-starter-visitor-ip";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function ssrVisitorIp(
  options: { secret?: string } = {},
): RequestHandler {
  const secret = options.secret ?? env.SSR_SHARED_SECRET;
  const secretDigest = secret ? digest(secret) : null;

  return (req, _res, next) => {
    const presented = single(req.headers[SSR_AUTH_HEADER]);
    const visitor = single(req.headers[SSR_VISITOR_IP_HEADER])?.trim();
    delete req.headers[SSR_AUTH_HEADER];
    delete req.headers[SSR_VISITOR_IP_HEADER];
    if (
      secretDigest &&
      presented &&
      visitor &&
      timingSafeEqual(digest(presented), secretDigest) &&
      isIP(visitor) !== 0
    ) {
      req.ssrVisitorIp = visitor;
    }
    next();
  };
}
