// Bank statement import route (bead legend-fnxl.3, WS-07; PRD v1.7 §3.19,
// ACC-04). Path and schemas are the `@starter/shared/accounting` endpoint
// object. Importing is reconciliation work: `accounting.reconcile`,
// tenant-wide (the service also refuses an outlet-scoped context).

import { Router, type Request } from "express";
import { importBankStatement } from "@starter/shared/accounting";
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
import { importBankStatement as importBankStatementService } from "../services/accounting-bank-statements.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingBankStatementsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const RECONCILE: PermissionCode = "accounting.reconcile";

  router.post(
    route(importBankStatement.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const params = importBankStatement.params.parse(req.params);
      const input = importBankStatement.body.parse(req.body);
      res.status(201).json({
        data: await importBankStatementService(
          getScopedTenantContext(req),
          params.bankAccountId,
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
