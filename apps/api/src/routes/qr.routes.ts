// Public QR scan (PRD v1.7 §3 F10 "Scan & Sesi Meja") and the guest menu read
// (contract openOrJoinTableSession `POST /api/qr/sessions`, getQrMenu
// `GET /api/qr/menu/:qrToken`).
//
// No staff session: the guest holds the printed table QR, and the tenant is
// resolved from the request host (TEN-02) by the API-wide tenant middleware.
// The signed token itself is verified against that tenant and the table's
// token hash (ORD-04); the first scan opens the session, later scans join it.
//
// No trusted-origin check: this route never reads a cookie. The scan is a
// public menu entry point (guests may arrive from a QR app).

import { Router, type Request } from "express";
import { getQrMenu, qrScanInputSchema } from "@starter/shared/qr-order";
import { outletIdSchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { jsonBody } from "../middleware/body";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { getQrMenu as readQrMenu } from "../services/guest-menu.service";
import { verifyTableQrToken } from "../services/qr-token";
import { openOrJoinTableSession } from "../services/table-session.service";

/**
 * Two-step guest context (TEN-03, legend-7csf; same shape as payment links):
 * verify the signed token against the host's tenant, then mint the context
 * scoped to the outlet the token names, so outlet RLS also backstops the
 * guest read. A bad token is the same NOT_FOUND the service answers; the
 * service still loads the table by token hash and checks it matches.
 */
function qrGuestContext(req: Request, qrToken: unknown) {
  const tenant = getTenantContext(req);
  const { payload } = verifyTableQrToken({
    token: qrToken,
    resolvedTenantId: tenant.tenantId,
  });
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(payload.outletId)],
  });
}

export const qrRouter = Router();

qrRouter.use(requireTenantContext);

qrRouter.post("/sessions", jsonBody, async (req, res) => {
  const input = qrScanInputSchema.parse(req.body);
  // The guest acts inside the tenant resolved from the host, reaching only
  // the outlet the signed table token names.
  const context = qrGuestContext(req, input.qrToken);
  res.status(201).json({ data: await openOrJoinTableSession(context, input) });
});

qrRouter.get("/menu/:qrToken", async (req, res) => {
  const { qrToken } = getQrMenu.params.parse(req.params);
  // Q23 (legend-qf0i): the read hides active items without a photo, and the
  // signed token names the tenant, outlet and table (TEN-02/ORD-04).
  const context = qrGuestContext(req, qrToken);
  res.json({ data: await readQrMenu(context, qrToken) });
});
