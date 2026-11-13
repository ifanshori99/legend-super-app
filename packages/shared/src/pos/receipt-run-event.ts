// Edge -> cloud report of one offline device receipt run (bead legend-zy43).
// `receipt_run.reported` carries the device's receipt sequence head and every
// receipt of the run, each with the outlet header as it was at issue time. The
// cloud applier (api edge/receipt-run-applier.ts) merges it with
// mergeDeviceReceiptRun: idempotent, and a hole in the run is refused so the
// device resends the full range. Edge -> cloud only; kept out of
// `posEventNames` (which lists the WS-04 events every consumer reads).
import {
  z,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { receiptPrefixSchema, RECEIPT_MAX_ORDINAL } from "./receipts.ts";
import { posReceiptSchema } from "./schemas.ts";

/** Receipts one run event may carry (bounds the apply transaction). */
export const RECEIPT_RUN_EVENT_MAX_RECEIPTS = 1000;

export const receiptRunOutletSnapshotSchema = z.strictObject({
  outletName: z.string().min(1).max(200),
  outletAddress: z.string().max(500),
  legalName: z.string().nullable(),
  npwpLast4: z.string().nullable(),
});

export const receiptRunReportedPayloadSchema = z.strictObject({
  sequence: z.strictObject({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    deviceId: uuidSchema,
    prefix: receiptPrefixSchema,
    lastNumber: z.number().int().min(0).max(RECEIPT_MAX_ORDINAL),
  }),
  receipts: z
    .array(
      z.strictObject({
        receipt: posReceiptSchema,
        outletSnapshot: receiptRunOutletSnapshotSchema,
      }),
    )
    .max(RECEIPT_RUN_EVENT_MAX_RECEIPTS),
});
export type ReceiptRunReportedPayload = z.infer<
  typeof receiptRunReportedPayloadSchema
>;

export const RECEIPT_RUN_AGGREGATE = "receipt_run";
export const RECEIPT_RUN_REPORTED_EVENT = "receipt_run.reported";

/** Aggregate id of the event is the device id (one run stream per device). */
export const receiptRunReportedEvent = defineDomainEvent({
  name: RECEIPT_RUN_REPORTED_EVENT,
  payload: receiptRunReportedPayloadSchema,
});
