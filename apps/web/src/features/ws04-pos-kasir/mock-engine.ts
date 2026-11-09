// In-memory "server" behind VITE_API_MOCK for the POS kasir flows (bead
// legend-mjmm): payment sessions (split, cash, QRIS, VA, e-wallet, card, EDC),
// customer codes, cashier shifts with blind count, supervisor overrides and day
// close. It enforces the rules the real API will: a payment never exceeds the
// remaining balance, cash change is computed here, an unknown EDC result locks
// every other payment until it is checked, the cashier never sees the system
// cash figure, an override is single-use and a PIN locks after five misses.
//
// State is plain JSON so it survives a reload (sessionStorage, see
// `getPosKasirEngine`). `?demo=<seed>` (./demo-seed.ts) seeds a state for the
// mockup screens; only this file reads it. Relative imports only: Node tests
// load it directly.
import { ApiError, NETWORK_ERROR_MESSAGE } from "../../lib/api/errors.ts";
import {
  SCENARIO_STORAGE_KEY,
  getLatencyMs,
  getScenario,
  isMockScenario,
  setScenario,
} from "../../lib/mock/control.ts";
import {
  DEMO_CODE_ORDER_ID,
  DEMO_ORDER_ID,
  DEMO_SHIFT_ID,
  canonicalOrderId,
  dayDemoSeed,
  payDemoSeed,
  readDemoSeed,
  shiftDemoSeed,
  type PayDemoSeed,
} from "./demo-seed.ts";
import {
  DEMO_BUSINESS_DATE,
  DEMO_EDC_APPROVAL,
  DEMO_EDC_BANK_REF,
  DEMO_QRIS_CONFIRMED_AT,
  MAX_PIN_MISSES,
  MOCK_SUPERVISOR_PIN,
  codeOrder,
  dayFixture,
  demoBlindCount,
  demoMovements,
  demoOrder,
  demoShift,
  edcTerminals,
  ewallets,
  paymentMethods,
  registeredTerminals,
  supervisorOptions,
  vaBanks,
} from "./fixtures.ts";
import type {
  ActiveShift,
  ApproveShiftCloseInput,
  AttemptRef,
  BlindCountReceipt,
  CashMovement,
  CashierCodeOrder,
  CloseDayInput,
  ConfirmCashInput,
  DayCloseRecap,
  DayCloseResult,
  EdcTerminal,
  EngineAttempt,
  EngineOrder,
  EngineShift,
  EngineState,
  EngineTender,
  Ewallet,
  OpenShiftInput,
  OverrideResult,
  PaymentAttempt,
  PaymentBill,
  PaymentMethodCode,
  PaymentMethodOption,
  PaymentSession,
  ReceiptResult,
  RecordCashMovementInput,
  RecordEdcStandaloneInput,
  RegisteredTerminal,
  RequestOverrideInput,
  ShiftReview,
  StartPaymentInput,
  SubmitBlindCountInput,
  SupervisorOption,
  VaBank,
} from "./types.ts";

/** An EDC request resolves this long after it was sent (bank answer stand-in). */
export const EDC_AUTO_CONFIRM_MS = 3000;
export const QRIS_TTL_MS = 10 * 60 * 1000;
export const VA_TTL_MS = 60 * 60 * 1000;
export const WALLET_TTL_MS = 15 * 60 * 1000;
const ENGINE_STORAGE_KEY = "legend-pos-kasir-mock-engine:v1";

// ---- Arithmetic (exported: the unit test covers these) ---------------------

/** The part of a reservation deposit this bill uses: never above the total. */
export function depositUsedIdr(totalIdr: number, depositIdr: number): number {
  return Math.min(Math.max(depositIdr, 0), totalIdr);
}

/** Deposit above the bill becomes customer balance (founder Q7). */
export function depositSurplusIdr(
  totalIdr: number,
  depositIdr: number,
): number {
  return Math.max(depositIdr - totalIdr, 0);
}

/** What is still to pay: total - deposit used - confirmed payments. */
export function remainingIdr(
  totalIdr: number,
  depositIdr: number,
  paidIdr: number,
): number {
  return Math.max(totalIdr - depositUsedIdr(totalIdr, depositIdr) - paidIdr, 0);
}

/** Cash change: received - the amount applied to the bill. */
export function cashChangeIdr(receivedIdr: number, appliedIdr: number): number {
  return receivedIdr - appliedIdr;
}

/** Cash expected in the drawer: float + sales - refunds + in - out - drops. */
export function expectedCashIdr(shift: {
  openingFloatIdr: number;
  cashSalesIdr: number;
  cashRefundsIdr: number;
  cashInIdr: number;
  cashOutIdr: number;
  cashDropIdr: number;
}): number {
  return (
    shift.openingFloatIdr +
    shift.cashSalesIdr -
    shift.cashRefundsIdr +
    shift.cashInIdr -
    shift.cashOutIdr -
    shift.cashDropIdr
  );
}

/** counted - expected: negative is short, positive is over. */
export function cashVarianceIdr(countedIdr: number, expectedIdr: number) {
  return countedIdr - expectedIdr;
}

/** Notes and coins counted: sum of denomination x quantity + the other amount. */
export function countedTotalIdr(
  counts: readonly { denominationIdr: number; quantity: number }[],
  otherAmountIdr: number,
): number {
  return (
    counts.reduce(
      (sum, line) => sum + line.denominationIdr * line.quantity,
      0,
    ) + otherAmountIdr
  );
}

// ---- Helpers ---------------------------------------------------------------

const pad = (value: number, length: number) =>
  String(value).padStart(length, "0");
const iso = (ms: number) => new Date(ms).toISOString();
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validation(message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message);
}
function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}
function notFound(message: string): never {
  throw new ApiError(404, "NOT_FOUND", message);
}

const isWholeIdr = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** Receipt number of a paid order: device prefix + ordinal from the order number. */
function receiptNumberFor(order: EngineOrder): string {
  const digits = order.orderNo.replace(/\D/g, "");
  return `POS01-${pad(Number(digits) || 1, 6)}`;
}

function emptyState(): EngineState {
  return {
    orders: {},
    shift: null,
    movements: [],
    overrides: {},
    pinMisses: {},
    day: null,
    applied: {},
    counters: { override: 0, movement: 0, shift: 0, id: 0 },
  };
}

export type EngineOptions = {
  clock?: () => number;
  /** The raw `?demo=` value; the browser engine reads the page URL. */
  readSeed?: () => string | null;
  /** "empty" makes the lists and lookups come back empty. */
  scenario?: () => string;
};

export function createPosKasirEngine(options: EngineOptions = {}) {
  const clock = options.clock ?? Date.now;
  const readSeed = options.readSeed ?? (() => null);
  const scenario = options.scenario ?? (() => "normal");
  let state = emptyState();

  const nextId = () => {
    state.counters.id += 1;
    return `00000000-0000-4000-8000-${pad(state.counters.id, 12)}`;
  };

  // ---- Seeding ------------------------------------------------------------

  function seedOrder(id: string, seed: PayDemoSeed): EngineOrder {
    const now = clock();
    const order = id === DEMO_CODE_ORDER_ID ? codeOrder() : demoOrder();
    if (id === DEMO_CODE_ORDER_ID) return order;
    const posRef = `${order.orderNo}-01`;
    const qris = (
      status: EngineAttempt["status"],
      amountIdr: number,
      extra: Partial<EngineAttempt> = {},
    ): EngineAttempt => ({
      id: nextId(),
      sequence: 1,
      method: "qris",
      status,
      amountIdr,
      startedAtMs: now,
      ...extra,
    });
    const tender = (
      method: PaymentMethodCode,
      label: string,
      amountIdr: number,
      extra: Partial<EngineTender> = {},
    ): EngineTender => ({
      id: nextId(),
      method,
      label,
      amountIdr,
      confirmedAt: DEMO_QRIS_CONFIRMED_AT,
      ...extra,
    });
    const edcAttempt = (
      status: EngineAttempt["status"],
      extra: Partial<EngineAttempt> = {},
    ): EngineAttempt => ({
      id: nextId(),
      sequence: 1,
      method: "edc",
      status,
      amountIdr: 148_000,
      startedAtMs: now,
      posRef,
      edc: {
        terminalId: edcTerminals[0].id,
        terminalLabel: edcTerminals[0].label,
        bank: edcTerminals[0].bank,
        mode: "card",
        lockedAmountIdr: 148_000,
      },
      ...extra,
    });
    switch (seed) {
      case "baru":
        break;
      case "split": {
        const attempt = qris("confirmed", 100_000, {
          startedAtMs: now - 5 * 60_000,
        });
        order.attempts.push(attempt);
        order.tenders.push(
          tender("qris", "QRIS", 100_000, { attemptId: attempt.id }),
        );
        break;
      }
      case "qris-aktif":
        order.attempts.push(
          qris("waiting", 148_000, { expiresAt: iso(now + 522_000) }),
        );
        break;
      case "qris-kedaluwarsa":
        order.attempts.push(
          qris("waiting", 148_000, { expiresAt: iso(now - 1000) }),
        );
        break;
      case "gagal":
        order.attempts.push(qris("failed", 148_000));
        order.checkOutcome = "fail";
        break;
      case "va":
        order.attempts.push({
          id: nextId(),
          sequence: 1,
          method: "va",
          status: "waiting",
          amountIdr: 148_000,
          startedAtMs: now,
          expiresAt: iso(now + VA_TTL_MS),
          va: {
            bank: "Bank BCA",
            number: "7001 2345 6789",
            deadline: iso(now + VA_TTL_MS),
          },
        });
        break;
      case "edc-menunggu":
        order.attempts.push(edcAttempt("waiting"));
        break;
      case "edc-tidak-pasti":
        order.attempts.push(
          edcAttempt("unknown", { startedAtMs: now - 60_000 }),
        );
        break;
      case "edc-berhasil": {
        const attempt = edcAttempt("confirmed", {
          startedAtMs: now - 30_000,
          cardMasked: "Kartu debit · •••• 4821",
          bankRef: DEMO_EDC_BANK_REF,
          approvalCode: DEMO_EDC_APPROVAL,
        });
        order.attempts.push(attempt);
        order.tenders.push(
          tender("edc", attempt.edc?.terminalLabel ?? "EDC", 148_000, {
            attemptId: attempt.id,
            reference: DEMO_EDC_BANK_REF,
          }),
        );
        order.receiptNo = receiptNumberFor(order);
        break;
      }
      case "lunas": {
        const attempt = qris("confirmed", 100_000, {
          startedAtMs: now - 5 * 60_000,
        });
        order.attempts.push(attempt);
        order.tenders.push(
          tender("qris", "QRIS", 100_000, { attemptId: attempt.id }),
          tender("cash", "Tunai", 48_000, {
            confirmedAt: iso(now),
            receivedIdr: 50_000,
            changeIdr: 2_000,
          }),
        );
        order.receiptNo = receiptNumberFor(order);
        break;
      }
    }
    return order;
  }

  /** The order for an id, seeded on first use or when `?demo=` changes. */
  function orderOf(rawId: string): EngineOrder {
    const id = canonicalOrderId(rawId);
    const known = id === DEMO_ORDER_ID || id === DEMO_CODE_ORDER_ID;
    if (!known && !state.orders[id]) notFound("Pesanan tidak ditemukan.");
    const seed = id === DEMO_ORDER_ID ? payDemoSeed(readSeed()) : null;
    const key = `pay:${id}`;
    if (!state.orders[id] || (seed !== null && state.applied[key] !== seed)) {
      const effective = seed ?? "baru";
      state.orders[id] = seedOrder(id, effective);
      state.applied[key] = effective;
    }
    return state.orders[id];
  }

  function seedShifts() {
    const seed = shiftDemoSeed(readSeed());
    if (seed === null || state.applied.shift === seed) return;
    state.applied.shift = seed;
    state.shift = demoShift("open");
    state.movements = demoMovements();
    state.counters.shift = 0;
  }

  function dayOf() {
    const seed = dayDemoSeed(readSeed());
    if (seed !== null && state.applied.day !== seed) {
      state.applied.day = seed;
      state.day = {
        status: "closed",
        inventoryDeduction: false,
        standaloneUnmatched: dayFixture.standaloneUnmatched,
        result: {
          // A few minutes before now, so the closed state matches the clock.
          closedAt: iso(clock() - 5 * 60_000),
          closedByName: dayFixture.managerName,
          localRecapSaved: true,
          batches: dayFixture.settlement.map((row) => ({
            bank: row.bank,
            status: "success" as const,
          })),
          accounting: "queued",
          standaloneUnmatched: dayFixture.standaloneUnmatched,
          stockDeductionApplied: false,
        },
      };
    }
    if (!state.day)
      state.day = {
        status: "open",
        inventoryDeduction: false,
        standaloneUnmatched: dayFixture.standaloneUnmatched,
        result: null,
      };
    return state.day;
  }

  // ---- Payment ------------------------------------------------------------

  const paidIdr = (order: EngineOrder) =>
    order.tenders.reduce((sum, tender) => sum + tender.amountIdr, 0);
  const remainingOf = (order: EngineOrder) =>
    remainingIdr(order.totalIdr, order.deposit?.amountIdr ?? 0, paidIdr(order));

  /** Resolves what time decides: an EDC answer after a few seconds. */
  function settle(order: EngineOrder) {
    const now = clock();
    for (const attempt of order.attempts)
      if (
        attempt.method === "edc" &&
        attempt.status === "waiting" &&
        !attempt.standalone &&
        now - attempt.startedAtMs >= EDC_AUTO_CONFIRM_MS
      )
        resolveAttempt(order, attempt);
  }

  const isExpired = (attempt: EngineAttempt) =>
    attempt.status === "waiting" &&
    attempt.method !== "edc" &&
    attempt.expiresAt !== undefined &&
    Date.parse(attempt.expiresAt) <= clock();

  /** An attempt that blocks any other payment on the bill. */
  const isLive = (attempt: EngineAttempt) =>
    attempt.status === "unknown" ||
    (attempt.status === "waiting" && !isExpired(attempt));

  function labelOf(attempt: EngineAttempt): string {
    if (attempt.method === "qris") return "QRIS";
    if (attempt.method === "va") return "Virtual Account";
    if (attempt.method === "ewallet")
      return attempt.ewallet?.label ?? "E-wallet";
    if (attempt.method === "card") return "Kartu kredit/debit";
    if (attempt.method === "edc") return attempt.edc?.terminalLabel ?? "EDC";
    return "Tunai";
  }

  function addTender(order: EngineOrder, tender: EngineTender) {
    order.tenders.push(tender);
    order.version += 1;
    if (remainingOf(order) === 0 && order.receiptNo === null)
      order.receiptNo = receiptNumberFor(order);
    if (tender.method === "cash" && state.shift?.status === "open")
      state.shift.cashSalesIdr += tender.amountIdr;
  }

  /** Settles an attempt as the order's stored outcome says (confirm or fail). */
  function resolveAttempt(order: EngineOrder, attempt: EngineAttempt) {
    if (order.checkOutcome === "fail" && attempt.method !== "edc") {
      attempt.status = "failed";
      return;
    }
    attempt.status = "confirmed";
    if (attempt.method === "edc") {
      attempt.cardMasked =
        attempt.edc?.mode === "qris"
          ? "QRIS di EDC"
          : "Kartu debit · •••• 4821";
      attempt.bankRef = DEMO_EDC_BANK_REF;
      attempt.approvalCode = DEMO_EDC_APPROVAL;
    }
    addTender(order, {
      id: nextId(),
      method: attempt.method,
      label: labelOf(attempt),
      amountIdr: attempt.amountIdr,
      confirmedAt: iso(clock()),
      reference: attempt.bankRef,
      attemptId: attempt.id,
    });
  }

  /** A failed or expired attempt is done once the cashier moves on. */
  function archiveStale(order: EngineOrder) {
    for (const attempt of order.attempts)
      if (attempt.status === "failed" || isExpired(attempt))
        attempt.status = "cancelled";
  }

  function attemptView(attempt: EngineAttempt): PaymentAttempt {
    const status = isExpired(attempt)
      ? "expired"
      : (attempt.status as PaymentAttempt["status"]);
    return {
      id: attempt.id,
      sequence: attempt.sequence,
      method: attempt.method,
      status,
      amountIdr: attempt.amountIdr,
      ...(attempt.expiresAt ? { expiresAt: attempt.expiresAt } : {}),
      ...(attempt.va ? { va: attempt.va } : {}),
      ...(attempt.ewallet ? { ewallet: attempt.ewallet } : {}),
      ...(attempt.edc ? { edc: attempt.edc } : {}),
      ...(attempt.cardMasked ? { cardMasked: attempt.cardMasked } : {}),
      ...(attempt.bankRef ? { bankRef: attempt.bankRef } : {}),
      ...(attempt.approvalCode ? { approvalCode: attempt.approvalCode } : {}),
      ...(attempt.posRef ? { posRef: attempt.posRef } : {}),
      ...(attempt.standalone ? { standalone: true } : {}),
    };
  }

  function billOf(order: EngineOrder): PaymentBill {
    const remaining = remainingOf(order);
    const depositIdr = order.deposit?.amountIdr ?? 0;
    return {
      tableLabel: order.tableLabel,
      orderNo: order.orderNo,
      itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
      guestCount: order.guestCount,
      subtotalIdr: order.subtotalIdr,
      serviceIdr: order.serviceIdr,
      taxIdr: order.taxIdr,
      totalIdr: order.totalIdr,
      ...(order.deposit
        ? {
            deposit: {
              reference: order.deposit.reference,
              amountIdr: depositUsedIdr(order.totalIdr, depositIdr),
              paid: true,
            },
          }
        : {}),
      depositSurplusIdr: depositSurplusIdr(order.totalIdr, depositIdr),
      allocations: order.tenders.map((tender) => ({
        id: tender.id,
        method: tender.method,
        label: tender.label,
        amountIdr: tender.amountIdr,
        status: "confirmed" as const,
        confirmedAt: tender.confirmedAt,
        ...(tender.reference ? { reference: tender.reference } : {}),
      })),
      remainingIdr: remaining,
      paid: remaining === 0,
    };
  }

  function sessionOf(order: EngineOrder): PaymentSession {
    settle(order);
    const bill = billOf(order);
    const live = order.attempts.filter((a) => a.status !== "cancelled");
    let attempt: EngineAttempt | undefined;
    if (bill.paid) {
      const lastId = order.tenders.at(-1)?.attemptId;
      attempt = lastId
        ? order.attempts.find((a) => a.id === lastId)
        : undefined;
    } else {
      const last = live.at(-1);
      attempt = last && last.status !== "confirmed" ? last : undefined;
    }
    const lastTender = order.tenders.at(-1);
    return {
      bill,
      activeAttempt: attempt ? attemptView(attempt) : null,
      ...(lastTender?.method === "cash" &&
      lastTender.receivedIdr !== undefined &&
      lastTender.changeIdr !== undefined
        ? {
            cash: {
              receivedIdr: lastTender.receivedIdr,
              changeIdr: lastTender.changeIdr,
            },
          }
        : {}),
      ...(order.receiptNo ? { receiptNo: order.receiptNo } : {}),
    };
  }

  function assertOpenBill(order: EngineOrder) {
    if (remainingOf(order) === 0)
      conflict("ALREADY_PAID", "Tagihan ini sudah lunas.");
  }

  function assertAmount(order: EngineOrder, amountIdr: number) {
    if (!isWholeIdr(amountIdr) || amountIdr <= 0)
      validation("Nominal harus lebih dari Rp0.");
    if (amountIdr > remainingOf(order))
      validation("Nominal tidak boleh melebihi sisa tagihan.");
  }

  function assertNoLiveAttempt(order: EngineOrder) {
    const live = order.attempts.find(isLive);
    if (!live) return;
    if (live.status === "unknown")
      conflict(
        "STATUS_UNKNOWN",
        "Hasil pembayaran sebelumnya belum pasti. Cek status dulu sebelum membayar lagi.",
      );
    conflict(
      "PAYMENT_IN_PROGRESS",
      "Masih ada pembayaran yang menunggu. Selesaikan atau batalkan dulu.",
    );
  }

  function findAttempt(order: EngineOrder, attemptId: string): EngineAttempt {
    const attempt = order.attempts.find((item) => item.id === attemptId);
    if (!attempt) notFound("Pembayaran tidak ditemukan.");
    return attempt;
  }

  function consumeOverride(
    overrideId: string,
    action: RequestOverrideInput["action"],
    objectId: string,
  ) {
    const override = state.overrides[overrideId];
    if (!override)
      throw new ApiError(
        403,
        "OVERRIDE_INVALID",
        "Persetujuan supervisor tidak ditemukan.",
      );
    if (
      override.action !== action ||
      canonicalOrderId(override.objectId) !== canonicalOrderId(objectId)
    )
      throw new ApiError(
        403,
        "OVERRIDE_INVALID",
        "Persetujuan supervisor ini untuk tindakan lain.",
      );
    if (override.usedFor !== null)
      throw new ApiError(
        409,
        "OVERRIDE_USED",
        "Persetujuan supervisor sudah dipakai.",
      );
    override.usedFor = objectId;
    return override;
  }

  // ---- Shift --------------------------------------------------------------

  function activeShiftView(shift: EngineShift): ActiveShift {
    return {
      id: shift.id,
      shiftNo: shift.shiftNo,
      status: shift.status,
      cashierName: shift.cashierName,
      terminalLabel: shift.terminalLabel,
      businessDate: shift.businessDate,
      openedAt: shift.openedAt,
      openingFloatIdr: shift.openingFloatIdr,
      countSubmitted: shift.count !== null,
    };
  }

  function shiftOf(shiftId: string): EngineShift {
    seedShifts();
    if (!state.shift && shiftId === DEMO_SHIFT_ID) {
      // The supervisor screen can be opened straight from a link.
      state.shift = demoShift("awaiting_approval");
      state.shift.count = {
        ...clone(demoBlindCount),
        submittedAt: "2026-11-08T08:32:00.000Z",
      };
      state.movements = demoMovements();
    }
    if (!state.shift || state.shift.id !== shiftId)
      notFound("Shift tidak ditemukan.");
    return state.shift;
  }

  function reviewOf(shift: EngineShift): ShiftReview {
    if (!shift.count)
      conflict("COUNT_NOT_SUBMITTED", "Kasir belum mengirim hitungan kas.");
    const expectedIdr = shift.closed?.expectedIdr ?? expectedCashIdr(shift);
    const counted = shift.count.countedIdr;
    return {
      shiftId: shift.id,
      shiftNo: shift.shiftNo,
      status: shift.status === "closed" ? "closed" : "awaiting_approval",
      cashierName: shift.cashierName,
      terminalLabel: shift.terminalLabel,
      businessDate: shift.businessDate,
      countedIdr: counted,
      expectedIdr,
      varianceIdr: cashVarianceIdr(counted, expectedIdr),
      breakdown: {
        openingFloatIdr: shift.openingFloatIdr,
        cashSalesIdr: shift.cashSalesIdr,
        cashRefundsIdr: shift.cashRefundsIdr,
        cashInIdr: shift.cashInIdr,
        cashOutIdr: shift.cashOutIdr,
        cashDropIdr: shift.cashDropIdr,
      },
      ...(shift.closed
        ? {
            varianceNote: shift.closed.varianceNote,
            approvedByName: shift.closed.approvedByName,
            closedAt: shift.closed.closedAt,
          }
        : {}),
    };
  }

  function buildDayRecap(): DayCloseRecap {
    const day = dayOf();
    const empty = scenario() === "empty";
    const liveShift = state.shift && state.shift.status !== "closed" ? 1 : 0;
    const result = day.result;
    return {
      businessDate: dayFixture.businessDate,
      cutoffTime: dayFixture.cutoffTime,
      status: day.status,
      totalSalesIdr: empty ? 0 : dayFixture.totalSalesIdr,
      refundIdr: dayFixture.refundIdr,
      voidIdr: dayFixture.voidIdr,
      channels: empty ? [] : clone([...dayFixture.channels]),
      shifts: empty
        ? { total: liveShift, closed: 0, terminals: 0, cashVarianceIdr: 0 }
        : {
            total: dayFixture.shifts.total + liveShift,
            closed: dayFixture.shifts.closed,
            terminals: dayFixture.shifts.terminals,
            cashVarianceIdr: dayFixture.shifts.cashVarianceIdr,
          },
      netPayments: empty ? [] : clone([...dayFixture.netPayments]),
      totalNetIdr: empty ? 0 : dayFixture.totalNetIdr,
      settlement: empty ? [] : clone([...dayFixture.settlement]),
      standaloneUnmatched: day.standaloneUnmatched,
      stockDeduction: {
        available: dayFixture.stockDeductionAvailable,
        applied: result?.stockDeductionApplied ?? false,
      },
      ...(result ? { result: clone(result) } : {}),
    };
  }

  // ---- Public API ---------------------------------------------------------

  return {
    snapshot(): EngineState {
      return clone(state);
    },
    restore(snapshot: EngineState) {
      state = { ...emptyState(), ...clone(snapshot) };
    },
    reset() {
      state = emptyState();
    },

    // Payment
    paymentMethods(): PaymentMethodOption[] {
      return scenario() === "empty" ? [] : clone(paymentMethods);
    },
    edcTerminals(): EdcTerminal[] {
      return scenario() === "empty" ? [] : clone(edcTerminals);
    },
    vaBanks(): VaBank[] {
      return scenario() === "empty" ? [] : clone(vaBanks);
    },
    ewallets(): Ewallet[] {
      return scenario() === "empty" ? [] : clone(ewallets);
    },

    session(orderId: string): PaymentSession {
      return sessionOf(orderOf(orderId));
    },

    startPayment(input: StartPaymentInput): PaymentSession {
      const order = orderOf(input.orderId);
      settle(order);
      assertOpenBill(order);
      assertNoLiveAttempt(order);
      assertAmount(order, input.amountIdr);
      archiveStale(order);
      const now = clock();
      const sequence =
        order.attempts.length +
        order.tenders.filter((t) => t.method === "cash").length +
        1;
      const attempt: EngineAttempt = {
        id: nextId(),
        sequence,
        method: input.method,
        status: "waiting",
        amountIdr: input.amountIdr,
        startedAtMs: now,
      };
      if (input.method === "qris") attempt.expiresAt = iso(now + QRIS_TTL_MS);
      if (input.method === "card") attempt.expiresAt = iso(now + WALLET_TTL_MS);
      if (input.method === "va") {
        const bank = vaBanks.find((item) => item.code === input.bankCode);
        if (!bank) validation("Pilih bank Virtual Account.");
        const number = `7001 ${pad(sequence, 4)} ${pad(state.counters.id, 4)}`;
        attempt.va = {
          bank: bank.label,
          number,
          deadline: iso(now + VA_TTL_MS),
        };
        attempt.expiresAt = iso(now + VA_TTL_MS);
      }
      if (input.method === "ewallet") {
        const wallet = ewallets.find((item) => item.code === input.walletCode);
        if (!wallet) validation("Pilih dompet digital.");
        attempt.ewallet = { code: wallet.code, label: wallet.label };
        attempt.expiresAt = iso(now + WALLET_TTL_MS);
      }
      if (input.method === "edc") {
        const terminal = edcTerminals.find((t) => t.id === input.terminalId);
        if (!terminal) validation("Pilih terminal EDC.");
        if (terminal.status !== "ready")
          conflict("TERMINAL_NOT_READY", "Terminal EDC belum siap.");
        attempt.edc = {
          terminalId: terminal.id,
          terminalLabel: terminal.label,
          bank: terminal.bank,
          mode: input.edcMode ?? "card",
          lockedAmountIdr: input.amountIdr,
        };
        attempt.posRef = `${order.orderNo}-${pad(sequence, 2)}`;
      }
      order.attempts.push(attempt);
      return sessionOf(order);
    },

    checkStatus(ref: AttemptRef): PaymentSession {
      const order = orderOf(ref.orderId);
      const attempt = findAttempt(order, ref.attemptId);
      settle(order);
      if (attempt.status === "unknown") {
        // The one way out of an unknown EDC result: ask the terminal again.
        if (order.checkOutcome === "fail") attempt.status = "failed";
        else resolveAttempt(order, attempt);
      } else if (attempt.status === "waiting" && !isExpired(attempt)) {
        if (attempt.method !== "edc") resolveAttempt(order, attempt);
      }
      return sessionOf(order);
    },

    refreshQris(ref: AttemptRef): PaymentSession {
      const order = orderOf(ref.orderId);
      const old = findAttempt(order, ref.attemptId);
      if (old.method !== "qris")
        conflict("NOT_QRIS", "Hanya QRIS yang bisa diperbarui.");
      if (old.status === "confirmed")
        conflict("ALREADY_PAID", "QRIS ini sudah dibayar.");
      if (isLive(old))
        conflict(
          "QRIS_STILL_ACTIVE",
          "QRIS masih berlaku. Tunggu pelanggan membayar.",
        );
      old.status = "cancelled";
      const now = clock();
      order.attempts.push({
        id: nextId(),
        sequence: old.sequence,
        method: "qris",
        status: "waiting",
        amountIdr: old.amountIdr,
        startedAtMs: now,
        expiresAt: iso(now + QRIS_TTL_MS),
      });
      return sessionOf(order);
    },

    confirmCash(input: ConfirmCashInput): PaymentSession {
      const order = orderOf(input.orderId);
      settle(order);
      assertOpenBill(order);
      assertNoLiveAttempt(order);
      assertAmount(order, input.amountIdr);
      if (!isWholeIdr(input.receivedIdr) || input.receivedIdr < input.amountIdr)
        validation("Uang diterima kurang dari nominal pembayaran.");
      archiveStale(order);
      addTender(order, {
        id: nextId(),
        method: "cash",
        label: "Tunai",
        amountIdr: input.amountIdr,
        confirmedAt: iso(clock()),
        receivedIdr: input.receivedIdr,
        changeIdr: cashChangeIdr(input.receivedIdr, input.amountIdr),
      });
      return sessionOf(order);
    },

    recordEdcStandalone(input: RecordEdcStandaloneInput): PaymentSession {
      const order = orderOf(input.orderId);
      settle(order);
      assertOpenBill(order);
      const last = order.attempts.at(-1);
      const edcTouched = order.attempts.some(
        (a) => a.method === "edc" && a.status === "unknown",
      );
      if (edcTouched)
        conflict(
          "EDC_STANDALONE_NOT_ALLOWED",
          "Hasil EDC belum pasti. Cek status, jangan catat standalone.",
        );
      if (last && (isLive(last) || last.status === "confirmed"))
        conflict(
          "EDC_STANDALONE_NOT_ALLOWED",
          "Standalone hanya bila tidak ada permintaan sebelumnya atau hasilnya gagal/batal.",
        );
      const terminal = edcTerminals.find((t) => t.id === input.terminalId);
      if (!terminal) validation("Pilih terminal EDC.");
      const bankRef = input.bankRef.trim();
      if (bankRef.length < 6) validation("Nomor referensi bank wajib diisi.");
      // The supervisor approved one amount: refuse to record a different one.
      const approved = state.overrides[input.overrideId];
      if (approved && approved.valueIdr !== remainingOf(order))
        throw new ApiError(
          403,
          "OVERRIDE_INVALID",
          "Sisa tagihan berubah sejak persetujuan. Minta persetujuan ulang.",
        );
      consumeOverride(input.overrideId, "edc_standalone", order.id);
      archiveStale(order);
      const amountIdr = remainingOf(order);
      const attempt: EngineAttempt = {
        id: nextId(),
        sequence: order.attempts.length + 1,
        method: "edc",
        status: "confirmed",
        amountIdr,
        startedAtMs: clock(),
        edc: {
          terminalId: terminal.id,
          terminalLabel: terminal.label,
          bank: terminal.bank,
          mode: "card",
          lockedAmountIdr: amountIdr,
        },
        bankRef,
        ...(input.approvalCode?.trim()
          ? { approvalCode: input.approvalCode.trim() }
          : {}),
        standalone: true,
      };
      order.attempts.push(attempt);
      addTender(order, {
        id: nextId(),
        method: "edc",
        label: terminal.label,
        amountIdr,
        confirmedAt: iso(clock()),
        reference: bankRef,
        attemptId: attempt.id,
      });
      dayOf().standaloneUnmatched += 1;
      return sessionOf(order);
    },

    cancelAttempt(ref: AttemptRef): PaymentSession {
      const order = orderOf(ref.orderId);
      const attempt = findAttempt(order, ref.attemptId);
      settle(order);
      if (attempt.status === "unknown")
        conflict(
          "STATUS_UNKNOWN",
          "Hasil pembayaran belum pasti. Cek status dulu sebelum membatalkan.",
        );
      if (attempt.status === "confirmed")
        conflict("ALREADY_PAID", "Pembayaran sudah terkonfirmasi.");
      attempt.status = "cancelled";
      return sessionOf(order);
    },

    printReceipt(orderId: string): ReceiptResult {
      const order = orderOf(orderId);
      if (remainingOf(order) > 0 || order.receiptNo === null)
        conflict("NOT_PAID", "Struk dicetak setelah tagihan lunas.");
      order.receiptPrints += 1;
      order.version += 1;
      return {
        receiptNo: order.receiptNo,
        printedAt: iso(clock()),
        reprint: order.receiptPrints > 1,
      };
    },

    lookupCode(raw: string): CashierCodeOrder {
      const digits = raw.replace(/\D/g, "");
      if (digits.length === 0) validation("Masukkan nomor kode pelanggan.");
      const found = scenario() !== "empty" && pad(Number(digits), 4) === "0044";
      if (!found)
        notFound(
          "Kode tidak ditemukan. Periksa nomor kode di ponsel pelanggan.",
        );
      const order = orderOf(DEMO_CODE_ORDER_ID);
      return {
        orderId: order.id,
        code: order.code ?? "LG-0044",
        tableLabel: order.tableLabel,
        items: clone(order.items),
        totalIdr: order.totalIdr,
        status: remainingOf(order) === 0 ? "paid" : "unpaid",
      };
    },

    // Shift
    registeredTerminals(): RegisteredTerminal[] {
      return clone(registeredTerminals);
    },

    activeShift(): ActiveShift | null {
      seedShifts();
      if (!state.shift || state.shift.status === "closed") return null;
      return activeShiftView(state.shift);
    },

    openShift(input: OpenShiftInput): ActiveShift {
      seedShifts();
      if (state.shift && state.shift.status !== "closed")
        conflict("SHIFT_ALREADY_OPEN", "Terminal ini masih punya shift aktif.");
      if (
        !isWholeIdr(input.openingFloatIdr) ||
        input.openingFloatIdr < 0 ||
        input.openingFloatIdr > 100_000_000
      )
        validation("Modal awal harus berupa rupiah utuh, tidak negatif.");
      const shift = demoShift("open");
      const index = state.counters.shift;
      state.counters.shift += 1;
      shift.id = index === 0 ? DEMO_SHIFT_ID : nextId();
      shift.shiftNo = `S-${pad(8 + index, 3)}`;
      shift.businessDate = DEMO_BUSINESS_DATE;
      shift.openedAt = iso(clock());
      shift.openingFloatIdr = input.openingFloatIdr;
      shift.cashSalesIdr = 0;
      shift.cashRefundsIdr = 0;
      shift.cashInIdr = 0;
      shift.cashOutIdr = 0;
      shift.cashDropIdr = 0;
      state.shift = shift;
      state.movements = [];
      return activeShiftView(shift);
    },

    cashMovements(shiftId: string): CashMovement[] {
      const shift = shiftOf(shiftId);
      if (scenario() === "empty") return [];
      return state.movements
        .filter((movement) => movement.shiftId === shift.id)
        .map((movement) => ({
          id: movement.id,
          type: movement.type,
          amountIdr: movement.amountIdr,
          reasonNote: movement.reasonNote,
          recordedAt: movement.recordedAt,
        }))
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    },

    recordCashMovement(input: RecordCashMovementInput): CashMovement {
      const shift = shiftOf(input.shiftId);
      if (shift.status !== "open")
        conflict("SHIFT_NOT_OPEN", "Shift ini sudah dalam proses penutupan.");
      if (!isWholeIdr(input.amountIdr) || input.amountIdr <= 0)
        validation("Nominal harus lebih dari Rp0.");
      const reasonNote = input.reasonNote.trim();
      if (reasonNote.length < 4)
        validation("Alasan wajib diisi, minimal 4 karakter.");
      // No drawer-balance check on purpose: the cashier must not learn the
      // system balance from a refusal (blind count). The server reconciles at
      // close. See CONTRACT-GAPS.md.
      if (input.type === "cash_in") shift.cashInIdr += input.amountIdr;
      else if (input.type === "cash_out") shift.cashOutIdr += input.amountIdr;
      else shift.cashDropIdr += input.amountIdr;
      state.counters.movement += 1;
      const movement = {
        id: `0d0d0002-0000-4000-8000-${pad(state.counters.movement, 12)}`,
        type: input.type,
        amountIdr: input.amountIdr,
        reasonNote,
        recordedAt: iso(clock()),
      };
      state.movements.push({ ...movement, shiftId: shift.id });
      return movement;
    },

    submitBlindCount(input: SubmitBlindCountInput): BlindCountReceipt {
      const shift = shiftOf(input.shiftId);
      if (shift.status !== "open")
        conflict("SHIFT_NOT_OPEN", "Hitungan untuk shift ini sudah dikirim.");
      if (input.counts.length === 0)
        validation("Hitung uang per pecahan sebelum mengirim.");
      for (const line of input.counts)
        if (
          !isWholeIdr(line.denominationIdr) ||
          line.denominationIdr <= 0 ||
          line.denominationIdr > 100_000 ||
          !Number.isInteger(line.quantity) ||
          line.quantity < 0 ||
          line.quantity > 10_000
        )
          validation("Jumlah lembar per pecahan tidak valid.");
      if (!isWholeIdr(input.otherAmountIdr) || input.otherAmountIdr < 0)
        validation("Nominal pecahan lain dan koin tidak valid.");
      const submittedAt = iso(clock());
      shift.count = {
        countedIdr: countedTotalIdr(input.counts, input.otherAmountIdr),
        counts: clone(input.counts),
        otherAmountIdr: input.otherAmountIdr,
        submittedAt,
      };
      shift.status = "awaiting_approval";
      return {
        shiftId: shift.id,
        status: "awaiting_supervisor",
        submittedAt,
      };
    },

    // Supervisor
    supervisors(): SupervisorOption[] {
      return clone(supervisorOptions);
    },

    shiftReview(shiftId: string): ShiftReview {
      return reviewOf(shiftOf(shiftId));
    },

    requestOverride(input: RequestOverrideInput): OverrideResult {
      const supervisor = supervisorOptions.find(
        (item) => item.userId === input.approverUserId,
      );
      if (!supervisor)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Pengguna ini tidak berwenang menyetujui.",
        );
      if (input.reason.trim().length < 3)
        validation("Alasan wajib diisi, minimal 3 karakter.");
      if (!/^\d{6}$/.test(input.pin)) validation("PIN terdiri dari 6 angka.");
      const misses = state.pinMisses[supervisor.userId] ?? 0;
      if (misses >= MAX_PIN_MISSES)
        throw new ApiError(
          423,
          "PIN_LOCKED",
          "PIN supervisor terkunci. Hubungi manajer outlet.",
        );
      if (input.pin !== MOCK_SUPERVISOR_PIN) {
        state.pinMisses[supervisor.userId] = misses + 1;
        const left = MAX_PIN_MISSES - misses - 1;
        throw new ApiError(
          403,
          left === 0 ? "PIN_LOCKED" : "PIN_INVALID",
          left === 0
            ? "PIN supervisor terkunci. Hubungi manajer outlet."
            : `PIN supervisor salah. Sisa percobaan ${left}.`,
        );
      }
      state.pinMisses[supervisor.userId] = 0;
      state.counters.override += 1;
      const id = `01JC0VER${pad(state.counters.override, 18)}`;
      state.overrides[id] = {
        id,
        action: input.action,
        valueIdr: input.valueIdr,
        reason: input.reason.trim(),
        objectType: input.objectType,
        objectId: input.objectId,
        approvedBy: supervisor.userId,
        createdAt: iso(clock()),
        usedFor: null,
      };
      return { overrideId: id, approvedByName: supervisor.name };
    },

    /** Raw override for the endpoint mock (getPosOverride). */
    override(overrideId: string) {
      const override = state.overrides[overrideId];
      if (!override) notFound("Persetujuan tidak ditemukan.");
      return clone(override);
    },

    /**
     * `closePosShift` as the shared contract has it today: the counts and the
     * approver arrive together. The screens use submitBlindCount +
     * approveShiftClose (overrideId) instead; see CONTRACT-GAPS.md.
     */
    closeShiftWithApprover(input: {
      shiftId: string;
      counts: { denominationIdr: number; quantity: number }[];
      varianceNote?: string | null;
      approvedBy: string;
    }): void {
      const shift = shiftOf(input.shiftId);
      if (shift.status === "closed")
        conflict("SHIFT_CLOSED", "Shift ini sudah ditutup.");
      const approver = supervisorOptions.find(
        (item) => item.userId === input.approvedBy,
      );
      if (!approver)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Pengguna ini tidak berwenang menyetujui.",
        );
      const countedIdr = countedTotalIdr(input.counts, 0);
      const expectedIdr = expectedCashIdr(shift);
      const variance = cashVarianceIdr(countedIdr, expectedIdr);
      const note = (input.varianceNote ?? "").trim();
      if (variance !== 0 && note.length < 4)
        validation("Penjelasan selisih wajib diisi, minimal 4 karakter.");
      shift.count = {
        countedIdr,
        counts: clone(input.counts),
        otherAmountIdr: 0,
        submittedAt: iso(clock()),
      };
      shift.status = "closed";
      shift.closed = {
        expectedIdr,
        varianceIdr: variance,
        varianceNote: note,
        approvedByName: approver.name,
        closedAt: iso(clock()),
      };
    },

    approveShiftClose(input: ApproveShiftCloseInput): ShiftReview {
      const shift = shiftOf(input.shiftId);
      if (shift.status === "closed")
        conflict("SHIFT_CLOSED", "Shift ini sudah ditutup.");
      if (shift.status !== "awaiting_approval" || !shift.count)
        conflict("COUNT_NOT_SUBMITTED", "Kasir belum mengirim hitungan kas.");
      const expectedIdr = expectedCashIdr(shift);
      const variance = cashVarianceIdr(shift.count.countedIdr, expectedIdr);
      const note = input.reason.trim();
      if (variance !== 0 && note.length < 4)
        validation("Penjelasan selisih wajib diisi, minimal 4 karakter.");
      const override = consumeOverride(
        input.overrideId,
        "cash_shift_close",
        shift.id,
      );
      const approver =
        supervisorOptions.find((item) => item.userId === override.approvedBy)
          ?.name ?? "Supervisor";
      shift.status = "closed";
      shift.closed = {
        expectedIdr,
        varianceIdr: variance,
        varianceNote: note,
        approvedByName: approver,
        closedAt: iso(clock()),
      };
      return reviewOf(shift);
    },

    // End of day
    dayRecap: buildDayRecap,

    closeDay(input: CloseDayInput): DayCloseRecap {
      const day = dayOf();
      if (day.status === "closed")
        conflict("DAY_ALREADY_CLOSED", "Hari usaha ini sudah ditutup.");
      if (state.shift && state.shift.status !== "closed")
        conflict("SHIFT_STILL_OPEN", "Masih ada shift yang belum ditutup.");
      const result: DayCloseResult = {
        closedAt: iso(clock()),
        closedByName: dayFixture.managerName,
        localRecapSaved: true,
        batches: dayFixture.settlement.map((row) => ({
          bank: row.bank,
          status: "success" as const,
        })),
        accounting: "queued",
        standaloneUnmatched: day.standaloneUnmatched,
        stockDeductionApplied:
          input.inventoryDeduction && dayFixture.stockDeductionAvailable,
      };
      day.status = "closed";
      day.inventoryDeduction = result.stockDeductionApplied;
      day.result = result;
      return buildDayRecap();
    },

    // Raw state for the endpoint mocks (./mock.ts).
    rawOrder(orderId: string): EngineOrder {
      const order = orderOf(orderId);
      settle(order);
      return clone(order);
    },
    rawRemainingIdr(orderId: string): number {
      return remainingOf(orderOf(orderId));
    },
    rawShift(): EngineShift | null {
      seedShifts();
      return state.shift ? clone(state.shift) : null;
    },
    rawMovements(shiftId: string) {
      shiftOf(shiftId);
      return clone(state.movements.filter((m) => m.shiftId === shiftId));
    },
  };
}

export type PosKasirEngine = ReturnType<typeof createPosKasirEngine>;

// ---- Browser singleton -----------------------------------------------------

let singleton: PosKasirEngine | null = null;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The engine for this page load, hydrated from sessionStorage once. */
export function getPosKasirEngine(): PosKasirEngine {
  if (singleton) return singleton;
  singleton = createPosKasirEngine({
    readSeed: readDemoSeed,
    scenario: getScenario,
  });
  const storage = browserStorage();
  if (!storage) return singleton;
  try {
    const raw = storage.getItem(ENGINE_STORAGE_KEY);
    if (raw) singleton.restore(JSON.parse(raw) as EngineState);
  } catch {
    // A stale or tampered snapshot must never break the mock: start clean.
    try {
      storage.removeItem(ENGINE_STORAGE_KEY);
    } catch {
      // Storage blocked: nothing to clean.
    }
  }
  return singleton;
}

function persistEngine() {
  const storage = browserStorage();
  if (!storage || !singleton) return;
  try {
    storage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(singleton.snapshot()));
  } catch {
    // Quota or private mode: the mock keeps working without reload memory.
  }
}

/** Runs one engine call and snapshots the state after it (browser only). */
export function callPosKasirEngine<T>(call: (engine: PosKasirEngine) => T): T {
  const result = call(getPosKasirEngine());
  persistEngine();
  return clone(result);
}

let scenarioAdopted = false;

/**
 * `?mock=` and the remembered scenario are normally read when the first typed
 * mock call runs (lib/mock/transport.ts). The local contracts here can run
 * first, so read them once ourselves; setScenario is idempotent with the
 * transport's own read.
 */
function adoptScenarioFromBrowser() {
  if (scenarioAdopted || typeof window === "undefined") return;
  scenarioAdopted = true;
  try {
    const raw =
      new URLSearchParams(window.location.search).get("mock") ??
      window.localStorage.getItem(SCENARIO_STORAGE_KEY);
    if (isMockScenario(raw)) setScenario(raw);
  } catch {
    // Storage blocked or no location: keep the current scenario.
  }
}

/**
 * Runs one engine call like a request: the active scenario (offline, error)
 * and the mock latency first. Used by the local contracts in ./api.ts, so they
 * fail like the typed endpoints do (which the mock transport already covers).
 */
export async function runPosKasirMock<T>(
  call: (engine: PosKasirEngine) => T,
  extraLatencyMs = 0,
): Promise<T> {
  adoptScenarioFromBrowser();
  const scenario = getScenario();
  const latency = getLatencyMs() + extraLatencyMs;
  if (latency > 0) await new Promise((done) => setTimeout(done, latency));
  if (scenario === "offline")
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  if (scenario === "error")
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "Terjadi kesalahan pada server. Coba lagi sebentar lagi.",
    );
  return callPosKasirEngine(call);
}
