// Delivery channel commission reconciliation routes (bead legend-5bn3; contract
// @starter/shared/delivery endpoints.ts), slice D5.
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/delivery-reconciliation", deliveryReconciliationRouter)`;
// the router merges params. requireAuth + requireTrustedOrigin +
// requireTenantContext like the POS routers; each handler adds
// requireOutletPermission on the path's outlet. Reconciliation is finance's
// (contract endpoints.ts), so it needs `accounting.reconcile`. Statement lines
// are imported by an internal service function, not by a public endpoint.
import { Router } from "express";
import { getDeliveryReconciliation } from "@starter/shared/delivery";
import { requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { getDeliveryReconciliation as getDeliveryReconciliationService } from "../services/delivery-reconciliation.service.ts";

export const deliveryReconciliationRouter = Router({ mergeParams: true });

deliveryReconciliationRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

deliveryReconciliationRouter.get(
  "/",
  requireOutletPermission("accounting.reconcile", (req) =>
    String(req.params.outletId),
  ),
  async (req, res) => {
    const { outletId } = getDeliveryReconciliation.params.parse(req.params);
    const query = getDeliveryReconciliation.query.parse(req.query);
    res.json({
      data: await getDeliveryReconciliationService(
        getScopedTenantContext(req),
        outletId,
        query,
      ),
    });
  },
);
