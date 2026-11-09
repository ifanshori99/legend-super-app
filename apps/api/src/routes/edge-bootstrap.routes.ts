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
//   GET /masters (bead legend-9ppw)
//     Same auth and tenant-domain check. Answers `{ snapshot, signature }`:
//     uoms, the outlet's stock locations, and its legal entity's chart of
//     accounts and account mappings (services/edge-master-sync.service.ts).

import { Router, type Request } from "express";
import { CoreError } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { buildEdgeBootstrapBundle } from "../services/edge-bootstrap.service.ts";
import { buildEdgeMasterSnapshot } from "../services/edge-master-sync.service.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

export const edgeBootstrapRouter = Router();

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

edgeBootstrapRouter.get("/", async (req, res) => {
  const { node, credential } = await authenticateEdgeNode(req);
  res.setHeader("Cache-Control", "private, no-store");
  // Signed with the presented credential's digest (rotation grace period).
  res.json(await buildEdgeBootstrapBundle(node, credential));
});

edgeBootstrapRouter.get("/masters", async (req, res) => {
  const { node, credential } = await authenticateEdgeNode(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await buildEdgeMasterSnapshot(node, credential));
});
