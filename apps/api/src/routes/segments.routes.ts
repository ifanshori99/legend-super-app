// Dynamic customer segments (legend-ts50; contract `@starter/shared/crm`
// endpoints listSegments, createSegment, previewSegment). Paths are absolute
// under /api, so the router is mounted without a prefix and guards each route
// itself (same shape as loyalty-program.routes.ts). Tenant-wide permission
// `crm.segment.manage` on every route; the tenant comes from the server-minted
// context, never the request.

import { Router } from "express";
import {
  createSegmentInputSchema,
  listSegments as listSegmentsEndpoint,
  previewSegmentInputSchema,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as segments from "../services/segments.service";

export const segmentsRouter = Router();

const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];
const manage = requireTenantPermission("crm.segment.manage");

segmentsRouter.get("/segments", ...staffGuard, manage, async (req, res) => {
  const query = listSegmentsEndpoint.query.parse(req.query);
  res.json(await segments.listSegments(getScopedTenantContext(req), query));
});

// Registered before any `/segments/:id` route so "preview" is never an id.
segmentsRouter.post(
  "/segments/preview",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = previewSegmentInputSchema.parse(req.body);
    res.json({
      data: await segments.previewSegment(
        getScopedTenantContext(req),
        input.definition,
      ),
    });
  },
);

segmentsRouter.post(
  "/segments",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = createSegmentInputSchema.parse(req.body);
    res.status(201).json({
      data: await segments.createSegment(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);
