// Mock handlers for EDC reconciliation (VITE_API_MOCK=true). The list endpoint
// is a proposed contract (legend-khi8n, no backend yet); the resolve handler
// copies the API's rules through ./lib.ts (gate, outcome per status, charged
// amount) and removes the row from the queue like a real resolve does.
// Sample data: Cafe Legend, timestamps relative to when the mock loads so the
// ages in the mockup (42 min, 2 min, 4 min) hold.
import type { EdcTransaction } from "@starter/shared/edc";
import {
  edcReconciliationQueueItemSchema,
  listEdcReconciliationQueue,
  resolveEdcReconciliation,
  type EdcReconciliationQueueItem,
} from "@starter/shared/payment/admin";
import { cafeLegendFixtures } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { reconciliationGate } from "./lib.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const SENOPATI = "b2c3d4e5-0001-4b01-8c01-000000000a01";
const KEMANG = "b2c3d4e5-0002-4b02-8c02-000000000a02";

const OUTLET_NAMES: Record<string, string> = {
  [SENOPATI]: "Cafe Legend Senopati",
  [KEMANG]: "Cafe Legend Kemang",
};

type Seed = {
  n: string;
  outletId: string;
  cashier: string;
  terminal: string;
  terminalNo: string;
  bank: "bca" | "mandiri" | "bni" | "bjb";
  bill: string;
  amountIdr: number;
  status: EdcTransaction["status"];
  flagged: boolean;
  minutesAgo: number;
  wireOpenMinutesAgo?: number;
  result?: { approvalCode: string; rrn: string; maskedPan: string };
};

const SEEDS: Seed[] = [
  {
    n: "1048",
    outletId: SENOPATI,
    cashier: "Dimas Kasir",
    terminal: "EDC-SNP-02",
    terminalNo: "02",
    bank: "bca",
    bill: "INV-1511-084",
    amountIdr: 425_000,
    status: "unknown",
    flagged: true,
    minutesAgo: 42,
  },
  {
    n: "1052",
    outletId: KEMANG,
    cashier: "Rani Kasir",
    terminal: "EDC-KMG-01",
    terminalNo: "01",
    bank: "mandiri",
    bill: "INV-1511-091",
    amountIdr: 280_000,
    status: "approved",
    flagged: true,
    minutesAgo: 35,
    result: {
      approvalCode: "A48213",
      rrn: "318200041052",
      maskedPan: "411111******1111",
    },
  },
  {
    n: "1057",
    outletId: SENOPATI,
    cashier: "Sari Kasir",
    terminal: "EDC-SNP-01",
    terminalNo: "01",
    bank: "bca",
    bill: "INV-1511-096",
    amountIdr: 175_000,
    status: "declined",
    flagged: true,
    minutesAgo: 28,
  },
  {
    n: "1061",
    outletId: KEMANG,
    cashier: "Rani Kasir",
    terminal: "EDC-KMG-01",
    terminalNo: "01",
    bank: "mandiri",
    bill: "INV-1511-103",
    amountIdr: 320_000,
    status: "unknown",
    flagged: false,
    minutesAgo: 2,
    wireOpenMinutesAgo: 2,
  },
  {
    n: "1063",
    outletId: SENOPATI,
    cashier: "Dimas Kasir",
    terminal: "EDC-SNP-02",
    terminalNo: "02",
    bank: "bca",
    bill: "INV-1511-105",
    amountIdr: 150_000,
    status: "unknown",
    flagged: false,
    minutesAgo: 4,
  },
];

const BANK_LABEL = { bca: "BCA", mandiri: "Mandiri", bni: "BNI", bjb: "BJB" };

function buildItem(seed: Seed, nowMs: number): EdcReconciliationQueueItem {
  const at = (minutes: number) =>
    new Date(nowMs - minutes * 60_000).toISOString();
  const final = seed.status !== "unknown" && seed.status !== "pending";
  return edcReconciliationQueueItemSchema.parse({
    transaction: {
      id: `f1a2b3c4-${seed.n}-4a${seed.n.slice(0, 2)}-8b${seed.n.slice(2)}-00000000${seed.n}`,
      tenantId,
      outletId: seed.outletId,
      terminalId: `e1f2a3b4-${seed.n}-4c${seed.n.slice(0, 2)}-8d${seed.n.slice(2)}-00000000${seed.n}`,
      bank: seed.bank,
      reference: seed.bill,
      idempotencyKey: `edc-sale-${seed.n}-${seed.bill}`.padEnd(16, "0"),
      amountIdr: seed.amountIdr,
      method: "card",
      status: seed.status,
      trace: `T${seed.n}`,
      approvalCode: seed.result?.approvalCode ?? null,
      rrn: seed.result?.rrn ?? null,
      cardType: seed.result ? "Visa" : null,
      maskedPan: seed.result?.maskedPan ?? null,
      responseCode: seed.status === "declined" ? "05" : null,
      message: seed.status === "declined" ? "Ditolak bank penerbit" : null,
      invoiceNo: `EDC-${seed.n}`,
      batchNo: null,
      needsReconciliation: seed.flagged,
      dispatchedAt: at(seed.minutesAgo),
      inquiryCount: seed.status === "unknown" ? 2 : 0,
      createdAt: at(seed.minutesAgo),
      updatedAt: at(seed.minutesAgo),
      completedAt: final ? at(seed.minutesAgo) : null,
    },
    outletName: OUTLET_NAMES[seed.outletId],
    cashierName: seed.cashier,
    terminalLabel: `${seed.terminal} · ${BANK_LABEL[seed.bank]}`,
    billNumber: seed.bill,
    remainingIdr: seed.amountIdr,
    saleWireOpenAt:
      seed.wireOpenMinutesAgo === undefined
        ? null
        : at(seed.wireOpenMinutesAgo),
  });
}

const store = createMockStore(() => {
  const nowMs = Date.now();
  return SEEDS.map((seed) => buildItem(seed, nowMs));
});

registerMock(listEdcReconciliationQueue, ({ query, scenario }) => {
  const needle = query.q?.toLowerCase();
  const filtered = store.get().filter((item) => {
    const tx = item.transaction;
    if (query.outletId && tx.outletId !== query.outletId) return false;
    if (query.status && tx.status !== query.status) return false;
    if (needle) {
      const haystack = [
        tx.invoiceNo,
        item.billNumber,
        item.cashierName,
        item.outletName,
        item.terminalLabel,
      ]
        .filter((part): part is string => part !== null)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  return paginateFixture(
    filtered,
    query,
    (item) => item.transaction.id,
    scenario,
  );
});

registerMock(resolveEdcReconciliation, ({ params, body }) => {
  const items = store.get();
  const item = items.find((entry) => entry.transaction.id === params.id);
  if (!item)
    throw new ApiError(404, "NOT_FOUND", "Transaksi EDC tidak ditemukan.");
  const row = item.transaction;
  const gate = reconciliationGate(item, Date.now());
  if (gate.kind === "not-eligible")
    throw new ApiError(
      409,
      "CONFLICT",
      "Transaksi ini tidak menunggu rekonsiliasi (sudah diselesaikan atau bukan penjualan).",
    );
  if (gate.kind === "wire-open")
    throw new ApiError(
      409,
      "CONFLICT",
      "Terminal masih memproses transaksi ini; tunggu sampai selesai, lalu ulangi.",
    );
  if (gate.kind === "too-early")
    throw new ApiError(
      409,
      "CONFLICT",
      "Terminal masih mungkin mengirim jawaban untuk transaksi ini; tunggu sampai 10 menit setelah dikirim, lalu ulangi.",
    );
  if (!gate.outcomes.includes(body.outcome))
    throw new ApiError(
      409,
      "CONFLICT",
      body.outcome === "declined"
        ? "Transaksi yang sudah disetujui terminal tidak dapat dinyatakan ditolak; void dulu di terminal dan catat lewat jalur void."
        : "Transaksi ini sudah berstatus akhir tanpa persetujuan. Void muatan di terminal, lalu nyatakan ditolak.",
    );
  if (
    body.outcome === "approved" &&
    body.evidence.chargedAmountIdr !== row.amountIdr
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Nominal di terminal EDC tidak sama dengan tagihan.",
    );

  const nowIso = new Date().toISOString();
  const resolved: EdcTransaction = {
    ...row,
    needsReconciliation: false,
    updatedAt: nowIso,
    ...(row.status === "unknown"
      ? {
          status: body.outcome,
          completedAt: nowIso,
          ...(body.outcome === "approved"
            ? {
                approvalCode: body.evidence.approvalCode ?? row.approvalCode,
                rrn: body.evidence.rrn ?? row.rrn,
              }
            : {}),
        }
      : {}),
  };
  store.set(items.filter((entry) => entry !== item));
  return { data: resolved };
});
