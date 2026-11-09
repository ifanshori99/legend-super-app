// Send a purchase order and revoke its share links (PRD v1.7 §3.18 "Kirim PO"; bead legend-9yz).
//
// Mounts (lead, routes/index.ts):
//   apiRouter.use("/inventory", createPurchasingSendRouter())
//   apiRouter.use("/public/purchase-orders", publicPurchaseOrderRouter)
//
// - createPurchasingSendRouter: requireAuth + requireTrustedOrigin +
//   requireTenantContext. The route only knows the order id, so it mints the
//   caller's reachable scope for the permission and the service re-checks it
//   against the order's own outlet (404 when the order is not visible).
// - publicPurchaseOrderRouter: no session, no trusted-origin check (it reads no
//   cookie). The tenant comes from the request host (TEN-02); the token is
//   looked up by its SHA-256 inside that tenant, and every bad token is one
//   and the same 404.

import {
  purchaseOrderIdSchema,
  revokePurchaseOrderShareLinksInputSchema,
  sendPurchaseOrderInputSchema,
} from "@starter/shared/inventory";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  getPublicPurchaseOrderPdf,
  PURCHASE_ORDER_SEND_PERMISSION,
  revokePurchaseOrderShareLinksForOrder,
  sendPurchaseOrder,
} from "../services/purchasing-send.service.ts";

export function createPurchasingSendRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.post(
    "/purchase-orders/:purchaseOrderId/send",
    jsonBody,
    requireMenuPermission(PURCHASE_ORDER_SEND_PERMISSION),
    async (req, res) => {
      const purchaseOrderId = purchaseOrderIdSchema.parse(
        req.params.purchaseOrderId,
      );
      const input = sendPurchaseOrderInputSchema.parse(req.body);
      res.json({
        data: await sendPurchaseOrder(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          purchaseOrderId,
          input,
        ),
      });
    },
  );

  router.post(
    "/purchase-orders/:purchaseOrderId/share-links/revoke",
    jsonBody,
    requireMenuPermission(PURCHASE_ORDER_SEND_PERMISSION),
    async (req, res) => {
      const purchaseOrderId = purchaseOrderIdSchema.parse(
        req.params.purchaseOrderId,
      );
      const input = revokePurchaseOrderShareLinksInputSchema.parse(req.body);
      res.json({
        data: await revokePurchaseOrderShareLinksForOrder(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          purchaseOrderId,
          input,
        ),
      });
    },
  );

  return router;
}

export const publicPurchaseOrderRouter = Router();

publicPurchaseOrderRouter.use(requireTenantContext);

const publicTokenParams = z.strictObject({ token: z.string().min(1).max(200) });

publicPurchaseOrderRouter.get("/:token", async (req, res) => {
  const { token } = publicTokenParams.parse(req.params);
  const file = await getPublicPurchaseOrderPdf(
    establishScopedTenantContext(getTenantContext(req), { kind: "tenant" }),
    token,
  );
  res
    .status(200)
    .type("application/pdf")
    .setHeader("Content-Disposition", `inline; filename="${file.filename}"`)
    // A bearer link: never cached by a shared proxy, never leaked by referrer.
    .setHeader("Cache-Control", "private, no-store")
    .setHeader("Referrer-Policy", "no-referrer")
    .setHeader("X-Content-Type-Options", "nosniff")
    .send(file.pdf);
});
