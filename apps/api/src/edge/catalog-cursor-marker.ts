// Marker the cloud puts on a refused catalog cursor (bead legend-75kly). The
// edge resets its stored cursor only when it sees this marker (or the cursor
// error itself), so an unrelated HTTP 400 never wipes a checkpoint. Header
// only: the page schemas and frames older edges read are unchanged.

/** Response header carrying the edge-facing error reason. */
export const EDGE_ERROR_HEADER = "X-Edge-Error";

/** `X-Edge-Error` value for a refused catalog sync cursor (status stays 400). */
export const CATALOG_CURSOR_REJECTED_MARKER = "CATALOG_CURSOR_REJECTED";
