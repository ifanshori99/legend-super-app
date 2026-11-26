// Pure money rules of the dearer-swap charge screen (legend-shabi). Plain
// TypeScript with no imports: Node tests load it directly. The amount is never
// computed in JSX.

/**
 * The difference a guest owes when the replacement dish costs more than the
 * unavailable one. A cheaper or equal replacement owes nothing: this never
 * returns a negative figure, so the screen can never ask for a refund here.
 */
export function chargeDiffIdr(i: {
  originalIdr: number;
  replacementIdr: number;
}): number {
  return Math.max(0, i.replacementIdr - i.originalIdr);
}

/**
 * What the till takes on top of the plain difference (service and tax on the
 * difference). The server's `amountIdr` is the figure to collect; this only
 * explains the gap to the difference and is never negative.
 */
export function chargeSurchargeIdr(i: {
  differenceIdr: number;
  amountIdr: number;
}): number {
  return Math.max(0, i.amountIdr - i.differenceIdr);
}

/**
 * How a failed collect call reads. The money may already be recorded when the
 * answer never arrived (network drop, timeout, server error) or the same
 * charge is being collected right now (409): the cashier must check the status
 * before trying again, so the charge is never recorded twice. Any other
 * refusal (permission, validation, closed charge) did not record anything.
 */
export function chargeFailureKind(status: number): "unknown" | "failed" {
  if (status === 0 || status === 408 || status === 409 || status >= 500)
    return "unknown";
  return "failed";
}

/**
 * What a failed collect does to the idempotency key. 409/422: the server
 * answered for this key and recorded nothing (the key is kept; it only frees
 * another method after the charge is read open). Auth and rate limits (401,
 * 403, 429) are refused before the server works on the request: on the key's
 * first send nothing can be recorded and the key ends (legend-f1mmf (b)); on a
 * later send an earlier one may have recorded, so it is kept. Any unknown
 * result keeps the key too. Any other refusal ends it.
 */
export function collectKeyAfter(
  status: number,
  firstSend = false,
): "refused" | "keep" | "end" {
  if (status === 409 || status === 422) return "refused";
  if (status === 401 || status === 403 || status === 429)
    return firstSend ? "end" : "keep";
  return chargeFailureKind(status) === "failed" ? "end" : "keep";
}

/**
 * The same for a card start. 503 EDC_AGENT_NOT_READY is not "nothing
 * written": the agent also answers it after the sale was written ahead. It
 * stays unknown like any 5xx; the screen reads the server first.
 */
export function edcStartKeyAfter(
  status: number,
  firstSend = false,
): "refused" | "keep" | "end" {
  return collectKeyAfter(status, firstSend);
}
