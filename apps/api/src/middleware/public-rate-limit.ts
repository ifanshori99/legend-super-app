// Rate limit for the API's public, session-free reads (bead legend-wd4b).
//
// The authenticated surface is bounded by requireAuth, the trusted-origin
// check and permissions; a guest holds no session, so nothing stops a client
// from repeating the public reads forever — and the menu reads return the
// whole catalogue. This middleware caps them per client IP and per resolved
// tenant in one bounded, process-local store.
//
// Which routes: the guest QR scan and menu (/api/qr, F10), the guest table
// session routes (/api/table-sessions, see guestSessionRateLimit), the brand website
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
// The store is in memory by default, like the session-extend limiter: fixed
// windows, an LRU cap, and incremental expiry so the work per request stays
// bounded. With REDIS_URL set the windows live in one shared Redis instead, so
// several API instances count as one (legend-bpvf); a Redis error or stall
// falls back to this instance's own counter and never fails the request. The
// Cloudflare rule documented in docs/deployment.md is the edge layer in front.
//
// Visitor IP: the web server's SSR calls arrive from its own address. When it
// forwards the visitor IP with the shared secret (middleware/ssr-visitor-ip.ts,
// legend-moe5), the per-IP bucket is charged with that address instead.

import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import {
  closeTableSession,
  confirmOpenBillSession,
  mergeTableSessions,
  moveSessionItems,
  moveTableSession,
} from "@starter/shared/qr-order";
import { siteConfig } from "@starter/shared/site";
import { MINUTE_MS } from "@starter/shared/identity";
import { env } from "../config/env";
import { clientIpKey } from "../lib/client-ip-key";
import { createFixedWindowCounter } from "../lib/fixed-window-counter";
import { HttpError } from "../lib/http-error";
import { whatsAppDigest } from "../lib/identity-digest";
import { logger } from "../lib/logger";
import {
  createLocalWindowStore,
  createRedisWindowStore,
  withLocalFallback,
  type SharedWindowStore,
} from "../lib/shared-window-store";
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
  "/api/public/receipts",
  "/api/tenant",
  // Guest reservation self-service by signed link (legend-o5gr). The token
  // travels in a header; this is the per-IP/tenant read budget for every verb.
  "/api/public/reservation-link",
  // Only the token-holding customer payment links. /api/payments/admin is
  // authenticated staff configuration and must never share the guests'
  // per-IP budget at a venue NAT (Opus review legend-wd4b).
  "/api/payments/links",
  // Supplier PO PDF share links (legend-9yz): token in the path, no session.
  "/api/public/purchase-orders",
  // Guest facility price board and QR entry lookup, no login (FAC-11, legend-zjfi).
  "/api/facility/catalog",
  "/api/facility/entry",
  // Active subscription plans for the Wi-Fi portal, no login (legend-1cj0).
  "/api/facility/subscription-plans",
  // EDC bridge tablet pairing, no session (legend-wasr7.24). The coarse
  // per-IP/minute guard in front of its own 5-wrong-codes-per-15-min limit.
  "/api/edc-bridge/pair",
];

/**
 * Mounts shared with authenticated staff routes: only the exact public read
 * (GET/HEAD on the mount itself) is limited; staff POST/PATCH and sub-paths
 * pass through without spending the guests' budget.
 */
const PUBLIC_READ_ONLY_MOUNTS = new Set(["/api/facility/subscription-plans"]);

function skipsLimiter(req: Request): boolean {
  if (!PUBLIC_READ_ONLY_MOUNTS.has(req.baseUrl)) return false;
  const readsOnly = req.method === "GET" || req.method === "HEAD";
  return !readsOnly || req.path !== "/";
}

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
  /**
   * Shared window store. Defaults to Redis when REDIS_URL is set, otherwise
   * the windows stay in this process. A failing store falls back to it.
   */
  store?: SharedWindowStore;
  /**
   * Prefix of the shared-store bucket names (`<prefix>:ip`, `<prefix>:tenant`),
   * so limiters with different limits never share a Redis key. Default "public".
   */
  bucketPrefix?: string;
};

// The counter lives in lib/fixed-window-counter.ts (env-free, so the edge
// link server can use it too: legend-wg5t); re-exported for existing callers.
export { createFixedWindowCounter };

let defaultRedisStore: SharedWindowStore | undefined;
let lastStoreErrorLog = 0;

function logStoreError(error: unknown) {
  const at = Date.now();
  if (at - lastStoreErrorLog < MINUTE_MS) return;
  lastStoreErrorLog = at;
  logger.warn(
    { err: error },
    "Shared rate-limit store unavailable; using this instance's own window",
  );
}

/**
 * The window store the limiters count in: the given or Redis-backed shared one
 * (with the in-process fallback), or the in-process counters alone.
 */
function resolveWindowStore(options: {
  store?: SharedWindowStore;
  capacity: number;
  clock: () => number;
}): SharedWindowStore {
  const localCounter = (limit: number, windowMs: number) =>
    createFixedWindowCounter({ limit, windowMs, capacity: options.capacity });
  let shared = options.store;
  if (!shared && env.REDIS_URL) {
    defaultRedisStore ??= createRedisWindowStore(env.REDIS_URL);
    shared = defaultRedisStore;
  }
  return shared
    ? withLocalFallback(shared, localCounter, {
        now: options.clock,
        onError: logStoreError,
      })
    : createLocalWindowStore(localCounter, options.clock);
}

/** Whole seconds a client must wait, at least one. */
function retrySeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * The address Express resolved; never a raw client-supplied header. Buckets are
 * keyed on `clientIpKey(ip)` (IPv6 by /64, legend-6jgd2); the internal-IP skip
 * still compares the exact address.
 */
export function clientIp(req: Request): string {
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
  const perIpLimit = options.perIp ?? env.PUBLIC_RATE_LIMIT_PER_MINUTE;
  const perTenantLimit =
    options.perTenant ?? env.PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE;
  const ipBucket = `${options.bucketPrefix ?? "public"}:ip`;
  const tenantBucket = `${options.bucketPrefix ?? "public"}:tenant`;
  const store = resolveWindowStore({ store: options.store, capacity, clock });

  return async (req, res, next) => {
    if (skipsLimiter(req)) return next();
    // Both buckets are charged, so one noisy IP cannot spend a tenant's whole
    // budget and one tenant's burst cannot hide behind many IPs.
    // SSR calls from the web server arrive from its own address. With the
    // shared secret the web server forwards the visitor IP (ssr-visitor-ip.ts)
    // and the per-IP bucket is charged with it; without, that address skips the
    // per-IP bucket, and the tenant bucket below still caps it.
    const visitor = req.ssrVisitorIp;
    const ip = visitor ?? clientIp(req);
    const tenant = findTenantContext(req);
    const [ipResult, tenantResult] = await Promise.all([
      !visitor && internalIps.has(ip)
        ? null
        : store.take(ipBucket, clientIpKey(ip), perIpLimit, windowMs),
      tenant
        ? store.take(tenantBucket, tenant.tenantId, perTenantLimit, windowMs)
        : null,
    ]);
    const limited =
      ipResult && !ipResult.allowed
        ? ipResult
        : tenantResult && !tenantResult.allowed
          ? tenantResult
          : null;
    if (limited) {
      // Whole seconds until the window reopens, so a client can wait exactly
      // that long. no-store keeps a CDN from replaying the 429.
      res.setHeader("Retry-After", String(retrySeconds(limited.retryAfterMs)));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Guest table-session routes (beads legend-6ipw, legend-fpi9, legend-khiv).
// /api/table-sessions/:sessionId/... is the guest cart, quote, bill, payment
// and poll surface: public by opaque bearer credential, polled every 2-5 s per
// guest. It sits under the same per-IP limiter as the public reads, with two
// differences so a venue is never blocked on one NAT address: the per-IP
// budget is sized for a whole dining room (every guest shares one address),
// and one table session also has its own bucket (keyed on its credential) so a
// single runaway table is capped at its own session budget. IP and tenant are
// checked first (legend-494: a random bearer must not create a key before that
// check passes), so a request the session bucket refuses has already been
// charged to the IP and tenant buckets: a table that keeps retrying after its
// 429 still spends the venue's shared budget. Staff POSTs on the same
// prefix that carry a staff session cookie are not counted here.

/** Per-IP guest budget as a multiple of the public per-IP budget (venue NAT). */
export const GUEST_SESSION_NAT_FACTOR = 10;
/**
 * Requests allowed per table session in one window. The session credential is
 * one per table session, shared by every guest device at the table (ORD-01),
 * so this covers a whole table polling: one guest on the pay screen is ~57 a
 * minute, a table of ten is ~600.
 */
export const GUEST_SESSION_PER_MINUTE = 600;

// Staff routes share this prefix with the guest ones. They are the POST
// endpoints the contract declares for staff; the set is built from those
// declarations so a new staff route is added in one place. Only a POST that
// also carries a staff session cookie skips the limiter (staff at the venue
// share the guests' NAT address); anything else on these paths is charged to
// the IP and tenant buckets like a guest request.
const STAFF_TABLE_SESSION_ENDPOINTS = [
  confirmOpenBillSession,
  closeTableSession,
  moveTableSession,
  mergeTableSessions,
  moveSessionItems,
];
const TABLE_SESSIONS_PREFIX = "/api/table-sessions";
const STAFF_TABLE_SESSION_PATHS = STAFF_TABLE_SESSION_ENDPOINTS.map(
  (endpoint) => {
    if (!endpoint.path.startsWith(`${TABLE_SESSIONS_PREFIX}/`))
      throw new Error(`Not a table-session route: ${endpoint.path}`);
    return new RegExp(
      `^${endpoint.path
        .slice(TABLE_SESSIONS_PREFIX.length)
        .replace(/:[A-Za-z][A-Za-z0-9]*/g, "[^/]+")}/?$`,
    );
  },
);
// Better Auth cookie: `<cookiePrefix>.session_token`, with `__Secure-` in front
// on https (lib/auth.ts sets cookiePrefix to the site id).
const STAFF_SESSION_COOKIE = new RegExp(
  `(?:^|;\\s*)(?:__Secure-)?${siteConfig.id.replace(/[^A-Za-z0-9_-]/g, "\\$&")}\\.session_token=`,
);

function isStaffTableSessionCall(req: Request): boolean {
  return (
    req.method === "POST" &&
    STAFF_TABLE_SESSION_PATHS.some((path) => path.test(req.path)) &&
    STAFF_SESSION_COOKIE.test(req.get("cookie") ?? "")
  );
}

const GUEST_CREDENTIAL_HEADER = /^Bearer ([A-Za-z0-9_-]{20,256})$/;

export type GuestSessionRateLimitOptions = Partial<
  Omit<PublicRateLimitOptions, "bucketPrefix">
> & {
  perSession?: number;
  /**
   * Credential-bearing requests allowed per client IP in one window. Bounds the
   * session keys one IP can create in the shared store. Off by default (no
   * extra store call): `guest:ip` already bounds those keys at the guest per-IP
   * limit. Set it to bound them tighter.
   */
  perIpCredentials?: number;
};

/**
 * Mount on `/api/table-sessions` after the tenant resolver. `req.path` is
 * relative to that mount.
 */
export function guestSessionRateLimit(
  options: GuestSessionRateLimitOptions = {},
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const perSessionLimit = options.perSession ?? GUEST_SESSION_PER_MINUTE;
  const perIpLimit =
    options.perIp ??
    env.PUBLIC_RATE_LIMIT_PER_MINUTE * GUEST_SESSION_NAT_FACTOR;
  const perIpCredentialsLimit = options.perIpCredentials;
  const internalIps = new Set(
    options.internalIps ?? env.PUBLIC_RATE_LIMIT_INTERNAL_IPS,
  );
  const store = resolveWindowStore({ store: options.store, capacity, clock });
  // "guest" buckets, apart from the public reads': same IP, different limits.
  const ipAndTenant = publicRateLimit({
    ...options,
    perIp: perIpLimit,
    perTenant:
      options.perTenant ?? env.PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE,
    bucketPrefix: "guest",
  });

  return async (req, res, next) => {
    if (isStaffTableSessionCall(req)) return next();
    // IP and tenant first: a request they refuse answers 429 before any
    // credential key exists, so a flood of random bearers from a limited IP
    // creates nothing in the shared store.
    let passed = false;
    let passedArg: unknown;
    await ipAndTenant(req, res, (arg?: unknown) => {
      passed = true;
      passedArg = arg;
    });
    if (!passed) return;
    if (passedArg !== undefined) return next(passedArg as Error);
    // Keyed on the credential, not the URL id: every device at a table shares
    // one credential (ORD-01), while a stranger who puts a victim's session id
    // in the URL with a junk credential only spends their own bucket. A request
    // without a well-formed credential is charged to IP and tenant only.
    const credential = GUEST_CREDENTIAL_HEADER.exec(
      req.get("authorization") ?? "",
    )?.[1];
    if (credential) {
      // Optional (perIpCredentials): credential-bearing requests capped per IP
      // per window, charged before the session bucket, so one IP creates at
      // most that many session keys per window. Same visitor-IP rule as
      // publicRateLimit.
      const visitor = req.ssrVisitorIp;
      const ip = visitor ?? clientIp(req);
      if (
        perIpCredentialsLimit !== undefined &&
        (visitor || !internalIps.has(ip))
      ) {
        const credIp = await store.take(
          "guest:cred-ip",
          clientIpKey(ip),
          perIpCredentialsLimit,
          windowMs,
        );
        if (!credIp.allowed) {
          rejectRateLimited(res, retrySeconds(credIp.retryAfterMs));
        }
      }
      const tenant = findTenantContext(req);
      const digest = createHash("sha256").update(credential).digest("hex");
      const result = await store.take(
        "guest:session",
        `${tenant?.tenantId ?? ""}:${digest}`,
        perSessionLimit,
        windowMs,
      );
      if (!result.allowed) {
        rejectRateLimited(res, retrySeconds(result.retryAfterMs));
      }
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Public booking writes (bead legend-t8bz). A guest booking creates rows and
// may open a DP payment, so it gets its own, much lower budget than the reads
// above (app.ts mounts the read limiter on /api/public/outlets, which the
// booking POST also passes through), plus a cap per guest contact so one
// number cannot be used to flood an outlet's table plan from many IPs.

/** Booking POSTs allowed per client IP per minute. */
export const PUBLIC_WRITE_PER_IP = 10;
/** Booking POSTs allowed per tenant per minute. */
export const PUBLIC_WRITE_PER_TENANT = 60;
/** Booking POSTs allowed per contact, tenant and outlet per hour. */
export const PUBLIC_WRITE_PER_CONTACT = 5;
export const PUBLIC_WRITE_CONTACT_WINDOW_MS = 60 * MINUTE_MS;

export type PublicWriteRateLimitOptions = {
  perIp: number;
  perTenant: number;
  perContact: number;
  internalIps?: readonly string[];
  windowMs?: number;
  contactWindowMs?: number;
  capacity?: number;
  now?: () => number;
  /** Shared window store for the IP and tenant buckets; see PublicRateLimitOptions. */
  store?: SharedWindowStore;
};

export function rejectRateLimited(
  res: Parameters<RequestHandler>[1],
  retry: number,
) {
  res.setHeader("Retry-After", String(retry));
  res.setHeader("Cache-Control", "no-store");
  throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
}

/**
 * Two handlers for one public booking route. Mount `perRequest` before the
 * body parser (IP + tenant buckets) and `perContact` after it (it reads
 * `contactPhone`). The contact bucket key is the keyed WhatsApp digest, never
 * the raw number. A body whose number does not normalize skips the contact
 * bucket: the strict contract refuses it afterwards and it writes nothing.
 *
 * Replays: a request repeating an `Idempotency-Key` already seen for the same
 * contact inside the window is not charged to the contact bucket again, so a
 * client retrying after a network error cannot lock itself out. The IP and
 * tenant buckets still count every request.
 */
export function createPublicBookingLimits(
  options: Partial<PublicWriteRateLimitOptions> = {},
): { perRequest: RequestHandler; perContact: RequestHandler } {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const contactWindowMs =
    options.contactWindowMs ?? PUBLIC_WRITE_CONTACT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const internalIps = new Set(
    options.internalIps ?? env.PUBLIC_RATE_LIMIT_INTERNAL_IPS,
  );
  const perIpLimit = options.perIp ?? PUBLIC_WRITE_PER_IP;
  const perTenantLimit = options.perTenant ?? PUBLIC_WRITE_PER_TENANT;
  const store = resolveWindowStore({ store: options.store, capacity, clock });
  const perContact = createFixedWindowCounter({
    limit: options.perContact ?? PUBLIC_WRITE_PER_CONTACT,
    windowMs: contactWindowMs,
    capacity,
  });
  // Replay memory: bounded, insertion ordered, values are expiry instants.
  const seenKeys = new Map<string, number>();

  return {
    perRequest: async (req, res, next) => {
      // Same visitor-IP rule as publicRateLimit (ssr-visitor-ip.ts).
      const visitor = req.ssrVisitorIp;
      const ip = visitor ?? clientIp(req);
      const tenant = findTenantContext(req);
      const [ipResult, tenantResult] = await Promise.all([
        !visitor && internalIps.has(ip)
          ? null
          : store.take("booking:ip", clientIpKey(ip), perIpLimit, windowMs),
        tenant
          ? store.take(
              "booking:tenant",
              tenant.tenantId,
              perTenantLimit,
              windowMs,
            )
          : null,
      ]);
      const limited =
        ipResult && !ipResult.allowed
          ? ipResult
          : tenantResult && !tenantResult.allowed
            ? tenantResult
            : null;
      if (limited) rejectRateLimited(res, retrySeconds(limited.retryAfterMs));
      next();
    },
    perContact: async (req, res, next) => {
      const now = clock();
      const tenant = findTenantContext(req);
      const phone = (req.body as { contactPhone?: unknown } | undefined)
        ?.contactPhone;
      if (!tenant || typeof phone !== "string") return next();
      let digest: string;
      try {
        digest = await whatsAppDigest(phone);
      } catch {
        return next();
      }
      const scope = `${tenant.tenantId}:${String(req.params.outletId ?? "")}:${digest}`;
      const idempotencyKey = req.header("idempotency-key");
      const replayKey = idempotencyKey ? `${scope}:${idempotencyKey}` : null;
      if (replayKey) {
        const expiresAt = seenKeys.get(replayKey);
        if (expiresAt !== undefined && expiresAt > now) return next();
      }
      const retry = perContact.take(`contact:${scope}`, now);
      if (retry !== null) rejectRateLimited(res, retry);
      if (replayKey) {
        if (seenKeys.size >= capacity) {
          const oldest = seenKeys.keys().next().value;
          if (oldest !== undefined) seenKeys.delete(oldest);
        }
        seenKeys.delete(replayKey);
        seenKeys.set(replayKey, now + contactWindowMs);
      }
      next();
    },
  };
}
