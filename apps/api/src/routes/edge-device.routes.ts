// Edge-served device registry API (bead legend-165; PRD v1.7 §3 F5 Registri
// Perangkat, EDG-03, EDG-05). Mount at /api/edge/devices BEFORE /api/edge in
// routes/index.ts. Like edge.routes.ts, the edge route guard refuses these
// paths on the cloud and the handlers refuse again when the process has no
// edge identity.
//
//   GET  /api/edge/devices            listEdgeDevices: the devices of THIS
//                                     node's outlet from the local replica.
//                                     Signed-in staff holding
//                                     `device.registry.manage` on the outlet.
//   POST /api/edge/devices/heartbeat  edgeDeviceHeartbeat: a registered, active
//                                     device of this outlet (X-Device-Token,
//                                     confirmed against the local replica by
//                                     deviceTenantCredential). The device id
//                                     comes from the token only.
import { Router, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  uuidSchema,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  edgeDeviceListQuerySchema,
  listOutletDevices as listOutletDevicesEndpoint,
} from "@starter/shared/edge";
import { and, desc, eq, sql } from "drizzle-orm";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  findTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  deviceHeartbeatHandler,
  listOutletDevices,
  toDevice,
} from "../services/device.service.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { outletContext } from "../services/device-pin-support.ts";

function edgeIdentity() {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode || !runtime.identity)
    throw new HttpError(
      503,
      "EDGE_NOT_READY",
      "Edge node belum siap melayani perangkat.",
    );
  return runtime.identity;
}

/** A tenant resolved for this request must be the node's own tenant. */
const requireNodeTenant: RequestHandler = (req, _res, next) => {
  const identity = edgeIdentity();
  const tenant = findTenantContext(req);
  if (tenant && tenant.tenantId !== identity.scope.tenantId)
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this edge node.",
    );
  next();
};

/** Session path: `device.registry.manage` on this node's outlet. */
const registryManager: RequestHandler = async (req, _res, next) => {
  const identity = edgeIdentity();
  const userId = getAuth(req).user.id;
  const tenantWide = establishScopedTenantContext(identity.context.tenant, {
    kind: "tenant",
  });
  const data = await loadTenantAccess(tenantWide, userId);
  const snapshot = resolveAccessSnapshot({
    tenant: identity.context.tenant,
    userId,
    ...data,
    mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
    now: new Date(),
  });
  const allowed =
    snapshot.contextFor("device.registry.manage", {
      type: "outlet",
      id: identity.scope.outletId,
    }) !== null;
  if (!allowed)
    throw new AccessError(
      "PERMISSION_DENIED",
      "Akun Anda tidak dapat melihat perangkat outlet ini.",
    );
  next();
};

const CURSOR_TAG = "edev1";
const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const createdOf = sql<string>`to_char(${devices.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function parseCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
  }
  const [tag, created, id, extra] = keys;
  if (
    tag !== CURSOR_TAG ||
    typeof created !== "string" ||
    !CREATED_PATTERN.test(created) ||
    !uuidSchema.safeParse(id).success ||
    extra !== undefined
  )
    throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
  return { created, id: String(id) };
}

export const edgeDeviceRouter = Router();

edgeDeviceRouter.get(
  "/",
  (req, _res, next) => {
    if (env.EDGE_MODE || getEdgeRuntimeState().edgeMode) return next("route");
    next();
  },
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireOutletPermission(
    "device.registry.manage",
    (req) => listOutletDevicesEndpoint.query.parse(req.query).outletId,
  ),
  async (req, res) => {
    const query = listOutletDevicesEndpoint.query.parse(req.query);
    const page = await listOutletDevices(getScopedTenantContext(req), query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      ...page,
      meta: { ...page.meta, serverTime: new Date().toISOString() },
    });
  },
);

edgeDeviceRouter.get(
  "/",
  requireNodeTenant,
  requireAuth,
  registryManager,
  async (req, res) => {
    const identity = edgeIdentity();
    const query = edgeDeviceListQuerySchema.parse(req.query);
    if (query.outletId && query.outletId !== identity.scope.outletId)
      throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const after = parseCursor(query.cursor);
    const outletId = outletIdSchema.parse(identity.scope.outletId);
    const context = outletContext(identity.context.tenant, outletId);
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({ row: devices, created: createdOf })
        .from(devices)
        .where(
          and(
            eq(devices.tenantId, identity.context.tenant.tenantId),
            eq(devices.outletId, outletId),
            query.type === undefined ? undefined : eq(devices.type, query.type),
            query.status === undefined
              ? undefined
              : eq(devices.status, query.status),
            after === null
              ? undefined
              : sql`(${devices.createdAt}, ${devices.id}) < (${after.created}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(desc(devices.createdAt), desc(devices.id))
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: page.map(({ row }) => toDevice(row)),
      meta: {
        limit: query.limit,
        serverTime: new Date().toISOString(),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([CURSOR_TAG, last.created, last.row.id])
            : null,
      },
    });
  },
);

edgeDeviceRouter.post(
  "/heartbeat",
  requireNodeTenant,
  requireTenantContext,
  jsonBody,
  deviceHeartbeatHandler,
);
