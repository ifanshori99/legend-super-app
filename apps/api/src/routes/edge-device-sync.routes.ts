// Device registry edge sync API (bead legend-165; PRD v1.7 §3 F5 Registri
// Perangkat, EDG-02, EDG-03, TEN-02). Thin route; every rule is in
// services/edge-device-sync.ts. Same shape as staff-pin-sync.routes.ts.
//
// deviceRecordSyncRouter (cloud only; mount at /api/edge-sync/device-records;
// /api/edge/* is edge-only under the EDGE_MODE route guard):
//   GET /?since=<watermark>&limit=<1..100>[&receiptSequences=1][&edgeInstance=<uuid>]
//     `receiptSequences=1` (exactly; strict query schema, S-K1 legend-3yqy)
//     adds the outlet's device receipt sequences; without it the page has no
//     such field, so an older edge keeps parsing pages.
//     legend-zsdd: `edgeInstance` names the edge's database. Only an active
//     primary node that sends it claims sequences (bound to node + instance)
//     and receives them; a standby or an edge without it gets `[]`.
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port. No session, no cookie, read-only.
//     Tenant and outlet come from the verified credential; a tenant resolved
//     from the domain or a device token must be the same one. Records include
//     revoked devices and never a token.

import { Router } from "express";
import { CoreError } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
} from "../services/edge-device-sync.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

export const deviceRecordSyncRouter = Router();

deviceRecordSyncRouter.get("/", async (req, res) => {
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
  const query = deviceSyncQuerySchema.parse(req.query);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await listDeviceRecordsSince(node, query));
});
