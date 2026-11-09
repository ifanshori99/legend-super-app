// Statutory table routes (bead legend-gfcr, PRD v1.7 PAYR-02 / R20). Mounted
// at `/api/hris/payroll/statutory-tables` (contract: hris/payroll endpoints.ts
// in packages/shared). Tenant comes from the server-minted context, never the
// request (TEN-02). Reading needs `payroll.view`, writing `payroll.run`, both
// tenant-wide; the service re-checks them inside the tenant transaction.

import { Router } from "express";
import {
  archiveStatutoryTable,
  createStatutoryTableDraft,
  getStatutoryTable,
  listStatutoryTables,
  publishStatutoryTable,
  updateStatutoryTableDraft,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as statutory from "../services/payroll-statutory.service";

export const payrollStatutoryRouter = Router();

payrollStatutoryRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

payrollStatutoryRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = listStatutoryTables.query.parse(req.query);
    res.json(
      await statutory.listStatutoryTables(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

payrollStatutoryRouter.get(
  "/:versionId",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { versionId } = getStatutoryTable.params.parse(req.params);
    res.json({
      data: await statutory.getStatutoryTable(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        versionId,
      ),
    });
  },
);

payrollStatutoryRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { idempotencyKey, ...input } = createStatutoryTableDraft.body.parse(
      req.body,
    );
    const version = await statutory.createStatutoryTableDraft(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
      idempotencyKey,
    );
    res.status(201).json({ data: version });
  },
);

payrollStatutoryRouter.put(
  "/:versionId",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { versionId } = updateStatutoryTableDraft.params.parse(req.params);
    const { idempotencyKey, ...input } = updateStatutoryTableDraft.body.parse(
      req.body,
    );
    res.json({
      data: await statutory.updateStatutoryTableDraft(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        versionId,
        input,
        idempotencyKey,
      ),
    });
  },
);

payrollStatutoryRouter.post(
  "/:versionId/publish",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { versionId } = publishStatutoryTable.params.parse(req.params);
    const { idempotencyKey } = publishStatutoryTable.body.parse(req.body);
    res.json({
      data: await statutory.publishStatutoryTable(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        versionId,
        idempotencyKey,
      ),
    });
  },
);

payrollStatutoryRouter.post(
  "/:versionId/archive",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { versionId } = archiveStatutoryTable.params.parse(req.params);
    const { idempotencyKey } = archiveStatutoryTable.body.parse(req.body);
    res.json({
      data: await statutory.archiveStatutoryTable(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        versionId,
        idempotencyKey,
      ),
    });
  },
);
