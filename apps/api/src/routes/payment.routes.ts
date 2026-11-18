// Customer payment endpoints (bead legend-gz3; PRD v1.7 §3.13 F13, D24).
//
// Paths and bodies are exactly `@starter/shared/payment`'s `defineEndpoint`
// definitions: GET /api/payments/links/:token, POST .../intents,
// GET .../intents/:intentId, POST .../intents/:intentId/refresh and
// POST .../pay-at-cashier.
//
// These routes are public by design: the guest holds a payment link token, not
// a session. The token is a random 256-bit credential resolved through
// payment_link_tokens before any tenant exists on the request (TEN-02), so the
// tenant context is minted here and nowhere else. No cookie is read or written
// and nothing is cached (`no-store`), which is why the session-origin check is
// not mounted: there is no session to protect from CSRF, and the token itself
// authorizes the call.
//
// `requireAuth` is deliberately absent: a signed-in staff member can also open
// a guest link, but the link never widens what the session may do.

import { Router } from "express";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createPaymentIntentInputSchema,
  paymentLinkTokenSchema,
} from "@starter/shared/payment";
import {
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { jsonBody } from "../middleware/body";
import { HttpError } from "../lib/http-error";
import {
  createIntent,
  getIntentView,
  getPaymentLinkView,
  refreshIntent,
  requestPayAtCashier,
  resolvePaymentLinkToken,
} from "../services/payment.service";
import { voidLiveCodesForMethodChange } from "../services/payment-va-release";

/** Resolves the guest credential and mints the outlet-scoped context. */
async function paymentLinkContext(token: string): Promise<ScopedTenantContext> {
  const parsed = paymentLinkTokenSchema.parse(token);
  const row = await resolvePaymentLinkToken(parsed);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Payment link not found.");
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(row.tenantId),
    brandId: null,
    source: "link_token",
  });
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(row.outletId)],
  });
}

export const paymentRouter = Router();

paymentRouter.get("/links/:token", async (req, res) => {
  const token = paymentLinkTokenSchema.parse(req.params.token);
  const context = await paymentLinkContext(token);
  res.json({ data: await getPaymentLinkView(context, token) });
});

paymentRouter.post("/links/:token/intents", jsonBody, async (req, res) => {
  const token = paymentLinkTokenSchema.parse(req.params.token);
  const input = createPaymentIntentInputSchema.parse(req.body);
  const context = await paymentLinkContext(token);
  // legend-9vmit: a guest who switches method or bank voids the old code.
  const intent = await createIntent(context, token, input, new Date(), {
    voidLiveCodesForChange: (scope) =>
      voidLiveCodesForMethodChange(context, scope),
  });
  res
    .status(201)
    .location(`/api/payments/links/${token}/intents/${intent.id}`)
    .json({ data: intent });
});

paymentRouter.get("/links/:token/intents/:intentId", async (req, res) => {
  const token = paymentLinkTokenSchema.parse(req.params.token);
  const intentId = uuidSchema.parse(req.params.intentId);
  const context = await paymentLinkContext(token);
  res.json({ data: await getIntentView(context, token, intentId) });
});

paymentRouter.post(
  "/links/:token/intents/:intentId/refresh",
  async (req, res) => {
    const token = paymentLinkTokenSchema.parse(req.params.token);
    const intentId = uuidSchema.parse(req.params.intentId);
    const context = await paymentLinkContext(token);
    res.json({ data: await refreshIntent(context, token, intentId) });
  },
);

paymentRouter.post("/links/:token/pay-at-cashier", async (req, res) => {
  const token = paymentLinkTokenSchema.parse(req.params.token);
  const context = await paymentLinkContext(token);
  res.json({ data: await requestPayAtCashier(context, token) });
});
