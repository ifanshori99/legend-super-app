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
