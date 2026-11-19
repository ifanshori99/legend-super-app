// Service requests: waiter call / bill request / complaint (PRD v1.7 §3 F10,
// ORD-07). Mounted at the API root (`apiRouter.use(serviceRequestRouter)`)
// because the contract spreads these paths over three prefixes:
//
// - POST /api/table-sessions/:sessionId/service-requests  (guest; Bearer
//   session credential; tenant from the host; no cookie, so no origin check)
// - GET  /api/outlets/:outletId/service-requests          (staff inbox)
// - POST /api/service-requests/:serviceRequestId/acknowledge|resolve (staff)
// - GET|POST|DELETE zone waiter assignments under /api/outlets/:outletId
//   (outlet manager; service_request.zone.manage)
//
// Staff routes: requireAuth + requireTrustedOrigin + tenant + the
// floor.table.operate permission on the request's own outlet (TEN-03).
// Middleware is per route: a router-wide guard would reject guests.

import { Router } from "express";
import {
  acknowledgeServiceRequest as acknowledgeEndpoint,
  assignZoneWaiter as assignZoneWaiterEndpoint,
  createServiceRequest as createEndpoint,
  listServiceRequests as listEndpoint,
  listZoneWaiters as listZoneWaitersEndpoint,
  removeZoneWaiter as removeZoneWaiterEndpoint,
  resolveServiceRequest as resolveEndpoint,
} from "@starter/shared/qr-order";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error";
import {
  acknowledgeServiceRequest,
  assignZoneWaiter,
  createServiceRequest,
  findServiceRequestOutlet,
  listServiceRequests,
  listZoneWaiterAssignments,
  removeZoneWaiterAssignment,
  resolveServiceRequest,
} from "../services/service-request.service";
import { guestSessionContext } from "../services/guest-session-scope";
import { resolveOutletContext } from "./floor-access";

export const serviceRequestRouter = Router();

const staffGuard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(header ?? "");
  if (!match)
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      "Sesi meja tidak dikenali; pindai QR meja lagi.",
    );
  return match[1];
}

serviceRequestRouter.post(
  "/table-sessions/:sessionId/service-requests",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const { sessionId } = createEndpoint.params.parse(req.params);
    const input = createEndpoint.body.parse(req.body);
    const token = bearer(req.get("authorization"));
    // TEN-03 (legend-7csf): reach only the outlet of the session the
    // credential names, as the other guest session routes do.
    const context = await guestSessionContext(getTenantContext(req), token);
    const { request, created } = await createServiceRequest(
      context,
      sessionId,
      token,
      input,
    );
    res.status(created ? 201 : 200).json({ data: request });
  },
);

serviceRequestRouter.get(
  "/outlets/:outletId/service-requests",
  ...staffGuard,
  async (req, res) => {
    const { outletId } = listEndpoint.params.parse(req.params);
    const query = listEndpoint.query.parse(req.query);
    const context = await resolveOutletContext(
      req,
      "floor.table.operate",
      outletId,
    );
    res.json(await listServiceRequests(context, outletId, query));
  },
);

/** Context for the outlet that owns the request, after a permission check. */
async function staffContextFor(
  req: Parameters<typeof resolveOutletContext>[0],
  serviceRequestId: string,
) {
  const outletId = await findServiceRequestOutlet(
    establishScopedTenantContext(getTenantContext(req), { kind: "tenant" }),
    serviceRequestId,
  );
  // The path carries no outlet, so resolveActingStaff could not compare it:
  // a cashier token issued for another outlet is refused here.
  if (req.actingStaff && req.actingStaff.outletId !== outletId)
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif bukan untuk outlet permintaan ini.",
    );
  return resolveOutletContext(req, "floor.table.operate", outletId);
}

serviceRequestRouter.post(
  "/service-requests/:serviceRequestId/acknowledge",
  ...staffGuard,
  async (req, res) => {
    const { serviceRequestId } = acknowledgeEndpoint.params.parse(req.params);
    const context = await staffContextFor(req, serviceRequestId);
    res.json({
      data: await acknowledgeServiceRequest(
        context,
        serviceRequestId,
        actorOf(req),
      ),
    });
  },
);

serviceRequestRouter.post(
  "/service-requests/:serviceRequestId/resolve",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { serviceRequestId } = resolveEndpoint.params.parse(req.params);
    const input = resolveEndpoint.body.parse(req.body);
    const context = await staffContextFor(req, serviceRequestId);
    res.json({
      data: await resolveServiceRequest(
        context,
        serviceRequestId,
        actorOf(req),
        input,
      ),
    });
  },
);

serviceRequestRouter.get(
  "/outlets/:outletId/zone-waiters",
  ...staffGuard,
  async (req, res) => {
    const { outletId } = listZoneWaitersEndpoint.params.parse(req.params);
    const query = listZoneWaitersEndpoint.query.parse(req.query);
    const context = await resolveOutletContext(
      req,
      "service_request.zone.manage",
      outletId,
    );
    res.json({
      data: await listZoneWaiterAssignments(context, outletId, query.zoneId),
    });
  },
);

serviceRequestRouter.post(
  "/outlets/:outletId/zones/:zoneId/waiters",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { outletId, zoneId } = assignZoneWaiterEndpoint.params.parse(
      req.params,
    );
    const input = assignZoneWaiterEndpoint.body.parse(req.body);
    const context = await resolveOutletContext(
      req,
      "service_request.zone.manage",
      outletId,
    );
    const { assignment, created } = await assignZoneWaiter(
      context,
      outletId,
      zoneId,
      input,
      actorOf(req),
    );
    res.status(created ? 201 : 200).json({ data: assignment });
  },
);

serviceRequestRouter.delete(
  "/outlets/:outletId/zone-waiters/:assignmentId",
  ...staffGuard,
  async (req, res) => {
    const { outletId, assignmentId } = removeZoneWaiterEndpoint.params.parse(
      req.params,
    );
    const context = await resolveOutletContext(
      req,
      "service_request.zone.manage",
      outletId,
    );
    await removeZoneWaiterAssignment(
      context,
      outletId,
      assignmentId,
      actorOf(req),
    );
    res.status(204).end();
  },
);
