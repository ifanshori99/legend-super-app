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
// - a session used on a flagged shared device (legend-wa9n7) needs the
//   `x-device-token` and `x-acting-staff` upgrade headers (or, for a browser,
//   the same two tokens as Sec-WebSocket-Protocol entries); the cook is then the
//   user whose permission is checked (see resolveKdsStaffConnection);
//
// Any failure answers null (deny by default).

import type { IncomingMessage } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { stationIdSchema } from "@starter/shared/access";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_HEADER } from "@starter/shared/pos/acting-staff";
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
import { isEdgeNode } from "../edge/mode.ts";
import { sessionAcceptedHere } from "../lib/edge-session.ts";
import {
  EDGE_STAFF_PIN,
  setRequestAuthMethod,
  setRequestUser,
} from "../lib/request-context.ts";
import { withEdgeDeviceOfHeaders } from "./edge-device-auth.ts";
import { pool } from "../db/index.ts";
import { auth } from "../lib/auth.ts";
import { assertSupportAccess } from "./platform-support.service.ts";
import { parseKdsRealtimeUrl } from "./kds-realtime.ts";
import { carryKdsCredentialsFromProtocols } from "./kds-realtime-protocol.ts";
import { resolveHostname } from "./org-resolve.service.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";
import { resolveActingStaffToken } from "./pos-acting-staff.service.ts";
import {
  registeredDeviceIdOfHeaders,
  signedDeviceIdOfHeaders,
} from "./raw-device-token.ts";
import {
  closeSessionAtMarkLimit,
  isActiveSharedDevice,
  markSessionSharedDevice,
} from "./shared-device.service.ts";

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
    // Browser carrier (legend-dsbqr): subprotocol tokens become the two
    // headers below. Idempotent, so every wakeup / recheck can call it again.
    if (!carryKdsCredentialsFromProtocols(request)) return null;
    // E2 (brief 1269): the upgrade runs outside Express, so an edge checks the
    // device token's digest here.
    return await withEdgeDeviceOfHeaders(request.headers, () =>
      resolveConnection(request),
    );
  } catch {
    return null;
  }
}

async function resolveConnection(
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
    // legend-k2l, design ws08 M2 sign-in method gate: this upgrade runs outside
    // requireAuth, so requestMayUseStaffRoles never sees it. Staff roles need a
    // password sign-in (on an edge: the staff PIN login); a missing method
    // counts as `legacy`.
    const authMethod =
      (session.session as { authMethod?: string | null }).authMethod ??
      "legacy";
    // E2 (brief 1269): an edge PIN session on an edge only, with its own
    // device's token; `resolveConnection` runs inside the verified context.
    if (!sessionAcceptedHere(session.session)) return null;
    if (authMethod !== "password" && authMethod !== EDGE_STAFF_PIN) return null;
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
    const outletId = outletIdSchema.parse(target.outletId);
    // legend-wa9n7, legend-1024: a session used on a flagged shared device may
    // not act as the login owner here. A session with any mark, or an upgrade
    // whose signed device header names an active flagged device, is a shared
    // device session EVEN when the marks have lapsed (restrict by default): it
    // needs a registry-valid device token AND a live cashier token (bound to
    // that device, this session and the path outlet), and the cook becomes the
    // user checked below. A device token the registry refuses, or a cashier
    // token that is ended or expired, is a refusal on any device, never a
    // fall back to the login owner. A personal session with no token at all is
    // unchanged. Headers persist on `request`, so every wakeup and recheck
    // re-resolves the tokens (revoked or expired throws -> deny). A browser
    // cannot set WebSocket headers: kds-realtime-protocol.ts moves its
    // Sec-WebSocket-Protocol carrier (legend-dsbqr) into these same headers
    // before this runs.
    const headerDeviceId = signedDeviceIdOfHeaders(
      request.headers,
      tenant.tenantId,
    );
    // A signed header naming an active flagged device also stamps the session
    // (as requireActingStaffOnSharedDevice does over HTTP), so the same cookie
    // replayed without the header stays marked. A full mark list (8 active)
    // refuses this device and closes the login session, as the HTTP route does
    // (sharedDeviceMarkLimit), so the cookie cannot pass header-less later.
    const headerFlagged =
      headerDeviceId !== null &&
      (await isActiveSharedDevice(tenant, headerDeviceId));
    if (
      headerDeviceId !== null &&
      headerFlagged &&
      !(await markSessionSharedDevice(session.session.id, headerDeviceId))
    ) {
      await closeSessionAtMarkLimit(session.session.id, session.user.id);
      return null;
    }
    const sharedSession =
      (session.session.sharedDeviceIds?.length ?? 0) > 0 || headerFlagged;
    const deviceHeader = request.headers[DEVICE_TOKEN_HEADER];
    const actingToken = request.headers[ACTING_STAFF_HEADER];
    const hasDeviceToken =
      typeof deviceHeader === "string" && deviceHeader !== "";
    const hasActingToken = typeof actingToken === "string";
    let userId = session.user.id;
    if (sharedSession || hasDeviceToken || hasActingToken) {
      const deviceId = await registeredDeviceIdOfHeaders(
        request.headers,
        tenant.tenantId,
      );
      if (hasDeviceToken && deviceId === null) return null;
      if (sharedSession && (deviceId === null || !hasActingToken)) return null;
      if (hasActingToken) {
        if (deviceId === null) return null;
        const acting = await resolveActingStaffToken(tenant, {
          token: actingToken,
          deviceId,
          sessionId: session.session.id,
          outletId,
        });
        userId = acting.staffUserId;
      }
    }
    // E2: no requireAuth on an upgrade; the resolver cuts an edge PIN session
    // to the edge list only when the request context names it. Edge only:
    // `withEdgeDeviceOfHeaders` opened this call's own context there. On the
    // cloud a recheck runs in the context of the HTTP request that revoked the
    // device (device.service.ts), whose identity must stay.
    if (isEdgeNode()) {
      setRequestUser(userId);
      setRequestAuthMethod(authMethod);
    }
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
