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

import { Router, type Request } from "express";
import { CoreError } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import { jsonBody } from "../middleware/body.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  applyDeviceHeartbeatUpsync,
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
} from "../services/edge-device-sync.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

//
// deviceHeartbeatUpsyncRouter (cloud only; mount at
// /api/edge-sync/device-heartbeats; legend-2lp.10):
//   POST / { devices: [{ id, lastSeenAt }] }  (strict, max 200)
//     Same edge credential as the GET above. The edge reports when its own
//     devices were last seen; the cloud moves `last_seen_at` forward only, for
//     active devices of the credential's outlet. Unknown, revoked and
//     other-outlet ids are ignored. Answers `{ applied, ignored }`.

export const deviceRecordSyncRouter = Router();
export const deviceHeartbeatUpsyncRouter = Router();

const edgeCallers = new WeakMap<
  Request,
  {
    node: NonNullable<Awaited<ReturnType<typeof verifyEdgeCredential>>>;
    arrivedAt: Date;
  }
>();

deviceRecordSyncRouter.get("/", async (req, res) => {
  // legend-yd0h8: arrival time, taken before the credential check's pool
  // waits; it orders the edge's receipt run reports (stale = not newer).
  const arrivedAt = new Date();
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
  res.json(await listDeviceRecordsSince(node, query, { now: arrivedAt }));
});

deviceHeartbeatUpsyncRouter.post("/", async (req, _res, next) => {
  // Same order as the GET: credential first, so an anonymous caller learns
  // nothing about the body rules and its body is never read.
  const arrivedAt = new Date();
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
  edgeCallers.set(req, { node, arrivedAt });
  next();
});

deviceHeartbeatUpsyncRouter.post("/", jsonBody, async (req, res) => {
  const caller = edgeCallers.get(req);
  if (caller === undefined)
    throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
  res.setHeader("Cache-Control", "private, no-store");
  res.json(
    await applyDeviceHeartbeatUpsync(caller.node, req.body, {
      now: caller.arrivedAt,
    }),
  );
});
