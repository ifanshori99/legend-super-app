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
// - Founder Q7 (13 Nov 2026): approve/reject of a cash out above the tenant
//   limit needs `accounting.cash_bank.approve` (the service refuses its
//   creator); the limit is set with `accounting.cash_bank.limit.manage` and
//   read by any of the three permissions.

import { Router, type Request, type RequestHandler } from "express";
import {
  approveCashBankEntry,
  createCashBankEntry,
  getCashBankEntry,
  getCashOutApprovalLimit,
  listCashBankEntries,
  putCashOutApprovalLimit,
  rejectCashBankEntry,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { sessionMfaVerifiedAt } from "../lib/mfa";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  approveCashBankEntry as approveCashBankEntryService,
  createCashBankEntry as createCashBankEntryService,
  getCashBankEntry as getCashBankEntryService,
  getCashOutApprovalLimit as getCashOutApprovalLimitService,
  listCashBankEntries as listCashBankEntriesService,
  putCashOutApprovalLimit as putCashOutApprovalLimitService,
  rejectCashBankEntry as rejectCashBankEntryService,
} from "../services/accounting-cash-bank-entries.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

/** Passes when the caller holds at least one of the permissions (else the last denial). */
function requireAnyMenuPermission(
  ...permissions: readonly PermissionCode[]
): RequestHandler {
  return async (req, res, next) => {
    let denied: unknown;
    for (const permission of permissions) {
      let passed = false;
      try {
        await requireMenuPermission(permission)(req, res, () => {
          passed = true;
        });
      } catch (error) {
        denied = error;
        continue;
      }
      if (passed) return next();
    }
    throw denied;
  };
}

export function createAccountingCashBankEntriesRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const RECORD: PermissionCode = "accounting.cash_bank.record";
  const APPROVE: PermissionCode = "accounting.cash_bank.approve";
  const LIMIT_MANAGE: PermissionCode = "accounting.cash_bank.limit.manage";

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

  router.post(
    route(approveCashBankEntry.path),
    jsonBody,
    requireMenuPermission(APPROVE),
    async (req, res) => {
      const { entryId } = approveCashBankEntry.params.parse(req.params);
      approveCashBankEntry.body.parse(req.body);
      res.json({
        data: await approveCashBankEntryService(
          getScopedTenantContext(req),
          entryId,
          actorId(req),
          { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
        ),
      });
    },
  );

  router.post(
    route(rejectCashBankEntry.path),
    jsonBody,
    requireMenuPermission(APPROVE),
    async (req, res) => {
      const { entryId } = rejectCashBankEntry.params.parse(req.params);
      const input = rejectCashBankEntry.body.parse(req.body);
      res.json({
        data: await rejectCashBankEntryService(
          getScopedTenantContext(req),
          entryId,
          input,
          actorId(req),
        ),
      });
    },
  );

  router.get(
    route(getCashOutApprovalLimit.path),
    requireAnyMenuPermission(RECORD, APPROVE, LIMIT_MANAGE),
    async (req, res) => {
      res.json({
        data: await getCashOutApprovalLimitService(getScopedTenantContext(req)),
      });
    },
  );

  router.put(
    route(putCashOutApprovalLimit.path),
    jsonBody,
    requireTenantPermission(LIMIT_MANAGE),
    async (req, res) => {
      const input = putCashOutApprovalLimit.body.parse(req.body);
      res.json({
        data: await putCashOutApprovalLimitService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
