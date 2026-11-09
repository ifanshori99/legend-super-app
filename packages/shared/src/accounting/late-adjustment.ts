// Late adjustment for automatic journals: a money fact whose business date
// falls in a closed fiscal period is not rejected. It posts on the first day of
// the period after the latest closed one and keeps the original business date in
// `journal_entries.late_adjustment_from` (CTO decision, auto-journals F19).
// Pure and browser-safe; the API supplies the latest closed period of the
// legal entity.

import { businessDateSchema } from "../core/index.ts";
import { nextPeriod, periodBounds, periodOf } from "./period-key.ts";

export type AutoJournalDate = {
  /** Date the journal is booked on (YYYY-MM-DD). */
  entryDate: string;
  /** Natural business date when the entry was moved forward; null when not moved. */
  lateAdjustmentFrom: string | null;
};

/**
 * Blocked iff a period is closed and the natural date's period is not after
 * it (`period <= latestClosedPeriod`, "YYYY-MM" compares lexicographically).
 * Then the entry moves to the first day of the period after the latest closed.
 */
export function resolveAutoJournalDate(
  naturalDate: string,
  latestClosedPeriod: string | null,
): AutoJournalDate {
  businessDateSchema.parse(naturalDate);
  if (latestClosedPeriod === null || periodOf(naturalDate) > latestClosedPeriod)
    return { entryDate: naturalDate, lateAdjustmentFrom: null };
  return {
    entryDate: periodBounds(nextPeriod(latestClosedPeriod)).start,
    lateAdjustmentFrom: naturalDate,
  };
}
