// The guest's table-session credential, kept in sessionStorage per QR token
// (PRD §3 "Keamanan Sesi": the session token is rotated on close, ORD-04). The
// device hash lives in localStorage so a page reload is still the same guest.
// Pure over an injected Storage so Node tests can run it.

export type StoredGuestSession = {
  qrToken: string;
  sessionId: string;
  sessionToken: string;
  sessionTokenExpiresAt: string;
  participantId: string | null;
  pax: number;
  outcome: "opened" | "joined";
};

const SESSION_PREFIX = "legend-qr-session:";
const BY_SESSION_PREFIX = "legend-qr-by-session:";
const DEVICE_KEY = "legend-qr-device";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parse(raw: string | null): StoredGuestSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredGuestSession>;
    if (
      typeof value.qrToken === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.sessionToken === "string" &&
      typeof value.sessionTokenExpiresAt === "string" &&
      typeof value.pax === "number" &&
      (value.outcome === "opened" || value.outcome === "joined")
    )
      return {
        qrToken: value.qrToken,
        sessionId: value.sessionId,
        sessionToken: value.sessionToken,
        sessionTokenExpiresAt: value.sessionTokenExpiresAt,
        participantId:
          typeof value.participantId === "string" ? value.participantId : null,
        pax: value.pax,
        outcome: value.outcome,
      };
  } catch {
    // A corrupt entry is treated as no session; the guest scans again.
  }
  return null;
}

export function readGuestSession(
  storage: StorageLike,
  qrToken: string,
  nowMs: number,
): StoredGuestSession | null {
  const stored = parse(storage.getItem(SESSION_PREFIX + qrToken));
  if (!stored) return null;
  // ORD-04: an expired credential is dropped, the table QR opens a new one.
  if (new Date(stored.sessionTokenExpiresAt).getTime() <= nowMs) {
    clearGuestSession(storage, qrToken);
    return null;
  }
  return stored;
}

export function writeGuestSession(
  storage: StorageLike,
  session: StoredGuestSession,
): void {
  storage.setItem(SESSION_PREFIX + session.qrToken, JSON.stringify(session));
  storage.setItem(BY_SESSION_PREFIX + session.sessionId, session.qrToken);
}

export function clearGuestSession(storage: StorageLike, qrToken: string): void {
  const stored = parse(storage.getItem(SESSION_PREFIX + qrToken));
  if (stored) storage.removeItem(BY_SESSION_PREFIX + stored.sessionId);
  storage.removeItem(SESSION_PREFIX + qrToken);
}

/** Bearer credential for `/api/table-sessions/:id/…` calls, if known. */
export function sessionTokenFor(
  storage: StorageLike,
  sessionId: string,
  nowMs: number,
): string | null {
  const qrToken = storage.getItem(BY_SESSION_PREFIX + sessionId);
  if (!qrToken) return null;
  return readGuestSession(storage, qrToken, nowMs)?.sessionToken ?? null;
}

const DEVICE_PATTERN = /^[a-f0-9]{32}$/;

/** Stable opaque device fingerprint for the guest identity (no login needed). */
export function deviceHash(storage: StorageLike, random: () => string): string {
  const existing = storage.getItem(DEVICE_KEY);
  if (existing && DEVICE_PATTERN.test(existing)) return existing;
  const created = random().replace(/-/g, "").slice(0, 32).toLowerCase();
  storage.setItem(DEVICE_KEY, created);
  return created;
}
