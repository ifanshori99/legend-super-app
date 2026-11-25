// Maps the mock engine's state to the wire shapes of the shared POS endpoints,
// so every typed mock response passes its contract schema (the unit test parses
// each one). Pure and relative-import only: Node tests load it directly. The
// demo orders also answer to a ULID because the real order id is a ULID.
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  DEMO_CODE_ORDER_ID,
  DEMO_CODE_ORDER_ULID,
  DEMO_ORDER_ID,
  DEMO_ORDER_ULID,
} from "./demo-seed.ts";
import {
  DEMO_BUSINESS_DATE,
  MOCK_CASHIER_ID,
  MOCK_DEVICE_ID,
  MOCK_SUPERVISOR_ID,
  dayFixture,
} from "./fixtures.ts";
import { depositUsedIdr, orderTotalIdr } from "./mock-engine.ts";
import type {
  CashMovement,
  DayCloseRecap,
  EngineOrder,
  EngineOverride,
  EngineShift,
  EngineTender,
} from "./types.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const scope = { tenantId, outletId };
const pad = (value: number, length: number) =>
  String(value).padStart(length, "0");

const AT = "2026-11-08T06:00:00.000Z";
const MENU_ITEM_ID = "00000000-0000-4000-8000-000000001004";
const TAX_RULE_ID = "00000000-0000-4000-8000-000000000800";
const DEPOSIT_TENDER_ID = "00000000-0000-4000-8000-0000000d0001";

export const orderUlidOf = (id: string) =>
  id === DEMO_ORDER_ID
    ? DEMO_ORDER_ULID
    : id === DEMO_CODE_ORDER_ID
      ? DEMO_CODE_ORDER_ULID
      : id;

/** The order lines as contract lines: their sum is the subtotal. */
function lines(order: EngineOrder) {
  const items = order.items.map((item) => ({ ...item }));
  const others = items.slice(1).reduce((sum, item) => sum + item.amountIdr, 0);
  if (items.length > 0) items[0].amountIdr = order.subtotalIdr - others;
  return items;
}

function tenderWire(order: EngineOrder, tender: EngineTender) {
  const gateway =
    tender.method === "qris" ||
    tender.method === "va" ||
    tender.method === "ewallet" ||
    tender.method === "card";
  return {
    id: tender.id,
    ...scope,
    orderId: orderUlidOf(order.id),
    method: tender.method === "edc" ? "edc_card" : tender.method,
    provider:
      tender.method === "cash" || tender.method === "points"
        ? "manual"
        : gateway
          ? "doit"
          : "edc",
    paymentIntentId: gateway ? tender.id : null,
    amountIdr: tender.amountIdr,
    receivedIdr: tender.method === "cash" ? (tender.receivedIdr ?? null) : null,
    changeIdr: tender.method === "cash" ? (tender.changeIdr ?? null) : null,
    reference: tender.reference ?? null,
    edcTransactionId: tender.method === "edc" ? tender.id : null,
    // One point is worth Rp1 in the mock (brief 936).
    pointsUsed: tender.method === "points" ? tender.amountIdr : null,
    status: "captured",
    requestedAt: tender.confirmedAt,
    resolvedAt: tender.confirmedAt,
    capturedBy: MOCK_CASHIER_ID,
    approvedBy: null,
  };
}

function depositTenderWire(order: EngineOrder) {
  const amountIdr = depositUsedIdr(
    orderTotalIdr(order),
    order.deposit?.amountIdr ?? 0,
  );
  return {
    id: DEPOSIT_TENDER_ID,
    ...scope,
    orderId: orderUlidOf(order.id),
    method: "qris",
    provider: "doit",
    paymentIntentId: DEPOSIT_TENDER_ID,
    amountIdr,
    receivedIdr: null,
    changeIdr: null,
    reference: order.deposit?.reference ?? null,
    edcTransactionId: null,
    pointsUsed: null,
    status: "captured",
    requestedAt: AT,
    resolvedAt: AT,
    capturedBy: null,
    approvedBy: null,
  };
}

function allTenders(order: EngineOrder) {
  const deposit =
    order.deposit &&
    depositUsedIdr(orderTotalIdr(order), order.deposit.amountIdr) > 0
      ? [depositTenderWire(order)]
      : [];
  return [...deposit, ...order.tenders.map((t) => tenderWire(order, t))];
}

export function receiptWire(order: EngineOrder) {
  const number = order.receiptNo ?? "POS01-000001";
  return {
    id: `00000000-0000-4000-8000-${pad(Number(number.replace(/\D/g, "")) + 70_000, 12)}`,
    ...scope,
    orderId: orderUlidOf(order.id),
    deviceId: MOCK_DEVICE_ID,
    number,
    sequenceNumber: Number(number.replace(/\D/g, "").slice(-6)) || 1,
    status: "issued",
    issuedAt: order.tenders.at(-1)?.confirmedAt ?? AT,
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    reprintCount: Math.max(order.receiptPrints - 1, 0),
  };
}

const EDC_BANK_WIRE: Record<string, "bca" | "bni"> = {
  "Bank A": "bca",
  "Bank B": "bni",
};
const EDC_STATUS_WIRE = {
  waiting: "pending",
  unknown: "unknown",
  confirmed: "approved",
  declined: "declined",
  failed: "failed",
  expired: "failed",
  cancelled: "cancelled",
} as const;

/** The latest 5 EDC requests of the bill, newest first (936). */
function edcAttemptsWire(order: EngineOrder) {
  return order.attempts
    .filter((attempt) => attempt.method === "edc" && attempt.edc)
    .slice(-5)
    .reverse()
    .map((attempt) => {
      const edc = attempt.edc!;
      return {
        id: attempt.id,
        status: EDC_STATUS_WIRE[attempt.status],
        amountIdr: attempt.amountIdr,
        terminalId: `00000000-0000-4000-8000-${pad(Number(edc.terminalId.replace(/\D/g, "")) + 80_000, 12)}`,
        terminalLabel: edc.terminalLabel,
        declineReason: edc.declineReason ?? null,
        responseCode: edc.responseCode ?? null,
        bank: EDC_BANK_WIRE[edc.bank] ?? null,
        method: edc.mode,
        mode: attempt.standalone ? "standalone" : "ecr",
        createdAt: new Date(attempt.startedAtMs).toISOString(),
        // The mock keeps no end time: a finished request closes when it starts.
        completedAt:
          attempt.status === "waiting"
            ? null
            : new Date(attempt.startedAtMs).toISOString(),
      };
    });
}

export function orderDetailWire(order: EngineOrder, remainingIdr: number) {
  const orderId = orderUlidOf(order.id);
  const paid = remainingIdr === 0;
  const idTail = Number(order.orderNo.replace(/\D/g, "")) || 1;
  return {
    id: orderId,
    ...scope,
    number: order.orderNo,
    channel: "pos",
    serviceType: "dine_in",
    tableSessionId: null,
    customerProfileId: null,
    externalRef: null,
    shiftId: null,
    deviceId: MOCK_DEVICE_ID,
    cashierId: MOCK_CASHIER_ID,
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.voucher?.discountIdr ?? 0,
    serviceChargeIdr: order.serviceIdr,
    taxIdr: order.taxIdr,
    roundingIdr: 0,
    totalIdr: orderTotalIdr(order),
    // The reservation DP is the order's `depositAppliedIdr`, never a tender
    // (contract, legend-p7lx): the customer display reads it to hold QRIS.
    depositAppliedIdr: depositUsedIdr(
      orderTotalIdr(order),
      order.deposit?.amountIdr ?? 0,
    ),
    status: paid ? "completed" : "awaiting_payment",
    createdBy: MOCK_CASHIER_ID,
    createdAt: AT,
    submittedAt: AT,
    firedAt: AT,
    completedAt: paid ? (order.tenders.at(-1)?.confirmedAt ?? AT) : null,
    voidedAt: null,
    voidReason: null,
    voidReasonNote: null,
    voidApprovedBy: null,
    voidApprovalRequestId: null,
    voidOverrideId: null,
    version: order.version,
    items: lines(order).map((item, index) => ({
      id: `01JBQ9C1${pad(idTail * 10 + index, 18)}`,
      tenantId,
      orderId,
      menuItemId: MENU_ITEM_ID,
      variantId: null,
      name: item.name,
      quantity: item.qty,
      unitPriceIdr: Math.round(item.amountIdr / item.qty),
      modifiersTotalIdr: 0,
      lineTotalIdr: Math.round(item.amountIdr / item.qty) * item.qty,
      modifiers: [],
      note: null,
      course: null,
      fireStatus: "fired",
      firedAt: AT,
      status: "served",
      voidReason: null,
      voidReasonNote: null,
      voidedBy: null,
      voidApprovedBy: null,
      voidApprovalRequestId: null,
      voidOverrideId: null,
      costSnapshotIdr: 0,
      createdAt: AT,
    })),
    tenders: order.tenders.map((t) => tenderWire(order, t)),
    discounts: order.voucher
      ? [
          {
            id: `00000000-0000-4000-8000-${pad(idTail + 90_000, 12)}`,
            tenantId,
            orderId,
            source: "voucher",
            kind: "amount",
            percentBp: null,
            amountIdr: order.voucher.discountIdr,
            reason: "promo_engine",
            reasonNote: null,
            appliedBy: MOCK_CASHIER_ID,
            approvedBy: null,
            approvalRequestId: null,
            overrideId: null,
            voucherCode: order.voucher.code,
            createdAt: AT,
          },
        ]
      : [],
    edcAttempts: edcAttemptsWire(order),
    receipt: paid && order.receiptNo ? receiptWire(order) : null,
  };
}

export function tenderResultWire(
  order: EngineOrder,
  remainingIdr: number,
  tender: EngineTender,
) {
  return {
    order: orderDetailWire(order, remainingIdr),
    tender: tenderWire(order, tender),
    remainingIdr,
  };
}

export function receiptIssueWire(order: EngineOrder) {
  const receipt = receiptWire(order);
  const rate = (amount: number, base: number) =>
    base === 0 ? 0 : Math.min(Math.round((amount / base) * 10_000), 10_000);
  return {
    receipt,
    document: {
      id: receipt.id,
      ...scope,
      receiptNumber: receipt.number,
      orderNumber: order.orderNo,
      documentKind: "receipt",
      status: "issued",
      reprint: false,
      outletName: cafeLegendFixtures.outlets[0].name,
      outletAddress: "Jl. Braga No. 10, Bandung",
      issuedAt: receipt.issuedAt,
      items: lines(order).map((item) => ({
        name: item.name,
        quantity: item.qty,
        unitPriceIdr: Math.round(item.amountIdr / item.qty),
        modifiersTotalIdr: 0,
        lineTotalIdr: Math.round(item.amountIdr / item.qty) * item.qty,
        note: null,
      })),
      discounts: order.voucher
        ? [
            {
              label: `Voucher ${order.voucher.code}`,
              source: "voucher",
              amountIdr: order.voucher.discountIdr,
            },
          ]
        : [],
      serviceCharge: {
        rateBp: rate(order.serviceIdr, order.subtotalIdr),
        baseIdr: order.subtotalIdr,
        amountIdr: order.serviceIdr,
      },
      taxLines: [
        {
          taxRuleId: TAX_RULE_ID,
          name: "PBJT",
          rateBp: rate(order.taxIdr, order.subtotalIdr + order.serviceIdr),
          baseIdr: order.subtotalIdr + order.serviceIdr,
          amountIdr: order.taxIdr,
        },
      ],
      subtotalIdr: order.subtotalIdr,
      discountIdr: order.voucher?.discountIdr ?? 0,
      serviceChargeIdr: order.serviceIdr,
      taxIdr: order.taxIdr,
      roundingIdr: 0,
      totalIdr: orderTotalIdr(order),
      tenders: allTenders(order).map((tender) => ({
        method: tender.method,
        amountIdr: tender.amountIdr,
        reference: tender.reference,
      })),
      cashierName: "Kasir 01",
      customerName: null,
    },
    deliveries: [
      {
        id: `00000000-0000-4000-8000-${pad(Number(receipt.sequenceNumber) + 80_000, 12)}`,
        ...scope,
        receiptId: receipt.id,
        channel: "print",
        status: "sent",
        destinationMasked: null,
        sentAt: AT,
        failureReason: null,
      },
    ],
    link: null,
  };
}

export const approvalPolicyWire = {
  ...scope,
  discountThresholdBp: 1000,
  cashRoundingIncrementIdr: 100,
};

// ---- Shift -----------------------------------------------------------------

/** `blind`: the caller lacks the variance permission, so the drawer figures go out as null. */
export function shiftWire(shift: EngineShift, blind = false) {
  const closed = shift.status === "closed" && shift.closed && shift.count;
  return {
    id: shift.id,
    ...scope,
    deviceId: MOCK_DEVICE_ID,
    cashierId: MOCK_CASHIER_ID,
    businessDate: shift.businessDate || DEMO_BUSINESS_DATE,
    status: closed ? "closed" : "open",
    openedAt: shift.openedAt,
    openingFloatIdr: shift.openingFloatIdr,
    cashSalesIdr: blind ? null : shift.cashSalesIdr,
    cashRefundsIdr: blind ? null : shift.cashRefundsIdr,
    cashInIdr: blind ? null : shift.cashInIdr,
    cashOutIdr: blind ? null : shift.cashOutIdr,
    cashDropIdr: blind ? null : shift.cashDropIdr,
    expectedIdr: closed && !blind ? shift.closed!.expectedIdr : null,
    countedIdr: closed ? shift.count!.countedIdr : null,
    varianceIdr: closed && !blind ? shift.closed!.varianceIdr : null,
    varianceNote:
      // Whether a note exists would reveal a non-zero variance to a blind caller.
      closed && !blind && shift.closed!.varianceIdr !== 0
        ? shift.closed!.varianceNote
        : null,
    approvedBy: closed ? MOCK_SUPERVISOR_ID : null,
    approvalRequestId: closed ? "00000000-0000-4000-8000-000000000904" : null,
    // The contract names the stored blind count the close used.
    countId: closed ? "00000000-0000-4000-8000-000000000905" : null,
    approvedAt: closed ? shift.closed!.closedAt : null,
    closedAt: closed ? shift.closed!.closedAt : null,
  };
}

export function movementWire(
  movement: CashMovement & { shiftId?: string },
  shiftId: string,
  /** Supervisor reads only: held for review. Never set for a blind caller. */
  needsApproval?: boolean,
) {
  return {
    id: movement.id,
    ...scope,
    shiftId,
    type: movement.type,
    amountIdr: movement.amountIdr,
    reasonNote: movement.reasonNote,
    recordedBy: MOCK_CASHIER_ID,
    recordedAt: movement.recordedAt,
    approvedBy: null,
    // Mock held ids only hold undecided rows, so the outcome is always null.
    ...(needsApproval === undefined ? {} : { needsApproval, outcome: null }),
  };
}

/** One stored count as the supervisor sees it (full figures). */
export function shiftCountWire(
  count: {
    id: string;
    sequence: number;
    forced: boolean;
    countedIdr: number;
    expectedIdr: number;
    heldCashOutIdr: number;
    submittedAt: string;
  },
  shiftId: string,
) {
  return {
    id: count.id,
    ...scope,
    shiftId,
    sequence: count.sequence,
    // The mock keeps the total only: one line of 100.000 notes plus no coins.
    counts: [
      {
        denominationIdr: 100_000,
        quantity: Math.floor(count.countedIdr / 100_000),
      },
    ],
    countedIdr: count.countedIdr,
    expectedIdr: count.expectedIdr,
    varianceIdr: count.countedIdr - count.expectedIdr,
    heldCashOutIdr: count.heldCashOutIdr,
    submittedBy: count.forced ? MOCK_SUPERVISOR_ID : MOCK_CASHIER_ID,
    submittedAt: count.submittedAt,
  };
}

// ---- End of day ------------------------------------------------------------

const CHANNEL_WIRE: Record<string, string> = {
  dine_in: "pos",
  takeaway: "qr",
  delivery: "gofood",
};
const TENDER_WIRE: Record<string, string> = { edc: "edc_card" };

export function recapWire(recap: DayCloseRecap) {
  const empty = recap.totalSalesIdr === 0;
  const device = (
    deviceId: string,
    gross: number,
    service: number,
    tax: number,
    shiftCount: number,
    variance: number,
  ) => ({
    deviceId,
    orderCount: empty ? 0 : 60,
    grossSalesIdr: empty ? 0 : gross,
    discountIdr: 0,
    serviceChargeIdr: empty ? 0 : service,
    taxIdr: empty ? 0 : tax,
    roundingIdr: 0,
    totalIdr: empty ? 0 : gross + service + tax,
    voidedOrderCount: 0,
    voidedAmountIdr: 0,
    refundCount: 0,
    refundAmountIdr: 0,
    depositAppliedIdr: 0,
    depositRefundedIdr: 0,
    shiftCount: empty ? 0 : shiftCount,
    cashVarianceIdr: empty ? 0 : variance,
    closed: recap.status === "closed",
  });
  const closed = recap.status === "closed" && recap.result;
  return {
    id: "00000000-0000-4000-8000-000000000f01",
    ...scope,
    businessDate: recap.businessDate,
    status: recap.status,
    generatedAt: AT,
    closedAt: closed ? recap.result!.closedAt : null,
    closedBy: closed ? MOCK_SUPERVISOR_ID : null,
    devices: [
      device(MOCK_DEVICE_ID, 6_400_000, 480_000, 600_000, 2, -20_000),
      device(
        "00000000-0000-4000-8000-000000000611",
        4_300_000,
        300_000,
        400_000,
        1,
        0,
      ),
    ],
    tenders: (empty ? [{ code: "cash", netIdr: 0 }] : recap.netPayments).map(
      (row) => ({
        method: TENDER_WIRE[row.code] ?? row.code,
        capturedIdr: row.netIdr,
        refundedIdr: 0,
        netIdr: row.netIdr,
      }),
    ),
    channels: (empty
      ? [{ code: "dine_in", amountIdr: 0 }]
      : recap.channels
    ).map((row) => ({
      channel: CHANNEL_WIRE[row.code] ?? "pos",
      orderCount: empty ? 0 : 20,
      totalIdr: row.amountIdr,
    })),
    totalSalesIdr: recap.totalSalesIdr,
    totalRefundsIdr: 0,
    totalDepositAppliedIdr: 0,
    totalDepositRefundedIdr: 0,
    totalVoidsIdr: 0,
    totalVarianceIdr: empty ? 0 : dayFixture.shifts.cashVarianceIdr,
    inventoryDeductionApplied: recap.stockDeduction.applied,
    accountingSync: {
      status:
        closed && recap.result!.accounting === "synced" ? "posted" : "pending",
      journalCount: 0,
      postedAt: null as string | null,
    },
  };
}

// ---- Override --------------------------------------------------------------

const ENDPOINT_ACTIONS = [
  "void",
  "discount",
  "refund",
  "cash_drawer_open",
  "price_correction",
];

/** Null when the action has no representation in the shared contract yet. */
export function overrideViewWire(override: EngineOverride) {
  if (!ENDPOINT_ACTIONS.includes(override.action)) return null;
  return {
    id: override.id,
    ...scope,
    action: override.action,
    method: "supervisor_pin",
    status: "approved",
    requestedBy: MOCK_CASHIER_ID,
    approvedBy: override.approvedBy,
    reasonCode: null,
    reason: override.reason,
    valueIdr: override.valueIdr,
    objectType: override.objectType,
    objectId: override.objectId,
    approvalRequestId: null,
    createdAt: override.createdAt,
    resolvedAt: override.createdAt,
  };
}
