// Promo engine and voucher routes (PRD v1.7 §3.21; bead legend-7x4g). Paths,
// params, bodies and queries come from the WS-08 contract
// (`@starter/shared/crm` defineEndpoint objects), so the API and the web client
// cannot drift.
//
// Tenant comes from the server-minted context, never the request (TEN-02).
// Administration (rules, stacking policy, vouchers, ROI) needs tenant-wide
// `promo.manage`. The two checkout previews need `order.create` on the outlet
// named by the `outletId` query parameter (TEN-03): the contract body carries
// no outlet, and a preview needs the outlet's price list and time zone. The
// services re-check every permission inside the tenant transaction.
//
// The POS, QR order and website checkouts do not call these routes to post an
// order: they call `redeemPromotions` / `releasePromotions`
// (services/crm-promo-engine.ts) inside their own order transaction.

import { Router, type Request } from "express";
import {
  createPromotionInputSchema,
  evaluatePromotions as evaluatePromotionsEndpoint,
  getPromotionRoi as getPromotionRoiEndpoint,
  issueVoucher as issueVoucherEndpoint,
  listPromotionOutlets as listPromotionOutletsEndpoint,
  listPromotions as listPromotionsEndpoint,
  listVouchers as listVouchersEndpoint,
  setPromotionOutlet as setPromotionOutletEndpoint,
  updatePromoStackingPolicy as updatePromoStackingPolicyEndpoint,
  updatePromotion as updatePromotionEndpoint,
  validateVoucher as validateVoucherEndpoint,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as promo from "../services/crm-promo.service";
import * as promoOutlets from "../services/crm-promo-outlets.service";

const manage = requireTenantPermission("promo.manage");
const outletOf = (req: Request) => String(req.query.outletId ?? "");
const checkout = requireOutletPermission("order.create", outletOf);

// ------------------------------------------------------------ promotions

export const promotionsRouter = Router();
promotionsRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

promotionsRouter.get("/", manage, async (req, res) => {
  const query = listPromotionsEndpoint.query.parse(req.query);
  res.json(
    await promo.listPromotions(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

promotionsRouter.post("/", manage, jsonBody, async (req, res) => {
  const input = createPromotionInputSchema.parse(req.body);
  const promotion = await promo.createPromotion(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/promotions/${promotion.id}`)
    .json({ data: promotion });
});

// Fixed paths before /:promotionId.
promotionsRouter.get("/stacking-policy", manage, async (req, res) => {
  res.json({
    data: await promo.getStackingPolicy(
      getScopedTenantContext(req),
      getAuth(req).user.id,
    ),
  });
});

promotionsRouter.put("/stacking-policy", manage, jsonBody, async (req, res) => {
  const input = updatePromoStackingPolicyEndpoint.body.parse(req.body);
  res.json({
    data: await promo.updateStackingPolicy(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

promotionsRouter.post("/evaluate", jsonBody, checkout, async (req, res) => {
  const input = evaluatePromotionsEndpoint.body.parse(req.body);
  res.json({
    data: await promo.evaluateCheckoutPromotions(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      outletOf(req),
      input,
    ),
  });
});

promotionsRouter.patch("/:promotionId", manage, jsonBody, async (req, res) => {
  const { promotionId } = updatePromotionEndpoint.params.parse(req.params);
  const input = updatePromotionEndpoint.body.parse(req.body);
  res.json({
    data: await promo.updatePromotion(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      promotionId,
      input,
    ),
  });
});

promotionsRouter.get("/:promotionId/roi", manage, async (req, res) => {
  const { promotionId } = getPromotionRoiEndpoint.params.parse(req.params);
  res.json({
    data: await promo.getPromotionRoi(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      promotionId,
    ),
  });
});

// Per-outlet switch (legend-e5it): list = tenant-wide promo.manage; set =
// promo.manage on the outlet in the path (TEN-03).
promotionsRouter.get("/:promotionId/outlets", manage, async (req, res) => {
  const { promotionId } = listPromotionOutletsEndpoint.params.parse(req.params);
  res.json({
    data: await promoOutlets.listPromotionOutlets(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      promotionId,
    ),
  });
});

promotionsRouter.put(
  "/:promotionId/outlets/:outletId",
  requireOutletPermission("promo.manage", (req) =>
    String(req.params.outletId ?? ""),
  ),
  jsonBody,
  async (req, res) => {
    const { promotionId, outletId } = setPromotionOutletEndpoint.params.parse(
      req.params,
    );
    const input = setPromotionOutletEndpoint.body.parse(req.body);
    res.json({
      data: await promoOutlets.setPromotionOutlet(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        promotionId,
        outletId,
        input,
      ),
    });
  },
);

// --------------------------------------------------------------- vouchers

export const vouchersRouter = Router();
vouchersRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

vouchersRouter.post("/validate", jsonBody, checkout, async (req, res) => {
  const input = validateVoucherEndpoint.body.parse(req.body);
  res.json({
    data: await promo.validateVoucherCode(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      outletOf(req),
      input,
    ),
  });
});

vouchersRouter.get("/", manage, async (req, res) => {
  const query = listVouchersEndpoint.query.parse(req.query);
  res.json(
    await promo.listVouchers(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

vouchersRouter.post("/", manage, jsonBody, async (req, res) => {
  const input = issueVoucherEndpoint.body.parse(req.body);
  const issued = await promo.issueVoucher(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/vouchers/${issued.voucher.id}`)
    .json({ data: issued });
});
