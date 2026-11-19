// Staff pin edge sync API (bead legend-obh5; PRD v1.7 §3 F6, §6 B staff_pins
// "(T, E)", EDG-02, TEN-02). Thin route; every rule is in
// services/staff-pin-sync.ts.
//
// staffPinSyncRouter (cloud only; mount at /api/edge-sync/staff-pin-records —
// /api/edge/* is edge-only under legend-2pi's EDGE_MODE route guard):
//   GET /?since=<watermark>&limit=<1..100>
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port (legend-2pi; deny-all until installed).
//     No session, no cookie, read-only (no Origin check needed). Tenant and
//     outlet come from the verified credential; a tenant resolved from the
//     domain or a device token must be the same one. Hash-only records, never
//     a pin. With `peppers=<versions held, e.g. 2,3>` the response also
//     carries the pepper(s) the cloud derived for this credential's outlet that
//     the edge lacks (never version 1, never the root; legend-ideif,
//     legend-jmsdx, see services/staff-pin-sync.ts).
//     Rate limited BEFORE the credential check (which reads the database):
//     per client IP and per presented credential (a digest of a well-formed
//     bearer, no database read), 429 RATE_LIMITED + Retry-After (legend-wg5t
//     item 8b). An edge syncs on a timer, so the limits are far above its
//     normal cadence.

import { createHash } from "node:crypto";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { CoreError } from "@starter/shared/core";
import { parseEdgeCredential } from "../edge/credential.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  createFixedWindowCounter,
  PUBLIC_RATE_LIMIT_CAPACITY,
  PUBLIC_RATE_LIMIT_MESSAGE,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
} from "../middleware/public-rate-limit.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  edgeCredentialFromAuthorization,
  listStaffPinRecordsSince,
  staffPinSyncQuerySchema,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

/** Requests per client IP per window; a venue NAT or proxy may share one IP. */
export const STAFF_PIN_SYNC_PER_IP = 60;
/** Requests per presented edge credential per window. */
export const STAFF_PIN_SYNC_PER_NODE = 30;

export type StaffPinSyncRouterOptions = {
  perIp?: number;
  perNode?: number;
  windowMs?: number;
  capacity?: number;
  /** Test seam; production uses the wall clock. */
  now?: () => number;
};

/**
 * Pre-authentication limiter (legend-wg5t item 8b). The credential check hits
 * the database, so an anonymous flood must be stopped before it. The second
 * key is a digest of the whole bearer (only when it has a credential's shape;
 * no database): a node polling too fast is capped, while someone who knows a
 * node's id but not its secret lands in another bucket and cannot lock the
 * real node out. The IP bucket still caps the forger. A bearer that does not
 * parse is charged to the IP only.
 */
function staffPinSyncRateLimit(
  options: StaffPinSyncRouterOptions,
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const perIp = createFixedWindowCounter({
    limit: options.perIp ?? STAFF_PIN_SYNC_PER_IP,
    windowMs,
    capacity,
  });
  const perNode = createFixedWindowCounter({
    limit: options.perNode ?? STAFF_PIN_SYNC_PER_NODE,
    windowMs,
    capacity,
  });
  return (req, res, next) => {
    const now = clock();
    // Both buckets are charged, so one node cannot hide behind many IPs and
    // one IP cannot spend every node's budget unnoticed.
    const ipRetry = perIp.take(
      `ip:${req.ip || req.socket.remoteAddress || "unknown"}`,
      now,
    );
    const bearer = edgeCredentialFromAuthorization(req.get("Authorization"));
    const nodeRetry =
      typeof bearer === "string" && parseEdgeCredential(bearer)
        ? perNode.take(
            `credential:${createHash("sha256").update(bearer).digest("base64url")}`,
            now,
          )
        : null;
    const retryAfter = ipRetry ?? nodeRetry;
    if (retryAfter !== null) {
      // Same shape as publicRateLimit: wait exactly the window; no-store keeps
      // a CDN from replaying the 429.
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}

/** Factory so tests can inject limits and a clock; the router below uses defaults. */
export function createStaffPinSyncRouter(
  options: StaffPinSyncRouterOptions = {},
): Router {
  const router = Router();
  router.use(staffPinSyncRateLimit(options));
  router.get("/", handleStaffPinSync);
  return router;
}

async function handleStaffPinSync(req: Request, res: Response): Promise<void> {
  // Authenticate before reading any input, so an anonymous caller learns
  // nothing about the query rules.
  const node = await verifyEdgeCredential(
    edgeCredentialFromAuthorization(req.get("Authorization")),
  );
  if (node === null)
    throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
  const resolved = findTenantContext(req);
  if (
    resolved !== undefined &&
    resolved.tenantId.toLowerCase() !== node.tenantId.toLowerCase()
  )
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this domain.",
    );
  const query = staffPinSyncQuerySchema.parse(req.query);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await listStaffPinRecordsSince(node, query));
}

export const staffPinSyncRouter = createStaffPinSyncRouter();
