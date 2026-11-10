// Bank account HTTP routes (legend-fnxl.2; PRD v1.7 §3.19 Kas & Bank). Paths
// and schemas are the `@starter/shared/accounting` endpoint objects. The tenant
// comes from the server-minted context (TEN-02), never from the body;
// permissions come from stored role assignments (TEN-03):
//
// - list: `accounting.journal.view` (whoever sees the books sees the masked
//   accounts);
// - create: `accounting.reconcile` (registering the account bank matching runs
//   against is reconciliation work).
//
// Mounted by the squad lead under /api/accounting next to the core router.

import { Router, type Request } from "express";
import {
  createBankAccount,
  listBankAccounts,
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
  createBankAccount as createBankAccountService,
  listBankAccounts as listBankAccountsService,
} from "../services/accounting-bank-accounts.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingBankAccountsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const VIEW: PermissionCode = "accounting.journal.view";
  const RECONCILE: PermissionCode = "accounting.reconcile";

  router.get(
    route(listBankAccounts.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const { legalEntityId } = listBankAccounts.params.parse(req.params);
      res.json({
        data: await listBankAccountsService(
          getScopedTenantContext(req),
          legalEntityId,
        ),
      });
    },
  );

  router.post(
    route(createBankAccount.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const input = createBankAccount.body.parse(req.body);
      res.status(201).json({
        data: await createBankAccountService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
