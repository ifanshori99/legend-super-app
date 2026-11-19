// Failed paid-item recovery routes (bead legend-4qu; PRD v1.7 ORD-08, ORD-09;
// contracts @starter/shared/qr-order endpoints.ts `reportOrderIssue`,
// `getOrderIssueOptions`, `chooseOrderIssueResolution`, `resolveOrderIssue`
// and guest.ts `listSessionOrderIssues`).
//
// Mount (routes/index.ts): `apiRouter.use(orderRecoveryRouter)`; the paths
// span three prefixes (/order-items, /order-issues, /table-sessions), so the
// router carries the full contract paths and guards are attached per route.
//
// - Staff (report, resolve): requireAuth + requireTrustedOrigin +
//   requireTenantContext + requireMenuPermission("order.recovery.handle"),
//   which mints the outlet-reach context; the service re-checks the outlet of
//   the concrete item or issue. The tenant comes from the server-minted
//   context (TEN-02), never the body.
// - Guest (list, options, customer-choice): the opaque session credential
//   (`Authorization: Bearer <sessionToken>`) resolves the session-scoped
//   context, the same as the QR order routes (ORD-01). The guest never sees
//   manual refund (ORD-08).
// - Strict contract schemas parse params, query and body.

import { Router } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  chooseOrderIssueResolution,
  getOrderIssueOptions,
  listSessionOrderIssues,
  reportOrderIssue,
  resolveOrderIssue,
} from "@starter/shared/qr-order";
import {
  actorOf,
  refuseActingStaffOtherOutlet,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import {
  issueOutletOfParam,
  itemOutletOf,
} from "../middleware/acting-staff-outlet.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { HttpError } from "../lib/http-error.ts";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { isRequestOnSharedDevice } from "../middleware/shared-device-allowlist.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as recovery from "../services/order-recovery.service.ts";
import { guestContext, sessionCredential } from "./qr-order.routes.ts";

export const orderRecoveryRouter = Router();

// The paths carry no outlet: a token of another outlet may not touch the item
// or issue (refuseActingStaffOtherOutlet, before the permission guard).
const staffGuardFor = (
  outletOf: Parameters<typeof refuseActingStaffOtherOutlet>[0],
) => [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  refuseActingStaffOtherOutlet(outletOf),
  requireMenuPermission("order.recovery.handle"),
];
const guestRead = [requireTenantContext];
const guestWrite = [requireTenantContext, requireTrustedOrigin];

orderRecoveryRouter.post(
  "/order-items/:orderItemId/issues",
  ...staffGuardFor(itemOutletOf),
  jsonBody,
  async (req, res) => {
    const { orderItemId } = reportOrderIssue.params.parse(req.params);
    const body = reportOrderIssue.body.parse(req.body);
    res.status(201).json({
      data: await recovery.reportFailedItem(
        getScopedTenantContext(req),
        userIdSchema.parse(actorOf(req)),
        orderItemId,
        body,
        new Date(),
      ),
    });
  },
);

orderRecoveryRouter.post(
  "/order-issues/:orderIssueId/resolve",
  ...staffGuardFor(issueOutletOfParam),
  jsonBody,
  async (req, res) => {
    const { orderIssueId } = resolveOrderIssue.params.parse(req.params);
    const body = resolveOrderIssue.body.parse(req.body);
    // Every resolution (manual refund, voucher, swap) is money out: closed on a
    // shared tablet (founder decision, closed by default; sub-1094 round 3, CTO
    // 19 Nov extends it to voucher and swap). Personal devices are unchanged.
    if (req.actingStaff || isRequestOnSharedDevice(req)) {
      throw new HttpError(
        403,
        ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED,
        "Layar ini tidak tersedia di tablet bersama.",
      );
    }
    res.json({
      data: await recovery.resolveOrderIssue(
        getScopedTenantContext(req),
        userIdSchema.parse(actorOf(req)),
        orderIssueId,
        body,
        new Date(),
      ),
    });
  },
);

orderRecoveryRouter.get(
  "/table-sessions/:sessionId/order-issues",
  ...guestRead,
  async (req, res) => {
    const { sessionId } = listSessionOrderIssues.params.parse(req.params);
    const credential = sessionCredential(req);
    res.json({
      data: await recovery.listSessionOrderIssues(
        await guestContext(req, credential),
        credential,
        sessionId,
        new Date(),
      ),
    });
  },
);

orderRecoveryRouter.get(
  "/order-issues/:orderIssueId/options",
  ...guestRead,
  async (req, res) => {
    const { orderIssueId } = getOrderIssueOptions.params.parse(req.params);
    const credential = sessionCredential(req);
    res.json({
      data: await recovery.getOrderIssueOptions(
        await guestContext(req, credential),
        credential,
        orderIssueId,
      ),
    });
  },
);

orderRecoveryRouter.post(
  "/order-issues/:orderIssueId/customer-choice",
  ...guestWrite,
  jsonBody,
  async (req, res) => {
    const { orderIssueId } = chooseOrderIssueResolution.params.parse(
      req.params,
    );
    const body = chooseOrderIssueResolution.body.parse(req.body);
    const credential = sessionCredential(req);
    res.json({
      data: await recovery.chooseOrderIssueResolution(
        await guestContext(req, credential),
        credential,
        orderIssueId,
        body,
        new Date(),
      ),
    });
  },
);
