// Pure rules of the device PIN pad and the override modal (bead legend-6ew;
// PRD v1.7 §3 F6 "PIN Perangkat", §3.6 "Override Supervisor", AUTH-06). No
// framework imports and no policy numbers: lengths and limits are passed in
// from @starter/shared/identity so the root contract test loads this with
// plain Node ESM.

export function appendDigit(
  pin: string,
  digit: string,
  length: number,
): string {
  if (!/^\d$/.test(digit) || pin.length >= length) return pin;
  return pin + digit;
}

export function removeLastDigit(pin: string): string {
  return pin.slice(0, -1);
}

/**
 * A full PIN is handed over only while nothing else is checked; until then
 * it waits in the pad (typed during the previous check, legend-6ew).
 */
export function readyToHandOver(
  pin: string,
  busy: boolean,
  length: number,
): boolean {
  return !busy && pin.length === length;
}

/**
 * Dots to fill: the digits of the try being typed, or all of them while a
 * handed-over PIN is checked and nothing new is typed yet.
 */
export function pinPadDots(
  typed: number,
  pending: boolean,
  length: number,
): number {
  return pending && typed === 0 ? length : typed;
}

/** Milliseconds left of a lock; 0 when none or already over. */
export function lockRemainingMs(
  lockedUntil: string | null,
  nowMs: number,
): number {
  if (lockedUntil === null) return 0;
  const left = Date.parse(lockedUntil) - nowMs;
  return Number.isFinite(left) && left > 0 ? left : 0;
}

/** "14:05" style countdown, rounded up so it never shows 00:00 while locked. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function attemptsRemaining(failed: number, max: number): number {
  return Math.max(0, max - failed);
}

/** Whole rupiah from what the cashier typed ("1.250.000" or "1250000"). */
export function parseRupiah(input: string): number | null {
  const digits = input.replace(/[.\s]/g, "");
  if (!/^\d{1,12}$/.test(digits)) return null;
  return Number(digits);
}

export type OverrideFormValues = {
  valueText: string;
  reasonCode: string;
  reason: string;
};
export type OverrideFormErrors = Partial<
  Record<"value" | "reasonCode" | "reason", true>
>;

/** Mirrors createApprovalRequestSchema: amount >= 0, reason 3..500 chars. */
export function validateOverrideForm(
  values: OverrideFormValues,
): OverrideFormErrors {
  const errors: OverrideFormErrors = {};
  if (parseRupiah(values.valueText) === null) errors.value = true;
  if (values.reasonCode === "") errors.reasonCode = true;
  const reason = values.reason.trim();
  if (reason.length < 3 || reason.length > 500) errors.reason = true;
  return errors;
}

export type ApprovalOutcome =
  "pending" | "approved" | "rejected" | "expired" | "cancelled";

/**
 * A pending request past its deadline is expired on screen even before the
 * next poll says so: the action stays blocked (fail closed, §3 F7).
 */
export function approvalOutcome(
  request: { status: string; deadlineAt: string },
  nowMs: number,
): ApprovalOutcome {
  if (request.status === "approved") return "approved";
  if (request.status === "rejected") return "rejected";
  if (request.status === "cancelled") return "cancelled";
  if (request.status === "expired") return "expired";
  return nowMs >= Date.parse(request.deadlineAt) ? "expired" : "pending";
}

/** The settled override read back after the phone request is approved. */
export type SettledOverride = { status: string; approvedBy: string | null };

/**
 * What the phone wait shows (legend-495 G3). An approved request is not yet an
 * approved override: the caller may continue only once the override itself is
 * settled as approved by someone other than the requester (AUTH-06). Until the
 * settlement is read the wait stays pending; any other settlement is shown as
 * that end, never as approved.
 */
export function phoneOutcome(input: {
  raw: ApprovalOutcome;
  decidedBy: string | null;
  settled: SettledOverride | null;
  requesterId: string | null;
}): { outcome: ApprovalOutcome; selfApproved: boolean } {
  const { raw, decidedBy, settled, requesterId } = input;
  if (raw !== "approved") return { outcome: raw, selfApproved: false };
  const rejectedSelf = { outcome: "rejected", selfApproved: true } as const;
  if (decidedBy === null || decidedBy === requesterId) return rejectedSelf;
  if (settled === null || settled.status === "pending")
    return { outcome: "pending", selfApproved: false };
  if (settled.status === "approved") {
    if (settled.approvedBy === null || settled.approvedBy === requesterId)
      return rejectedSelf;
    return { outcome: "approved", selfApproved: false };
  }
  if (settled.status === "cancelled" || settled.status === "expired")
    return { outcome: settled.status, selfApproved: false };
  return { outcome: "rejected", selfApproved: false };
}

/**
 * X, Escape or an outside click while the phone wait is pending withdraws the
 * request first; the dialog closes only after the cancel succeeds (G5).
 */
export function closeAction(state: {
  waiting: boolean;
  outcome: ApprovalOutcome;
}): "cancel" | "close" {
  return state.waiting && state.outcome === "pending" ? "cancel" : "close";
}

/** The fields that make up one override intent (what the server fingerprints). */
export type OverrideIntentFields = {
  outletId: string | undefined;
  action: string;
  objectType: string;
  objectId: string;
  valueText: string;
  reasonCode: string;
  reason: string;
  method: string;
  approverId: string | null;
};

/** Equal for the same intent; differs as soon as any field changes (G4). */
export function overrideIntentSignature(fields: OverrideIntentFields): string {
  return JSON.stringify([
    fields.outletId ?? null,
    fields.action,
    fields.objectType,
    fields.objectId,
    fields.valueText.trim(),
    fields.reasonCode,
    fields.reason.trim(),
    fields.method,
    fields.approverId,
  ]);
}

/**
 * One idempotency key per override intent (G4): the key made for a signature
 * is reused on every retry of it, replaced when the signature changes and
 * after `reset()` (intent finished).
 */
export function createIntentKeyKeeper(makeKey: () => string) {
  let current: { signature: string; key: string } | null = null;
  return {
    keyFor(signature: string): string {
      if (current === null || current.signature !== signature)
        current = { signature, key: makeKey() };
      return current.key;
    },
    reset() {
      current = null;
    },
  };
}
