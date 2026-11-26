// Calls of the extra shift screens: held cash outs (legend-pspy) and recount
// limit / force close (legend-7mlf). Same rules as ./api.ts: shared endpoints go
// through the typed client; the force close runs on the real O3 API (O4,
// legend-wasr7.8) and on the mock engine in mock mode.
import {
  decidePosCashMovement,
  forceClosePosShift,
  getPosShift,
  listPosShiftCounts,
  submitPosShiftCount,
  posCashMovementDecisionSchema,
  type PosCashMovementDecision,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  clearForceCloseApproval,
  readForceCloseApproval,
  writeForceCloseApproval,
} from "./force-close-store";
import { runPosKasirMock } from "./mock-engine";
import { fetchSupervisors, isCloseStale, requestOverride } from "./shift-api";
import { readStoredCount } from "./shift-count-store";
import {
  bookVarianceIdr,
  countLimitReached,
  sameUser,
  thirdPersons,
} from "./shift-extra-logic";
import {
  FORCE_CLOSE_NOTE_MIN,
  type ApproveForcedCountInput,
  type DecideHeldCashInput,
  type ForceCloseInput,
  type ForceCloseView,
  type ForceCloseViewer,
  type HeldCashOutReview,
  type OwnCountSummary,
  type SubmitForcedCountInput,
} from "./shift-extra-types";
import type { SupervisorOption } from "./types";

/**
 * Supervisor trail of a shift: cash outs held for review, the physical
 * variance of the latest count and the book variance (physical + held).
 */
export async function fetchHeldCashOuts(
  outletId: string,
  shiftId: string,
  signal?: AbortSignal,
): Promise<HeldCashOutReview> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.heldCashOuts(shiftId));
  const [report, counts] = await Promise.all([
    callEndpoint(getPosShift, { params: { outletId, shiftId } }, { signal }),
    callEndpoint(
      listPosShiftCounts,
      { params: { outletId, shiftId } },
      { signal },
    ),
  ]);
  const items = report.data.movements
    .filter(
      (row) =>
        row.needsApproval === true &&
        row.outcome == null &&
        row.type !== "cash_in",
    )
    .map((row) => ({
      id: row.id,
      type: row.type === "drop" ? ("drop" as const) : ("cash_out" as const),
      amountIdr: Number(row.amountIdr),
      reasonNote: row.reasonNote,
      recordedAt: row.recordedAt,
      // The movement carries no cashier name yet (gap): the shift screen has it.
      cashierName: "",
      recordedBy: row.recordedBy,
    }))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const totalHeldIdr = items.reduce((sum, item) => sum + item.amountIdr, 0);
  const latest = [...counts.data].sort((a, b) => b.sequence - a.sequence)[0];
  const physicalVarianceIdr = latest ? Number(latest.varianceIdr) : null;
  // Gap: the held refund and void cash is not in the contract, so 0.
  const heldCorrectionIdr = 0;
  return {
    shiftId,
    items,
    totalHeldIdr,
    physicalVarianceIdr,
    heldCorrectionIdr,
    bookVarianceIdr:
      physicalVarianceIdr === null
        ? null
        : bookVarianceIdr(physicalVarianceIdr, heldCorrectionIdr),
    // The count DTO has no `forced` flag (gap): every stored count is counted.
    cashierCounts: counts.data.length,
    limitReached: countLimitReached(counts.data.length),
  };
}

/** A supervisor approves or rejects a held cash out. */
export async function decideHeldCashMovement(
  outletId: string,
  input: DecideHeldCashInput,
): Promise<PosCashMovementDecision> {
  if (API_MOCK)
    return posCashMovementDecisionSchema.parse(
      await runPosKasirMock((engine) => engine.decideHeldCashMovement(input)),
    );
  const { data } = await callEndpoint(decidePosCashMovement, {
    params: {
      outletId,
      shiftId: input.shiftId,
      movementId: input.movementId,
    },
    body: { decision: input.decision },
  });
  return data;
}

/**
 * The cashier's latest count. The server answers a cashier nothing about
 * counts (those rows carry expected and variance), so on the real wire this
 * is the receipt of the submit, kept on this device.
 */
export async function fetchOwnCountSummary(
  outletId: string,
  shiftId: string,
): Promise<OwnCountSummary | null> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.ownCountSummary(shiftId));
  const stored = readStoredCount(outletId, shiftId);
  if (!stored) return null;
  return {
    shiftId,
    sequence: stored.sequence,
    countedIdr: stored.countedIdr,
    submittedAt: stored.submittedAt,
    // The recount limit is the server's: a fourth count is answered 409.
    limitReached: false,
    countId: stored.countId,
    noteRequired: stored.noteRequired,
  };
}

/** Supervisors who may witness a force close, minus the counter and cashier. */
export async function fetchWitnesses(
  outletId: string,
  exclude: readonly string[] = [],
): Promise<SupervisorOption[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.witnesses());
  const options = await fetchSupervisors(outletId, "cash_shift_close");
  return thirdPersons(options, exclude);
}

/** The trimmed reason reaches the API's floor (`note` >= 10). */
export const forceCloseNoteValid = (note: string): boolean =>
  note.trim().length >= FORCE_CLOSE_NOTE_MIN;

/** Starts the force close of a shift on this device over (tests, recount). */
export function discardForceCloseApproval(
  outletId: string,
  shiftId: string,
): void {
  clearForceCloseApproval(outletId, shiftId);
}

/**
 * Where the force close of a shift stands (O4 real wire). The supervisor's
 * forced count is their own count of a shift that is not theirs; the witness
 * approval of it lives on this device (./force-close-store.ts).
 */
export async function fetchForceCloseView(
  outletId: string,
  shiftId: string,
  viewer: ForceCloseViewer,
  signal?: AbortSignal,
): Promise<ForceCloseView> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.forceCloseView(shiftId));
  const [report, counts] = await Promise.all([
    callEndpoint(getPosShift, { params: { outletId, shiftId } }, { signal }),
    callEndpoint(
      listPosShiftCounts,
      { params: { outletId, shiftId } },
      { signal },
    ),
  ]);
  const shift = report.data.shift;
  const rows = [...counts.data].sort((a, b) => a.sequence - b.sequence);
  const latest = rows.at(-1);
  const mine = rows
    .filter(
      (row) =>
        sameUser(row.submittedBy, viewer.userId) &&
        !sameUser(row.submittedBy, shift.cashierId),
    )
    .at(-1);
  const stored = readForceCloseApproval(outletId, shiftId);
  const approval = stored && mine && stored.countId === mine.id ? stored : null;
  const closed = shift.status === "closed";
  return {
    shiftId,
    shiftNo: shiftId.slice(0, 8),
    // The shift DTO carries no cashier or terminal name yet (as in shift-api).
    cashierName: "",
    terminalLabel: "",
    openedAt: shift.openedAt,
    ownShift: sameUser(shift.cashierId, viewer.userId),
    cashierId: shift.cashierId,
    stage: closed
      ? "closed"
      : !mine
        ? "count"
        : approval && !approval.stale
          ? "ready"
          : "witness",
    count: mine
      ? {
          id: mine.id,
          countedIdr: Number(mine.countedIdr),
          expectedIdr: Number(mine.expectedIdr),
          varianceIdr: Number(mine.varianceIdr),
          countedByName: viewer.name,
        }
      : null,
    witnessName: (closed ? stored : approval)?.approverName ?? null,
    stale:
      !closed &&
      mine !== undefined &&
      (latest?.id !== mine.id || approval?.stale === true),
  };
}

/** The supervisor counts the drawer: a normal blind count from their session. */
export async function submitForcedCount(
  outletId: string,
  input: SubmitForcedCountInput,
  idempotencyKey: string,
): Promise<unknown> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.submitForcedCount(input));
  if (input.otherAmountIdr !== 0)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Hitung semua pecahan satu per satu sebelum mengirim.",
    );
  const counted = input.counts.filter((line) => line.quantity > 0);
  const [first] = input.counts;
  const lines = counted.length > 0 ? counted : first ? [first] : [];
  clearForceCloseApproval(outletId, input.shiftId);
  const { data } = await callEndpoint(submitPosShiftCount, {
    params: { outletId, shiftId: input.shiftId },
    body: {
      counts: lines.map((line) => ({
        denominationIdr: line.denominationIdr,
        quantity: line.quantity,
      })),
      idempotencyKey,
    },
  });
  return data;
}

/**
 * A third person approves the supervisor's forced count by PIN (override of
 * `pos_shift_count`). Neither the counter nor the cashier: refused here before
 * any PIN leaves, and again by the server.
 */
export async function witnessForcedCount(
  outletId: string,
  input: ApproveForcedCountInput,
  viewer: ForceCloseViewer,
  shift: { cashierId?: string } = {},
): Promise<unknown> {
  if (
    sameUser(input.approverUserId, viewer.userId) ||
    (shift.cashierId !== undefined &&
      sameUser(input.approverUserId, shift.cashierId))
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Penyetuju tidak boleh kasir shift atau supervisor yang menghitung.",
    );
  if (API_MOCK) {
    const override = await requestOverride(outletId, {
      action: "cash_shift_close",
      valueIdr: input.valueIdr,
      reason: input.reason,
      objectType: "cash_shift",
      objectId: input.shiftId,
      approverUserId: input.approverUserId,
      pin: input.pin,
    });
    return runPosKasirMock((engine) =>
      engine.witnessForcedCount({
        shiftId: input.shiftId,
        overrideId: override.overrideId,
      }),
    );
  }
  const override = await requestOverride(outletId, {
    action: "cash_shift_close",
    valueIdr: input.valueIdr,
    reason: input.reason,
    objectType: "pos_shift_count",
    objectId: input.countId,
    approverUserId: input.approverUserId,
    pin: input.pin,
  });
  writeForceCloseApproval(outletId, input.shiftId, {
    countId: input.countId,
    overrideId: override.overrideId,
    approverUserId: input.approverUserId,
    approverName: input.approverName,
    stale: false,
  });
  return override;
}

/**
 * Closes the shift with the approved forced count and the written reason.
 * The server marks a shift whose tablet never reported its offline queue and
 * alerts finance (O3); a stale count is marked here for a recount.
 */
export async function forceCloseShift(
  outletId: string,
  input: ForceCloseInput,
  idempotencyKey: string,
): Promise<unknown> {
  const note = input.note.trim();
  if (!forceCloseNoteValid(note))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Tulis alasan penutupan paksa minimal 10 huruf.",
    );
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.forceClose({ ...input, note }));
  const approval = readForceCloseApproval(outletId, input.shiftId);
  if (!approval || approval.stale)
    throw new ApiError(409, "COUNT_NOT_APPROVED", "Hitungan belum disetujui.");
  try {
    const { data } = await callEndpoint(forceClosePosShift, {
      params: { outletId, shiftId: input.shiftId },
      body: {
        countId: approval.countId,
        note,
        approvedBy: approval.approverUserId,
        approvalRequestId: approval.overrideId,
        idempotencyKey,
      },
    });
    return data;
  } catch (error) {
    if (isCloseStale(error))
      writeForceCloseApproval(outletId, input.shiftId, {
        ...approval,
        stale: true,
      });
    throw error;
  }
}
