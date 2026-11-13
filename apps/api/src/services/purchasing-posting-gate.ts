// Purchasing posting flag (legend-29vw): one switch for the whole chain.
// `SUPPLIER_INVOICE_POSTING_ENABLED` turns on the goods receipt journal
// (Dr inventory / Cr GRNI, auto-journal consumer) AND the supplier invoice
// payable (Dr GRNI / Cr accounts payable, posted in the invoice transaction).
// They must be live together: an invoice that clears GRNI needs a receipt that
// booked it.

import { env } from "../config/env.ts";

let postingEnabledOverride: boolean | null = null;

/** Test seam: `null` goes back to the env flag. */
export function setPurchasingPostingEnabled(enabled: boolean | null): void {
  postingEnabledOverride = enabled;
}

/** The env flag (or the test seam). The tenant accounting module is checked by the callers. */
export function purchasingPostingEnabled(): boolean {
  return postingEnabledOverride ?? env.SUPPLIER_INVOICE_POSTING_ENABLED;
}
