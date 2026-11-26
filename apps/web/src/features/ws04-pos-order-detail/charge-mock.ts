// Mock mode handlers of the charge screen (VITE_API_MOCK=true). One demo
// charge answers to any id: POS-0048, Meja A12, Nasi ayam -> Nasi sapi, Rp10.000.
//
//   ?demo=selisih-lunas         the charge is already paid
//   ?demo=selisih-belum-pasti   the first collect is recorded but the answer
//                               never arrives (504); the status check shows
//                               it paid, a retry with the same key replays
//   ?demo=selisih-qris-lunas        the QRIS is paid after a few status reads
//   ?demo=selisih-qris-kedaluwarsa  the last code ended unpaid
//   ?demo=selisih-qris-gagal        the last code failed
//   ?demo=selisih-qris-putus        the first QRIS is created but answers 504
//   ?demo=selisih-qris-habis        the code's time is up, the server still
//                                   says pending
//   ?demo=selisih-edc-disetujui | -menunggu | -belum-pasti | -ditolak | -tinjau
//                                   what the terminal answered
//   ?demo=selisih-edc-putus     a card started here ends unknown (the
//                               supervisor settles it with the slip)
//   any other seed: a card started here is approved after two status reads
//   ?mock=error | empty | slow  the shared scenarios (transport)
//
// Mirrors apps/api/src/services/order-recovery-charge-pos.ts: cash must reach
// the charge amount (change is the surplus); QRIS sends no amount and answers a
// pending code while the charge stays open (the gateway pays it, never this
// mock); EDC card pays the exact amount at once. A replay with the same key
// answers the same, a different key on a paid charge is a 409.
import type { z } from "@starter/shared/core";
import {
  ISSUE_CHARGE_EDC_STATEMENT_REQUIRED,
  ISSUE_CHARGE_SLIP_REQUIRED,
  type posIssueChargeDetailSchema,
} from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import {
  collectIssueChargeAtPos,
  getIssueCharge,
  resolveIssueChargeAttempt,
  startIssueChargeEdc,
} from "./charge-endpoints";

type ChargeWire = z.input<typeof posIssueChargeDetailSchema>;
type Stored = {
  /** Start key of each card sale started from the till, by sale id. */
  saleKeys: Map<string, string>;
  /** Reads until a started sale answers. */
  readsUntilAnswer: number;
  /** Keys a supervisor closed: a late arrival is refused. */
  closedKeys: Set<string>;
  status: "open" | "paid";
  paidKey: string | null;
  /** The first collect answers 504 once, after recording. */
  dropAnswer: boolean;
  payment: ChargeWire["payment"];
  edcSales: ChargeWire["edcSales"];
  /** Status reads until a pending code is paid; null: never. */
  readsUntilPaid: number | null;
};

const AT = "2026-11-12T07:32:00.000Z";
const AMOUNT_IDR = 10_000;
const store = new Map<string, Stored>();

function demoSeed(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("demo");
}

function qrisWire(
  chargeId: string,
  id: string,
  status: "pending" | "expired" | "failed",
  minutesLeft = 10,
): NonNullable<Stored["payment"]> {
  return {
    id,
    target: { kind: "issue_charge", chargeId },
    method: "qris",
    amountIdr: AMOUNT_IDR,
    status,
    qrisPayload: `MOCK-QRIS-${chargeId}-${id}`,
    redirectUrl: null,
    vaNumber: null,
    bankCode: null,
    bankName: null,
    expiresAt: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
    paidAt: null,
  };
}

const OLD_CODE = "0b0e7c53-94a6-4f0a-8f43-5f9d7c1e6a01";

function seedPayment(chargeId: string, seed: string | null): Stored["payment"] {
  if (seed === "selisih-qris-kedaluwarsa")
    return qrisWire(chargeId, OLD_CODE, "expired", -1);
  if (seed === "selisih-qris-gagal")
    return qrisWire(chargeId, OLD_CODE, "failed");
  if (seed === "selisih-qris-habis")
    return qrisWire(chargeId, OLD_CODE, "pending", -1);
  return null;
}

const EDC_SEEDS = {
  "selisih-edc-disetujui": "approved",
  "selisih-edc-menunggu": "pending",
  "selisih-edc-belum-pasti": "unknown",
  "selisih-edc-ditolak": "declined",
  "selisih-edc-tinjau": "approved",
} as const;

function seedSales(seed: string | null): Stored["edcSales"] {
  if (seed === null || !(seed in EDC_SEEDS)) return [];
  const status = EDC_SEEDS[seed as keyof typeof EDC_SEEDS];
  return [
    {
      id: "5c1d7a90-2b64-4e8f-9a17-3d0f8e6b4c21",
      status,
      amountIdr: AMOUNT_IDR,
      terminalId: "7e9a4b12-6c38-4d5f-8b20-1f3c5d7e9a02",
      terminalLabel: "EDC BCA 01",
      declineReason: status === "declined" ? "Saldo tidak cukup" : null,
      responseCode: status === "declined" ? "51" : null,
      bank: "bca",
      method: "card",
      mode: "ecr",
      createdAt: AT,
      completedAt: status === "approved" || status === "declined" ? AT : null,
      needsReconciliation: seed === "selisih-edc-tinjau",
    },
  ];
}

function stored(chargeId: string): Stored {
  let entry = store.get(chargeId);
  if (!entry) {
    const seed = demoSeed();
    entry = {
      status: seed === "selisih-lunas" ? "paid" : "open",
      paidKey: null,
      dropAnswer:
        seed === "selisih-belum-pasti" || seed === "selisih-qris-putus",
      payment: seedPayment(chargeId, seed),
      edcSales: seedSales(seed),
      readsUntilPaid: seed === "selisih-qris-lunas" ? 2 : null,
      saleKeys: new Map(),
      readsUntilAnswer: 0,
      closedKeys: new Set(),
    };
    store.set(chargeId, entry);
  }
  return entry;
}

function chargeWire(chargeId: string, entry: Stored) {
  return {
    id: chargeId,
    orderId: "01JBQ9C0000000000000000048",
    status: entry.status,
    differenceIdr: AMOUNT_IDR,
    amountIdr: AMOUNT_IDR,
    paidAt: entry.status === "paid" ? AT : null,
  };
}

function dropOnce(entry: Stored) {
  if (!entry.dropAnswer) return;
  entry.dropAnswer = false;
  throw new ApiError(
    504,
    "GATEWAY_TIMEOUT",
    "Server tidak menjawab tepat waktu.",
  );
}

function readCharge(chargeId: string, entry: Stored) {
  return {
    data: {
      ...chargeWire(chargeId, entry),
      orderNumber: "POS-0048",
      tableLabel: "Meja A12",
      original: { name: "Nasi ayam", quantity: 1, lineTotalIdr: 35_000 },
      replacement: { name: "Nasi sapi", quantity: 1, lineTotalIdr: 45_000 },
      payment: entry.payment,
      edcSales: entry.edcSales,
    },
  };
}

const TERMINAL_LABEL = "EDC BCA 01";

/** A sale started here answers after a few reads, like the terminal. */
function answerStartedSales(entry: Stored) {
  const started = entry.edcSales.find(
    (sale) => sale.status === "pending" && entry.saleKeys.has(sale.id),
  );
  if (!started) return;
  if (entry.readsUntilAnswer > 0) {
    entry.readsUntilAnswer -= 1;
    return;
  }
  started.status = demoSeed() === "selisih-edc-putus" ? "unknown" : "approved";
  if (started.status === "approved") started.completedAt = AT;
}

registerMock(getIssueCharge, ({ params }) => {
  const entry = stored(params.chargeId);
  answerStartedSales(entry);
  if (entry.payment?.status === "pending" && entry.readsUntilPaid !== null) {
    if (entry.readsUntilPaid > 0) entry.readsUntilPaid -= 1;
    else {
      entry.payment = { ...entry.payment, status: "paid", paidAt: AT };
      entry.status = "paid";
    }
  }
  return readCharge(params.chargeId, entry);
});

registerMock(startIssueChargeEdc, ({ params, body }) => {
  const entry = stored(params.chargeId);
  if (entry.closedKeys.has(body.idempotencyKey))
    throw new ApiError(
      409,
      "CONFLICT",
      "Percobaan ini sudah ditutup supervisor; mulai penagihan baru.",
    );
  let sale = entry.edcSales.find(
    (item) => entry.saleKeys.get(item.id) === body.idempotencyKey,
  );
  if (!sale) {
    if (entry.status === "paid")
      throw new ApiError(409, "CONFLICT", "Tagihan selisih ini sudah lunas.");
    sale = {
      id: globalThis.crypto.randomUUID(),
      status: "pending",
      amountIdr: AMOUNT_IDR,
      terminalId: body.terminalId,
      terminalLabel: TERMINAL_LABEL,
      declineReason: null,
      responseCode: null,
      bank: "bca",
      method: "card",
      mode: "ecr",
      createdAt: new Date().toISOString(),
      completedAt: null,
      needsReconciliation: false,
    };
    entry.edcSales = [sale, ...entry.edcSales];
    entry.saleKeys.set(sale.id, body.idempotencyKey);
    entry.readsUntilAnswer = 2;
  }
  return {
    data: {
      id: sale.id,
      tenantId: "00000000-0000-4000-8000-000000000001",
      outletId: "00000000-0000-4000-8000-000000000002",
      terminalId: sale.terminalId,
      bank: "bca" as const,
      reference: params.chargeId,
      idempotencyKey: body.idempotencyKey,
      amountIdr: AMOUNT_IDR,
      method: "card" as const,
      status: sale.status,
      trace: "MOCK0001",
      approvalCode: null,
      rrn: null,
      cardType: null,
      maskedPan: null,
      responseCode: null,
      message: null,
      invoiceNo: null,
      batchNo: null,
      needsReconciliation: false,
      dispatchedAt: sale.createdAt,
      inquiryCount: 0,
      createdAt: sale.createdAt,
      updatedAt: sale.createdAt,
      completedAt: null,
    },
  };
});

registerMock(resolveIssueChargeAttempt, ({ params, body }) => {
  const entry = stored(params.chargeId);
  const answer = (outcome: "recorded" | "closed") => {
    const { data } = readCharge(params.chargeId, entry);
    return { data: { outcome, charge: data } };
  };
  const close = () => {
    entry.closedKeys.add(body.idempotencyKey);
    return answer("closed");
  };
  if (body.method === "cash")
    return entry.paidKey === body.idempotencyKey ? answer("recorded") : close();
  const sale = entry.edcSales.find(
    (item) => entry.saleKeys.get(item.id) === body.idempotencyKey,
  );
  if (!sale) return close();
  if (sale.status === "pending")
    throw new ApiError(
      409,
      "CONFLICT",
      "Terminal masih memproses transaksi ini; tunggu sampai selesai, lalu ulangi.",
    );
  const pay = () => {
    sale.status = "approved";
    sale.completedAt = AT;
    entry.status = "paid";
    entry.paidKey = body.idempotencyKey;
    return answer("recorded");
  };
  if (sale.status === "unknown") {
    if (body.edc === undefined)
      throw new ApiError(
        409,
        ISSUE_CHARGE_EDC_STATEMENT_REQUIRED,
        "Cek terminal dulu: nyatakan kartu gagal, atau lunas dengan slip.",
      );
    if (body.edc === "failed") {
      sale.status = "declined";
      sale.completedAt = AT;
      return close();
    }
    if (body.slip === undefined)
      throw new ApiError(
        409,
        ISSUE_CHARGE_SLIP_REQUIRED,
        "Isi RRN, kode approval, dan nominal dari slip EDC.",
      );
    if (body.slip.chargedAmountIdr !== AMOUNT_IDR)
      throw new ApiError(
        409,
        "CONFLICT",
        "Nominal di slip tidak sama dengan tagihan selisih; transaksi tetap perlu dicek.",
      );
    return pay();
  }
  if (sale.status === "approved") return pay();
  return close();
});

registerMock(collectIssueChargeAtPos, ({ params, body }) => {
  const entry = stored(params.chargeId);
  if (entry.closedKeys.has(body.idempotencyKey))
    throw new ApiError(
      409,
      "CONFLICT",
      "Percobaan ini sudah ditutup supervisor; mulai penagihan baru.",
    );
  const received = body.method === "cash" ? body.receivedIdr : AMOUNT_IDR;
  const answer = () => ({
    data: {
      charge: chargeWire(params.chargeId, entry),
      changeIdr: received - AMOUNT_IDR,
    },
  });
  if (entry.status === "paid") {
    if (entry.paidKey === body.idempotencyKey) return answer();
    throw new ApiError(409, "CONFLICT", "Tagihan selisih ini sudah lunas.");
  }
  // legend-gt98h: the code is pending; the charge is paid by the gateway. One
  // live code per charge, and a key that already made a code answers that code.
  if (body.method === "qris") {
    const live =
      entry.payment?.status === "pending" ||
      entry.payment?.id === body.idempotencyKey;
    if (!live || entry.payment === null)
      entry.payment = qrisWire(params.chargeId, body.idempotencyKey, "pending");
    dropOnce(entry);
    const { data } = answer();
    return { data: { ...data, payment: entry.payment } };
  }
  if (body.method === "edc_card") {
    const sale = entry.edcSales.find((s) => s.id === body.edcTransactionId);
    if (!sale)
      throw new ApiError(404, "NOT_FOUND", "Transaksi EDC tidak ditemukan.");
    if (sale.status !== "approved" || sale.needsReconciliation)
      throw new ApiError(
        409,
        "CONFLICT",
        "Transaksi EDC belum disetujui bank; tunggu hasil atau cek status.",
      );
  }
  if (received < AMOUNT_IDR)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Uang diterima kurang dari tagihan selisih.",
    );
  entry.status = "paid";
  entry.paidKey = body.idempotencyKey;
  dropOnce(entry);
  return answer();
});
