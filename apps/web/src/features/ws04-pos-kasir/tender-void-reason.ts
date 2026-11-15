// Why the server voided a QRIS tender and refunded the money (event
// `order.tender_voided`, payload `reason`). Maps the reason to the cashier text
// that asks the guest to pay again. An unknown or missing reason gets the
// generic text, never a made-up cause.
export const TENDER_VOID_REASONS = [
  "bill_below_tender",
  "business_day_closed",
  "refund_reserved",
  "edc_request_open",
] as const;

export type TenderVoidReason = (typeof TENDER_VOID_REASONS)[number];

export function tenderVoidMessageKey(reason: string | null | undefined) {
  const known = TENDER_VOID_REASONS.find((r) => r === reason);
  return `posKasirGateway.tenderVoided.${known ?? "unknown"}`;
}
