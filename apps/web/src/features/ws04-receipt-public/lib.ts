// Pure helpers for the public e-receipt page (no imports from React or the app,
// so they load in Node tests).

const DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});
const TIME = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
});

/** "11 November 2026, 14.32" in the outlet's time (WIB). */
export function formatIssuedAt(iso: string): string {
  const date = new Date(iso);
  return `${DATE.format(date)}, ${TIME.format(date).replace(":", ".")}`;
}

/** The error a missing, expired or unknown token produces (API: one 404). */
export function isInvalidLink(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    ((error as { status: unknown }).status === 404 ||
      (error as { status: unknown }).status === 410)
  );
}

/** Sum of what the customer paid, from the tenders (matches the total, POS-07). */
export function paidIdr(tenders: readonly { amountIdr: number }[]): number {
  return tenders.reduce((sum, tender) => sum + tender.amountIdr, 0);
}
