// Business-day window shared by the expo board and the pickup display
// (CTO decision 2026-11-09): an unfinished order or number stays visible past
// the business-day cutoff; a finished one leaves with the new day. The look-back
// is capped so an order nobody ever closes cannot sit on a wall forever.

/** Business days before today that an unfinished order or number may stay. */
export const EXPO_PICKUP_LOOKBACK_DAYS = 2;

/** Earliest business date (YYYY-MM-DD) still shown on `today` (YYYY-MM-DD). */
export function expoPickupFloorDate(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - EXPO_PICKUP_LOOKBACK_DAYS);
  return day.toISOString().slice(0, 10);
}
