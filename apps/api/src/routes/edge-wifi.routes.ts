// Edge-served Wi-Fi agent API (bead legend-hsk; plan
// docs/briefs/sub-ws09-wifi-plan.md section 6; PRD v1.7 §3 F5 + F25, FAC-11,
// FAC-13). Mount at /api/edge/wifi BEFORE /api/edge in routes/index.ts. Like
// edge-device.routes.ts, the edge route guard refuses these paths on the cloud
// and the handlers refuse again when the process has no edge identity.
//
//   GET  /api/edge/wifi/grants                        live grants of THIS
//                                                     node's outlet (no raw
//                                                     controller device id)
//   POST /api/edge/wifi/sessions/:wifiSessionId/revoke  staff cut a session
//   GET  /api/edge/wifi/walled-garden                 the pre-auth allowlist,
//                                                     for manual controller
//                                                     provisioning
//
// Signed-in staff holding `device.registry.manage` on the node's outlet. The
// tenant and the outlet come from the node identity, never from the request.
import { Router, type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import { outletIdSchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  getEdgeWifiWalledGarden,
  listEdgeWifiGrants,
  revokeEdgeWifiSession,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { wifiAgent } from "../edge/wifi/port.ts";
import { HttpError } from "../lib/http-error.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { outletContext } from "../services/device-pin-support.ts";
import { auditFacility } from "../services/facility-shared.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";

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
const wifiManager: RequestHandler = async (req, _res, next) => {
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
      "Akun Anda tidak dapat mengelola Wi-Fi outlet ini.",
    );
  next();
};

/**
 * Strict response contract as the last gate: an agent view that carries a
 * field outside it (a raw controller id) is a server bug, answered 500 with
 * nothing of the data in the body.
 */
function respond<T>(
  schema: { safeParse(data: unknown): { success: boolean; data?: T } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new HttpError(
      500,
      "WIFI_RESPONSE_INVALID",
      "Respons Wi-Fi tidak valid.",
    );
  return parsed.data as T;
}

/** The node's own tenant and outlet as a server-minted context. */
function nodeScope() {
  const identity = edgeIdentity();
  const outletId = outletIdSchema.parse(identity.scope.outletId);
  return {
    outletId,
    context: outletContext(identity.context.tenant, outletId),
  };
}

export const edgeWifiRouter = Router();

edgeWifiRouter.use(requireNodeTenant, requireAuth, requireTrustedOrigin);

edgeWifiRouter.get("/grants", wifiManager, async (req, res) => {
  listEdgeWifiGrants.query.parse(req.query);
  const { outletId, context } = nodeScope();
  const grants = await wifiAgent().listLiveGrants(context, outletId);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(respond(listEdgeWifiGrants.response, { data: grants }));
});

edgeWifiRouter.get("/walled-garden", wifiManager, async (req, res) => {
  const { context } = nodeScope();
  const garden = await wifiAgent().walledGarden(context);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(respond(getEdgeWifiWalledGarden.response, { data: garden }));
});

edgeWifiRouter.post(
  "/sessions/:wifiSessionId/revoke",
  wifiManager,
  jsonBody,
  async (req, res) => {
    const { wifiSessionId } = revokeEdgeWifiSession.params.parse(req.params);
    revokeEdgeWifiSession.body.parse(req.body);
    const { outletId, context } = nodeScope();
    const agent = wifiAgent();
    // A session this tenant and outlet never granted: 404 before the provider
    // is touched. RLS and the explicit filters keep other tenants out.
    const known = await withTenant(db, context, (tx) =>
      tx.execute(
        sql`SELECT 1 FROM wifi_device_grants
            WHERE tenant_id = ${context.tenant.tenantId}::uuid
              AND outlet_id = ${outletId}::uuid
              AND wifi_session_id = ${wifiSessionId}::uuid
            LIMIT 1`,
      ),
    );
    if (known.rows.length === 0)
      throw new HttpError(404, "NOT_FOUND", "Sesi Wi-Fi tidak ditemukan.");
    const grants = await agent.endSession(context, {
      outletId,
      wifiSessionId,
      reason: "staff_revoked",
    });
    await withTenant(db, context, (tx) =>
      auditFacility(tx, context, getAuth(req).user.id, new Date(), {
        action: "wifi_grant.revoked",
        objectType: "wifi_session",
        objectId: wifiSessionId,
        outletId,
        before: null,
        after: { grantCount: grants.length },
      }),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json(respond(revokeEdgeWifiSession.response, { data: grants }));
  },
);
