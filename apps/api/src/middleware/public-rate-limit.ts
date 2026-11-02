// Rate limit for the API's public, session-free reads (bead legend-wd4b).
//
// The authenticated surface is bounded by requireAuth, the trusted-origin
// check and permissions; a guest holds no session, so nothing stops a client
// from repeating the public reads forever — and the menu reads return the
// whole catalogue. This middleware caps them per client IP and per resolved
// tenant in one bounded, process-local store.
//
// Which routes: the guest QR scan and menu (/api/qr, F10), the brand website
// and its menu (/api/public/site, F21), the SSR brand context (/api/tenant,
// TEN-08) and customer payment links (/api/payments, F13). Authenticated
// routes, Better Auth, provider webhooks and the TLS ask are never mounted
// here: auth keeps its own stricter per-route limits and health stays free so
// a limiter window can never fail a probe.
//
// Client IP: `req.ip`, the address Express resolved with the app's
// `trust proxy` setting. With TRUST_PROXY unset (or a hop count/subnet list)
// a client-supplied X-Forwarded-For is ignored, so the key cannot be spoofed;
// TRUST_PROXY itself refuses `true` (config/env.ts). Keep the hop count aligned
// with the proxies in front of the API (Cloudflare + reverse proxy = 2), or
// every request shares the proxy's address — see docs/deployment.md.
//
// The store is in memory, like the session-extend limiter: fixed windows, an
// LRU cap, and incremental expiry so the work per request stays bounded.
// Several API instances each hold their own window; the Cloudflare rule
// documented in docs/deployment.md is the edge layer in front of them.

import type { Request, RequestHandler } from "express";
import { MINUTE_MS } from "@starter/shared/identity";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { findTenantContext } from "./tenant";

/** One fixed window for every public read; env limits are per minute. */
export const PUBLIC_RATE_LIMIT_WINDOW_MS = MINUTE_MS;

/** Tracked keys per bucket. Oldest keys are evicted first, resetting them. */
export const PUBLIC_RATE_LIMIT_CAPACITY = 20_000;

export const PUBLIC_RATE_LIMIT_MESSAGE =
  "Terlalu banyak permintaan. Coba lagi sebentar.";

/**
 * The public, unauthenticated surface. Path prefixes only: Express matches on
 * whole segments, so "/api/qr" covers "/api/qr/menu/…" but not "/api/qrx".
 */
export const PUBLIC_RATE_LIMIT_PATHS: string[] = [
  "/api/qr",
  "/api/public/site",
  "/api/public/outlets",
  "/api/tenant",
  // Only the token-holding customer payment links. /api/payments/admin is
  // authenticated staff configuration and must never share the guests'
  // per-IP budget at a venue NAT (Opus review legend-wd4b).
  "/api/payments/links",
];

export type PublicRateLimitOptions = {
  /** Requests allowed per client IP in one window. */
  perIp: number;
  /** Requests allowed per resolved tenant in one window. */
  perTenant: number;
  /**
   * Addresses that skip the per-IP bucket (the tenant bucket still applies):
   * the web server's own address, whose SSR calls carry no visitor IP and
   * would otherwise put every visitor in one bucket.
   */
  internalIps?: readonly string[];
  windowMs?: number;
  capacity?: number;
  /** Test seam; production uses the wall clock. */
  now?: () => number;
};

type Window = { windowStart: number; count: number };

/**
 * Fixed-window counter with the shape of services/session-extend-limiter.ts:
 * a bounded Map, the least recently used key evicted first, and a few expired
 * keys swept per call so cleanup cost does not grow with the map.
 */
export function createFixedWindowCounter(options: {
  limit: number;
  windowMs: number;
  capacity: number;
}) {
  const hits = new Map<string, Window>();
  return {
    size: () => hits.size,
    /**
     * Counts one request. Returns null while the key is inside its limit, or
     * the whole seconds left in the window once it is over.
     */
    take(key: string, now: number): number | null {
      // Check a small number per request, keeping cleanup work bounded.
      let checked = 0;
      for (const [entryKey, hit] of hits) {
        if (now - hit.windowStart >= options.windowMs) hits.delete(entryKey);
        if (++checked === 4) break;
      }
      let hit = hits.get(key);
      if (!hit || now - hit.windowStart >= options.windowMs) {
        if (!hit && hits.size >= options.capacity) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
        hit = { windowStart: now, count: 0 };
      }
      hit.count += 1;
      // Move the active key to the end so churn evicts the least recent one.
      hits.delete(key);
      hits.set(key, hit);
      if (hit.count <= options.limit) return null;
      return Math.max(
        1,
        Math.ceil((hit.windowStart + options.windowMs - now) / 1000),
      );
    },
  };
}

/** The address Express resolved; never a raw client-supplied header. */
function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * One limiter pair for the whole public surface, so a client cannot multiply
 * its budget by switching between the public routes. Mount it after the
 * tenant resolver: the per-tenant bucket needs the server-minted context.
 */
export function publicRateLimit(
  options: Partial<PublicRateLimitOptions> = {},
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const internalIps = new Set(
    options.internalIps ?? env.PUBLIC_RATE_LIMIT_INTERNAL_IPS,
  );
  const perIp = createFixedWindowCounter({
    limit: options.perIp ?? env.PUBLIC_RATE_LIMIT_PER_MINUTE,
    windowMs,
    capacity,
  });
  const perTenant = createFixedWindowCounter({
    limit: options.perTenant ?? env.PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE,
    windowMs,
    capacity,
  });

  return (req, res, next) => {
    const now = clock();
    // Both buckets are charged, so one noisy IP cannot spend a tenant's whole
    // budget and one tenant's burst cannot hide behind many IPs.
    // SSR calls from the web server arrive from its own address with no
    // visitor IP (apps/web upstream.server.ts), so that address skips the
    // per-IP bucket; the tenant bucket below still caps it.
    const ip = clientIp(req);
    const ipRetry = internalIps.has(ip) ? null : perIp.take(`ip:${ip}`, now);
    const tenant = findTenantContext(req);
    const tenantRetry = tenant
      ? perTenant.take(`tenant:${tenant.tenantId}`, now)
      : null;
    const retryAfter = ipRetry ?? tenantRetry;
    if (retryAfter !== null) {
      // Whole seconds until the window reopens, so a client can wait exactly
      // that long. no-store keeps a CDN from replaying the 429.
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}
