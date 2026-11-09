// Cash deposit HTTP routes (legend-fnxl.5; PRD v1.7 §3.19 Kas & Bank, ACC-05).
// Paths and schemas are the `@starter/shared/accounting` endpoint objects. The
// tenant comes from the server-minted context (TEN-02), never from the body;
// permissions come from stored role assignments (TEN-03):
//
// - record: `accounting.cash_deposit.record` on the body's outlet
//   (`requireOutletPermission`), so an outlet manager records for its own
//   outlet only and `cash_deposits` RLS keeps the row there;
// - list and alerts: the same permission over whatever the caller reaches
//   (`requireMenuPermission` mints tenant-wide or outlet-reach scope); the
//   service narrows the rows to the outlets in scope.
//
// Mounted by the squad lead under /api/accounting next to the core router.

import { Router, type Request } from "express";
import {
  createCashDeposit,
  listCashDeposits,
  listUndepositedCashAlerts,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createCashDeposit as createCashDepositService,
  listCashDeposits as listCashDepositsService,
  listUndepositedCashAlerts as listUndepositedCashAlertsService,
} from "../services/accounting-cash-deposits.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingCashDepositsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const RECORD: PermissionCode = "accounting.cash_deposit.record";

  // Declared before the list route: `/cash-deposits/alerts` is its own path.
  router.get(
    route(listUndepositedCashAlerts.path),
    requireMenuPermission(RECORD),
    async (req, res) => {
      const query = listUndepositedCashAlerts.query.parse(req.query);
      res.json({
        data: await listUndepositedCashAlertsService(
          getScopedTenantContext(req),
          query,
        ),
      });
    },
  );

  router.get(
    route(listCashDeposits.path),
    requireMenuPermission(RECORD),
    async (req, res) => {
      const query = listCashDeposits.query.parse(req.query);
      res.json(await listCashDepositsService(getScopedTenantContext(req), query));
    },
  );

  router.post(
    route(createCashDeposit.path),
    jsonBody,
    requireOutletPermission(
      RECORD,
      (req) => (req.body as { outletId?: string } | undefined)?.outletId ?? "",
    ),
    async (req, res) => {
      const input = createCashDeposit.body.parse(req.body);
      res.status(201).json({
        data: await createCashDepositService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
