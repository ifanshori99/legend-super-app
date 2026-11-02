// Member-facing formatting. Dates use the outlet's business time zone and one
// fixed locale, so the server render and the browser render never disagree
// (PRD: business dates in the outlet time zone). Amounts go through <Money> /
// formatRupiah from @starter/shared/i18n.

export const OUTLET_TIME_ZONE = "Asia/Jakarta";

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: OUTLET_TIME_ZONE,
});

/** "2026-10-30T12:40:00.000Z" → "30 Okt 2026". */
export function formatMemberDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** Basis points → whole percent, rounded down so progress never overstates. */
export function percentFromBp(basisPoints: number): number {
  return Math.floor(basisPoints / 100);
}

/** Tier multiplier in basis points (15.000) → "1,5". */
export function formatMultiplier(basisPoints: number): string {
  return new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
}
