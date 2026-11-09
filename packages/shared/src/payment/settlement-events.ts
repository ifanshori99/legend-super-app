// Settlement domain events (bead legend-9pz9 slice 4; design
// docs/design/auto-journals.md). `settlement.reconciled` (WS-05) is a gateway
// settlement matched to the bank statement, `edc_transaction.settled` (WS-00)
// is an EDC settlement batch the bank paid out. Both carry the money facts the
// auto-journal consumer posts: gross, MDR fee and the net the bank received.
// Payloads are JSON only; amounts are whole rupiah; `settledOn` is the bank
// settlement date (a business date, not an instant).
//
// No emitter exists yet (beads legend-3a5m, legend-jlqi, legend-cs7). Emitter
// contract:
// - Each bank payout has exactly one emitter and one event. EDC payouts are
//   emitted only as `edc_transaction.settled`, never as `settlement.reconciled`.
// - One event per outlet. `settlementId` / `settlementBatchId` are unique per
//   tenant: the emitter dedupes by provider + bank statement line or provider
//   reference, so a re-imported bank file never makes a new id.
// - Emit once, when the settlement is final. A replay with other amounts is
//   ignored (already_posted), so corrections are a manual journal.
// - Net must be >= 0: a day where refunds exceed the payout is booked
//   manually by finance.
// - Net goes to the entity's single `bank` mapping. A `bankAccountId` field
//   would be a v2 (breaking) change.
//
// This file must not import `./index.ts` (it is re-exported from there).

import {
  businessDateSchema,
  idrSchema,
  outletIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";

const grossIdr = idrSchema.refine((n) => n > 0, "grossIdr must be above 0");
const feeIdr = idrSchema.refine((n) => n >= 0, "feeIdr must not be negative");
const netSettledIdr = idrSchema.refine(
  (n) => n >= 0,
  "netSettledIdr must not be negative",
);

function grossIsNetPlusFee(amounts: {
  grossIdr: number;
  feeIdr: number;
  netSettledIdr: number;
}): boolean {
  return amounts.grossIdr === amounts.netSettledIdr + amounts.feeIdr;
}
const GROSS_MESSAGE = {
  message: "grossIdr must equal netSettledIdr + feeIdr",
  path: ["grossIdr"],
};

export const settlementReconciledPayloadSchema = z
  .strictObject({
    settlementId: uuidSchema,
    /** Gateway provider key (for example `doit`). */
    provider: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => !value.startsWith("edc_"),
        "EDC payouts use edc_transaction.settled",
      ),
    outletId: outletIdSchema,
    settledOn: businessDateSchema,
    grossIdr,
    feeIdr,
    netSettledIdr,
  })
  .refine(grossIsNetPlusFee, GROSS_MESSAGE);
export type SettlementReconciledPayload = z.infer<
  typeof settlementReconciledPayloadSchema
>;

export const edcTransactionSettledPayloadSchema = z
  .strictObject({
    settlementBatchId: uuidSchema,
    terminalId: uuidSchema,
    outletId: outletIdSchema,
    settledOn: businessDateSchema,
    grossIdr,
    feeIdr,
    netSettledIdr,
  })
  .refine(grossIsNetPlusFee, GROSS_MESSAGE);
export type EdcTransactionSettledPayload = z.infer<
  typeof edcTransactionSettledPayloadSchema
>;

export const settlementReconciledEvent = defineDomainEvent({
  name: "settlement.reconciled",
  payload: settlementReconciledPayloadSchema,
});

export const edcTransactionSettledEvent = defineDomainEvent({
  name: "edc_transaction.settled",
  payload: edcTransactionSettledPayloadSchema,
});
