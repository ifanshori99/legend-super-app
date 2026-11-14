// Calls of the extra shift screens: held cash outs (legend-pspy) and recount
// limit / force close (legend-7mlf). Same rules as ./api.ts: shared endpoints go
// through the typed client, the rest runs on the mock engine in mock mode and
// fails with CONTRACT_PENDING elsewhere (see ./CONTRACT-GAPS.md).
import {
  decidePosCashMovement,
  getPosShift,
  listPosShiftCounts,
  type PosCashMovementDecision,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { contractPending } from "./api";
import { runPosKasirMock, type PosKasirEngine } from "./mock-engine";
import { bookVarianceIdr, countLimitReached } from "./shift-extra-logic";
import type {
  DecideHeldCashInput,
  ForceCloseInput,
  ForceCloseView,
  HeldCashOutReview,
  OwnCountSummary,
  SubmitForcedCountInput,
  WitnessForcedCountInput,
} from "./shift-extra-types";
import type { SupervisorOption } from "./types";

function local<T>(
  feature: string,
  call: (engine: PosKasirEngine) => T,
): Promise<T> {
  if (!API_MOCK) return Promise.reject(contractPending(feature));
  return runPosKasirMock(call);
}

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
    return runPosKasirMock((engine) => engine.decideHeldCashMovement(input));
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

/** The cashier's latest count. Server side the cashier receipt is the only blind source. */
export const fetchOwnCountSummary = (
  shiftId: string,
): Promise<OwnCountSummary | null> =>
  local("ringkasan hitungan kasir", (engine) =>
    engine.ownCountSummary(shiftId),
  );

export const fetchWitnesses = (): Promise<SupervisorOption[]> =>
  local("daftar penyetuju tutup paksa", (engine) => engine.witnesses());

export const fetchForceCloseView = (shiftId: string): Promise<ForceCloseView> =>
  local("tutup paksa shift", (engine) => engine.forceCloseView(shiftId));

export const submitForcedCount = (
  input: SubmitForcedCountInput,
): Promise<ForceCloseView> =>
  local("hitungan tutup paksa", (engine) => engine.submitForcedCount(input));

export const witnessForcedCount = (
  input: WitnessForcedCountInput,
): Promise<ForceCloseView> =>
  local("persetujuan orang ketiga", (engine) =>
    engine.witnessForcedCount(input),
  );

export const forceCloseShift = (
  input: ForceCloseInput,
): Promise<ForceCloseView> =>
  local("tutup paksa shift", (engine) => engine.forceClose(input));
