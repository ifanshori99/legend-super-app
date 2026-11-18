// Facility tickets at the cashier (936, legend-hpgyw part D; contracts
// `sellAccessTicketAtPos` in @starter/shared/facility and
// @starter/shared/pos/ticket). Mounted without a prefix (absolute paths).
// The sale path names a facility and the order paths name an order, never an
// outlet, so each guard first resolves the outlet (404 when it is not this
// tenant's) and then the cashier needs `pos.sale.create` on it (TEN-03):
// ticket sale and credential are the cashier's sale, the list is a read.

import { Router, type Request } from "express";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  doorCheckAccessTicket,
  sellAccessTicketAtPos,
} from "@starter/shared/facility";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import {
  issuePosTicketCredential,
  listPosOrderTickets,
} from "@starter/shared/pos/ticket";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error";
import { doorCheckTicket } from "../services/facility-door-check";
import {
  findFacilityOutletId,
  sellPosTicket,
} from "../services/facility-pos-ticket-sale";
import {
  issuePosTicketCredential as issueCredential,
  listPosOrderTickets as listTickets,
} from "../services/facility-pos-tickets";
import { findPosOrderOutletId } from "../services/pos-order-customer.service";
import { currentDeviceIdOf } from "./device-id";

export const facilityPosTicketRouter = Router();

const outlets = new WeakMap<Request, string>();
const outletOfRequest = (req: Request) => {
  const outletId = outlets.get(req);
  if (!outletId) throw new Error("Ticket outlet was not resolved");
  return outletId;
};
const sell = requireOutletPermission("pos.sale.create", outletOfRequest);
const view = requireOutletPermission("order.view", outletOfRequest);
// The door check names a credential, not an outlet: the door staff reach comes
// from the permission and the service only sees tickets inside that reach.
const operateDoor = requireMenuPermission("facility.booth.operate");

const guards = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

function setOutlet(req: Request, outletId: string): void {
  // The path carries no outlet, so resolveActingStaff could not compare it.
  if (req.actingStaff && req.actingStaff.outletId !== outletId)
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif bukan untuk outlet ini.",
    );
  outlets.set(req, outletId);
}

/** The facility's outlet (404 when it is not this tenant's facility). */
async function resolveFacilityOutlet(
  req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
): Promise<void> {
  const body = sellAccessTicketAtPos.body.parse(req.body);
  const outletId = await findFacilityOutletId(
    getTenantContext(req).tenantId,
    body.facilityId,
  );
  if (!outletId)
    throw new HttpError(404, "NOT_FOUND", "Fasilitas tidak ditemukan.");
  setOutlet(req, outletId);
  next();
}

/** The order's outlet (404 when it is not this tenant's POS order). */
async function resolveOrderOutlet(
  req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
): Promise<void> {
  // The credential route also carries :ticketId, which the strict list params
  // schema refuses: only the order id picks the outlet here (its handler parses
  // the full params again).
  const { orderId } = listPosOrderTickets.params.parse({
    orderId: req.params.orderId,
  });
  const outletId = await findPosOrderOutletId(
    getTenantContext(req).tenantId,
    orderId,
  );
  if (!outletId)
    throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  setOutlet(req, outletId);
  next();
}

facilityPosTicketRouter.post(
  "/facility/tickets/pos",
  ...guards,
  jsonBody,
  resolveFacilityOutlet,
  sell,
  async (req, res) => {
    const body = sellAccessTicketAtPos.body.parse(req.body);
    const data = await sellPosTicket(
      getScopedTenantContext(req),
      {
        userId: userIdSchema.parse(actorOf(req)),
        deviceId: await currentDeviceIdOf(req),
        expectedVersion: null,
      },
      body,
    );
    res.json({ data });
  },
);

facilityPosTicketRouter.get(
  "/pos/orders/:orderId/tickets",
  ...guards,
  resolveOrderOutlet,
  view,
  async (req, res) => {
    const { orderId } = listPosOrderTickets.params.parse(req.params);
    res.json({
      data: await listTickets(
        getScopedTenantContext(req),
        outletIdSchema.parse(outletOfRequest(req)),
        orderId,
      ),
    });
  },
);

facilityPosTicketRouter.post(
  "/pos/orders/:orderId/tickets/:ticketId/credential",
  ...guards,
  jsonBody,
  resolveOrderOutlet,
  sell,
  async (req, res) => {
    const { orderId, ticketId } = issuePosTicketCredential.params.parse(
      req.params,
    );
    const body = issuePosTicketCredential.body.parse(req.body);
    const data = await issueCredential(
      getScopedTenantContext(req),
      {
        userId: userIdSchema.parse(actorOf(req)),
        deviceId: await currentDeviceIdOf(req),
        expectedVersion: null,
      },
      {
        outletId: outletIdSchema.parse(outletOfRequest(req)),
        orderId,
        ticketId,
        idempotencyKey: body.idempotencyKey,
      },
    );
    // The credential is shown once: never cached.
    res.setHeader("Cache-Control", "no-store").json({ data });
  },
);

// 936 second-opinion fix (group T): the door validator of the QR token or PIN.
// Every credential failure is one uniform 403 DOOR_CREDENTIAL_INVALID.
facilityPosTicketRouter.post(
  "/facility/tickets/door-check",
  ...guards,
  jsonBody,
  operateDoor,
  async (req, res) => {
    const body = doorCheckAccessTicket.body.parse(req.body);
    const data = await doorCheckTicket(
      getScopedTenantContext(req),
      actorOf(req),
      body,
      new Date(),
      req.actingStaff?.outletId ?? null,
    );
    res.setHeader("Cache-Control", "no-store").json({ data });
  },
);
