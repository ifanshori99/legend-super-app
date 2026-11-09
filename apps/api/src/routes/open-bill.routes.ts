// Open-bill control API (PRD v1.7 §3 F43 "Kontrol Open Bill", founder Q31-Q34;
// beads legend-8cm4, legend-2zb5). Contracts: convertSessionToOpenBill,
// listOpenBillApprovers, getOpenBillPolicy, updateOpenBillPolicy.
//
// Mounted at the API root like the service-request router: the paths span
// `/api/outlets/...` and `/api/table-sessions/...`, so staff middleware is
// attached per route instead of the router. Outlet ids come from the path or
// from the stored session, never from the body.

import { Router, type Request } from "express";
import { AccessError } from "@starter/shared/access";
import { z, outletIdSchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  convertSessionToOpenBillInputSchema,
  tableSessionIdSchema,
  upsertOpenBillPolicyInputSchema,
} from "@starter/shared/qr-order";
import { verifyDeviceToken } from "../lib/device-token";
import { getAuth, requireAuth } from "../middleware/auth";
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
import { resolveOutletContext } from "./floor-access";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const sessionParams = z.strictObject({ sessionId: tableSessionIdSchema });

export const openBillRouter = Router();

/** Staff session + trusted origin + resolved tenant, per route. */
const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];

/**
 * The signed device id, only when the request carries a valid token for the
 * resolved tenant. Optional: a signed-in staff browser has none (like the
 * AUTH-06 override, which records no device for a back-office caller).
 */
function optionalDeviceIdOf(req: Request): string | null {
  const tenant = getTenantContext(req);
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (
    tenant.source !== "device" ||
    payload === null ||
    payload.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase()
  )
    return null;
  return payload.deviceId;
}

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
      data: await upsertOpenBillPolicy(
        context,
        outletId,
        input,
        getAuth(req).user.id,
      ),
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
    res.json({
      data: await convertSessionToOpenBill(
        context,
        sessionId,
        input,
        getAuth(req).user.id,
        { deviceId: optionalDeviceIdOf(req) },
      ),
    });
  },
);
