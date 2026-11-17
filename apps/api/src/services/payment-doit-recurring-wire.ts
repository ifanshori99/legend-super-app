// DOIT recurring billing wire format (bead 6c6; PRD recurring billing).
//
// ASSUMED contract, verify in legend-s5c. No DOIT recurring documentation is
// in this repo, so every shape below is an assumption and lives only in this
// file: sandbox certification edits this one file.
//   - Events   { id, type, created_at, data: { invoice } }, type is
//              `invoice.created` or `invoice.paid` (same envelope as
//              `doitWebhookEnvelopeSchema`).
//   - invoice  { id, subscription_id, plan_id, amount (whole IDR), currency
//              "IDR", period_start, period_end (ISO dates), hosted_url
//              (https), status open|paid|void|expired, paid_at? }
//   - HTTP     POST /v1/recurring/plans
//              POST /v1/recurring/subscriptions
//              POST /v1/recurring/subscriptions/{id}/pause|resume|cancel
//              GET  /v1/recurring/subscriptions/{id}
//              GET  /v1/recurring/subscriptions?reference={uuid}
//                   -> { data: subscription[] } (empty = DOIT has none)
//
// Only what moves money is strict (ids, amount, currency, status, period).
// Unknown extra fields are dropped, never echoed. Nothing here logs or throws
// a response body, header or secret.

import { isoDateTimeSchema } from "@starter/shared/core";
import { z } from "zod";
import { doitWebhookEnvelopeSchema } from "./payment-doit-wire";

/** Webhook event types of recurring billing. Anything else is not ours. */
export const DOIT_RECURRING_EVENT_TYPES = [
  "invoice.created",
  "invoice.paid",
] as const;
export type DoitRecurringEventType =
  (typeof DOIT_RECURRING_EVENT_TYPES)[number];

export function isDoitRecurringEvent(
  type: string,
): type is DoitRecurringEventType {
  return (DOIT_RECURRING_EVENT_TYPES as readonly string[]).includes(type);
}

/** Billing intervals a plan can have. */
export const DOIT_RECURRING_INTERVALS = ["month", "week"] as const;
export type DoitRecurringInterval = (typeof DOIT_RECURRING_INTERVALS)[number];

const idSchema = z.string().min(1).max(100);
/** Whole rupiah above zero: a zero or fractional invoice never parses. */
const positiveAmountSchema = z.number().int().positive();
/** Calendar date `YYYY-MM-DD` that really exists (no 2026-02-31). */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    );
  }, "Not a calendar date");
const httpsUrlSchema = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Not an https URL");

/** Invoice statuses of the assumed contract. */
export const doitInvoiceStatusSchema = z.enum([
  "open",
  "paid",
  "void",
  "expired",
]);
export type DoitInvoiceStatus = z.infer<typeof doitInvoiceStatusSchema>;

export const doitInvoiceSchema = z.object({
  id: idSchema,
  subscription_id: idSchema,
  plan_id: idSchema,
  amount: positiveAmountSchema,
  currency: z.literal("IDR"),
  period_start: isoDateSchema,
  period_end: isoDateSchema,
  hosted_url: httpsUrlSchema,
  status: doitInvoiceStatusSchema,
  // Needs an explicit offset (same rule as the payment `paid_at`): a bad or
  // zoneless value becomes null instead of failing a settled invoice.
  paid_at: isoDateTimeSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
});
export type DoitInvoice = z.infer<typeof doitInvoiceSchema>;

/** Webhook body of an invoice event: the envelope around `{ invoice }`. */
export const doitInvoiceEventSchema = doitWebhookEnvelopeSchema.extend({
  type: z.enum(DOIT_RECURRING_EVENT_TYPES),
  data: z.object({ invoice: doitInvoiceSchema }),
});
export type DoitInvoiceEvent = z.infer<typeof doitInvoiceEventSchema>;

/** The invoice event in `body`, or null when it is not a well-formed
 * `invoice.created` / `invoice.paid` (the caller stores and ignores it).
 * A period that does not end after it starts is malformed too. Paths and values of a
 * bad body are never reported. */
export function parseDoitInvoiceEvent(body: unknown): DoitInvoiceEvent | null {
  const parsed = doitInvoiceEventSchema.safeParse(body);
  if (!parsed.success) return null;
  const { invoice } = parsed.data.data;
  if (invoice.period_end <= invoice.period_start) return null;
  return parsed.data;
}

// -- HTTP answers -----------------------------------------------------------

export const doitRecurringPlanSchema = z.object({
  id: idSchema,
  amount: positiveAmountSchema,
  interval: z.enum(DOIT_RECURRING_INTERVALS),
});
export type DoitRecurringPlan = z.infer<typeof doitRecurringPlanSchema>;

export const doitRecurringSubscriptionSchema = z.object({
  id: idSchema,
  plan_id: idSchema,
  status: z.string().min(1).max(32),
  // Echo of the `reference` sent at creation (Legend's subscription id), null
  // when DOIT does not return it (ASSUMED). The reconcile tool binds a lookup
  // result to a local row only when it equals the row id.
  reference: idSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  // Link of the first invoice when DOIT already knows it, else null.
  first_invoice_url: httpsUrlSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
});
export type DoitRecurringSubscription = z.infer<
  typeof doitRecurringSubscriptionSchema
>;

/** Answer of the lookup by `reference` (ASSUMED). One malformed entry fails the
 * whole answer: a partial list could hide a second subscription. */
export const doitRecurringSubscriptionListSchema = z.object({
  data: z.array(doitRecurringSubscriptionSchema).max(100),
});
export type DoitRecurringSubscriptionList = z.infer<
  typeof doitRecurringSubscriptionListSchema
>;

/** Statuses DOIT reports after a pause / resume / cancel call (ASSUMED, like
 * the rest of this file; `canceled` is accepted next to `cancelled`). */
export const DOIT_SUBSCRIPTION_STATUS_AFTER = {
  pause: ["paused"],
  resume: ["active"],
  cancel: ["cancelled", "canceled"],
} as const satisfies Record<"pause" | "resume" | "cancel", readonly string[]>;

/** True only when the answer is about this very subscription and carries the
 * status the action should have produced. Anything else is unconfirmed. */
export function doitSubscriptionActionConfirmed(
  action: keyof typeof DOIT_SUBSCRIPTION_STATUS_AFTER,
  answer: DoitRecurringSubscription,
  providerSubscriptionId: string,
): boolean {
  const expected: readonly string[] = DOIT_SUBSCRIPTION_STATUS_AFTER[action];
  return (
    answer.id === providerSubscriptionId &&
    expected.includes(answer.status.trim().toLowerCase())
  );
}

// -- HTTP requests ----------------------------------------------------------

export type DoitCreatePlanInput = {
  name: string;
  amountIdr: number;
  interval: DoitRecurringInterval;
};

export function doitCreatePlanBody(input: DoitCreatePlanInput) {
  return {
    name: input.name,
    amount: input.amountIdr,
    currency: "IDR",
    interval: input.interval,
  };
}

export type DoitCreateSubscriptionInput = {
  /** DOIT's plan id (`provider_plan_id`). */
  providerPlanId: string;
  /** Legend's own subscription id, echoed by DOIT for reconciliation. */
  reference: string;
};

export function doitCreateSubscriptionBody(input: DoitCreateSubscriptionInput) {
  return { plan_id: input.providerPlanId, reference: input.reference };
}
