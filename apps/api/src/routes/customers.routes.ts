// Customer 360 for staff (legend-ts50; contract `listCustomers` and
// `getCustomer360`). Paths are absolute under /api, so the router is mounted
// without a prefix and guards each route itself (same shape as
// loyalty-program.routes.ts). Tenant-wide `crm.customer.view`; the full
// WhatsApp number needs `crm.customer.pii.read` as well, read from the same
// permission snapshot (the service audits each reveal).

import { Router, type Request } from "express";
import {
  getCustomer360 as getCustomer360Endpoint,
  listCustomers as listCustomersEndpoint,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as customers from "../services/customer360.service";

export const customersRouter = Router();

const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];
const viewCustomer = requireTenantPermission("crm.customer.view");

/** True when the caller holds `crm.customer.pii.read` over the whole tenant. */
function canReadPii(req: Request): boolean {
  return (
    getAccessSnapshot(req).contextFor("crm.customer.pii.read", {
      type: "tenant",
    }) !== null
  );
}

customersRouter.get(
  "/customers",
  ...staffGuard,
  viewCustomer,
  async (req, res) => {
    const query = listCustomersEndpoint.query.parse(req.query);
    res.json(
      await customers.listCustomers(
        getScopedTenantContext(req),
        query,
        canReadPii(req),
      ),
    );
  },
);

customersRouter.get(
  "/customers/:customerProfileId",
  ...staffGuard,
  viewCustomer,
  async (req, res) => {
    const { customerProfileId } = getCustomer360Endpoint.params.parse(
      req.params,
    );
    res.json({
      data: await customers.getCustomer360(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        customerProfileId,
        canReadPii(req),
      ),
    });
  },
);
