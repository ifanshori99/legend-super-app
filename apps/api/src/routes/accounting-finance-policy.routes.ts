// Tenant finance policy HTTP routes (legend-pxcs; PRD v1.7 §3.19, ACC-04
// matching tolerance, ACC-05 undeposited-cash limit). Paths and schemas are the
// `@starter/shared/accounting` endpoint objects. The tenant comes from the
// server-minted context (TEN-02), never from the body; permissions come from
// stored role assignments (TEN-03):
//
// - read: `accounting.journal.view` (anyone who sees the books may see the
//   limits they are judged against);
// - write: `accounting.reconcile` (the policy tunes bank matching and the
//   deposit alert, both reconciliation work; unlike `accounting.period.close`
//   or `accounting.asset.manage` it names the same duty).
//
// Both are tenant-wide: the policy is one row per tenant.
//
// Mounted by the squad lead under /api/accounting next to the core router.

import { Router, type Request } from "express";
import { getFinancePolicy, putFinancePolicy } from "@starter/shared/accounting";
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
  getFinancePolicy as getFinancePolicyService,
  putFinancePolicy as putFinancePolicyService,
} from "../services/accounting-finance-policy.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingFinancePolicyRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const VIEW: PermissionCode = "accounting.journal.view";
  const RECONCILE: PermissionCode = "accounting.reconcile";

  router.get(
    route(getFinancePolicy.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      res.json({
        data: await getFinancePolicyService(getScopedTenantContext(req)),
      });
    },
  );

  router.put(
    route(putFinancePolicy.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const input = putFinancePolicy.body.parse(req.body);
      res.json({
        data: await putFinancePolicyService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
