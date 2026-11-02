// Ticket timer color for a KDS station (PRD "KDS per Stasiun": warna timer
// berdasarkan target). A ticket turns "near" at 80% of the station target and
// "late" at the target (coordinator decision, bead legend-10n review).
export const KDS_NEAR_TARGET_BP = 8_000;

export type KdsTimerStatus = "onTrack" | "near" | "late";

export function kdsTimerStatus(
  elapsedSeconds: number,
  targetSeconds: number,
): KdsTimerStatus {
  if (elapsedSeconds >= targetSeconds) return "late";
  // Integer compare: elapsed / target >= 80%  <=>  elapsed * 10^4 >= target * 8000.
  if (elapsedSeconds * 10_000 >= targetSeconds * KDS_NEAR_TARGET_BP)
    return "near";
  return "onTrack";
}

/**
 * 18:04 — the elapsed time a ticket band shows (DESIGN.md §5: 30px tabular).
 * A kitchen reads minutes and seconds, not a rounded "18 menit".
 */
export function formatElapsedSeconds(elapsedSeconds: number): string {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
