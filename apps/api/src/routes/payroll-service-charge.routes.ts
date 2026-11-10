// Service-charge pool routes, configuration side (bead legend-gfcr, PRD v1.7
// §3 D.30 "Distribusi Service Charge"). Expected mount:
// `/api/hris/payroll/service-charge-pools` (contract: hris/payroll
// endpoints.ts in packages/shared). Tenant comes from the server-minted
// context, never the request (TEN-02). Reading needs `payroll.view`, creating
// a pool `payroll.run`; the service re-checks both inside the tenant
// transaction. Calculate and approve are the payroll engine's (legend-pf9u7)
// and are not registered here.

import { Router } from "express";
import {
  createServiceChargePool,
  listServiceChargeAllocations,
  listServiceChargePools,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as pools from "../services/payroll-service-charge.service";

export const payrollServiceChargeRouter = Router();

payrollServiceChargeRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

payrollServiceChargeRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = listServiceChargePools.query.parse(req.query);
    const page = await pools.listServiceChargePools(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    );
    res.json(listServiceChargePools.response.parse(page));
  },
);

payrollServiceChargeRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const body = createServiceChargePool.body.parse(req.body);
    const pool = await pools.createServiceChargePool(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      body,
    );
    res
      .status(201)
      .json(createServiceChargePool.response.parse({ data: pool }));
  },
);

payrollServiceChargeRouter.get(
  "/:poolId/allocations",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { poolId } = listServiceChargeAllocations.params.parse(req.params);
    const query = listServiceChargeAllocations.query.parse(req.query);
    const page = await pools.listServiceChargeAllocations(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      poolId,
      query,
    );
    res.json(listServiceChargeAllocations.response.parse(page));
  },
);
