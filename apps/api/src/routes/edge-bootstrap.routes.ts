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

export type EdgeBootstrapRouterOptions = {
  perIp?: number;
  perCredential?: number;
  windowMs?: number;
  capacity?: number;
  /** Test seam; production uses the wall clock. */
  now?: () => number;
};

/**
 * Pre-authentication limiter (legend-aor4). The credential check hits the
 * database, so an anonymous flood must be stopped before it. The credential
 * key is a digest of the whole bearer (only when it has a credential's shape;
 * no database), so a forger who knows a node's id but not its secret lands in
 * another bucket and cannot lock the real node out. The IP bucket still caps
 * the forger. A bearer that does not parse is charged to the IP only.
 */
function edgeBootstrapRateLimit(
  options: EdgeBootstrapRouterOptions,
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const perIp = createFixedWindowCounter({
    limit: options.perIp ?? EDGE_BOOTSTRAP_PER_IP,
    windowMs,
    capacity,
  });
  const perCredential = createFixedWindowCounter({
    limit: options.perCredential ?? EDGE_BOOTSTRAP_PER_CREDENTIAL,
    windowMs,
    capacity,
  });
  return (req, res, next) => {
    const now = clock();
    const ipRetry = perIp.take(
      `ip:${req.ip || req.socket.remoteAddress || "unknown"}`,
      now,
    );
    const bearer = edgeCredentialFromAuthorization(req.get("Authorization"));
    const credentialRetry =
      typeof bearer === "string" && parseEdgeCredential(bearer)
        ? perCredential.take(
            `credential:${createHash("sha256").update(bearer).digest("base64url")}`,
            now,
          )
        : null;
    const retryAfter = ipRetry ?? credentialRetry;
    if (retryAfter !== null) {
      // no-store keeps a CDN from replaying the 429.
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}

/** Factory so tests can inject limits and a clock; the router below uses defaults. */
export function createEdgeBootstrapRouter(
  options: EdgeBootstrapRouterOptions = {},
): Router {
  const router = Router();
  // Limiter on the bootstrap route only: /masters is not throttled here (the
  // master-sync tests call it more often than the bootstrap limits allow).
  router.get("/", edgeBootstrapRateLimit(options), handleEdgeBootstrap);
  router.get("/masters", handleEdgeMasters);
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
  res.json(await buildEdgeMasterSnapshot(node, credential));
}

export const edgeBootstrapRouter = createEdgeBootstrapRouter();
