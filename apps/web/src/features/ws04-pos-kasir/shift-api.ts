// Shift, supervisor and end-of-day calls of the POS kasir (split from ./api.ts,
// brief 1268 W0). Same rules as ./api.ts: components use the hooks in
// ./shift-hooks.ts, and a call without a contract runs on the mock engine in
// mock mode and fails with CONTRACT_PENDING everywhere else.
import {
  closePosDay,
  closePosShift,
  getEndOfDayRecap,
  getPosShift,
  getPosShiftPrint,
  listPosCashMovements,
  listPosShifts,
  openPosShift,
  PosError,
  recordPosCashMovement,
  submitPosShiftCount,
  type EndOfDayRecapView,
  type PosShift,
  type PrintPaperWidth,
} from "@starter/shared/pos";
import {
  createPosOverride,
  getPosOverride,
  listPosOverrideApprovers,
} from "@starter/shared/access/override";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { contractPending, local, METHOD_LABELS } from "./api";
import { countPendingOfflineSales } from "./offline/queue";
import { defaultOfflineBackend } from "./offline/store";
import { runPosKasirMock } from "./mock-engine";
import {
  clearStoredCount,
  readStoredCount,
  writeStoredCount,
} from "./shift-count-store";
import {
  type ActiveShift,
  type ApproveShiftCloseInput,
  type BlindCountReceipt,
  type CashMovement,
  type CloseDayInput,
  type CloseShiftWithApprovalInput,
  type DayCloseRecap,
  type OpenShiftInput,
  type OverrideAction,
  type OverrideResult,
  type RecordCashMovementInput,
  type RegisteredTerminal,
  type RequestOverrideInput,
  type ShiftReview,
  type SubmitBlindCountInput,
  type SupervisorOption,
} from "./types";

const CHANNEL_LABELS: Record<string, string> = {
  qr: "QR pelanggan",
  pos: "Kasir",
  captain: "Captain order",
  gofood: "GoFood",
  grabfood: "GrabFood",
  shopeefood: "ShopeeFood",
  reservation: "Reservasi",
  kiosk: "Kiosk",
  facility: "Sarapan fasilitas",
};

// ---- Typed endpoints (raw) -------------------------------------------------

export async function fetchShifts(outletId: string, signal?: AbortSignal) {
  const page = await callEndpoint(
    listPosShifts,
    { params: { outletId }, query: {} },
    { signal },
  );
  return page.data;
}

export async function fetchShiftReport(
  outletId: string,
  shiftId: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getPosShift,
    { params: { outletId, shiftId } },
    { signal },
  );
  return data;
}

/** P3: the closing report as ESC/POS bytes for this tablet's own printer. */
export async function fetchShiftPrint(
  outletId: string,
  shiftId: string,
  paperWidth: PrintPaperWidth,
  reprint: boolean,
) {
  const { data } = await callEndpoint(getPosShiftPrint, {
    params: { outletId, shiftId },
    query: { paperWidth, reprint: reprint ? "true" : "false" },
  });
  return data;
}

export async function fetchOverride(overrideId: string) {
  const { data } = await callEndpoint(getPosOverride, {
    params: { overrideId },
  });
  return data;
}

/** Raw close call: the body still wants `approvalRequestId` (a contract gap). */
export const postCloseShiftRaw = closePosShift;

// ---- Mapping real responses to the screen view-models ----------------------

function activeShiftFrom(shift: PosShift): ActiveShift {
  return {
    id: shift.id,
    // The shift row has no number or names yet (gap): short id and neutral text.
    shiftNo: shift.id.slice(0, 8),
    status: shift.status,
    cashierName: "",
    terminalLabel: "",
    businessDate: shift.businessDate,
    openedAt: shift.openedAt,
    openingFloatIdr: Number(shift.openingFloatIdr),
    countSubmitted: false,
  };
}

function dayRecapFrom(recap: EndOfDayRecapView, cutoff: string): DayCloseRecap {
  // The blind view (legend-awg5p) blanks the drawer figures with null; keep
  // them null so the screen shows a dash, never a made-up 0.
  const hidden = "drawerFiguresHidden" in recap;
  const closedDevices = recap.devices.filter((d) => d.closed);
  return {
    businessDate: recap.businessDate,
    cutoffTime: cutoff,
    status: recap.status,
    totalSalesIdr: Number(recap.totalSalesIdr),
    refundIdr: Number(recap.totalRefundsIdr),
    voidIdr: Number(recap.totalVoidsIdr),
    depositAppliedIdr: Number(recap.totalDepositAppliedIdr ?? 0),
    depositRefundedIdr: Number(recap.totalDepositRefundedIdr ?? 0),
    channels: recap.channels.map((row) => ({
      code: row.channel,
      label: CHANNEL_LABELS[row.channel] ?? row.channel,
      amountIdr: Number(row.totalIdr),
    })),
    shifts: {
      total: recap.devices.reduce((sum, d) => sum + d.shiftCount, 0),
      closed: closedDevices.reduce((sum, d) => sum + d.shiftCount, 0),
      terminals: recap.devices.length,
      cashVarianceIdr:
        recap.totalVarianceIdr === null ? null : Number(recap.totalVarianceIdr),
    },
    netPayments: recap.tenders.map((row) => ({
      code: row.method,
      label: METHOD_LABELS[row.method] ?? row.method,
      netIdr: row.netIdr === null ? null : Number(row.netIdr),
    })),
    totalNetIdr: recap.tenders.reduce<number | null>(
      (sum, row) =>
        sum === null || row.netIdr === null ? null : sum + Number(row.netIdr),
      0,
    ),
    ...(hidden ? { drawerFiguresHidden: true } : {}),
    // Settlement per bank and unmatched standalone are not in the contract yet.
    settlement: null,
    standaloneUnmatched: null,
    unsyncedReceiptCount: recap.unsyncedReceiptCount,
    stockDeduction: {
      available: true,
      applied: recap.inventoryDeductionApplied,
    },
    ...(recap.status === "closed" && recap.closedAt
      ? {
          result: {
            closedAt: recap.closedAt,
            closedByName: "",
            localRecapSaved: true,
            batches: [],
            accounting:
              recap.accountingSync.status === "posted"
                ? ("synced" as const)
                : ("queued" as const),
            standaloneUnmatched: 0,
            stockDeductionApplied: recap.inventoryDeductionApplied,
          },
        }
      : {}),
  };
}

// ---- Shift -----------------------------------------------------------------

export async function fetchActiveShift(
  outletId: string,
  signal?: AbortSignal,
): Promise<ActiveShift | null> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.activeShift());
  const shifts = await fetchShifts(outletId, signal);
  const open = shifts.find((shift) => shift.status === "open");
  if (!open) return null;
  // A count the cashier already sent is kept on this device (the server never
  // reads one back to a cashier): the shift then waits for the supervisor.
  return {
    ...activeShiftFrom(open),
    countSubmitted: readStoredCount(outletId, open.id) !== null,
  };
}

export async function openShift(
  outletId: string,
  input: OpenShiftInput,
  idempotencyKey: string,
): Promise<ActiveShift> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.openShift(input));
  const { data } = await callEndpoint(openPosShift, {
    params: { outletId },
    body: {
      openingFloatIdr: input.openingFloatIdr,
      idempotencyKey,
    },
  });
  return activeShiftFrom(data);
}

export async function fetchCashMovements(
  outletId: string,
  shiftId: string,
  signal?: AbortSignal,
): Promise<CashMovement[]> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.cashMovements(shiftId));
  const page = await callEndpoint(
    listPosCashMovements,
    { params: { outletId, shiftId }, query: {} },
    { signal },
  );
  return page.data.map((row) => ({
    id: row.id,
    type: row.type,
    amountIdr: Number(row.amountIdr),
    reasonNote: row.reasonNote,
    recordedAt: row.recordedAt,
  }));
}

export async function recordCashMovement(
  outletId: string,
  input: RecordCashMovementInput,
  idempotencyKey: string,
): Promise<CashMovement> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.recordCashMovement(input));
  const { data } = await callEndpoint(recordPosCashMovement, {
    params: { outletId, shiftId: input.shiftId },
    body: {
      type: input.type,
      amountIdr: input.amountIdr,
      reasonNote: input.reasonNote,
      idempotencyKey,
    },
  });
  return {
    id: data.id,
    type: data.type,
    amountIdr: Number(data.amountIdr),
    reasonNote: data.reasonNote,
    recordedAt: data.recordedAt,
  };
}

/**
 * The blind count, per denomination (the contract has no lump sum: the cashier
 * form lists every denomination). The answer is blind too; the receipt is kept
 * so the close can name the count.
 */
export async function submitBlindCount(
  outletId: string,
  input: SubmitBlindCountInput,
  idempotencyKey: string,
): Promise<BlindCountReceipt> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.submitBlindCount(input));
  if (input.otherAmountIdr !== 0)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Hitung semua pecahan satu per satu sebelum mengirim.",
    );
  const counted = input.counts.filter((line) => line.quantity > 0);
  const [first] = input.counts;
  const lines = counted.length > 0 ? counted : first ? [first] : [];
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
  const count = {
    countId: data.id,
    sequence: data.sequence,
    countedIdr: Number(data.countedIdr),
    noteRequired: data.noteRequired,
  };
  writeStoredCount(outletId, input.shiftId, {
    ...count,
    submittedAt: data.submittedAt,
  });
  return {
    shiftId: data.shiftId,
    status: "awaiting_supervisor",
    submittedAt: data.submittedAt,
    count,
  };
}

/** The cashier starts a new count: the stored one no longer counts. */
export function discardOwnCount(outletId: string, shiftId: string): void {
  clearStoredCount(outletId, shiftId);
}

export const fetchRegisteredTerminals = (): Promise<RegisteredTerminal[]> =>
  local("terminal terdaftar", (engine) => engine.registeredTerminals());

// ---- Supervisor ------------------------------------------------------------

/**
 * Supervisors who may approve `action` here (server-filtered, 1268 B3). Without
 * an action the call has no contract yet (corrections still use the mock).
 */
export async function fetchSupervisors(
  outletId: string,
  action?: OverrideAction,
): Promise<SupervisorOption[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.supervisors());
  const endpointAction = action
    ? OVERRIDE_ENDPOINT_ACTIONS.find((item) => item === action)
    : undefined;
  if (!endpointAction) throw contractPending("daftar supervisor");
  const { data } = await callEndpoint(listPosOverrideApprovers, {
    query: { outletId, action: endpointAction },
  });
  return data.map((row) => ({ userId: row.userId, name: row.displayName }));
}

export const fetchShiftReview = (shiftId: string): Promise<ShiftReview> =>
  local("tinjauan tutup shift", (engine) => engine.shiftReview(shiftId));

const OVERRIDE_ENDPOINT_ACTIONS = [
  "void",
  "discount",
  "refund",
  "cash_drawer_open",
  "price_correction",
  "cash_shift_close",
] as const;

export async function requestOverride(
  outletId: string,
  input: RequestOverrideInput,
): Promise<OverrideResult> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.requestOverride(input));
  const action = OVERRIDE_ENDPOINT_ACTIONS.find(
    (item) => item === input.action,
  );
  // `edc_standalone` has its own call in ./api.ts (gap).
  if (!action) throw contractPending(`persetujuan ${input.action}`);
  const { data } = await callEndpoint(createPosOverride, {
    body: {
      outletId,
      action,
      valueIdr: input.valueIdr,
      reason: input.reason,
      objectType: input.objectType,
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: input.approverUserId,
        pin: input.pin,
      },
    },
  });
  return { overrideId: data.id, approvedByName: "" };
}

export const approveShiftClose = (
  input: ApproveShiftCloseInput,
): Promise<ShiftReview> =>
  local("persetujuan tutup shift (overrideId)", (engine) =>
    engine.approveShiftClose(input),
  );

/** Answers that mean the stored count or approval cannot be used any more. */
const CLOSE_STALE_CODES = new Set([
  "SHIFT_COUNT_STALE",
  "SHIFT_COUNT_SUPERSEDED",
]);
export const isCloseStale = (error: unknown): boolean =>
  error instanceof ApiError && CLOSE_STALE_CODES.has(error.code);
/** The shift is already closed (maybe by this very request): read it again. */
export const isCloseSettled = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === "SHIFT_ALREADY_CLOSED" ||
    error.code === "IDEMPOTENCY_KEY_REUSED");
export const isQrisHoldBlock = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "QRIS_HOLD_ACTIVE";

/**
 * Close from the cashier's device (1268 W3): the supervisor's PIN decision is
 * the override of this exact count (objectType `pos_shift_count`, requested by
 * the cashier), then the close names it. The cashier never sees expected or
 * variance. `overrideId` of an earlier try is reused: only the close repeats.
 */
export async function closeShiftWithApproval(
  outletId: string,
  input: CloseShiftWithApprovalInput,
  existing: { overrideId: string } | null,
  closeKey: string,
  onApproved: (overrideId: string) => void,
): Promise<void> {
  const reason = input.reason.trim();
  // O3 (CTO O2 (a)): offline sales still on this tablet hold drawer cash the
  // shift does not count yet. Refused before any PIN; the count also goes to
  // the server, which refuses too. Unreadable storage throws: never a guess.
  const offlineQueuePending = await countPendingOfflineSales(
    defaultOfflineBackend(),
    outletId,
  );
  if (offlineQueuePending > 0) {
    const refusal = new PosError("OFFLINE_QUEUE_PENDING");
    throw new ApiError(refusal.status, refusal.code, refusal.message);
  }
  if (API_MOCK) {
    const approved =
      existing ??
      (await requestOverride(outletId, {
        action: "cash_shift_close",
        valueIdr: 0,
        reason,
        objectType: "cash_shift",
        objectId: input.shiftId,
        approverUserId: input.approverUserId,
        pin: input.pin,
      }));
    onApproved(approved.overrideId);
    await runPosKasirMock((engine) =>
      engine.approveShiftClose({
        shiftId: input.shiftId,
        overrideId: approved.overrideId,
        reason,
      }),
    );
    return;
  }
  const approved =
    existing ??
    (await requestOverride(outletId, {
      action: "cash_shift_close",
      valueIdr: 0,
      reason,
      objectType: "pos_shift_count",
      objectId: input.countId,
      approverUserId: input.approverUserId,
      pin: input.pin,
    }));
  onApproved(approved.overrideId);
  await callEndpoint(closePosShift, {
    params: { outletId, shiftId: input.shiftId },
    body: {
      countId: input.countId,
      ...(input.noteRequired ? { varianceNote: reason } : {}),
      approvedBy: input.approverUserId,
      approvalRequestId: approved.overrideId,
      idempotencyKey: closeKey,
      offlineQueuePending,
    },
  });
  clearStoredCount(outletId, input.shiftId);
}

// ---- End of day ------------------------------------------------------------

export async function fetchDayCloseRecap(
  outletId: string,
  businessDate: string,
  cutoff: string,
  signal?: AbortSignal,
): Promise<DayCloseRecap> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.dayRecap());
  const { data } = await callEndpoint(
    getEndOfDayRecap,
    { params: { outletId }, query: { businessDate } },
    { signal },
  );
  return dayRecapFrom(data, cutoff);
}

export async function closeDay(
  outletId: string,
  businessDate: string,
  cutoff: string,
  input: CloseDayInput,
  idempotencyKey: string,
): Promise<DayCloseRecap> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.closeDay(input));
  const { data } = await callEndpoint(closePosDay, {
    params: { outletId },
    body: {
      businessDate,
      inventoryDeduction: input.inventoryDeduction,
      idempotencyKey,
    },
  });
  return dayRecapFrom(data, cutoff);
}
