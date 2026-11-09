// Reconciliation case HTTP routes (bead legend-fnxl.6; PRD v1.7 §3.19 Kas &
// Bank, ACC-04). Paths and schemas are the `@starter/shared/accounting`
// endpoint objects. The tenant comes from the server-minted context (TEN-02),
// never from the body; permissions come from stored role assignments (TEN-03):
//
// - read: `accounting.journal.view`;
// - open and act: `accounting.reconcile`.
//
// The service applies the outlet layer (a case outside the caller's outlets is
// "not found"). Mounted by the squad lead under /api/accounting.

import { Router, type Request } from "express";
import {
  actOnReconciliationCase,
  getReconciliationCase,
  listReconciliationCases,
  openReconciliationCase,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  actOnReconciliationCase as actOnCaseService,
  getReconciliationCase as getCaseService,
  listReconciliationCases as listCasesService,
  openReconciliationCase as openCaseService,
} from "../services/accounting-bank-recon-cases.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingBankReconCasesRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const VIEW: PermissionCode = "accounting.journal.view";
  const RECONCILE: PermissionCode = "accounting.reconcile";

  router.get(
    route(listReconciliationCases.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const query = listReconciliationCases.query.parse(req.query);
      res.json(await listCasesService(getScopedTenantContext(req), query));
    },
  );

  router.post(
    route(openReconciliationCase.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const input = openReconciliationCase.body.parse(req.body);
      res.status(201).json({
        data: await openCaseService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  router.get(
    route(getReconciliationCase.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const { caseId } = getReconciliationCase.params.parse(req.params);
      res.json({
        data: await getCaseService(getScopedTenantContext(req), caseId),
      });
    },
  );

  router.post(
    route(actOnReconciliationCase.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const { caseId } = actOnReconciliationCase.params.parse(req.params);
      const input = actOnReconciliationCase.body.parse(req.body);
      res.json({
        data: await actOnCaseService(
          getScopedTenantContext(req),
          caseId,
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
