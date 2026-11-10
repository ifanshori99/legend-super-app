/**
 * Fallback outlet time zone for transfer times and business dates (D-CORE-6).
 * Screens read the real zone and the owner Q39 cutoff from `useOutletClock()`
 * (lib/tenant-context.tsx); this constant stays the documented default for
 * callers without an outlet, such as the mock handlers.
 */
export const INVENTORY_TIME_ZONE = "Asia/Jakarta";
