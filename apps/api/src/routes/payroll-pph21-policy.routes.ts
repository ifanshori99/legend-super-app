// Tenant PPh 21 policy routes (bead legend-y4wp, PRD v1.7 §3 D.30 "PPh 21").
// Mounted at `/api/hris/payroll/pph21-policies` (contract: hris/payroll
// endpoints.ts in packages/shared). Tenant comes from the server-minted
// context, never the request (TEN-02). Reading needs `payroll.view`, publishing
// a version `payroll.run`, both tenant-wide; the service re-checks them inside
// the tenant transaction. Versions are append-only: there is no PUT, PATCH or
// DELETE.

import { Router } from "express";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import {
  createPph21Policy,
  getPph21PolicyInForce,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as policies from "../services/payroll-pph21-policy.service";

export const payrollPph21PolicyRouter = Router();

payrollPph21PolicyRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

payrollPph21PolicyRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    res.json({
      data: await policies.listPph21PolicyVersions(
        getScopedTenantContext(req),
        getAuth(req).user.id,
      ),
    });
  },
);

payrollPph21PolicyRouter.get(
  "/in-force",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = getPph21PolicyInForce.query.parse(req.query);
    const date =
      query.date ?? businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
    res.json({
      data: await policies.getPph21PolicyInForce(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        date,
      ),
    });
  },
);

payrollPph21PolicyRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { idempotencyKey, ...input } = createPph21Policy.body.parse(req.body);
    const version = await policies.createPph21PolicyVersion(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
      new Date(),
      idempotencyKey,
    );
    res.status(201).json({ data: version });
  },
);
