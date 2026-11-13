// Finance command "jurnalkan penerimaan" (legend-7e0q4). Mount at
// `/api/inventory` (routes/index.ts). Path and body come from
// `@starter/shared/inventory` (`journalizeGoodsReceipt`).
//
// The tenant comes from the server-minted context (TEN-02). The command books
// a journal, so it needs `accounting.journal.post` over the whole tenant; the
// receipt id is looked up inside that tenant (another tenant's id is a 404).

import {
  journalizeGoodsReceipt as journalizeGoodsReceiptContract,
  journalizeGoodsReceiptInputSchema,
} from "@starter/shared/inventory";
import { Router } from "express";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { journalizeGoodsReceipt } from "../services/purchasing-receipt-journalize.service.ts";

const BASE = "/api/inventory";

export function createPurchasingReceiptJournalizeRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.post(
    journalizeGoodsReceiptContract.path.slice(BASE.length),
    jsonBody,
    requireTenantPermission("accounting.journal.post"),
    async (req, res) => {
      const { goodsReceiptId } = journalizeGoodsReceiptContract.params.parse(
        req.params,
      );
      journalizeGoodsReceiptInputSchema.parse(req.body);
      res.json({
        data: await journalizeGoodsReceipt(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          goodsReceiptId,
        ),
      });
    },
  );

  return router;
}
