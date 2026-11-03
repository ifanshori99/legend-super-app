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
//     a pin or the pepper (the pepper is provisioned out of band:
//     STAFF_PIN_PEPPER on the edge box).

import { Router } from "express";
import { CoreError } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  edgeCredentialFromAuthorization,
  listStaffPinRecordsSince,
  staffPinSyncQuerySchema,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

export const staffPinSyncRouter = Router();

staffPinSyncRouter.get("/", async (req, res) => {
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
});
