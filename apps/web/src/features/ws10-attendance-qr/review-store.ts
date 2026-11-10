// Supervisor decisions for the selfie sampling review (F25).
//
// GAP: the shared HRIS contract has no "review an attendance log" endpoint yet
// (only `transitionAttendanceValidity` describes the rule). Until that endpoint
// lands, the screen keeps each decision in this browser tab, keyed by the log
// id, and mints an idempotency key per decision so the future call can be
// replayed safely. Storage is `sessionStorage`: it disappears when the tab
// closes, is never sent anywhere, and is absent during SSR.
//
// The validity itself still goes through the contract state machine
// (`transitionAttendanceValidity`): accept is only a transition for a flagged
// log, flag only for a valid one, and a rejected log stays terminal.
import type { AttendanceLog, AttendanceValidity } from "@starter/shared/hris";
import { transitionAttendanceValidity } from "@starter/shared/hris";
import type { OutletId } from "@starter/shared/core";
import { newIdempotencyKey } from "@/lib/idempotency";

export type AttendanceReviewKind = "accepted" | "flagged";

export type AttendanceReviewDecision = {
  readonly kind: AttendanceReviewKind;
  /** Validity after the decision, computed by the contract transition. */
  readonly validity: AttendanceValidity;
  readonly decidedAt: string;
  /** Reused when the same decision is replayed; a changed decision gets a new key. */
  readonly idempotencyKey: string;
};

export type AttendanceReviewState = Readonly<
  Record<string, AttendanceReviewDecision>
>;

const STORAGE_PREFIX = "legend-attendance-review:";
const EMPTY: AttendanceReviewState = Object.freeze({});
const listeners = new Set<() => void>();
/** Stable snapshot per outlet and business date: useSyncExternalStore needs one object. */
const cache = new Map<string, AttendanceReviewState>();

function storageKey(outletId: OutletId, businessDate: string): string {
  return `${STORAGE_PREFIX}${outletId}:${businessDate}`;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    // Storage can be blocked (private mode, embedded webview): the screen still
    // works for the open dialog, it just cannot reopen the decision later.
    return null;
  }
}

function isDecision(value: unknown): value is AttendanceReviewDecision {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "accepted" || record.kind === "flagged") &&
    (record.validity === "valid" ||
      record.validity === "flagged" ||
      record.validity === "rejected") &&
    typeof record.decidedAt === "string" &&
    typeof record.idempotencyKey === "string"
  );
}

function load(outletId: OutletId, businessDate: string): AttendanceReviewState {
  const raw = (() => {
    try {
      return storage()?.getItem(storageKey(outletId, businessDate));
    } catch {
      return null;
    }
  })();
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, AttendanceReviewDecision] =>
        isDecision(entry[1]),
    );
    if (entries.length === 0) return EMPTY;
    return Object.freeze(Object.fromEntries(entries));
  } catch {
    return EMPTY;
  }
}

/** The decisions saved for this outlet's business date. */
export function reviewDecisionsSnapshot(
  outletId: OutletId,
  businessDate: string,
): AttendanceReviewState {
  const key = storageKey(outletId, businessDate);
  const cached = cache.get(key);
  if (cached) return cached;
  const loaded = load(outletId, businessDate);
  cache.set(key, loaded);
  return loaded;
}

export function subscribeReviewDecisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(
  outletId: OutletId,
  businessDate: string,
  next: AttendanceReviewState,
): AttendanceReviewState {
  const key = storageKey(outletId, businessDate);
  cache.set(key, next);
  try {
    storage()?.setItem(key, JSON.stringify(next));
  } catch {
    // Quota or blocked storage: the in-memory snapshot still drives the screen.
  }
  for (const listener of listeners) listener();
  return next;
}

/** The validity a decision produces, or null when the log is terminal. */
export function decidedValidity(
  original: AttendanceValidity,
  kind: AttendanceReviewKind,
): AttendanceValidity | null {
  if (original === "rejected") return null;
  if (kind === "accepted")
    return original === "flagged"
      ? transitionAttendanceValidity(original, "accept")
      : original;
  return original === "valid"
    ? transitionAttendanceValidity(original, "flag")
    : original;
}

/**
 * Records a supervisor decision. Replaying the same decision keeps the
 * original idempotency key; changing it mints a new one. Returns null for a
 * rejected (terminal) log, which the dialog never offers.
 */
export function decideAttendanceSample(input: {
  outletId: OutletId;
  businessDate: string;
  log: Pick<AttendanceLog, "id" | "validity">;
  kind: AttendanceReviewKind;
}): AttendanceReviewDecision | null {
  const current = reviewDecisionsSnapshot(input.outletId, input.businessDate);
  const existing = current[input.log.id];
  if (existing?.kind === input.kind) return existing;
  const validity = decidedValidity(input.log.validity, input.kind);
  if (validity === null) return null;
  const decision: AttendanceReviewDecision = {
    kind: input.kind,
    validity,
    decidedAt: new Date().toISOString(),
    idempotencyKey: newIdempotencyKey(),
  };
  write(input.outletId, input.businessDate, {
    ...current,
    [input.log.id]: decision,
  });
  return decision;
}
