// Open-bill control API (PRD v1.7 §3 F43 "Kontrol Open Bill", founder Q31-Q34;
// beads legend-8cm4, legend-2zb5). Contracts: convertSessionToOpenBill,
// listOpenBillApprovers, getOpenBillPolicy, updateOpenBillPolicy.
//
// Mounted at the API root like the service-request router: the paths span
// `/api/outlets/...` and `/api/table-sessions/...`, so staff middleware is
// attached per route instead of the router. Outlet ids come from the path or
// from the stored session, never from the body.

import { Router } from "express";
import { AccessError } from "@starter/shared/access";
import { z, outletIdSchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  convertSessionToOpenBillInputSchema,
  tableSessionIdSchema,
  upsertOpenBillPolicyInputSchema,
} from "@starter/shared/qr-order";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import {
  convertSessionToOpenBill,
  getOpenBillPolicy,
  listOpenBillApprovers,
  openBillSessionOutletId,
  upsertOpenBillPolicy,
} from "../services/open-bill-control.service";
import { PinDeviceThrottledError } from "../services/staff-pin-proof.service";
import { resolveOutletContext } from "./floor-access";
import { currentDeviceIdOf } from "./device-id.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const sessionParams = z.strictObject({ sessionId: tableSessionIdSchema });

export const openBillRouter = Router();

/** Staff session + trusted origin + resolved tenant, per route. */
const staffGuard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

openBillRouter.get(
  "/outlets/:outletId/open-bill/approvers",
  ...staffGuard,
  async (req, res) => {
    const { outletId } = outletParams.parse(req.params);
    const context = await resolveOutletContext(
      req,
      "floor.table.operate",
      outletId,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: await listOpenBillApprovers(context, outletId) });
  },
);

openBillRouter.get(
  "/outlets/:outletId/open-bill-policy",
  ...staffGuard,
  async (req, res) => {
    const { outletId } = outletParams.parse(req.params);
    // Floor staff read it for the convert dialog; managers read it to edit.
    const context = await resolveOutletContext(
      req,
      "floor.table.operate",
      outletId,
    ).catch((error: unknown) => {
      if (!(error instanceof AccessError)) throw error;
      return resolveOutletContext(
        req,
        "floor.open_bill_policy.manage",
        outletId,
      );
    });
    res.json({ data: await getOpenBillPolicy(context, outletId) });
  },
);

openBillRouter.put(
  "/outlets/:outletId/open-bill-policy",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { outletId } = outletParams.parse(req.params);
    const input = upsertOpenBillPolicyInputSchema.parse(req.body);
    const context = await resolveOutletContext(
      req,
      "floor.open_bill_policy.manage",
      outletId,
    );
    res.json({
      data: await upsertOpenBillPolicy(context, outletId, input, actorOf(req)),
    });
  },
);

openBillRouter.post(
  "/table-sessions/:sessionId/open-bill",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const input = convertSessionToOpenBillInputSchema.parse(req.body);
    // The session's own outlet decides who may act: look it up under the
    // tenant, then require floor.table.operate on that outlet.
    const outletId = await openBillSessionOutletId(
      establishScopedTenantContext(getTenantContext(req), { kind: "tenant" }),
      sessionId,
    );
    const context = await resolveOutletContext(
      req,
      "floor.table.operate",
      outletId,
    );
    res.setHeader("Cache-Control", "private, no-store");
    try {
      res.json({
        data: await convertSessionToOpenBill(
          context,
          sessionId,
          input,
          actorOf(req),
          { deviceId: await currentDeviceIdOf(req) },
        ),
      });
    } catch (error) {
      // 429 tells the device when its PIN window ends (bead legend-vfj7z).
      if (error instanceof PinDeviceThrottledError)
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  },
);
