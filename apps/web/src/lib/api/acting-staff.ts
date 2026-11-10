// The "active cashier" token of a POS device (docs/DECISIONS.md, 2026-11-10
// "Kasir aktif per perangkat lewat token server"). The API issues it after a
// personal PIN (POST /api/staff-pins/pos-session) and wants it back in the
// X-Acting-Staff header on POS calls. Kept in memory and sessionStorage, never
// localStorage: it ends with the tab and is not shared with other tabs.
// Browser only; on the server every function answers "no token".
import {
  ACTING_STAFF_ERROR_CODES,
  ACTING_STAFF_HEADER,
} from "@starter/shared/pos/acting-staff";

const TOKEN_KEY = "legend-acting-staff";
// Owned by features/ws01-device-pin/storage.ts (the "who is working" label);
// a rejected token must clear it too, so the screen does not claim a cashier
// the API no longer accepts.
export const ACTIVE_STAFF_STORAGE_KEY = "legend-device-active-staff";
const SWITCH_PATH = "/pos/ganti-pengguna";

export type ActingStaffToken = {
  token: string;
  /** ISO time the API stops accepting the token. */
  expiresAt: string;
};

let memory: ActingStaffToken | null = null;

function isToken(value: unknown): value is ActingStaffToken {
  const row = value as Partial<ActingStaffToken> | null;
  return typeof row?.token === "string" && typeof row?.expiresAt === "string";
}

function stored(): ActingStaffToken | null {
  if (typeof window === "undefined") return null;
  if (memory) return memory;
  try {
    const raw = window.sessionStorage.getItem(TOKEN_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    memory = isToken(value) ? value : null;
  } catch {
    memory = null;
  }
  return memory;
}

export function writeActingStaffToken(value: ActingStaffToken): void {
  if (typeof window === "undefined") return;
  memory = value;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: the in-memory copy still serves this page.
  }
}

export function clearActingStaffToken(): void {
  memory = null;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored that we can reach.
  }
}

/** The live token, or null when none was issued or it has expired. */
export function readActingStaffToken(): string | null {
  const value = stored();
  if (!value) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) {
    clearActingStaffToken();
    return null;
  }
  return value.token;
}

// POS calls only: /api/outlets/<id>/pos... and /api/pos-overrides... Every
// other path keeps the session owner as the actor.
const POS_PATH = /^\/api\/(?:outlets\/[^/]+\/pos|pos-overrides)(?:\/|$)/;

export function actingStaffHeaderFor(path: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  if (!POS_PATH.test(path.split("?")[0] ?? "")) return {};
  const token = readActingStaffToken();
  return token ? { [ACTING_STAFF_HEADER]: token } : {};
}

// Codes that mean "this token is no longer good": the cashier types the PIN
// again. UNSUPPORTED (server wiring) and NOT_ALLOWED (a rule for this call,
// not for the token) keep the token.
const REJECTING_CODES: ReadonlySet<string> = new Set([
  ACTING_STAFF_ERROR_CODES.INVALID,
  ACTING_STAFF_ERROR_CODES.EXPIRED,
  ACTING_STAFF_ERROR_CODES.REVOKED,
  ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
  ACTING_STAFF_ERROR_CODES.INACTIVE,
]);

/**
 * Called for every failed API answer. When the code says the acting-staff
 * token was refused, forget it and the active cashier label, then send the
 * user to the PIN screen.
 */
export function handleActingStaffRejection(code: string): void {
  if (typeof window === "undefined" || !REJECTING_CODES.has(code)) return;
  clearActingStaffToken();
  try {
    window.localStorage.removeItem(ACTIVE_STAFF_STORAGE_KEY);
  } catch {
    // Blocked storage: the redirect below still happens.
  }
  if (!window.location.pathname.startsWith(SWITCH_PATH))
    window.location.assign(SWITCH_PATH);
}
