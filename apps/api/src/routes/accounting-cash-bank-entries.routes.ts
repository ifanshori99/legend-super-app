// Cash in/out and bank transfer HTTP routes (legend-4961; PRD v1.7 §3.19 Kas &
// Bank). Paths and schemas are the `@starter/shared/accounting` endpoint
// objects. The tenant comes from the server-minted context (TEN-02), never from
// the body; the permission is `accounting.cash_bank.record` from stored role
// assignments (TEN-03).
//
// - All routes use `requireMenuPermission`, which mints the caller's reachable
//   scope. Bank accounts live on the legal entity, so a write also needs tenant
//   scope: the service refuses an outlet-scoped caller with OUTLET_OUT_OF_SCOPE
//   (assertTenantScope). Reads narrow the rows to the caller's outlets.

import { Router, type Request } from "express";
import {
  createCashBankEntry,
  getCashBankEntry,
  listCashBankEntries,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createCashBankEntry as createCashBankEntryService,
  getCashBankEntry as getCashBankEntryService,
  listCashBankEntries as listCashBankEntriesService,
} from "../services/accounting-cash-bank-entries.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingCashBankEntriesRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const RECORD: PermissionCode = "accounting.cash_bank.record";

  router.get(
    route(listCashBankEntries.path),
    requireMenuPermission(RECORD),
    async (req, res) => {
      const query = listCashBankEntries.query.parse(req.query);
      res.json(
        await listCashBankEntriesService(getScopedTenantContext(req), query),
      );
    },
  );

  router.get(
    route(getCashBankEntry.path),
    requireMenuPermission(RECORD),
    async (req, res) => {
      const { entryId } = getCashBankEntry.params.parse(req.params);
      res.json({
        data: await getCashBankEntryService(
          getScopedTenantContext(req),
          entryId,
        ),
      });
    },
  );

  router.post(
    route(createCashBankEntry.path),
    jsonBody,
    requireMenuPermission(RECORD),
    async (req, res) => {
      const input = createCashBankEntry.body.parse(req.body);
      res.status(201).json({
        data: await createCashBankEntryService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
