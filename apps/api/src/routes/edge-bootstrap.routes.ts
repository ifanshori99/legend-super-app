// Edge bootstrap bundle API (bead legend-khu5; PRD v1.7 §3 F5 "Server
// Lokal", TEN-02). Thin route; every rule is in
// services/edge-bootstrap.service.ts. Same shape as edge-device-sync.routes.ts.
//
// edgeBootstrapRouter (cloud only; mount at /api/edge-sync/bootstrap):
//   GET /
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port. No session, no cookie, read-only.
//     Tenant and outlet come from the verified credential; a tenant resolved
//     from the domain must be the same one. Answers `{ bundle, signature }`.
//     Rate limited BEFORE the credential check (which reads the database):
//     per client IP and per presented credential (a digest of a well-formed
//     bearer, no database read), 429 RATE_LIMITED + Retry-After (legend-aor4,
//     same pattern as staff-pin-sync.routes.ts, legend-wg5t item 8b).
//   GET /masters (bead legend-9ppw)
//     Same auth and tenant-domain check. Answers `{ snapshot, signature }`:
//     uoms, the outlet's stock locations, and its legal entity's chart of
//     accounts and account mappings (services/edge-master-sync.service.ts).
//     Own limiter (legend-uznb), higher than the bootstrap one because a node
//     pulls masters on a timer: per client IP and per client IP + edge node id
//     (parsed from a well-formed bearer, no database read).
//
// createApp (app.ts) mounts createEdgeBootstrapRateLimit() BEFORE tenant
// resolution (legend-uznb, Codex 119), so a flood is refused before the
// tenant-domain query. The router keeps the same limiter so it stays limited
// when mounted on its own; a request already counted upstream is not counted
// twice.

import { createHash } from "node:crypto";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { CoreError } from "@starter/shared/core";
import {
  EDGE_MASTER_SNAPSHOT_VERSION_HEADER,
  edgeMasterSnapshotQuerySchema,
} from "@starter/shared/edge/master-sync";
import { parseEdgeCredential } from "../edge/credential.ts";
import { HttpError } from "../lib/http-error.ts";
import { clientIpKey } from "../lib/client-ip-key.ts";
import {
  createFixedWindowCounter,
  PUBLIC_RATE_LIMIT_CAPACITY,
  PUBLIC_RATE_LIMIT_MESSAGE,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
} from "../middleware/public-rate-limit.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { buildEdgeBootstrapBundle } from "../services/edge-bootstrap.service.ts";
import { buildEdgeMasterSnapshot } from "../services/edge-master-sync.service.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

// legend-aor4: bootstrap runs once when a node first starts (plus a few
// retries after a failure), so these are far above a real node's need while
// still stopping a flood of well-formed `edg1` tokens with random secrets
// from reaching the tenant/node queries.
/** Requests per client IP per window; a venue NAT may restart several nodes. */
export const EDGE_BOOTSTRAP_PER_IP = 30;
/** Requests per presented edge credential per window. */
export const EDGE_BOOTSTRAP_PER_CREDENTIAL = 10;
// legend-uznb: /masters is pulled on a timer (edge/master-sync.ts, at most
// once a minute per node) plus retries, so its limits sit above the bootstrap
// ones and use their own buckets.
/** /masters requests per client IP per window (all nodes behind one NAT). */
export const EDGE_MASTERS_PER_IP = 120;
/** /masters requests per client IP + edge node id per window. */
export const EDGE_MASTERS_PER_DEVICE = 30;

export type EdgeBootstrapRouterOptions = {
  perIp?: number;
  perCredential?: number;
  mastersPerIp?: number;
  mastersPerDevice?: number;
  windowMs?: number;
  capacity?: number;
  /** Test seam; production uses the wall clock. */
  now?: () => number;
};

/** Requests already passed by an upstream limiter (app.ts), not charged twice. */
const countedRequests = new WeakSet<Request>();

function isMastersPath(path: string): boolean {
  return path.replace(/\/+$/, "").toLowerCase() === "/masters";
}

/**
 * Pre-authentication limiter (legend-aor4). The credential check hits the
 * database, so an anonymous flood must be stopped before it. The credential
 * key is a digest of the whole bearer (only when it has a credential's shape;
 * no database), so a forger who knows a node's id but not its secret lands in
 * another bucket and cannot lock the real node out. The IP bucket still caps
 * the forger. A bearer that does not parse is charged to the IP only.
 *
 * /masters (legend-uznb) has its own, higher buckets: per client IP and per
 * client IP + edge node id. Keyed on the IP too, a forger elsewhere cannot use
 * a node's id to lock that node out. Needs no tenant, so app.ts runs it before
 * tenant resolution; paths are relative to the bootstrap mount point.
 */
export function createEdgeBootstrapRateLimit(
  options: EdgeBootstrapRouterOptions = {},
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const counter = (limit: number) =>
    createFixedWindowCounter({ limit, windowMs, capacity });
  const perIp = counter(options.perIp ?? EDGE_BOOTSTRAP_PER_IP);
  const perCredential = counter(
    options.perCredential ?? EDGE_BOOTSTRAP_PER_CREDENTIAL,
  );
  const mastersPerIp = counter(options.mastersPerIp ?? EDGE_MASTERS_PER_IP);
  const mastersPerDevice = counter(
    options.mastersPerDevice ?? EDGE_MASTERS_PER_DEVICE,
  );
  return (req, res, next) => {
    if (countedRequests.has(req)) return next();
    const now = clock();
    const ip = clientIpKey(req.ip || req.socket.remoteAddress);
    const bearer = edgeCredentialFromAuthorization(req.get("Authorization"));
    const parsed =
      typeof bearer === "string" ? parseEdgeCredential(bearer) : null;
    let retryAfter: number | null;
    if (isMastersPath(req.path)) {
      const ipRetry = mastersPerIp.take(`ip:${ip}`, now);
      // Keyed on the whole bearer (hashed), not the node id alone: a host on
      // the same IP that knows a node's id but not its secret lands in its own
      // bucket and cannot exhaust the real node's. Not charged once the IP
      // bucket refused (no churn of the device store by a limited IP).
      const deviceRetry =
        ipRetry === null && typeof bearer === "string" && parsed
          ? mastersPerDevice.take(
              `device:${ip}:${createHash("sha256").update(bearer).digest("base64url")}`,
              now,
            )
          : null;
      retryAfter = ipRetry ?? deviceRetry;
    } else {
      const ipRetry = perIp.take(`ip:${ip}`, now);
      const credentialRetry =
        ipRetry === null && typeof bearer === "string" && parsed
          ? perCredential.take(
              `credential:${createHash("sha256").update(bearer).digest("base64url")}`,
              now,
            )
          : null;
      retryAfter = ipRetry ?? credentialRetry;
    }
    if (retryAfter !== null) {
      // no-store keeps a CDN from replaying the 429.
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    countedRequests.add(req);
    next();
  };
}

/** Factory so tests can inject limits and a clock; the router below uses defaults. */
export function createEdgeBootstrapRouter(
  options: EdgeBootstrapRouterOptions = {},
): Router {
  const router = Router();
  const rateLimit = createEdgeBootstrapRateLimit(options);
  router.get("/", rateLimit, handleEdgeBootstrap);
  router.get("/masters", rateLimit, handleEdgeMasters);
  return router;
}

/** The verified node and the credential it presented; throws on any mismatch. */
async function authenticateEdgeNode(
  req: Request,
): Promise<{ node: VerifiedEdgeNode; credential: string }> {
  const credential = edgeCredentialFromAuthorization(req.get("Authorization"));
  const node = await verifyEdgeCredential(credential);
  if (node === null || credential === null)
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
  return { node, credential };
}

async function handleEdgeBootstrap(req: Request, res: Response): Promise<void> {
  const { node, credential } = await authenticateEdgeNode(req);
  res.setHeader("Cache-Control", "private, no-store");
  // Signed with the presented credential's digest (rotation grace period).
  res.json(await buildEdgeBootstrapBundle(node, credential));
}

async function handleEdgeMasters(req: Request, res: Response): Promise<void> {
  const { node, credential } = await authenticateEdgeNode(req);
  res.setHeader("Cache-Control", "private, no-store");
  // The query survives a proxy stripping our custom header. With neither,
  // the response remains the old version 1 shape.
  const query = edgeMasterSnapshotQuerySchema.parse(req.query);
  const asked = Number.parseInt(
    query.snapshotVersion ?? req.get(EDGE_MASTER_SNAPSHOT_VERSION_HEADER) ?? "",
    10,
  );
  if (query.brandPage !== undefined && !(asked >= 2))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Halaman brand memerlukan snapshot versi 2.",
    );
  res.json(
    await buildEdgeMasterSnapshot(node, credential, {
      snapshotVersion: Number.isFinite(asked) ? asked : undefined,
      brandPage: query.brandPage === "1",
      brandCursor: query.brandCursor,
      uomIsSystem: query.uomIsSystem === "1",
    }),
  );
}

export const edgeBootstrapRouter = createEdgeBootstrapRouter();
