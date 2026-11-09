// Sync conflict review + replay (bead legend-wqc6; PRD v1.7 §3 F5
// "Sinkronisasi", EDG-02). Cloud only: mount at /api/edge-sync-conflicts.
//
//   GET  /?outletId=&status=&edgeNodeId=&cursor=&limit=   list, newest first
//   GET  /:conflictId                                     envelope + resolutions
//   POST /:conflictId/resolve                             { action, note }
//
// All need `device.registry.manage` on the conflict's outlet. The outlet of a
// `:conflictId` route is read from the conflict itself (never from the
// client); an unknown id answers 404 before any permission is revealed.
// Signed-in, trusted origin, tenant from the domain (TEN-02), back-office
// surface (AUTH-05).
import { Router, type Request } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  edgeSyncConflictListQuerySchema,
  edgeSyncConflictParamsSchema,
  resolveEdgeSyncConflictBodySchema,
} from "@starter/shared/edge";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  getEdgeSyncConflict,
  getEdgeSyncConflictOutletId,
  listEdgeSyncConflicts,
  resolveEdgeSyncConflict,
} from "../services/edge-sync-conflict.service.ts";

export const edgeSyncConflictsRouter = Router();

edgeSyncConflictsRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

/** The conflict's outlet, found once per request for the permission check. */
const conflictOutlets = new WeakMap<Request, string>();

/** Looks the outlet up with a tenant-wide read context (id only is used). */
const loadConflictOutlet = async (
  req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
) => {
  try {
    const { conflictId } = edgeSyncConflictParamsSchema.parse(req.params);
    const outletId = await getEdgeSyncConflictOutletId(
      establishScopedTenantContext(getTenantContext(req), { kind: "tenant" }),
      conflictId,
    );
    if (!outletId)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Konflik sinkronisasi tidak ditemukan.",
      );
    conflictOutlets.set(req, outletId);
    next();
  } catch (error) {
    next(error);
  }
};

const manageConflictOutlet = requireOutletPermission(
  "device.registry.manage",
  (req) => conflictOutlets.get(req) ?? "",
);

// With ?outletId= the permission is checked on that outlet. Without it the
// caller gets the outlets their grant reaches (tenant-wide or the union of
// their outlets); RLS and the service filter keep the rows inside that reach.
const manageListedOutlet = requireOutletPermission(
  "device.registry.manage",
  (req) => String(req.query.outletId ?? ""),
);
const manageReachableOutlets = requireMenuPermission("device.registry.manage");

edgeSyncConflictsRouter.get(
  "/",
  (req, res, next) =>
    (req.query.outletId === undefined
      ? manageReachableOutlets
      : manageListedOutlet)(req, res, next),
  async (req, res) => {
    const query = edgeSyncConflictListQuerySchema.parse(req.query);
    const page = await listEdgeSyncConflicts(
      getScopedTenantContext(req),
      query,
    );
    res.json({
      data: page.items,
      meta: { limit: query.limit, nextCursor: page.nextCursor },
    });
  },
);

edgeSyncConflictsRouter.get(
  "/:conflictId",
  loadConflictOutlet,
  manageConflictOutlet,
  async (req, res) => {
    const { conflictId } = edgeSyncConflictParamsSchema.parse(req.params);
    res.json({
      data: await getEdgeSyncConflict(getScopedTenantContext(req), conflictId),
    });
  },
);

edgeSyncConflictsRouter.post(
  "/:conflictId/resolve",
  jsonBody,
  loadConflictOutlet,
  manageConflictOutlet,
  async (req, res) => {
    const { conflictId } = edgeSyncConflictParamsSchema.parse(req.params);
    const input = resolveEdgeSyncConflictBodySchema.parse(req.body);
    res.json({
      data: await resolveEdgeSyncConflict(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        conflictId,
        input,
      ),
    });
  },
);
