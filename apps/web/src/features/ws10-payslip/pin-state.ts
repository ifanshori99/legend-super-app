// Pure logic of the payslip PIN screens (bead legend-ilzrj; PRD v1.7 §3 D.30):
// input rules, the new-PIN check, the API error mapping and the lock clock.
// No React, no framework imports and no TypeScript-only runtime syntax, so the
// unit tests load it directly with native Node type stripping.
//
// The error mapping is duck-typed on `status`, `code`, `remainingAttempts` and
// `lockedUntil` (an `ApiError` has them), so tests can pass plain objects.

export const PAYSLIP_PIN_LENGTH = 6;
/** Same limit as the API (`PAYSLIP_PIN_MAX_ATTEMPTS` in the payroll contract). */
export const PAYSLIP_PIN_MAX_ATTEMPTS = 5;

export type PinErrorState =
  | { kind: "invalid"; remainingAttempts: number | null }
  | { kind: "locked"; lockedUntil: string | null }
  | { kind: "not_set" }
  | { kind: "rate_limited" }
  | { kind: "unavailable" }
  | { kind: "not_found" }
  | { kind: "network" }
  | { kind: "unknown" };

export type NewPinProblem = "incomplete" | "mismatch" | "weak";
export type NewPinCheck = { ok: true } | { ok: false; reason: NewPinProblem };

export type PinStatusInput = {
  status: "not_set" | "active" | "locked";
  lockedUntil: string | null;
};
export type PinStatusView = "create" | "enter" | "locked";

/** Keeps digits only, at most `PAYSLIP_PIN_LENGTH` of them. */
export function sanitizePinInput(raw: string): string {
  return String(raw).replace(/\D/g, "").slice(0, PAYSLIP_PIN_LENGTH);
}

export function isCompletePin(pin: string): boolean {
  return new RegExp(`^\\d{${PAYSLIP_PIN_LENGTH}}$`).test(pin);
}

/** 111111, or a straight run up or down (123456, 654321, 345678). */
function isWeakPin(pin: string): boolean {
  const digits = pin.split("").map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]);
  return (
    steps.every((step) => step === 0) ||
    steps.every((step) => step === 1) ||
    steps.every((step) => step === -1)
  );
}

/** Order of the checks: incomplete, weak, mismatch. */
export function validateNewPin(pin: string, confirm: string): NewPinCheck {
  if (!isCompletePin(pin)) return { ok: false, reason: "incomplete" };
  if (isWeakPin(pin)) return { ok: false, reason: "weak" };
  if (pin !== confirm) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

type ErrorLike = {
  status?: unknown;
  code?: unknown;
  remainingAttempts?: unknown;
  lockedUntil?: unknown;
};

function validDateString(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/**
 * Maps a failed PIN / OTP call to the state the screen renders. A wrong
 * WhatsApp code answers like a wrong PIN (403 PAYSLIP_PIN_INVALID).
 */
export function classifyPinError(err: unknown): PinErrorState {
  if (typeof err !== "object" || err === null) return { kind: "network" };
  const { status, code, remainingAttempts, lockedUntil } = err as ErrorLike;
  if (typeof status !== "number" || status === 0) return { kind: "network" };

  if (code === "PAYSLIP_PIN_INVALID") {
    return {
      kind: "invalid",
      remainingAttempts:
        typeof remainingAttempts === "number" &&
        Number.isInteger(remainingAttempts) &&
        remainingAttempts >= 0
          ? remainingAttempts
          : null,
    };
  }
  if (code === "PAYSLIP_PIN_LOCKED" || status === 423)
    return { kind: "locked", lockedUntil: validDateString(lockedUntil) };
  if (code === "PAYSLIP_PIN_NOT_SET") return { kind: "not_set" };
  if (status === 429) return { kind: "rate_limited" };
  if (status === 503) return { kind: "unavailable" };
  if (status === 404) return { kind: "not_found" };
  return { kind: "unknown" };
}

/** Whole minutes left, rounded up, never below 0; null without a valid date. */
export function minutesUntil(
  lockedUntil: string | null,
  now: Date,
): number | null {
  if (lockedUntil === null) return null;
  const end = Date.parse(lockedUntil);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / 60_000));
}

/** Which screen the PIN status opens; an expired lock opens the PIN entry. */
export function pinStatusView(
  status: PinStatusInput,
  now: Date,
): PinStatusView {
  if (status.status === "not_set") return "create";
  if (status.status === "locked") {
    const end =
      status.lockedUntil === null ? Number.NaN : Date.parse(status.lockedUntil);
    if (!Number.isNaN(end) && end <= now.getTime()) return "enter";
    return "locked";
  }
  return "enter";
}
