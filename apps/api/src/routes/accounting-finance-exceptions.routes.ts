// Finance exceptions list (bead legend-4oclu): read-only, behind
// `accounting.journal.view` over whatever the caller reaches
// (`requireMenuPermission` mints tenant-wide or outlet-reach scope; the
// service narrows every kind to it). Mounted under /api/accounting.

import { Router } from "express";
import { financeExceptionsQuerySchema } from "@starter/shared/validators/finance-exceptions";
import { requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";

export function createAccountingFinanceExceptionsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.get(
    "/finance-exceptions",
    requireMenuPermission("accounting.journal.view"),
    async (req, res) => {
      const parsed = financeExceptionsQuerySchema.safeParse(req.query);
      if (!parsed.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "Check the dates (from and to, at most 92 days), kind and outlet.",
        );
      res.json(
        await listFinanceExceptions(getScopedTenantContext(req), parsed.data),
      );
    },
  );

  return router;
}
