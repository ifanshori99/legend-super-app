/**
 * The ticket sale is wired to the real endpoints (sale, tickets of a bill,
 * credential and print), so the screen is never locked. Kept in its own light
 * file so the nav entry can read it without loading the mock engine.
 */
export const TICKET_SALE_CONNECTED = true;
