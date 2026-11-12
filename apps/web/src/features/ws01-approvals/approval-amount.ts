// The rupiah figure shown for an approval request. A shift close carries its
// cash difference in `payload.valueIdr` (the request's `amountIdr` stays null),
// and only the approver sees it: the requester must not learn the expected
// cash from the inbox (legend-6om3). Pure, no imports, tested directly.

export const CASH_SHIFT_CLOSE = "cash_shift_close";

export function approvalAmountIdr(
  req: {
    action: string;
    amountIdr: number | null;
    payload: Record<string, unknown>;
  },
  viewer: "approver" | "requester",
): number | null {
  if (req.action !== CASH_SHIFT_CLOSE) return req.amountIdr;
  if (viewer === "requester") return null;
  const value = req.payload.valueIdr;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
