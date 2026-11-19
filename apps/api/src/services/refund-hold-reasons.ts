// 1072 F-P3: leaf module (no imports) for refund hold reasons that raw SQL in
// other modules must match. `payment-provider-partial-refund.ts` imports
// `reservation-deposit-credit.ts`, so the reason lives here for both.

/**
 * 1055 G2 (architect AP2-2): reason of the hold filed when the provider reports
 * a refund id on one transaction that is on record for another transaction (or
 * intent): the reports disagree on whose refund it is.
 */
export const HOLD_TRANSACTION_CONFLICT_REASON =
  "Nomor refund penyedia sudah tercatat di transaksi lain (HOLD_TRANSACTION_CONFLICT)";
