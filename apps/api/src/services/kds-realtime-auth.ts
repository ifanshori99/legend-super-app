// Staff identity for the KDS station socket (bead legend-4d5). A WebSocket
// upgrade never passes through the Express chain, so this repeats, for a raw
// IncomingMessage, what a station route gets from requireAuth +
// requireTenantContext + requireOutletPermission + requireStationPermission:
//
// - the Better Auth session from the cookie, read from the database on every
//   call (no cookie cache), so a signed-out or revoked session loses the
//   socket on its next wakeup or recheck;
// - the tenant of the request host's registered domain (TEN-02), or — only in
//   development with synthetic data, for a signed-in caller — the first
//   seeded tenant, exactly as app.ts. Never a tenant from client input;
// - `kds.ticket.process` on the path's station, whose outlet must be the path
//   outlet; the minted context is the station one (its RLS reach is the station's outlet), and the
//   service re-asserts the station on every read.
//
// - a support (impersonated) session also needs an active support access grant
//   for this tenant (TEN-04), re-checked on every wakeup and recheck;
//
// Any failure answers null (deny by default).

import type { IncomingMessage } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { stationIdSchema } from "@starter/shared/access";
import {
  assertOutletInScope,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { pool } from "../db/index.ts";
import { auth } from "../lib/auth.ts";
import { assertSupportAccess } from "./platform-support.service.ts";
import { parseKdsRealtimeUrl } from "./kds-realtime.ts";
import { resolveHostname } from "./org-resolve.service.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";

const PERMISSION = "kds.ticket.process";

/** Same gate as app.ts `developmentSyntheticTenant`. */
const developmentSyntheticTenant =
  env.DEPLOYMENT_MODE === "development" &&
  env.NODE_ENV !== "production" &&
  env.DATA_CLASSIFICATION === "synthetic";

async function tenantOf(
  request: IncomingMessage,
): Promise<TenantContext | null> {
  const host = (request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host) {
    const resolution = await resolveHostname(host);
    if (resolution.ok)
      return establishTenantContext({
        tenantId: resolution.tenantId,
        brandId: resolution.brandId,
        source: "domain",
      });
  }
  if (!developmentSyntheticTenant) return null;
  // Development only: the first seeded tenant (as app.ts), never from input.
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at, id LIMIT 1",
  );
  const row = result.rows[0];
  return row
    ? establishTenantContext({
        tenantId: row.id,
        brandId: null,
        source: "session",
      })
    : null;
}

/** `resolveConnection` port of attachKdsRealtime for staff sessions. */
export async function resolveKdsStaffConnection(
  request: IncomingMessage,
): Promise<{ userId: string; context: ScopedTenantContext } | null> {
  try {
    const target = parseKdsRealtimeUrl(request.url);
    if (!target) return null;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true },
    });
    if (!session) return null;
    const tenant = await tenantOf(request);
    if (!tenant) return null;
    // A support (impersonated) session keeps the socket only while its support
    // access grant is active. connect, every wakeup and every recheck pass
    // here, so expiry or revocation cuts the socket (throw -> deny).
    const impersonatedBy = (
      session.session as { impersonatedBy?: string | null }
    ).impersonatedBy;
    if (impersonatedBy)
      await assertSupportAccess({
        tenantId: tenant.tenantId,
        actorUserId: impersonatedBy,
        dataClass: "personal",
        intent: "read",
      });
    const userId = session.user.id;
    const data = await loadTenantAccess(
      establishScopedTenantContext(tenant, { kind: "tenant" }),
      userId,
    );
    const snapshot = resolveAccessSnapshot({
      tenant,
      userId,
      ...data,
      mfaVerified: false,
      now: new Date(),
    });
    const outletId = outletIdSchema.parse(target.outletId);
    // Station grant only (a station-scoped cook reaches just their station);
    // the minted context's outlet must be the path's outlet.
    const context = snapshot.contextFor(PERMISSION, {
      type: "station",
      id: stationIdSchema.parse(target.stationId),
    });
    if (!context) return null;
    assertOutletInScope(context.outletScope, outletId);
    return { userId, context };
  } catch {
    return null;
  }
}
