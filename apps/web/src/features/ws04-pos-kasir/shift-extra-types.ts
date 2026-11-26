// View-models for the extra shift screens: held cash outs (legend-pspy) and
// recount limit / force close (legend-7mlf). Kept apart from ./types.ts, which
// belongs to the payment work. Plain TypeScript: Node tests load it directly.
import type { BlindCountLine } from "./types.ts";

/** `?demo=<seed>` values the shift mock understands besides the base ones. */
export const SHIFT_EXTRA_DEMO_SEEDS = [
  "hitungan-batas",
  "tutup-paksa",
  "tutup-paksa-menunggu",
  "tutup-paksa-siap",
  "hitungan-usang",
  "shift-sendiri",
  "perangkat-gagal",
  "kas-kosong",
  "kas-gagal",
] as const;
export type ShiftExtraDemoSeed = (typeof SHIFT_EXTRA_DEMO_SEEDS)[number];

export function shiftExtraDemoSeed(
  raw: string | null,
): ShiftExtraDemoSeed | null {
  return raw !== null &&
    (SHIFT_EXTRA_DEMO_SEEDS as readonly string[]).includes(raw)
    ? (raw as ShiftExtraDemoSeed)
    : null;
}

/** The API lets a cashier submit three counts per shift (MAX_CASHIER_COUNTS). */
export const SHIFT_CASHIER_COUNT_LIMIT = 3;

/** Error code the API answers when the cashier used all counts (409). */
export const SHIFT_COUNT_LIMIT_CODE = "SHIFT_COUNT_LIMIT";
export const SHIFT_COUNT_STALE_CODE = "SHIFT_COUNT_STALE";
export const SHIFT_COUNT_SUPERSEDED_CODE = "SHIFT_COUNT_SUPERSEDED";
/** The terminal could not be verified (DEMO-CONTRACT: no shared code yet). */
export const DEVICE_UNVERIFIED_CODE = "DEVICE_UNVERIFIED";

/** A cash out or drop larger than the expected drawer cash, held for review. */
export type HeldCashOut = {
  id: string;
  type: "cash_out" | "drop";
  amountIdr: number;
  reasonNote: string;
  recordedAt: string;
  cashierName: string;
  /** User who recorded it; that user may not decide it themselves. */
  recordedBy: string;
};

/** Supervisor verdict on a held cash out (route `.../cash-movements/:movementId/decision`). */
export type HeldCashDecision = "approved" | "rejected";

/** Mock-side verdict with plain string ids; the API layer brands it via the shared schema. */
export interface MockCashMovementDecision {
  movementId: string;
  outcome: HeldCashDecision;
  decidedBy: string;
  decidedAt: string;
}

export type DecideHeldCashInput = {
  shiftId: string;
  movementId: string;
  decision: HeldCashDecision;
};

/** The supervisor trail of one shift: held cash outs and both variances. */
export type HeldCashOutReview = {
  shiftId: string;
  items: HeldCashOut[];
  totalHeldIdr: number;
  /** counted - expected; negative is short. */
  physicalVarianceIdr: number | null;
  /**
   * Held refund and void cash the API books at close. The contract does not
   * carry it yet (CONTRACT-GAPS.md), so it is 0.
   */
  heldCorrectionIdr: number;
  /** What the API books: physical variance + held correction (`bookVarianceIdr`). */
  bookVarianceIdr: number | null;
  /** Counts the cashier submitted; the supervisor forces the close at the limit. */
  cashierCounts: number;
  limitReached: boolean;
};

/** What the cashier may know about their latest count: never a system figure. */
export type OwnCountSummary = {
  shiftId: string;
  /** 1, 2, 3 ... */
  sequence: number;
  countedIdr: number;
  submittedAt: string;
  limitReached: boolean;
  /** Real wire only: the stored count the close names, and whether a note is due. */
  countId?: string;
  noteRequired?: boolean;
};

/** A second supervisor (the witness) the mock offers for a force close. */
export const MOCK_WITNESS_ID = "00000000-0000-4000-8000-000000000504";
export const MOCK_WITNESS_NAME = "Supervisor 02";
export const MOCK_COUNTER_NAME = "Supervisor 01";

export type ForceCloseStage = "count" | "witness" | "ready" | "closed";

/** The supervisor's force close of a shift whose cashier used all recounts. */
export type ForceCloseView = {
  shiftId: string;
  shiftNo: string;
  cashierName: string;
  terminalLabel: string;
  openedAt: string;
  /** The viewer is the cashier of this shift and may not approve or close it. */
  ownShift: boolean;
  stage: ForceCloseStage;
  count: {
    id: string;
    countedIdr: number;
    expectedIdr: number;
    varianceIdr: number;
    countedByName: string;
  } | null;
  witnessName: string | null;
  /** The count no longer matches the drawer: count again. */
  stale: boolean;
};

export type SubmitForcedCountInput = {
  shiftId: string;
  counts: BlindCountLine[];
  otherAmountIdr: number;
};

export type WitnessForcedCountInput = { shiftId: string; overrideId: string };

export type ForceCloseInput = { shiftId: string; note: string };

/** Extra mock state, stored on the engine state next to the base fields. */
export type ShiftExtraState = {
  heldMovementIds: string[];
  /** Every count submitted for the shift, newest last. */
  counts: {
    id: string;
    shiftId: string;
    forced: boolean;
    countedIdr: number;
    expectedIdr: number;
    heldCashOutIdr: number;
    submittedAt: string;
  }[];
  /** The force close in progress, if any. */
  forced: {
    shiftId: string;
    countId: string;
    witnessName: string | null;
    witnessOverrideId: string | null;
  } | null;
  /** Verdicts already given, by movement id: a repeat of the same one is a no-op. */
  decisions?: Record<string, MockCashMovementDecision>;
  /** Which extra demo seed was applied last. */
  appliedSeed: string | null;
};
