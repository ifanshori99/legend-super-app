// Breakfast order from the access ticket, paid before the kitchen (PRD v1.7
// §3 F22; founder Q43). Paths, params and bodies come from the WS-09 contract
// (`@starter/shared/facility` breakfast endpoints). Mount at `/api/facility`,
// before `facilityRouter`.
//
// Guest routes (`/tickets/:ticketId/...`) use the member chain of
// member.routes.ts: tenant from the PWA host (TEN-02) → requireAuth →
// requireTrustedOrigin → jsonBody (POST) → requireMember(). The profile always
// comes from the session; the service refuses a ticket that is not the
// member's (404). The staff fire route is gated by `facility.booth.operate`
// like the other facility staff routes. "Paid" is never set here: only the
// verified payment event marks an order paid.
import { Router } from "express";
import { crmErrorMessages } from "@starter/shared/crm";
import {
  cancelBreakfastOrder as cancelBreakfastOrderEndpoint,
  createBreakfastOrder as createBreakfastOrderEndpoint,
  fireBreakfastOrder as fireBreakfastOrderEndpoint,
  getBreakfastMenu as getBreakfastMenuEndpoint,
  payBreakfastOrder as payBreakfastOrderEndpoint,
} from "@starter/shared/facility";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { getMemberScope, requireMember } from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as breakfast from "../services/facility-breakfast.service.ts";

export const facilityBreakfastRouter = Router();

const base = [requireTenantContext, requireAuth, requireTrustedOrigin];
const operate = requireMenuPermission("facility.booth.operate");

/** A member with a session but no profile yet gets 404 CUSTOMER_NOT_FOUND. */
function memberOf(scope: ReturnType<typeof getMemberScope>): {
  customerProfileId: string;
} {
  if (!scope.customerProfileId)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      crmErrorMessages.CUSTOMER_NOT_FOUND,
    );
  return { customerProfileId: scope.customerProfileId };
}

facilityBreakfastRouter.get(
  "/tickets/:ticketId/breakfast-menu",
  ...base,
  requireMember(),
  async (req, res) => {
    const { ticketId } = getBreakfastMenuEndpoint.params.parse(req.params);
    const scope = getMemberScope(req);
    res.json({
      data: await breakfast.getBreakfastMenuForMember(
        scope.context,
        memberOf(scope),
        ticketId,
      ),
    });
  },
);

facilityBreakfastRouter.post(
  "/tickets/:ticketId/breakfast-orders",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    const { ticketId } = createBreakfastOrderEndpoint.params.parse(req.params);
    const body = createBreakfastOrderEndpoint.body.parse(req.body);
    const scope = getMemberScope(req);
    res.status(201).json({
      data: await breakfast.createBreakfastOrderForMember(
        scope.context,
        memberOf(scope),
        ticketId,
        body,
      ),
    });
  },
);

facilityBreakfastRouter.post(
  "/tickets/:ticketId/breakfast-orders/:orderId/pay",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    const { ticketId, orderId } = payBreakfastOrderEndpoint.params.parse(
      req.params,
    );
    const body = payBreakfastOrderEndpoint.body.parse(req.body);
    const scope = getMemberScope(req);
    res.json({
      data: await breakfast.payBreakfastOrderForMember(
        scope.context,
        memberOf(scope),
        ticketId,
        orderId,
        body,
      ),
    });
  },
);

facilityBreakfastRouter.post(
  "/tickets/:ticketId/breakfast-orders/:orderId/cancel",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    const { ticketId, orderId } = cancelBreakfastOrderEndpoint.params.parse(
      req.params,
    );
    const body = cancelBreakfastOrderEndpoint.body.parse(req.body);
    const scope = getMemberScope(req);
    res.json({
      data: await breakfast.cancelBreakfastOrderForMember(
        scope.context,
        memberOf(scope),
        ticketId,
        orderId,
        body,
      ),
    });
  },
);

// Staff: send to the kitchen now. The service refuses an unpaid order
// (409 BREAKFAST_NOT_PAID); a fired order answers with itself.
facilityBreakfastRouter.post(
  "/breakfast-orders/:orderId/fire",
  ...base,
  operate,
  jsonBody,
  async (req, res) => {
    const { orderId } = fireBreakfastOrderEndpoint.params.parse(req.params);
    const body = fireBreakfastOrderEndpoint.body.parse(req.body);
    res.json({
      data: await breakfast.fireBreakfastOrderByStaff(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        orderId,
        body,
      ),
    });
  },
);
