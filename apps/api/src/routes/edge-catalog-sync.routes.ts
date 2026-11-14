// Catalog edge sync API (bead legend-97p; PRD v1.7 §3 F8 Master Menu & Harga,
// §3 F16 Resep & BOM, EDG-02, TEN-02). Thin route; every rule is in
// services/edge-catalog-sync.ts. Same shape as edge-device-sync.routes.ts.
//
// catalogRecordSyncRouter (cloud only; mount at /api/edge-sync/catalog;
// /api/edge/* is edge-only under the EDGE_MODE route guard):
//   GET /?stream=<stream>&since=<cursor>&limit=<1..100>
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port. No session, no cookie, read-only.
//     Tenant and outlet come from the verified credential; a tenant resolved
//     from the domain or a device token must be the same one. The credential is
//     checked before the query is read (401 first).

import { Router } from "express";
import { CoreError } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { isCatalogDeliveryRefused } from "../services/edge-master-data-publisher.ts";
import {
  catalogSyncQuerySchema,
  listCatalogRecordsSince,
} from "../services/edge-catalog-sync.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

export const catalogRecordSyncRouter = Router();

catalogRecordSyncRouter.get("/", async (req, res) => {
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
  const query = catalogSyncQuerySchema.parse(req.query);
  // legend-3k41y: a blocked node (outlet brand moved) is refused, fail closed.
  if (await isCatalogDeliveryRefused(db, node))
    throw new CoreError(
      "FORBIDDEN",
      "Edge node diblokir: brand outlet berubah, provisi ulang node.",
    );
  res.setHeader("Cache-Control", "private, no-store");
  res.json(
    await listCatalogRecordsSince(db, {
      tenantId: node.tenantId,
      outletId: node.outletId,
      query,
    }),
  );
});
