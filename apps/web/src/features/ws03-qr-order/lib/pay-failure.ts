// Which failed "start payment" shows the C2b screen "halaman belum bisa
// dibuka" (nothing was paid, retry or pick another method): only when no
// answer came back (network) or the gateway itself is down (5xx). A refusal
// (409 order changed, 422 method turned off, ...) gets the ordinary failure
// notice instead. Duck-typed on `status` so the unit tests load it directly.
export function gatewayUnreachable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status === 0 || status >= 500;
}

/**
 * 1272 P2-2: the server refused the code because the total the guest saw is no
 * longer the price (rate or bill changed): the guest sees the new price and
 * confirms again; the gateway is never opened on the old one.
 */
export function feeChanged(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "FEE_CHANGED";
}
