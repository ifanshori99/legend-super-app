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
//   GET|POST /api/edge/catalog-override  owner only (legend-10nex): read or
//                         grant the time-boxed override of the 24 h stale
//                         catalog sales block. Works offline.
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { PermissionCode } from "@starter/shared/access";
import { AccessError } from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { env } from "../config/env.ts";
import { checkDatabase } from "../db/index.ts";
import {
  catalogOverrideInputSchema,
  catalogOverrideNow,
  grantCatalogOverride,
  loadActiveCatalogOverride,
  type CatalogOverride,
} from "../edge/catalog-override.ts";
import { catalogFreshnessToDto } from "../edge/catalog-freshness.ts";
import {
  getCatalogFreshness,
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
} from "../edge/runtime.ts";
import { getEdgeSelfieHealth } from "../edge/selfie-health.ts";
import { getSelfieVolumeHealth } from "../edge/selfie-volume-health.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { rejectActingStaff } from "../middleware/acting-staff.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
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

/** The signed-in user's access snapshot for this node's tenant. */
async function sessionSnapshot(req: Request) {
  const { identity } = edgeIdentity();
  const userId = getAuth(req).user.id;
  const tenantWide = establishScopedTenantContext(identity.context.tenant, {
    kind: "tenant",
  });
  const data = await loadTenantAccess(tenantWide, userId);
  return resolveAccessSnapshot({
    tenant: identity.context.tenant,
    userId,
    ...data,
    mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
    now: new Date(),
  });
}

/** Session path: an operational permission on this outlet. */
const sessionReader: RequestHandler = async (req, _res, next) => {
  const { identity } = edgeIdentity();
  const snapshot = await sessionSnapshot(req);
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

/**
 * Owner path (legend-10nex): only an assignment of the owner TEMPLATE counts.
 * A custom role holding the same codes does not (no new permission code, so no
 * stored role rows to migrate). An active cashier token is refused before this
 * runs (rejectActingStaff). Works offline: it reads the local access replica.
 */
const ownerReader: RequestHandler = async (req, _res, next) => {
  const { identity } = edgeIdentity();
  const snapshot = await sessionSnapshot(req);
  const allowed = snapshot.allowsVia("owner", "device.registry.manage", {
    type: "outlet",
    id: identity.scope.outletId,
  });
  if (!allowed)
    throw new AccessError(
      "PERMISSION_DENIED",
      "Hanya Owner yang dapat mengizinkan penjualan saat katalog belum tersinkron.",
    );
  next();
};

const statusHandler: RequestHandler = async (req, res) => {
  const { identity, link } = edgeIdentity();
  res.setHeader("Cache-Control", "private, no-store");
  const status = await getEdgeStatus({
    context: identity.context,
    scope: identity.scope,
    cloudLink: link.cloudLink,
    deviceId: statusDevices.get(req) ?? null,
  });
  // legend-10nex: price/product-status freshness for the cashier warning.
  // Omitted before boot. The sales block itself is the sales gate's job.
  const tracker = getCatalogFreshness();
  const catalogFreshness = tracker
    ? catalogFreshnessToDto(tracker.snapshot())
    : undefined;
  res.json({
    data: catalogFreshness ? { ...status, catalogFreshness } : status,
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
    // Informational: stale prices/product status never change the HTTP code.
    catalogFreshness: (() => {
      const tracker = getCatalogFreshness();
      return tracker ? catalogFreshnessToDto(tracker.snapshot()) : null;
    })(),
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

// Owner override of the 24 h stale-catalog sales block (legend-10nex, Q57).
// Body {minutes: 1..1440, reason: 3..500 chars}; the grant is audited and
// replaces any active override of this edge node.
function overrideToDto(override: CatalogOverride) {
  return {
    id: override.id,
    grantedBy: override.grantedBy,
    grantedAt: override.grantedAt.toISOString(),
    untilAt: override.untilAt.toISOString(),
    reason: override.reason,
  };
}

const overrideDeps = () => {
  const { identity } = edgeIdentity();
  return {
    deps: { context: identity.context, outletId: identity.scope.outletId },
    edgeNodeId: identity.scope.edgeNodeId,
  };
};

edgeRouter.get(
  "/catalog-override",
  requireNodeTenant,
  requireAuth,
  rejectActingStaff,
  ownerReader,
  async (_req, res) => {
    const { deps, edgeNodeId } = overrideDeps();
    const active = await loadActiveCatalogOverride(deps, {
      edgeNodeId,
      now: catalogOverrideNow(),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: active ? overrideToDto(active) : null });
  },
);

edgeRouter.post(
  "/catalog-override",
  requireNodeTenant,
  requireAuth,
  requireTrustedOrigin,
  rejectActingStaff,
  ownerReader,
  jsonBody,
  async (req, res) => {
    const body = catalogOverrideInputSchema.parse(req.body);
    const { deps, edgeNodeId } = overrideDeps();
    const override = await grantCatalogOverride(deps, {
      ...body,
      edgeNodeId,
      userId: z.string().min(1).parse(getAuth(req).user.id),
      now: catalogOverrideNow(),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json({ data: overrideToDto(override) });
  },
);
