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

/** Offset to add to the device clock so it reads like the API clock.
 * `serverNow` is the API time at read, `fetchedAtMs` the device time when the
 * page arrived. Without `serverNow` (or an unparsable one) there is no skew. */
export function clockSkewMs(
  serverNow: string | undefined,
  fetchedAtMs: number,
): number {
  if (serverNow === undefined) return 0;
  const server = Date.parse(serverNow);
  return Number.isFinite(server) ? server - fetchedAtMs : 0;
}

/** Milliseconds until the session expires, never below zero and never above
 * the granted duration (a client clock behind the server would otherwise show
 * more time than the session has). */
export function remainingMs(
  expiresAt: string,
  nowMs: number,
  durationMinutes?: number,
): number {
  const left = Math.max(0, Date.parse(expiresAt) - nowMs);
  return durationMinutes === undefined
    ? left
    : Math.min(left, durationMinutes * 60_000);
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

export type DisplayStatus = "active" | "expired" | "ended";

/**
 * Status for display on the client clock. Unlike the contract's
 * `supportAccessStatus` (which fails closed for *access* decisions), the UI
 * fails toward *showing* a session: any `endedAt` means the server ended it
 * (even if the client clock is behind that instant), and a session whose
 * start is still in the client's future counts as running, so a lagging
 * clock never hides a freshly opened session from the tenant (TEN-04).
 */
export function displayStatus(grant: TimedGrant, nowMs: number): DisplayStatus {
  if (grant.endedAt !== null) return "ended";
  return nowMs < Date.parse(grant.expiresAt) ? "active" : "expired";
}

export function isGrantActive(grant: TimedGrant, nowMs: number): boolean {
  return displayStatus(grant, nowMs) === "active";
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
