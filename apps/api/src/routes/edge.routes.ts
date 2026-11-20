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
//                         catalog sales block. Works offline. The grant also
//                         needs a recent second factor.
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { PermissionCode } from "@starter/shared/access";
import {
  AccessError,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
} from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { env } from "../config/env.ts";
import { checkDatabase, db } from "../db/index.ts";
import { countBlockedOutboxAggregates } from "../services/core-outbox-dead-alert.ts";
import {
  catalogOverrideInputSchema,
  catalogOverrideNow,
  isCatalogOverrideClockReady,
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
import { loadSessionRow } from "../services/identity-session.service.ts";
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
const requestTimes = new WeakMap<Request, Date>();

/** One trusted instant for authorization and the operation it authorizes. */
function edgeRequestNow(req: Request): Date {
  let now = requestTimes.get(req);
  if (!now) {
    now = catalogOverrideNow();
    requestTimes.set(req, now);
  }
  return now;
}

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
  const now = edgeRequestNow(req);
  const userId = getAuth(req).user.id;
  const tenantWide = establishScopedTenantContext(identity.context.tenant, {
    kind: "tenant",
  });
  // legend-7zwmv (P3-1 of the 1201 second opinion): on the edge, validity is
  // judged by the trusted monotonic clock (`now`), never the edge box's wall
  // clock behind statement_timestamp(). includeInactive returns every row and
  // no DB `clock`, so `now` decides each assignment's valid_from/valid_until.
  // Before the trusted clock is installed (or after stop) `now` is only the app
  // wall clock, so the status read keeps the DB clock path as before.
  const data = await loadTenantAccess(tenantWide, userId, {
    includeInactive: isCatalogOverrideClockReady(),
  });
  return resolveAccessSnapshot({
    tenant: identity.context.tenant,
    userId,
    ...data,
    mfaVerified: (await sessionMfaVerifiedAt(req, now)) !== null,
    now,
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
  // Fail closed: without the trusted clock an Owner's validity cannot be judged.
  if (!isCatalogOverrideClockReady())
    throw new HttpError(
      503,
      "EDGE_CLOCK_NOT_READY",
      "Jam perangkat belum siap. Coba lagi sebentar lagi.",
    );
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

/**
 * A grant lets sales run on an old catalog, so the session's second factor must
 * be recent (same rule as the receipt write-off route, pos-receipt-writeoff
 * .routes.ts, and the role-grant path): no verification is MFA_REQUIRED (403),
 * a stale or future one is REAUTH_REQUIRED (401), and a revoked or expired
 * session never counts. It reads the local session row, so it works offline.
 */
const recentSecondFactor: RequestHandler = async (req, _res, next) => {
  const session = await loadSessionRow(getAuth(req).session.id);
  const now = edgeRequestNow(req).getTime();
  if (
    session &&
    (session.revokedAt !== null || session.expiresAt.getTime() <= now)
  )
    throw new AccessError("REAUTH_REQUIRED");
  const verifiedAt = session?.mfaVerifiedAt ?? null;
  if (verifiedAt === null) throw new AccessError("MFA_REQUIRED");
  const age = now - verifiedAt.getTime();
  if (!(age >= 0 && age <= ROLE_GRANT_REAUTH_MAX_AGE_MS))
    throw new AccessError("REAUTH_REQUIRED");
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
    // Count only; no event or tenant identifiers are exposed by health.
    blockedOutboxAggregates:
      runtime.identity && database === "ok"
        ? await countBlockedOutboxAggregates(db, runtime.identity.context, {
            destinations: ["cloud-sync"],
          }).catch(() => null)
        : null,
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
  async (req, res) => {
    const { deps, edgeNodeId } = overrideDeps();
    const active = await loadActiveCatalogOverride(deps, {
      edgeNodeId,
      now: edgeRequestNow(req),
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
  recentSecondFactor,
  jsonBody,
  async (req, res) => {
    const body = catalogOverrideInputSchema.parse(req.body);
    const { deps, edgeNodeId } = overrideDeps();
    const override = await grantCatalogOverride(deps, {
      ...body,
      edgeNodeId,
      userId: z.string().min(1).parse(getAuth(req).user.id),
      now: edgeRequestNow(req),
    }).catch((error: unknown) => {
      // The trusted clock is not ready: no grant can be timed yet.
      if ((error as { code?: unknown } | null)?.code === "EDGE_CLOCK_NOT_READY")
        throw new HttpError(
          503,
          "EDGE_CLOCK_NOT_READY",
          "Jam perangkat belum siap. Coba lagi sebentar lagi.",
        );
      throw error;
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json({ data: overrideToDto(override) });
  },
);
