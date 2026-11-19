// Facility tickets at the cashier (936, legend-hpgyw part D; contracts
// `sellAccessTicketAtPos` in @starter/shared/facility and
// @starter/shared/pos/ticket). Mounted without a prefix (absolute paths).
// The sale path names a facility and the order paths name an order, never an
// outlet, so each guard first resolves the outlet (404 when it is not this
// tenant's) and then the cashier needs `pos.sale.create` on it (TEN-03):
// ticket sale and credential are the cashier's sale, the list is a read.

import { and, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import {
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  doorCheckAccessTicket,
  sellAccessTicketAtPos,
} from "@starter/shared/facility";
import { MINUTE_MS } from "@starter/shared/identity";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import {
  issuePosTicketCredential,
  listPosOrderTickets,
} from "@starter/shared/pos/ticket";
import {
  listPosTicketProducts,
  listPosTicketSlots,
  searchPosTicketCustomers,
} from "@starter/shared/pos/ticket-cashier";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { rejectRateLimited } from "../middleware/public-rate-limit";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant";
import { db } from "../db";
import { createFixedWindowCounter } from "../lib/fixed-window-counter";
import { HttpError } from "../lib/http-error";
import { doorCheckTicket } from "../services/facility-door-check";
import * as cashierReads from "../services/facility-pos-ticket-catalog";
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

// 1059 (R2-05, g7l20): the door scope after the acting-staff cut.
const doorContexts = new WeakMap<Request, ScopedTenantContext>();
// R3-02: the verified device of the request, handed to the service, which
// re-reads its training mode under a row lock (this route read is the fast path).
const doorDevices = new WeakMap<Request, string | null>();

// The one refusal of every door-check failure (same body as facility-door-check).
const doorRefused = () =>
  new HttpError(
    403,
    "DOOR_CREDENTIAL_INVALID",
    "Kredensial pintu tidak valid.",
  );

/**
 * R2-05 + 1128: a token whose outlet is outside the staff's reach gets the
 * uniform refusal BEFORE any credential lookup. The reach is NOT cut to the
 * token's outlet: the service compares the outlet of the ticket with the token
 * only AFTER the QR or PIN matched (ACTING_STAFF_OUTLET_MISMATCH, the PIN slot
 * stays used, no ticket data in the 403), so an unknown or wrong credential is
 * still the uniform DOOR_CREDENTIAL_INVALID (no oracle).
 * g7l20: a training-mode device never opens the door, same uniform refusal and
 * before the service, so it neither opens a ticket nor counts as a PIN guess.
 */
async function sliceDoorScope(
  req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
): Promise<void> {
  const reach = getScopedTenantContext(req);
  const actingOutlet = req.actingStaff?.outletId;
  if (actingOutlet !== undefined) {
    const scope = reach.outletScope;
    if (
      scope.kind === "outlets" &&
      !scope.outletIds.some(
        (id) => id.toLowerCase() === actingOutlet.toLowerCase(),
      )
    )
      throw doorRefused();
  }
  const deviceId = await currentDeviceIdOf(req);
  if (deviceId !== null) {
    const tenantId = reach.tenant.tenantId;
    // Read tenant-wide: a device of another outlet than the staff's reach must
    // still be seen. A device row that cannot be read fails closed.
    const [device] = await withTenant(
      db,
      establishScopedTenantContext(reach.tenant, { kind: "tenant" }),
      (tx) =>
        tx
          .select({ trainingMode: devices.trainingMode })
          .from(devices)
          .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
          .limit(1),
    );
    if (!device || device.trainingMode === true) throw doorRefused();
  }
  doorContexts.set(req, reach);
  doorDevices.set(req, deviceId);
  next();
}

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

// 1096 (legend-hpgyw card 1): the cashier's reads for the ticket sale. The
// path names the outlet, so resolveActingStaff compares it and the cashier
// needs `pos.sale.create` on it, like the sale itself.
const sellOnPathOutlet = requireOutletPermission("pos.sale.create", (req) =>
  String(req.params.outletId ?? ""),
);

// 1096 architect P2: the customer search returns names, so a cashier could
// enumerate the customer list with many short queries. Cap it per user and
// tenant. Same process-local fixed-window counter the public and edge limits
// use (lib/fixed-window-counter.ts); no shared store, so with several API
// instances each one counts on its own. Mounted after the permission check:
// only an allowed cashier is counted, and every refusal is the same 429.
export const TICKET_CUSTOMER_SEARCH_PER_MINUTE = 30;
const customerSearchLimit = createFixedWindowCounter({
  limit: TICKET_CUSTOMER_SEARCH_PER_MINUTE,
  windowMs: MINUTE_MS,
  capacity: 5_000,
});

function limitCustomerSearch(
  req: Request,
  res: Parameters<typeof rejectRateLimited>[0],
  next: (error?: unknown) => void,
): void {
  // The acting cashier (PIN session on a shared device), not the device's
  // owner session, so cashiers on one tablet do not share a counter.
  const key = `${getTenantContext(req).tenantId}:${actorOf(req)}`;
  const retry = customerSearchLimit.take(key, Date.now());
  if (retry !== null) rejectRateLimited(res, retry);
  next();
}

facilityPosTicketRouter.get(
  "/outlets/:outletId/pos/tickets/customers",
  ...guards,
  sellOnPathOutlet,
  limitCustomerSearch,
  async (req, res) => {
    const { outletId } = searchPosTicketCustomers.params.parse(req.params);
    const { q } = searchPosTicketCustomers.query.parse(req.query);
    res.json({
      data: await cashierReads.searchPosTicketCustomers(
        getScopedTenantContext(req),
        outletId,
        q,
      ),
    });
  },
);

facilityPosTicketRouter.get(
  "/outlets/:outletId/pos/tickets/products",
  ...guards,
  sellOnPathOutlet,
  async (req, res) => {
    const { outletId } = listPosTicketProducts.params.parse(req.params);
    res.json({
      data: await cashierReads.listPosTicketProducts(
        getScopedTenantContext(req),
        outletId,
      ),
    });
  },
);

facilityPosTicketRouter.get(
  "/outlets/:outletId/pos/tickets/slots",
  ...guards,
  sellOnPathOutlet,
  async (req, res) => {
    const { outletId } = listPosTicketSlots.params.parse(req.params);
    const query = listPosTicketSlots.query.parse(req.query);
    res.json({
      data: await cashierReads.listPosTicketSlots(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        query,
      ),
    });
  },
);

// 936 second-opinion fix (group T): the door validator of the QR token or PIN.
// Every credential failure is one uniform 403 DOOR_CREDENTIAL_INVALID.
facilityPosTicketRouter.post(
  "/facility/tickets/door-check",
  ...guards,
  jsonBody,
  operateDoor,
  sliceDoorScope,
  async (req, res) => {
    const body = doorCheckAccessTicket.body.parse(req.body);
    const context = doorContexts.get(req);
    if (!context) throw new Error("Door scope was not resolved");
    const data = await doorCheckTicket(
      context,
      actorOf(req),
      body,
      doorDevices.get(req) ?? null,
      req.actingStaff?.outletId ?? null,
    );
    res.setHeader("Cache-Control", "no-store").json({ data });
  },
);
