// Public QR scan (PRD v1.7 §3 F10 "Scan & Sesi Meja"; contract
// openOrJoinTableSession `POST /api/qr/sessions`).
//
// No staff session: the guest holds the printed table QR, and the tenant is
// resolved from the request host (TEN-02) by the API-wide tenant middleware.
// The signed token itself is verified against that tenant and the table's
// token hash (ORD-04); the first scan opens the session, later scans join it.
//
// No trusted-origin check: this route never reads a cookie. The scan is a
// public menu entry point (guests may arrive from a QR app).

import { Router } from "express";
import { qrScanInputSchema } from "@starter/shared/qr-order";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { jsonBody } from "../middleware/body";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { openOrJoinTableSession } from "../services/table-session.service";

export const qrRouter = Router();

qrRouter.use(requireTenantContext);

qrRouter.post("/sessions", jsonBody, async (req, res) => {
  const input = qrScanInputSchema.parse(req.body);
  // The guest acts inside the tenant resolved from the host: a tenant-wide
  // context with no outlet reach restriction (the table names the outlet).
  const context = establishScopedTenantContext(getTenantContext(req), {
    kind: "tenant",
  });
  res.status(201).json({ data: await openOrJoinTableSession(context, input) });
});
