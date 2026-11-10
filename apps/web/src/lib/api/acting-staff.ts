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
// Set when this tab's cashier token is refused or runs out (review K,
// legend-5u03q). While it is set and no live token exists, POS calls are held:
// clearing the token and the label must not hand the POS back to the session
// owner on the next call. Only a new token or the end of cashier mode
// (sign-out) clears it. sessionStorage, like the token: one tab, one cashier.
const PIN_REQUIRED_KEY = "legend-acting-staff-pin-required";
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

let pinRequiredMemory = false;

function setPinRequired(value: boolean): void {
  pinRequiredMemory = value;
  try {
    if (value) window.sessionStorage.setItem(PIN_REQUIRED_KEY, "1");
    else window.sessionStorage.removeItem(PIN_REQUIRED_KEY);
  } catch {
    // Blocked storage: the in-memory flag still holds this page.
  }
}

function pinRequired(): boolean {
  if (pinRequiredMemory) return true;
  try {
    return window.sessionStorage.getItem(PIN_REQUIRED_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Ends cashier mode in this tab (sign-out): forgets the token and lifts the
 * hold, so the next login works the POS as itself. Not for a refused PIN
 * pick; that keeps the hold.
 */
export function endActingStaffMode(): void {
  clearActingStaffToken();
  if (typeof window === "undefined") return;
  setPinRequired(false);
}

/**
 * Ends this tab's pos-session token (POST /api/staff-pins/pos-session/end,
 * e.g. the PIN screen undoing a PIN of another tile) and keeps POS calls held
 * until the next token: ending a cashier never hands the POS back to the
 * session owner. Only sign-out (`endActingStaffMode`) lifts the hold.
 */
export function releaseActingStaffToken(): void {
  clearActingStaffToken();
  if (typeof window === "undefined") return;
  setPinRequired(true);
}

export function writeActingStaffToken(value: ActingStaffToken): void {
  if (typeof window === "undefined") return;
  memory = value;
  setPinRequired(false);
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
  if (isExpired(value)) {
    // Not a silent clear: the label goes too and the cashier is sent to the PIN screen.
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.EXPIRED);
    return null;
  }
  return value.token;
}

function isExpired(value: ActingStaffToken): boolean {
  return Date.parse(value.expiresAt) <= Date.now();
}

function hasActiveStaffLabel(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ACTIVE_STAFF_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Message of the ApiError the client throws when a POS call is held. */
export const ACTING_STAFF_HELD_MESSAGE =
  "Kasir aktif sudah kedaluwarsa. Masukkan PIN lagi.";

// POS calls only: /api/outlets/<id>/pos..., /api/pos-overrides... and
// /api/pos/orders/<id>/customer. Every other path keeps the session owner as
// the actor.
const POS_PATH =
  /^\/api\/(?:outlets\/[^/]+\/pos(?:\/|$)|pos-overrides(?:\/|$)|pos\/orders\/[^/]+\/customer\/?$)/;

/**
 * Headers for a call to `path`. Returns null when the call must be HELD: a POS
 * path with an expired token, with no token after this tab's token was
 * refused (sticky until a new token), or with no token while the
 * active-cashier label says a cashier is working. Sent without the header, the API would treat the
 * call as the session owner. The rejection flow has already run (token and
 * label cleared, PIN screen opened); the caller must not send the request.
 */
export function actingStaffHeaderFor(
  path: string,
): Record<string, string> | null {
  if (typeof window === "undefined") return {};
  if (!POS_PATH.test(path.split("?")[0] ?? "")) return {};
  const value = stored();
  if (value && !isExpired(value)) return { [ACTING_STAFF_HEADER]: value.token };
  if (value || pinRequired() || hasActiveStaffLabel()) {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.EXPIRED);
    return null;
  }
  return {};
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
  setPinRequired(true);
  try {
    window.localStorage.removeItem(ACTIVE_STAFF_STORAGE_KEY);
  } catch {
    // Blocked storage: the redirect below still happens.
  }
  if (!window.location.pathname.startsWith(SWITCH_PATH))
    window.location.assign(SWITCH_PATH);
}
