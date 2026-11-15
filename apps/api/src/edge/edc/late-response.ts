// How long a terminal may still answer a sale the agent already gave up on
// (legend-ftsq0). The agent's sale timeout defaults to 120 s; after that the
// sale row is `unknown`, but the terminal can still finish the charge on its
// own, and an agent restart loses the in-memory wire state that tracked it.
// The window below covers both. Until it passes, an `unknown` sale must not be
// resolved by hand: the late answer could still charge the customer.
// One place on purpose, so the rule is easy to change.
export const EDC_LATE_RESPONSE_WINDOW_MS = 10 * 60_000;

/** True while a terminal can still send a response for this sale. A row that
 * was never dispatched has nothing on the wire. */
export function lateResponsePossible(
  row: { dispatchedAt: Date | null },
  now: Date,
): boolean {
  if (row.dispatchedAt === null) return false;
  return (
    now.getTime() - row.dispatchedAt.getTime() < EDC_LATE_RESPONSE_WINDOW_MS
  );
}
