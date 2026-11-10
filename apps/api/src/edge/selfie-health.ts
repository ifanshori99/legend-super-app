// In-memory health of the local selfie path, shown on GET /api/edge/health
// (`selfie`). Informational only: it never changes the health status. It holds
// timestamps and a count, no ids and no personal data. A restart clears it.
export interface EdgeSelfieHealth {
  /** Set while the local upload answers 507 EDGE_SELFIE_STORAGE_FULL. */
  storageFull: { since: string; lastAt: string } | null;
  /** Uploads the cloud rejected since this process started. */
  rejected: number;
}

let storageFull: { since: string; lastAt: string } | null = null;
let rejected = 0;

/** True when this starts a new episode (the caller logs once per episode). */
export function recordSelfieStorageFull(now: Date): boolean {
  const at = now.toISOString();
  if (storageFull) {
    storageFull = { since: storageFull.since, lastAt: at };
    return false;
  }
  storageFull = { since: at, lastAt: at };
  return true;
}

/** A selfie reached the disk: the full-disk episode is over. */
export function recordSelfieStored(): void {
  storageFull = null;
}

export function recordUploaderRejection(): void {
  rejected += 1;
}

export function getEdgeSelfieHealth(): EdgeSelfieHealth {
  return { storageFull: storageFull ? { ...storageFull } : null, rejected };
}

/** Tests only. */
export function resetEdgeSelfieHealth(): void {
  storageFull = null;
  rejected = 0;
}
