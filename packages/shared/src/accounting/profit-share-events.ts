// Profit-share domain events (WS-07 line of events/catalog.ts, bead
// legend-cq2). Payloads are JSON only; amounts are whole rupiah. The WS-07
// auto-journal rule for `distribution.completed` (posting-rules.ts) books
// `distributedIdr`, the gross amount taken from retained earnings:
// `paidNetIdr` is credited to the bank and `taxWithheldIdr` to
// `dividend_tax_payable` (Utang PPh Dividen) until it is remitted.
import { z } from "zod";
import { idrSchema, isoDateTimeSchema, userIdSchema } from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  distributionLineIdSchema,
  distributionRunIdSchema,
  fiscalPeriodIdSchema,
  journalEntryIdSchema,
  profitEntityIdSchema,
  shareholderIdSchema,
} from "./ids.ts";
import { periodKeySchema } from "./period-key.ts";
import { distributionRunTypeSchema } from "./profit-share.ts";

const countSchema = z.number().int().min(1).max(200);

/** Emitted when the owner/directors approve a run: amounts are frozen (SH-04). */
export const distributionApprovedEvent = defineDomainEvent({
  name: "distribution.approved",
  payload: z.strictObject({
    distributionRunId: distributionRunIdSchema,
    profitEntityId: profitEntityIdSchema,
    fiscalPeriodId: fiscalPeriodIdSchema,
    period: periodKeySchema,
    type: distributionRunTypeSchema,
    shareVersion: z.number().int().min(1).safe(),
    totalGrossIdr: idrSchema,
    totalTaxWithheldIdr: idrSchema,
    totalNetIdr: idrSchema,
    shareholderCount: countSchema,
    approvedBy: userIdSchema,
    approvedAt: isoDateTimeSchema,
  }),
});

/** One shareholder's payment was recorded (§4 P step 4). */
export const distributionPaidEvent = defineDomainEvent({
  name: "distribution.paid",
  payload: z.strictObject({
    distributionRunId: distributionRunIdSchema,
    distributionLineId: distributionLineIdSchema,
    profitEntityId: profitEntityIdSchema,
    shareholderId: shareholderIdSchema,
    grossIdr: idrSchema,
    taxWithheldIdr: idrSchema,
    netIdr: idrSchema,
    paymentRef: z.string().trim().min(1).max(100),
    paidAt: isoDateTimeSchema,
  }),
});

/** Every line is paid and the automatic journal is posted (§4 P step 4). */
export const distributionCompletedEvent = defineDomainEvent({
  name: "distribution.completed",
  payload: z
    .strictObject({
      distributionRunId: distributionRunIdSchema,
      profitEntityId: profitEntityIdSchema,
      fiscalPeriodId: fiscalPeriodIdSchema,
      period: periodKeySchema,
      type: distributionRunTypeSchema,
      /** Gross amount debited from retained earnings (posting-rules amount key). */
      distributedIdr: idrSchema,
      taxWithheldIdr: idrSchema,
      paidNetIdr: idrSchema,
      shareholderCount: countSchema,
      journalEntryId: journalEntryIdSchema.nullable(),
      completedAt: isoDateTimeSchema,
    })
    .refine(
      (payload) =>
        payload.distributedIdr === payload.taxWithheldIdr + payload.paidNetIdr,
      {
        path: ["distributedIdr"],
        message: "distributedIdr must equal taxWithheldIdr + paidNetIdr",
      },
    ),
});

export const PROFIT_SHARE_EVENTS = {
  "distribution.approved": distributionApprovedEvent,
  "distribution.paid": distributionPaidEvent,
  "distribution.completed": distributionCompletedEvent,
} as const;
export type ProfitShareEventName = keyof typeof PROFIT_SHARE_EVENTS;
