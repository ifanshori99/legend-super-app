// Audited write-off of a lost receipt number (legend-0hzqw). Owner only
// (`pos.receipt.writeoff`); cloud only (the service refuses on an edge).
//
// Mounts (routes/index.ts): apiRouter.use("/outlets/:outletId/pos", ...)

import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { AccessError } from "@starter/shared/access";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import { receiptNumberWriteoffInputSchema } from "@starter/shared/pos";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as writeoff from "../services/pos-receipt-writeoff.service.ts";

export const posReceiptWriteoffRouter = Router({ mergeParams: true });

posReceiptWriteoffRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const owner = requireOutletPermission("pos.receipt.writeoff", outletOf);

const params = z.strictObject({ outletId: outletIdSchema });

// A write-off hides a missing number from the receipt trail for good, so the
// session must have verified its second factor (AUTH-05), whatever role grants
// the permission: `approve` is not an MFA-sensitive tag, so a custom role
// holding the code would otherwise skip MFA. Runs after the permission check,
// which loads the access snapshot.
const verifiedSecondFactor: RequestHandler = (req, _res, next) => {
  if (!getAccessSnapshot(req).mfaVerified)
    throw new AccessError("MFA_REQUIRED");
  next();
};

posReceiptWriteoffRouter.post(
  "/receipt-writeoffs",
  owner,
  verifiedSecondFactor,
  jsonBody,
  async (req, res) => {
    const { outletId } = params.parse(req.params);
    const body = receiptNumberWriteoffInputSchema.parse(req.body);
    res.status(201).json({
      data: await writeoff.writeOffReceiptNumber(
        getScopedTenantContext(req),
        { userId: userIdSchema.parse(getAuth(req).user.id) },
        outletId,
        body,
      ),
    });
  },
);

posReceiptWriteoffRouter.get("/receipt-writeoffs", owner, async (req, res) => {
  const { outletId } = params.parse(req.params);
  res.json({
    data: await writeoff.listReceiptNumberWriteoffs(
      getScopedTenantContext(req),
      outletId,
    ),
  });
});
