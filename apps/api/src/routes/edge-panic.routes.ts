// Edge-served panic alert relay API (bead legend-bod; PRD v1.7 §3 F25
// "Keselamatan", FAC-08). Mount at /api/edge/panic BEFORE /api/edge in
// routes/index.ts. Like edge-wifi.routes.ts, the edge route guard refuses these
// paths on the cloud and the handlers refuse again when the process has no edge
// identity.
//
//   POST /api/edge/panic/events            a panic button press. The device
//                                          token (X-Device-Token) proves the
//                                          device; the body names the same
//                                          device, an idempotency eventId and
//                                          the device clock.
//   POST /api/edge/panic/alerts/:alertId/ack  staff take the alert; the first
//                                          one wins, a second gets 409.
//   GET  /api/edge/panic/alerts            the alerts of THIS node's outlet.
//
// Staff routes need a signed-in account holding `facility.booth.operate` on the
// node's outlet. The tenant and the outlet come from the node identity, never
// from the request.
import { Router, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import { CoreError, outletIdSchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  panicAlertIdSchema,
  panicAlertListQuerySchema,
  panicEventInputSchema,
} from "@starter/shared/facility";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { findActiveDeviceForToken } from "../services/device-registry-check.ts";
import { outletContext } from "../services/device-pin-support.ts";
import { OPERATE_PERMISSION } from "../services/facility-shared.ts";
import {
  acknowledgePanicAlert,
  ingestPanicEvent,
  listPanicAlerts,
} from "../services/panic-relay.service.ts";
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

/** Session path: `facility.booth.operate` on this node's outlet. */
const panicOperator: RequestHandler = async (req, _res, next) => {
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
    snapshot.contextFor(OPERATE_PERMISSION, {
      type: "outlet",
      id: identity.scope.outletId,
    }) !== null;
  if (!allowed)
    throw new AccessError(
      "PERMISSION_DENIED",
      "Akun Anda tidak dapat menangani peringatan darurat outlet ini.",
    );
  next();
};

/** The node's own tenant and outlet as a server-minted context. */
function nodeScope() {
  const identity = edgeIdentity();
  const outletId = outletIdSchema.parse(identity.scope.outletId);
  return {
    outletId,
    context: outletContext(identity.context.tenant, outletId),
  };
}

export const edgePanicRouter = Router();

edgePanicRouter.post(
  "/events",
  requireNodeTenant,
  jsonBody,
  async (req, res) => {
    const identity = edgeIdentity();
    const raw = req.get(DEVICE_TOKEN_HEADER);
    const payload = raw ? verifyDeviceToken(raw) : null;
    if (payload === null)
      throw new CoreError("UNAUTHORIZED", "Tombol darurat tidak terdaftar.");
    if (payload.tenantId !== identity.scope.tenantId)
      throw new HttpError(
        403,
        "TENANT_MISMATCH",
        "Tenant does not match this edge node.",
      );
    // Registry check (active, not rotated away); the outlet is compared by the
    // service so a button of another outlet is a 403, not an unknown device.
    const device = await findActiveDeviceForToken(payload);
    if (!device)
      throw new CoreError("UNAUTHORIZED", "Tombol darurat tidak terdaftar.");
    const body = panicEventInputSchema.parse(req.body);
    if (body.deviceId !== device.id)
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Perangkat tidak cocok dengan token.",
      );
    const { context } = nodeScope();
    const { alert, replayed } = await ingestPanicEvent(context, body);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(replayed ? 200 : 201).json({ data: { alert, replayed } });
  },
);

edgePanicRouter.post(
  "/alerts/:alertId/ack",
  requireNodeTenant,
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  panicOperator,
  async (req, res) => {
    const alertId = panicAlertIdSchema.parse(req.params.alertId);
    const { context } = nodeScope();
    const alert = await acknowledgePanicAlert(
      context,
      getAuth(req).user.id,
      alertId,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: alert });
  },
);

edgePanicRouter.get(
  "/alerts",
  requireNodeTenant,
  requireAuth,
  panicOperator,
  async (req, res) => {
    const query = panicAlertListQuerySchema.parse(req.query);
    const { outletId, context } = nodeScope();
    const page = await listPanicAlerts(context, outletId, query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(page);
  },
);
