// A payment request whose answer never reached the till (1268 W2 review). The
// cashier who sent it repeats it; when that cannot happen (they left, the stored
// request is unreadable, the gateway keeps answering 503) a supervisor settles
// the request here with a PIN and a reason. Never a payment: the API either
// finds what the request recorded or makes sure it can never be recorded.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  outletIdSchema,
  userIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { staffPinInputSchema } from "../identity/inputs.ts";
import { orderIdSchema, posOrderDetailSchema } from "./schemas.ts";

/** The kind of payment is part of the key the till makes: `<kind>:<uuid>`. */
export const posPaymentIntentKeySchema = z
  .string()
  .max(100)
  .regex(
    /^(cash|qris|edc_standalone|points):[A-Za-z0-9._-]{8,64}$/,
    "Kunci permintaan pembayaran tidak valid.",
  );

/**
 * What the supervisor states about a hand-keyed EDC payment that was not
 * recorded: the card was not charged, or the till records the payment now.
 */
export const posPaymentIntentCardSchema = z.enum(["not_debited", "recording"]);

/**
 * - `recorded`: the request was recorded; read the bill.
 * - `closed`: it was not, and a late arrival of the same key is refused.
 * - `fenced`: no key is known; the order `version` moved, so a late arrival is
 *   refused as stale.
 */
export const posPaymentIntentOutcomeSchema = z.enum([
  "recorded",
  "closed",
  "fenced",
]);
export type PosPaymentIntentOutcome = z.infer<
  typeof posPaymentIntentOutcomeSchema
>;

/** An unrecorded EDC (or unknown) request without the supervisor's statement. */
export const PAYMENT_INTENT_CARD_STATEMENT_REQUIRED =
  "PAYMENT_INTENT_CARD_STATEMENT_REQUIRED" as const;

export const resolvePosPaymentIntent = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/payment-intents/resolve",
  params: z.strictObject({ outletId: outletIdSchema, orderId: orderIdSchema }),
  body: clientInputSchema({
    /** null: the till cannot read the stored request. */
    key: posPaymentIntentKeySchema.nullable(),
    card: posPaymentIntentCardSchema.optional(),
    reason: z.string().trim().min(3).max(500),
    approverUserId: userIdSchema,
    pin: staffPinInputSchema,
  }),
  response: dataResponseSchema(
    z.strictObject({
      outcome: posPaymentIntentOutcomeSchema,
      order: posOrderDetailSchema,
    }),
  ),
});
