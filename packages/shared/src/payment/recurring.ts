// Back-office contracts for DOIT recurring billing (bead legend-6c6; PRD
// "Tagihan Berulang"): plans, subscriptions and their invoices. The tenant
// always comes from the trusted session context and the plan price is server
// truth. A subscription turns active only from a verified `invoice.paid`
// webhook, never from a call on these routes. Provider ids stay server-side.

import {
  z,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";

const RECURRING = "/api/payments/recurring";

export const recurringIntervalSchema = z.enum(["month", "week"]);
export type RecurringInterval = z.infer<typeof recurringIntervalSchema>;

export const recurringPlanStatusSchema = z.enum(["active", "archived"]);
export const recurringSubscriptionStatusSchema = z.enum([
  "pending_first_payment",
  "active",
  "past_due",
  "paused",
  "cancelled",
  // Start stored before the gateway call, or an outcome at the gateway that
  // could not be confirmed. Never has access; a person or a retry resolves it.
  "provisioning",
  "needs_reconcile",
]);
export const subscriptionInvoiceStatusSchema = z.enum([
  "open",
  "paid",
  "void",
  "expired",
  "needs_review",
]);

export const recurringPlanSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  name: z.string().min(1).max(120),
  amountIdr: idrSchema.refine((n) => n > 0),
  interval: recurringIntervalSchema,
  status: recurringPlanStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RecurringPlan = z.infer<typeof recurringPlanSchema>;

export const recurringSubscriptionSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  planId: uuidSchema,
  customerProfileId: uuidSchema,
  status: recurringSubscriptionStatusSchema,
  currentPeriodStart: businessDateSchema.nullable(),
  currentPeriodEnd: businessDateSchema.nullable(),
  /** A paid period that has not started yet; it becomes current on its start. */
  nextPeriodStart: businessDateSchema.nullable(),
  nextPeriodEnd: businessDateSchema.nullable(),
  /** Error code of an unconfirmed outcome (status `needs_reconcile`). */
  reconcileReason: z.string().max(100).nullable(),
  activatedAt: isoDateTimeSchema.nullable(),
  pausedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RecurringSubscription = z.infer<typeof recurringSubscriptionSchema>;

/** `subscription_invoices` row. `needs_review` means money or a mismatch a
 * person must look at; it never grants access. */
export const subscriptionInvoiceSchema = z.strictObject({
  id: uuidSchema,
  subscriptionId: uuidSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  amountIdr: idrSchema.refine((n) => n > 0),
  hostedUrl: z.string().max(512),
  status: subscriptionInvoiceStatusSchema,
  paidAt: isoDateTimeSchema.nullable(),
  notifiedAt: isoDateTimeSchema.nullable(),
  reviewReason: z.string().max(64).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SubscriptionInvoiceDto = z.infer<typeof subscriptionInvoiceSchema>;

/** Whole rupiah above zero; no tenant, provider or status from the client. */
export const createRecurringPlanInputSchema = z.strictObject({
  outletId: outletIdSchema,
  name: z.string().trim().min(1).max(120),
  amountIdr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  interval: recurringIntervalSchema,
});
export type CreateRecurringPlanInput = z.infer<
  typeof createRecurringPlanInputSchema
>;

export const listRecurringPlansQuerySchema = z.strictObject({
  outletId: outletIdSchema.optional(),
  status: recurringPlanStatusSchema.optional(),
});

export const startRecurringSubscriptionInputSchema = z.strictObject({
  planId: uuidSchema,
  customerProfileId: uuidSchema,
});
export type StartRecurringSubscriptionInput = z.infer<
  typeof startRecurringSubscriptionInputSchema
>;

export const recurringSubscriptionStartedSchema = z.strictObject({
  subscription: recurringSubscriptionSchema,
  firstInvoiceUrl: z.string().max(512).nullable(),
});

const subscriptionParams = z.strictObject({ subscriptionId: uuidSchema });

export const listRecurringPlans = defineEndpoint({
  method: "GET",
  path: `${RECURRING}/plans`,
  query: listRecurringPlansQuerySchema,
  response: dataResponseSchema(z.array(recurringPlanSchema)),
});
export const createRecurringPlan = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/plans`,
  body: createRecurringPlanInputSchema,
  response: dataResponseSchema(recurringPlanSchema),
});
export const startRecurringSubscription = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions`,
  body: startRecurringSubscriptionInputSchema,
  response: dataResponseSchema(recurringSubscriptionStartedSchema),
});
export const getRecurringSubscription = defineEndpoint({
  method: "GET",
  path: `${RECURRING}/subscriptions/:subscriptionId`,
  params: subscriptionParams,
  response: dataResponseSchema(recurringSubscriptionSchema),
});
export const listSubscriptionInvoices = defineEndpoint({
  method: "GET",
  path: `${RECURRING}/subscriptions/:subscriptionId/invoices`,
  params: subscriptionParams,
  response: dataResponseSchema(z.array(subscriptionInvoiceSchema)),
});
export const pauseRecurringSubscription = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions/:subscriptionId/pause`,
  params: subscriptionParams,
  response: dataResponseSchema(recurringSubscriptionSchema),
});
export const resumeRecurringSubscription = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions/:subscriptionId/resume`,
  params: subscriptionParams,
  response: dataResponseSchema(recurringSubscriptionSchema),
});
export const cancelRecurringSubscription = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions/:subscriptionId/cancel`,
  params: subscriptionParams,
  response: dataResponseSchema(recurringSubscriptionSchema),
});
/** Reconcile tools (legend-yqne1, legend-lch2o): the row follows what DOIT says,
 * never to `active` (only a verified invoice.paid webhook activates).
 * `resolved` is false when the row stayed `needs_reconcile`. */
export const recurringReconcileResultSchema = z.strictObject({
  subscription: recurringSubscriptionSchema,
  resolved: z.boolean(),
});
export const resolveRecurringSubscription = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions/:subscriptionId/resolve`,
  params: subscriptionParams,
  body: z.strictObject({}),
  response: dataResponseSchema(recurringReconcileResultSchema),
});
export const reconcileRecurringStartIntent = defineEndpoint({
  method: "POST",
  path: `${RECURRING}/subscriptions/:subscriptionId/reconcile-intent`,
  params: subscriptionParams,
  body: z.strictObject({}),
  response: dataResponseSchema(recurringReconcileResultSchema),
});

/** Days after the end of the paid period a customer keeps using the
 * subscription quota while the next invoice is unpaid (per outlet, default 3,
 * 0 = access stops at the end of the paid period). Grace days count toward
 * the next period, never toward an extra one. */
export const RECURRING_GRACE_DAYS_MIN = 0;
export const RECURRING_GRACE_DAYS_MAX = 30;
export const recurringGraceDaysSchema = z
  .number()
  .int()
  .min(RECURRING_GRACE_DAYS_MIN)
  .max(RECURRING_GRACE_DAYS_MAX);

export const recurringGraceSettingSchema = z.strictObject({
  graceDays: recurringGraceDaysSchema,
});
export type RecurringGraceSetting = z.infer<typeof recurringGraceSettingSchema>;

export const updateRecurringGraceInputSchema = z.strictObject({
  graceDays: recurringGraceDaysSchema,
});
export type UpdateRecurringGraceInput = z.infer<
  typeof updateRecurringGraceInputSchema
>;

const outletGraceParams = z.strictObject({ outletId: outletIdSchema });

export const getRecurringOutletGrace = defineEndpoint({
  method: "GET",
  path: `${RECURRING}/outlets/:outletId/grace`,
  params: outletGraceParams,
  response: dataResponseSchema(recurringGraceSettingSchema),
});
export const updateRecurringOutletGrace = defineEndpoint({
  method: "PUT",
  path: `${RECURRING}/outlets/:outletId/grace`,
  params: outletGraceParams,
  body: updateRecurringGraceInputSchema,
  response: dataResponseSchema(recurringGraceSettingSchema),
});
