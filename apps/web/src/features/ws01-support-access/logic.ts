// Pure rules for the support-access screens (PRD v1.7 §3 F4 "Support
// Access", TEN-04). No framework or runtime imports so the root contract test
// can load it with plain Node ESM. The authoritative status rule lives in
// @starter/shared/platform (`supportAccessStatus`); these helpers only shape
// time for display and ordering.

/** Under this much time left the banner turns to the warning tone. */
export const WARNING_BEFORE_EXPIRY_MS = 5 * 60_000;

type TimedGrant = {
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
};

/** Milliseconds until the session expires, never below zero. */
export function remainingMs(expiresAt: string, nowMs: number): number {
  return Math.max(0, Date.parse(expiresAt) - nowMs);
}

/** "59:07" under one hour, "1:59:07" otherwise. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function isExpiringSoon(expiresAt: string, nowMs: number): boolean {
  return remainingMs(expiresAt, nowMs) <= WARNING_BEFORE_EXPIRY_MS;
}

/** Same reading as the contract: running, not ended, not past expiry. */
export function isGrantActive(grant: TimedGrant, nowMs: number): boolean {
  if (grant.endedAt !== null && Date.parse(grant.endedAt) <= nowMs)
    return false;
  return (
    nowMs >= Date.parse(grant.startedAt) && nowMs < Date.parse(grant.expiresAt)
  );
}

/** Newest session first. */
export function sortGrantsNewestFirst<T extends { startedAt: string }>(
  grants: readonly T[],
): T[] {
  return [...grants].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

export function findActiveGrant<T extends TimedGrant>(
  grants: readonly T[],
  nowMs: number,
): T | null {
  return (
    sortGrantsNewestFirst(grants).find((grant) =>
      isGrantActive(grant, nowMs),
    ) ?? null
  );
}

/** Keeps only digits and caps at six, for the authenticator field. */
export function sanitizeMfaCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

/** Mirrors the contract's reason bounds (support-access.ts `reasonSchema`);
 * the schema stays the authority, these only drive the character counter. */
export const REASON_MIN_LENGTH = 20;
export const REASON_MAX_LENGTH = 500;
