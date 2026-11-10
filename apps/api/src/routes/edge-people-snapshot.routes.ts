// Edge people snapshot API (legend-ye4j1, card C2; design
// docs/design/hris-edge-replication.md 3.1). Thin route; the rules are in
// services/edge-people-snapshot.ts. Same shape as edge-device-sync.routes.ts.
//
// edgePeopleSnapshotRouter (cloud only; mount at /api/edge-sync/people-snapshot):
//   GET /
//     Edge node only: `Authorization: Bearer <edge credential>`, verified by
//     the EdgeCredentialVerifier port. No session, no cookie, read-only, no
//     query. Tenant and outlet come only from the verified credential; a tenant
//     resolved from the domain or a device token must be the same one.
//     200 body: the snapshot; headers `ETag` (SHA-256 of the data sections) and
//     `X-Legend-Snapshot-Generated-At`. `If-None-Match` equal to the ETag
//     answers 304 with no body. Always `Cache-Control: private, no-store`.
//     Nothing from the snapshot is logged.

import { Router } from "express";
import { CoreError } from "@starter/shared/core";
import {
  EDGE_PEOPLE_SNAPSHOT_ETAG_HEADER,
  EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER,
  EDGE_PEOPLE_SNAPSHOT_IF_NONE_MATCH_HEADER,
} from "@starter/shared/edge";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  buildEdgePeopleSnapshot,
  etagMatches,
} from "../services/edge-people-snapshot.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

export const edgePeopleSnapshotRouter = Router();

edgePeopleSnapshotRouter.get("/", async (req, res) => {
  // Authenticate before reading any input, so an anonymous caller learns
  // nothing about the request rules.
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
  const snapshot = await buildEdgePeopleSnapshot(node);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader(EDGE_PEOPLE_SNAPSHOT_ETAG_HEADER, snapshot.etag);
  res.setHeader(EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER, snapshot.generatedAt);
  if (
    etagMatches(
      req.get(EDGE_PEOPLE_SNAPSHOT_IF_NONE_MATCH_HEADER),
      snapshot.etag,
    )
  ) {
    res.status(304).end();
    return;
  }
  res.json(snapshot.body);
});
