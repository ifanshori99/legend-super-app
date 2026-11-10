// Staff identity for the panic stream (bead legend-bod). A WebSocket upgrade
// never passes through the Express chain, so this repeats, for a raw
// IncomingMessage, what the panic routes get from requireAuth + the node
// identity + `facility.booth.operate` on the outlet:
//
// - the Better Auth session from the cookie, read from the database on every
//   call (no cookie cache), so a signed-out session loses the socket on the
//   next recheck;
// - the tenant of THIS edge node, never one from the request;
// - `facility.booth.operate` on the path's outlet, which must be the node's
//   own outlet.
//
// Any failure answers null (deny by default).
import type { IncomingMessage } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import {
  assertOutletInScope,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { auth } from "../lib/auth.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { OPERATE_PERMISSION } from "./facility-shared.ts";
import { parsePanicRealtimeUrl } from "./panic-relay-realtime.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";

/** `resolveConnection` port of attachPanicRealtime for staff sessions. */
export async function resolvePanicStaffConnection(
  request: IncomingMessage,
): Promise<{ userId: string; context: ScopedTenantContext } | null> {
  try {
    const target = parsePanicRealtimeUrl(request.url);
    if (!target) return null;
    const runtime = getEdgeRuntimeState();
    if (!runtime.edgeMode || !runtime.identity) return null;
    const { identity } = runtime;
    const outletId = outletIdSchema.parse(target.outletId);
    if (identity.scope.outletId.toLowerCase() !== outletId) return null;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true },
    });
    if (!session) return null;
    const tenant = identity.context.tenant;
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
    const context = snapshot.contextFor(OPERATE_PERMISSION, {
      type: "outlet",
      id: outletId,
    });
    if (!context) return null;
    assertOutletInScope(context.outletScope, outletId);
    return { userId, context };
  } catch {
    return null;
  }
}
