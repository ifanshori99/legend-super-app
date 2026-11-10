// Edge-only API (bead legend-2pi; contract @starter/shared/edge). Mount at
// /api/edge. The edge route guard (edge/mode.ts) refuses /api/edge/* on the
// cloud, and these handlers refuse again when the process has no edge
// identity, so a mis-mounted router answers nothing useful.
//
//   GET /api/edge/health  liveness for the outlet's monitoring: mode, cloud
//                         link, local database and whether the device
//                         registry replica is stale. No session, no tenant
//                         data. Staleness never changes the HTTP status: an
//                         offline edge keeps serving (legend-2lp.7).
//   GET /api/edge/status  getEdgeStatus. Tenant and outlet are the node's own
//                         (from its credential), never the request's
//                         (TEN-02). Readers:
//                         - a registered device of THIS outlet (X-Device-Token,
//                           confirmed by the device registry port, legend-165;
//                           fail closed until it is wired), or
//                         - a signed-in staff member holding one of
//                           STATUS_READ_PERMISSIONS on this outlet.
import { Router, type Request, type RequestHandler } from "express";
import type { PermissionCode } from "@starter/shared/access";
import { AccessError } from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { env } from "../config/env.ts";
import { checkDatabase } from "../db/index.ts";
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
} from "../edge/runtime.ts";
import { getEdgeSelfieHealth } from "../edge/selfie-health.ts";
import { getSelfieVolumeHealth } from "../edge/selfie-volume-health.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { findActiveDeviceForToken } from "../services/device-registry-check.ts";
import { getEdgeStatus } from "../services/edge-status.service.ts";

/** Operational staff of the outlet may see its offline status (§4 Alur F). */
export const STATUS_READ_PERMISSIONS: readonly PermissionCode[] = [
  "order.view",
  "order.create",
  "pos.sale.create",
  "kds.ticket.process",
  "kds.expo.operate",
  "device.registry.manage",
];

const statusDevices = new WeakMap<Request, string>();

function edgeIdentity() {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode || !runtime.identity)
    throw new HttpError(
      503,
      "EDGE_NOT_READY",
      "Edge node belum siap melayani perangkat.",
    );
  return { identity: runtime.identity, link: runtime.link };
}

/** A tenant resolved for this request must be the node's own tenant. */
const requireNodeTenant: RequestHandler = (req, _res, next) => {
  const { identity } = edgeIdentity();
  const tenant = findTenantContext(req);
  if (tenant && tenant.tenantId !== identity.scope.tenantId)
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this edge node.",
    );
  next();
};

/** Device path: a registered, active device of this outlet. */
const deviceReader: RequestHandler = async (req, _res, next) => {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  if (!raw) return next("route");
  const { identity } = edgeIdentity();
  const payload = verifyDeviceToken(raw);
  const device =
    payload && payload.tenantId === identity.scope.tenantId
      ? await findActiveDeviceForToken(payload, {
          outletId: identity.scope.outletId,
        })
      : null;
  if (!device)
    throw new CoreError(
      "UNAUTHORIZED",
      "Hanya perangkat terdaftar di outlet ini yang dapat membaca status.",
    );
  statusDevices.set(req, device.id);
  next();
};

/** Session path: an operational permission on this outlet. */
const sessionReader: RequestHandler = async (req, _res, next) => {
  const { identity } = edgeIdentity();
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
  const allowed = STATUS_READ_PERMISSIONS.some(
    (permission) =>
      snapshot.contextFor(permission, {
        type: "outlet",
        id: identity.scope.outletId,
      }) !== null,
  );
  if (!allowed)
    throw new AccessError(
      "PERMISSION_DENIED",
      "Akun Anda tidak dapat melihat status edge node outlet ini.",
    );
  next();
};

const statusHandler: RequestHandler = async (req, res) => {
  const { identity, link } = edgeIdentity();
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await getEdgeStatus({
      context: identity.context,
      scope: identity.scope,
      cloudLink: link.cloudLink,
      deviceId: statusDevices.get(req) ?? null,
    }),
  });
};

export const edgeRouter = Router();

edgeRouter.get("/health", async (_req, res) => {
  const runtime = getEdgeRuntimeState();
  let database: "ok" | "unreachable" = "ok";
  try {
    await checkDatabase();
  } catch {
    database = "unreachable";
  }
  const ready =
    runtime.edgeMode && runtime.identity !== null && database === "ok";
  res.setHeader("Cache-Control", "no-store");
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "unavailable",
    mode: runtime.edgeMode ? "edge" : "cloud",
    cloudLink: runtime.link.cloudLink,
    database,
    deviceRegistry: { stale: getDeviceRegistrySyncState()?.stale ?? true },
    // Informational: a full selfie disk never changes status or HTTP code.
    selfie: getEdgeSelfieHealth(),
    // Informational too: the selfie volume check (legend-svy91), cached 30 s.
    selfieVolume: await getSelfieVolumeHealth({
      dir: env.EDGE_SELFIE_DIR,
      maxBytes: env.EDGE_SELFIE_MAX_BYTES,
    }).catch(() => null),
  });
});

edgeRouter.get("/status", requireNodeTenant, deviceReader, statusHandler);
edgeRouter.get(
  "/status",
  requireNodeTenant,
  requireAuth,
  sessionReader,
  statusHandler,
);
