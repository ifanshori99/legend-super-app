// Profit-share recipient reconciliation contract (bead legend-9t04v, Codex
// finding 405). Distribution lines from before the recipient snapshot exist
// have no trusted recipient login: those whose shareholder has a login today
// are flagged `recipient_unverified` and are visible to no shareholder login
// until a tenant Owner assigns the recipient (or marks "no login") here.
// The tenant comes from the session (TEN-02); schemas are strict.
import {
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  distributionLineIdSchema,
  distributionRunIdSchema,
  profitEntityIdSchema,
  shareholderIdSchema,
} from "./ids.ts";
import { distributionLinePaymentStatusSchema } from "./profit-share.ts";

const BASE = "/api/tenant/profit-share/recipient-reconciliation";

/** One distribution line that still has no verified recipient. */
export const unverifiedRecipientLineSchema = z.strictObject({
  lineId: distributionLineIdSchema,
  runId: distributionRunIdSchema,
  profitEntityId: profitEntityIdSchema,
  shareholderId: shareholderIdSchema,
  shareholderName: z.string(),
  netIdr: idrSchema,
  paymentStatus: distributionLinePaymentStatusSchema,
  paidAt: isoDateTimeSchema.nullable(),
});
export type UnverifiedRecipientLine = z.infer<
  typeof unverifiedRecipientLineSchema
>;

/**
 * Owner decision for one line. `recipientUserId` is the login that may read
 * the statement; `null` means nobody (no login / write off).
 */
export const resolveUnverifiedRecipientInputSchema = z.strictObject({
  recipientUserId: userIdSchema.nullable(),
  note: z.string().trim().min(1).max(500),
});
export type ResolveUnverifiedRecipientInput = z.infer<
  typeof resolveUnverifiedRecipientInputSchema
>;

export const resolveUnverifiedRecipientResultSchema = z.strictObject({
  lineId: distributionLineIdSchema,
  recipientUserId: userIdSchema.nullable(),
});
export type ResolveUnverifiedRecipientResult = z.infer<
  typeof resolveUnverifiedRecipientResultSchema
>;

/** Owner only: lines awaiting a recipient decision. */
export const listUnverifiedRecipientLines = defineEndpoint({
  method: "GET",
  path: BASE,
  response: dataResponseSchema(z.array(unverifiedRecipientLineSchema)),
});

/** Owner only: set the recipient of one flagged line (once). */
export const resolveUnverifiedRecipient = defineEndpoint({
  method: "POST",
  path: `${BASE}/:lineId/resolve`,
  params: z.strictObject({ lineId: distributionLineIdSchema }),
  body: resolveUnverifiedRecipientInputSchema,
  response: dataResponseSchema(resolveUnverifiedRecipientResultSchema),
});
