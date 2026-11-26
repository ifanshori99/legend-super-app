// Tenant authorization middleware (bead legend-4f9; TEN-03). Mount after
// requireAuth + requireTrustedOrigin + requireTenantContext: the tenant comes
// from the domain or token (TEN-02), never from the request.
//
// The route names the permission it needs; the resolver answers with the
// server-minted ScopedTenantContext the handler passes to services. Its outlet
// reach is what `withTenant` installs as app.outlet_ids. Postgres enforces it
// with the `outlet_isolation` policy on outlet-owned tables only (outlet_id
// NOT NULL, migration 0032, legend-tjey); tables with a nullable outlet_id and
// station-level narrowing rely on the service checks. See docs/plan/contracts.md
// "TEN-03 outlet isolation layers".
//
// AUTH-05: the snapshot carries `mfaRequired` / `mfaVerified` for the web area
// guards and `/api/me/access`, read from the same session row the API gate
// enforces (legend-6xf, mounted by legend-qfvu). This middleware itself
// enforces permission + scope + time; the second-factor gate runs once per
// guarded router (requireIdentitySurface / requireSessionMfa).

import type { Request, RequestHandler } from "express";
import {
  AccessError,
  outletReachOf,
  stationIdSchema,
  stationReachOf,
  type PermissionCode,
} from "@starter/shared/access";
import {
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { HttpError } from "../lib/http-error";
import { actorOf, hasActingStaffHeader } from "./acting-staff";
import { sessionMfaVerifiedAt } from "../lib/mfa";
import { getTenantContext } from "./tenant";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
  type AccessSnapshot,
  type TenantAccessData,
} from "../services/permission-resolver";

const snapshots = new WeakMap<Request, AccessSnapshot>();
const dataByRequest = new WeakMap<Request, TenantAccessData>();
const contexts = new WeakMap<Request, ScopedTenantContext>();

/**
 * Station-scoped list routes (legend-fsb7) keep their context apart from
 * `contexts`: the outlet-wide RLS reach is only safe together with the
 * station narrowing, so `getScopedTenantContext` refuses these routes and the
 * handler must take `getStationScope` instead. The permitted stations are not
 * carried here: the service computes them with `permittedStationIds` inside
 * its own tenant transaction, so the decision and the rows share one snapshot.
 */
export type StationScope = {
  readonly context: ScopedTenantContext;
};
const stationScopes = new WeakMap<Request, StationScope>();

/** The station-scoped context set by requireStationScopePermission. */
export function getStationScope(req: Request): StationScope {
  const scope = stationScopes.get(req);
  if (!scope)
    throw new Error(
      "getStationScope() used without requireStationScopePermission",
    );
  return scope;
}

/**
 * Resolves (and caches per request) the caller's effective access. Read-only:
 * the tenant transaction only selects assignments, roles and the org tree.
 */
export async function loadRequestAccess(req: Request): Promise<AccessSnapshot> {
  const cached = snapshots.get(req);
  if (cached) return cached;
  // Fail closed: a router that never mounted resolveActingStaff must not
  // silently fall back to the session owner's permissions for a request that
  // asked to act as someone else.
  if (hasActingStaffHeader(req) && !req.actingStaff)
    throw new HttpError(
      400,
      ACTING_STAFF_ERROR_CODES.UNSUPPORTED,
      "Kasir aktif belum didukung untuk endpoint ini.",
    );
  const tenant = getTenantContext(req);
  // The permission subject is the acting cashier when one resolved (see
  // middleware/acting-staff.ts), else the session owner.
  const userId = actorOf(req);
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userId,
  );
  const snapshot = resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    // The session's verified second factor (lib/mfa.ts, bead legend-6xf).
    // Never the per-request `mfaCode` check: that consumes a TOTP step and is
    // reserved for TEN-04 support access. The web guard reads the same flag
    // through /api/me/access. An acting cashier never inherits the session
    // owner's verified second factor.
    mfaVerified: req.actingStaff
      ? false
      : (await sessionMfaVerifiedAt(req)) !== null,
    now: data.clock ?? new Date(),
  });
  snapshots.set(req, snapshot);
  dataByRequest.set(req, data);
  return snapshot;
}

/** The assignments, roles and org tree `loadRequestAccess` read for this request. */
export function getRequestAccessData(req: Request): TenantAccessData {
  const data = dataByRequest.get(req);
  if (!data)
    throw new Error("getRequestAccessData() used without loadRequestAccess");
  return data;
}

/** The snapshot loaded by a permission middleware on this request. */
export function getAccessSnapshot(req: Request): AccessSnapshot {
  const snapshot = snapshots.get(req);
  if (!snapshot)
    throw new Error("getAccessSnapshot() used without a permission middleware");
  return snapshot;
}

/** The tenant context minted for this request's permitted action (TEN-03). */
export function getScopedTenantContext(req: Request): ScopedTenantContext {
  const context = contexts.get(req);
  if (!context)
    throw new Error(
      "getScopedTenantContext() used without requireTenantPermission",
    );
  return context;
}

/**
 * Requires `permission` over the whole tenant (tenant administration: roles,
 * organisation settings, approval matrix). A brand/outlet/station-scoped grant
 * does not reach a tenant-wide target, so it is denied (deny by default).
 *
 * The role/route split that already exists in the codebase uses
 * `requireTenantPermission("org.structure.manage")` on org routes and
 * `requireTenantPermission("access.role.view")` on the RBAC routes.
 */
export function requireTenantPermission(
  permission: PermissionCode,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const context = snapshot.contextFor(permission, { type: "tenant" });
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this tenant.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/**
 * Menu routes (legend-lmk): brand-owned records need a brand target and
 * outlet-owned records an outlet target, so a tenant-wide check alone would
 * deny a general manager assigned at brand scope or an outlet manager toggling
 * 86. This mints the caller's reachable scope for the permission: tenant-wide
 * when the caller reaches the whole tenant, otherwise the union of the outlets
 * their applicable assignments reach (TEN-03). Services still re-check the
 * permission against the concrete brand/outlet of every record, so this is a
 * cheap gate and never widens the data the outlet RLS policy shows.
 */
export function requireMenuPermission(
  permission: PermissionCode,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    let context = snapshot.contextFor(permission, { type: "tenant" });
    if (!context) {
      const tenant = getTenantContext(req);
      const data = dataByRequest.get(req);
      if (!data) throw new Error("requireMenuPermission() without access data");
      const reach = outletReachOf({
        principal: {
          tenantId: tenant.tenantId,
          userId: userIdSchema.parse(actorOf(req)),
          assignments: data.assignments,
        },
        roles: data.roles,
        org: data.org,
        now: data.clock ?? new Date(),
        permission,
      });
      // null = no outlet reach for this permission (deny by default).
      if (reach !== null) context = establishScopedTenantContext(tenant, reach);
    }
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot manage the menu in this tenant.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/**
 * Station-aware read gate for a station-bound list (kitchen station config,
 * a KDS station selector): the same reach as requireMenuPermission, plus a
 * station-only grant, whose outlets come from the stations the caller reaches
 * for `permission` (legend-fsb7). Use it ONLY on routes whose service filters
 * the rows with `permittedStationIds` — the context is outlet-wide because RLS
 * cannot filter by station, so the service is what keeps a station-scoped
 * caller inside its own station(s).
 */
export function requireStationScopePermission(
  permission: PermissionCode,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    let context = snapshot.contextFor(permission, { type: "tenant" });
    if (!context) {
      const tenant = getTenantContext(req);
      const data = dataByRequest.get(req);
      if (!data)
        throw new Error("requireStationScopePermission() without access data");
      const principal = {
        tenantId: tenant.tenantId,
        userId: userIdSchema.parse(actorOf(req)),
        assignments: data.assignments,
      } as const;
      const reach = outletReachOf({
        principal,
        roles: data.roles,
        org: data.org,
        now: data.clock ?? new Date(),
        permission,
      });
      if (reach?.kind === "tenant") {
        context = establishScopedTenantContext(tenant, reach);
      } else {
        // Union of the outlet/brand reach and the outlets of the stations a
        // station grant reaches (legend-cy2e): outlet A + station B must
        // reach both outlets, not A alone. The context stays outlet-wide, so
        // the service narrows to `permittedStationIds` (station B only, not
        // the other stations of outlet B).
        const stations = stationReachOf({
          principal,
          roles: data.roles,
          org: data.org,
          now: data.clock ?? new Date(),
          permission,
        });
        const outletIds = [
          ...new Set([
            ...(reach?.outletIds ?? []).map((id) => id.toLowerCase()),
            ...stations.flatMap((stationId) => {
              const station = data.org.stations.find(
                (row) => row.id.toLowerCase() === stationId.toLowerCase(),
              );
              return station ? [station.outletId.toLowerCase()] : [];
            }),
          ]),
        ].map((id) => outletIdSchema.parse(id));
        if (outletIds.length > 0)
          context = establishScopedTenantContext(tenant, {
            kind: "outlets",
            outletIds,
          });
      }
    }
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda hanya dapat mengakses stasiun yang ditugaskan.",
      );
    // Not `contexts`: see StationScope. The handler must take the station
    // getter, whose service narrows to `permittedStationIds`.
    stationScopes.set(req, { context });
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/**
 * Requires `permission` on one station and mints the context a station-bound
 * route (KDS board, ticket bump, kitchen station config, a printer bound to a
 * station) runs with (legend-fsb7, TEN-03). The station id comes from the
 * verified request (path, body or resolved record) and is schema-validated;
 * a station-scoped assignment reaches only its own station, outlet/brand/
 * tenant scopes every station they contain, and an unknown station fails
 * closed. The minted context's RLS reach is the station's outlet, so the
 * service MUST re-assert the station on every query and mutation
 * (`assertStationPermission` in services/station-access.ts) and fail closed
 * when the station of the resource cannot be determined.
 */
export function requireStationPermission(
  permission: PermissionCode,
  stationIdOf: (req: Request) => string | undefined,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const raw = stationIdOf(req);
    // A station-bound route without a determinable station grants nothing.
    if (raw === undefined)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Stasiun tidak dapat ditentukan untuk aksi ini.",
      );
    const stationId = stationIdSchema.parse(raw);
    const context = snapshot.contextFor(permission, {
      type: "station",
      id: stationId,
    });
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda hanya dapat mengakses stasiun yang ditugaskan.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/**
 * Requires `permission` on one outlet and mints an outlet-scoped context, so
 * `withTenant` installs `app.outlet_ids` = that outlet (TEN-03). The
 * `outlet_isolation` RLS policy then limits outlet-owned tables (outlet_id NOT
 * NULL) to it; tables with a nullable outlet_id still need the service's
 * `outletIdsForQuery` / `assertOutletInScope` filter. The outlet id must come
 * from the verified request (path or body) and is schema-validated; a role
 * that only holds another outlet, or a station-only grant, is denied. Used by
 * the inventory, tax and payment-admin routes.
 */
export function requireOutletPermission(
  permission: PermissionCode,
  outletIdOf: (req: Request) => string,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const outletId = outletIdSchema.parse(outletIdOf(req));
    const context = snapshot.contextFor(permission, {
      type: "outlet",
      id: outletId,
    });
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this outlet.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

const fallbackUsed = new WeakSet<Request>();

/**
 * Like `requireOutletPermission`, but `fallback` also lets the request in when
 * the caller lacks `primary` (same outlet). `usedFallbackPermission(req)` says
 * which one passed, so the service can narrow what a fallback caller may do
 * (the POS captain order: `order.create` only reaches `captain` orders).
 */
export function requireOutletPermissionOrFallback(
  primary: PermissionCode,
  fallback: PermissionCode,
  outletIdOf: (req: Request) => string,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const outletId = outletIdSchema.parse(outletIdOf(req));
    const scope = { type: "outlet", id: outletId } as const;
    const first = snapshot.contextFor(primary, scope);
    const context = first ?? snapshot.contextFor(fallback, scope);
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this outlet.",
      );
    if (first) fallbackUsed.delete(req);
    else fallbackUsed.add(req);
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/** True when the request passed on the fallback permission only. */
export function usedFallbackPermission(req: Request): boolean {
  return fallbackUsed.has(req);
}
