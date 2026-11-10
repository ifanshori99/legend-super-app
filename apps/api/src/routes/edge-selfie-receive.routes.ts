// Edge selfie upload API (bead legend-0wvoz, C6; design
// docs/design/hris-edge-replication.md 6.1). Thin route; every rule is in
// services/edge-selfie-receive.ts.
//
// createEdgeSelfieReceiveRouter (cloud only; mounted by createStorageApiRouter
// at /api/edge-sync/attendance-selfies so it gets the storage runtime):
//   PUT /:objectId   body = the LSS1 sealed file, header X-Legend-Sealed-Sha256
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port. No session, no cookie. Tenant and outlet
//     come from the verified credential; a tenant resolved from the domain or a
//     device token must be the same one.
//     Rate limited BEFORE the credential check (which reads the database), the
//     same pattern as routes/staff-pin-sync.routes.ts: per client IP and per
//     presented credential (a digest of a well-formed bearer, no database
//     read), 429 RATE_LIMITED + Retry-After. The credential is checked before
//     the body is read, so an anonymous caller cannot make the cloud buffer
//     6 MiB; the body is capped at EDGE_SELFIE_SEALED_MAX_BYTES (413).
//     No storage runtime: 503.

import { createHash } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { CoreError, uuidSchema } from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  EDGE_SELFIE_SEALED_MAX_BYTES,
  SEALED_SHA256_HEADER,
} from "@starter/shared/edge";
import { parseEdgeCredential } from "../edge/credential.ts";
import type * as schema from "../db/schema";
import { HttpError } from "../lib/http-error.ts";
import {
  createFixedWindowCounter,
  PUBLIC_RATE_LIMIT_CAPACITY,
  PUBLIC_RATE_LIMIT_MESSAGE,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
} from "../middleware/public-rate-limit.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import type { MalwareScanner } from "../services/core-image.ts";
import { receiveEdgeSelfie } from "../services/edge-selfie-receive.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

/** Requests per client IP per window; a venue NAT or proxy may share one IP. */
export const EDGE_SELFIE_RECEIVE_PER_IP = 120;
/** Requests per presented edge credential per window. */
export const EDGE_SELFIE_RECEIVE_PER_NODE = 60;

export type EdgeSelfieReceiveRouterOptions = {
  database: NodePgDatabase<typeof schema>;
  /** Null when the app has no object storage runtime: every upload answers 503. */
  storage: ObjectStorage | null;
  scanner: MalwareScanner | null | undefined;
  perIp?: number;
  perNode?: number;
  windowMs?: number;
  capacity?: number;
  /** Test seam for the limiter clock (ms); production uses the wall clock. */
  now?: () => number;
};

/**
 * Pre-authentication limiter: the credential check hits the database, so an
 * anonymous flood must be stopped before it. See staff-pin-sync.routes.ts for
 * why the second key is a digest of the whole bearer.
 */
function edgeSelfieRateLimit(
  options: EdgeSelfieReceiveRouterOptions,
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const perIp = createFixedWindowCounter({
    limit: options.perIp ?? EDGE_SELFIE_RECEIVE_PER_IP,
    windowMs,
    capacity,
  });
  const perNode = createFixedWindowCounter({
    limit: options.perNode ?? EDGE_SELFIE_RECEIVE_PER_NODE,
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
    const nodeRetry =
      typeof bearer === "string" && parseEdgeCredential(bearer)
        ? perNode.take(
            `credential:${createHash("sha256").update(bearer).digest("base64url")}`,
            now,
          )
        : null;
    const retryAfter = ipRetry ?? nodeRetry;
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}

/** Verifies the edge credential and keeps the node for the handler. */
async function authenticateEdgeNode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
  res.locals.edgeNode = node;
  next();
}

export function createEdgeSelfieReceiveRouter(
  options: EdgeSelfieReceiveRouterOptions,
): Router {
  const router = Router();
  router.use(edgeSelfieRateLimit(options));
  router.put(
    "/:objectId",
    authenticateEdgeNode,
    // Whatever the Content-Type, the body is the sealed file.
    express.raw({ type: () => true, limit: EDGE_SELFIE_SEALED_MAX_BYTES }),
    async (req: Request, res: Response) => {
      const { storage, scanner, database } = options;
      if (!storage || !scanner)
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Penyimpanan berkas belum tersedia.",
        );
      const objectId = uuidSchema.safeParse(req.params.objectId);
      if (!objectId.success)
        throw new HttpError(400, "VALIDATION_ERROR", "Invalid object id.");
      const node = res.locals.edgeNode as VerifiedEdgeNode;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await receiveEdgeSelfie(
        { database, storage, scanner },
        node,
        {
          objectId: objectId.data,
          body,
          sealedSha256Header: req.get(SEALED_SHA256_HEADER),
        },
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.status(result.status).json({ objectId: objectId.data });
    },
  );
  return router;
}
