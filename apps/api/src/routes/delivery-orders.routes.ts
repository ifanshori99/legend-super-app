// Delivery channel order routes (bead legend-5bn3; contract
// @starter/shared/delivery endpoints.ts). Stub from D1: the handlers land in
// slice D4.
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/delivery-orders", deliveryOrdersRouter)`;
// the router merges params. requireAuth + requireTrustedOrigin +
// requireTenantContext like the POS routers; each handler adds
// requireOutletPermission on the path's outlet.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";

export const deliveryOrdersRouter = Router({ mergeParams: true });

deliveryOrdersRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);
