// Platform payment gateway registry (sub-302 D7, D10). Super Admin switches
// gateways on or off, picks the default gateway for new tenants and sets the
// per-gateway webhook time window and secret grace period. Non-secret only:
// credentials stay sealed per tenant (`integrations.ts`).

import { dataResponseSchema, isoDateTimeSchema, z } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";

/** Gateways Legend has an adapter for. Mirrors the DB check constraint. */
export const PAYMENT_GATEWAY_PROVIDERS = ["doit", "duitku"] as const;
export const paymentGatewayProviderSchema = z.enum(PAYMENT_GATEWAY_PROVIDERS);
export type PaymentGatewayProvider = z.infer<
  typeof paymentGatewayProviderSchema
>;

export const platformGatewaySchema = z.strictObject({
  provider: paymentGatewayProviderSchema,
  displayName: z.string().min(1).max(60),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  webhookTolerancePastSec: z.number().int(),
  webhookToleranceFutureSec: z.number().int(),
  secretGraceHours: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: isoDateTimeSchema,
});
export type PlatformGateway = z.infer<typeof platformGatewaySchema>;

export const updatePlatformGatewayInputSchema = z.strictObject({
  enabled: z.boolean(),
  isDefault: z.boolean(),
  webhookTolerancePastSec: z.number().int().min(60).max(172800),
  webhookToleranceFutureSec: z.number().int().min(0).max(3600),
  secretGraceHours: z.number().int().min(1).max(720),
  reason: z.string().trim().min(1).max(500),
});
export type UpdatePlatformGatewayInput = z.infer<
  typeof updatePlatformGatewayInputSchema
>;

export const platformGatewayParamsSchema = z.strictObject({
  provider: paymentGatewayProviderSchema,
});

export const platformPaymentGatewayEndpoints = {
  listPlatformGateways: defineEndpoint({
    method: "GET",
    path: "/api/platform/payment-gateways",
    response: dataResponseSchema(z.array(platformGatewaySchema)),
  }),
  updatePlatformGateway: defineEndpoint({
    method: "PUT",
    path: "/api/platform/payment-gateways/:provider",
    params: platformGatewayParamsSchema,
    body: updatePlatformGatewayInputSchema,
    response: dataResponseSchema(platformGatewaySchema),
  }),
} as const;
