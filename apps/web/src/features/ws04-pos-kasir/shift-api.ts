// Shift, supervisor and end-of-day calls of the POS kasir (split from ./api.ts,
// brief 1268 W0). Same rules as ./api.ts: components use the hooks in
// ./shift-hooks.ts, and a call without a contract runs on the mock engine in
// mock mode and fails with CONTRACT_PENDING everywhere else.
import {
  closePosDay,
  closePosShift,
  getEndOfDayRecap,
  getPosShift,
  listPosCashMovements,
  listPosShifts,
  openPosShift,
  recordPosCashMovement,
  type EndOfDayRecapView,
  type PosShift,
} from "@starter/shared/pos";
import {
  createPosOverride,
  getPosOverride,
} from "@starter/shared/access/override";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { contractPending, local, METHOD_LABELS } from "./api";
import { runPosKasirMock } from "./mock-engine";
import {
  type ActiveShift,
  type ApproveShiftCloseInput,
  type BlindCountReceipt,
  type CashMovement,
  type CloseDayInput,
  type DayCloseRecap,
  type OpenShiftInput,
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
  return open ? activeShiftFrom(open) : null;
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

export const submitBlindCount = (
  input: SubmitBlindCountInput,
): Promise<BlindCountReceipt> =>
  local("hitungan kas buta", (engine) => engine.submitBlindCount(input));

export const fetchRegisteredTerminals = (): Promise<RegisteredTerminal[]> =>
  local("terminal terdaftar", (engine) => engine.registeredTerminals());

// ---- Supervisor ------------------------------------------------------------

export const fetchSupervisors = (): Promise<SupervisorOption[]> =>
  local("daftar supervisor", (engine) => engine.supervisors());

export const fetchShiftReview = (shiftId: string): Promise<ShiftReview> =>
  local("tinjauan tutup shift", (engine) => engine.shiftReview(shiftId));

const OVERRIDE_ENDPOINT_ACTIONS = [
  "void",
  "discount",
  "refund",
  "cash_drawer_open",
  "price_correction",
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
  // `cash_shift_close` and `edc_standalone` are not override actions yet (gap).
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
