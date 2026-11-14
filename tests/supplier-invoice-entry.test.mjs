// Supplier invoice entry screen: pure model + catalog contract (bead
// legend-0xnm; PRD v1.7 §3 F18 "Alur Pengadaan", §3.18 three-way match,
// §3.19 PPN masukan / PPh 23). Written fail-first from the sub-brief and the
// money decision: "web does not compute total, DPP, PPN, payable or variance".
//
// The brief names no exports; this test pins the model surface of
// apps/web/src/features/ws06-purchasing/invoice-entry-model.ts:
//
//   goodsDraftsFromOrder(orderLines, receiptLines, describe)
//     one draft per PO line: quantity defaults to the QC-accepted quantity
//     (received - rejected over all receipts), price to the PO price, text
//     fields, and `included` false when nothing was accepted.
//   buildInvoiceInput(values, idempotencyKey)
//     -> { ok: true, payload } | { ok: false, errors }; payload is the
//     createSupplierInvoiceInputSchema input. PPN / PPh 23 are the typed text
//     (blank = 0); no total, DPP or payable key is ever added.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";
import * as shared from "../packages/shared/src/inventory/index.ts";

const MODEL = "../apps/web/src/features/ws06-purchasing/invoice-entry-model.ts";
const model = () => import(MODEL);
const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const fixtures = shared.cafeLegendPurchasingFixtures;
const orderByNumber = (number) => {
  const found = fixtures.purchaseOrderDetails.find(
    (detail) => detail.purchaseOrder.number === number,
  );
  assert.ok(found, `Fixture purchase order "${number}" is missing`);
  return found;
};
const receiptLinesFor = (purchaseOrderId) =>
  fixtures.goodsReceiptDetails
    .filter((detail) => detail.receipt.purchaseOrderId === purchaseOrderId)
    .flatMap((detail) => detail.lines);

const KEMASAN = "PO/BDG/2026/10/0044"; // received 4 (1 rejected) + 2
const KOPI = "PO/BDG/2026/10/0042"; // received 12 + 5, nothing rejected
const SAYUR = "PO/BDG/2026/11/0046"; // approved, nothing received yet

const describe = (line) => `Bahan ${line.inventoryItemId.slice(-4)}`;
// Number convention (decided by the agent, applies to quantity AND price):
// Indonesian format, "." groups thousands and "," is the decimal mark.
const idNumber = (text) =>
  Number(String(text).replace(/\./g, "").replace(",", "."));
const quantityOf = (draft) => idNumber(draft.quantity);
const priceOf = (draft) => idNumber(draft.unitPrice);

async function draftsFor(number, receiptPatch = (lines) => lines) {
  const { goodsDraftsFromOrder } = await model();
  const order = orderByNumber(number);
  const receipts = receiptPatch(receiptLinesFor(order.purchaseOrder.id));
  return {
    order,
    drafts: goodsDraftsFromOrder(order.lines, receipts, describe),
  };
}

test("legend-0xnm F18 default invoice lines bill the accepted quantity at the PO price", async () => {
  const { order, drafts } = await draftsFor(KEMASAN);
  assert.equal(drafts.length, order.lines.length);
  const [first, second] = order.lines;
  // 4 received, 1 QC-rejected: only 3 may be invoiced (INV-05).
  assert.equal(drafts[0].purchaseOrderLineId, first.id);
  assert.equal(drafts[0].kind, "goods");
  assert.equal(drafts[0].included, true);
  assert.equal(quantityOf(drafts[0]), 3);
  assert.equal(priceOf(drafts[0]), Number(first.unitPriceIdr));
  assert.equal(drafts[0].description, describe(first));
  assert.equal(drafts[1].purchaseOrderLineId, second.id);
  assert.equal(quantityOf(drafts[1]), 2);
  assert.equal(priceOf(drafts[1]), Number(second.unitPriceIdr));
});

test("legend-0xnm F18 default invoice lines add up several receipts of one PO line", async () => {
  const { order, drafts } = await draftsFor(KOPI, (lines) => [
    ...lines,
    {
      ...lines[0],
      id: "00000000-0000-4000-8000-0000000fffff",
      quantityReceived: "5.0000",
      quantityRejected: "2.0000",
    },
  ]);
  // 12 + (5 - 2) accepted on the coffee line.
  const coffee = drafts.find(
    (draft) => draft.purchaseOrderLineId === order.lines[0].id,
  );
  assert.equal(quantityOf(coffee), 15);
});

test("legend-0xnm F18 a PO line with nothing accepted starts out of the invoice", async () => {
  const none = await draftsFor(SAYUR);
  assert.ok(none.drafts.length > 0);
  assert.ok(none.drafts.every((draft) => draft.included === false));

  const { order, drafts } = await draftsFor(KOPI, (lines) => {
    const target = lines.findIndex(
      (line) => line.purchaseOrderLineId === orderByNumber(KOPI).lines[1].id,
    );
    return lines.map((line, index) =>
      index === target
        ? { ...line, quantityRejected: line.quantityReceived }
        : line,
    );
  });
  assert.deepEqual(
    drafts.map((draft) => draft.included),
    [true, false],
  );
  assert.equal(drafts[1].purchaseOrderLineId, order.lines[1].id);
});

// ---- buildInvoiceInput -----------------------------------------------------

const KEY = "6f1c2a90-0000-4000-8000-00000000cafe";

async function valuesFor(number, patch = {}) {
  const { order, drafts } = await draftsFor(number);
  const { purchaseOrder } = order;
  return {
    outletId: purchaseOrder.outletId,
    supplierId: purchaseOrder.supplierId,
    purchaseOrderId: purchaseOrder.id,
    number: "FK/2026/11/0777",
    invoiceDate: "2026-11-10",
    dueDate: "2026-11-24",
    lines: drafts,
    ppn: "257400",
    pph23: "",
    ...patch,
  };
}

const serviceDraft = {
  key: "svc-1",
  kind: "service",
  purchaseOrderLineId: null,
  included: true,
  description: "Jasa pasang mesin",
  quantity: "1",
  unitPrice: "500000",
};

test("legend-0xnm F18 the built payload passes the shared create-invoice schema", async () => {
  const { buildInvoiceInput } = await model();
  const result = buildInvoiceInput(await valuesFor(KOPI), KEY);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(
    shared.createSupplierInvoiceInputSchema.safeParse(result.payload).success,
    true,
  );
  assert.equal(result.payload.number, "FK/2026/11/0777");
  assert.equal(result.payload.lines.length, 2);
  assert.equal(result.payload.idempotencyKey, KEY);
  assert.equal(result.payload.lines[0].kind, "goods");
  assert.equal(result.payload.lines[0].quantity, "12.0000");
  assert.equal(result.payload.lines[0].unitPriceIdr, "185000.0000");
});

test("legend-0xnm F18 PPN and PPh 23 go through as typed and the web adds no totals", async () => {
  const { buildInvoiceInput } = await model();
  const { payload } = buildInvoiceInput(await valuesFor(KOPI), KEY);
  // 257400 is the typed tax-invoice amount, not a percentage of the lines.
  assert.equal(payload.ppnIdr, 257_400);
  // No service line and nothing typed: PPh 23 stays 0, never derived.
  assert.equal(payload.pph23Idr, 0);

  const blank = buildInvoiceInput(
    await valuesFor(KOPI, { ppn: "", pph23: "" }),
    KEY,
  ).payload;
  assert.equal(blank.ppnIdr, 0);
  assert.equal(blank.pph23Idr, 0);

  const base = await valuesFor(KOPI);
  const withService = { ...base, lines: [...base.lines, serviceDraft] };
  // A service line must not make the web guess a 2% withholding either.
  assert.equal(
    buildInvoiceInput({ ...withService, pph23: "10000" }, KEY).payload.pph23Idr,
    10_000,
  );
  assert.equal(
    buildInvoiceInput({ ...withService, pph23: "" }, KEY).payload.pph23Idr,
    0,
  );
  const service = buildInvoiceInput(withService, KEY).payload.lines.at(-1);
  assert.equal(service.kind, "service");
  assert.equal(service.purchaseOrderLineId, null);

  const allowed = new Set(
    Object.keys(shared.createSupplierInvoiceInputSchema.shape),
  );
  for (const key of Object.keys(payload))
    assert.ok(allowed.has(key), `unexpected payload key ${key}`);
  for (const key of ["totalIdr", "payableIdr", "goodsIdr", "dppIdr"])
    assert.equal(key in payload, false, `${key} must come from the API`);
});

test("legend-0xnm F18 an excluded PO line is not sent", async () => {
  const { buildInvoiceInput } = await model();
  const values = await valuesFor(KOPI);
  const result = buildInvoiceInput(
    {
      ...values,
      lines: values.lines.map((line, index) =>
        index === 1 ? { ...line, included: false } : line,
      ),
    },
    KEY,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.payload.lines.map((line) => line.purchaseOrderLineId),
    [values.lines[0].purchaseOrderLineId],
  );
});

test("legend-0xnm F18 invalid entries are rejected on their own field before any request", async () => {
  const { buildInvoiceInput } = await model();
  const failed = async (patch) => {
    const result = buildInvoiceInput(await valuesFor(KOPI, patch), KEY);
    assert.equal(result.ok, false, JSON.stringify(patch));
    return result.errors;
  };

  assert.equal(
    (await failed({ dueDate: "2026-11-09" })).dueDate,
    "dueBeforeInvoice",
  );
  assert.equal((await failed({ number: "   " })).number, "required");
  assert.equal((await failed({ invoiceDate: "" })).invoiceDate, "required");
  for (const bad of ["abc", "-1", "1.5", "12,5"])
    assert.equal(
      (await failed({ ppn: bad })).ppn,
      "invalidAmount",
      `ppn ${bad}`,
    );
  assert.equal((await failed({ pph23: "-5" })).pph23, "invalidAmount");

  const values = await valuesFor(KOPI);
  const noLines = await failed({
    lines: values.lines.map((line) => ({ ...line, included: false })),
  });
  assert.equal(noLines.form, "noLines");

  const zero = await failed({
    lines: values.lines.map((line, index) =>
      index === 0 ? { ...line, quantity: "0" } : line,
    ),
  });
  assert.equal(zero.lines[values.lines[0].key].quantity, "invalidQuantity");

  const badPrice = await failed({
    lines: values.lines.map((line, index) =>
      index === 1 ? { ...line, unitPrice: "abc" } : line,
    ),
  });
  assert.equal(badPrice.lines[values.lines[1].key].unitPrice, "invalidPrice");
});

// Assumption (ambiguous in the spec): the user is Indonesian, so a price
// typed as "12.500" is twelve thousand five hundred rupiah, not 12.5. A wrong
// reading would silently under-bill, so grouping is understood explicitly.
test("legend-0xnm F18 a price typed with Indonesian grouping is read as whole rupiah", async () => {
  const { buildInvoiceInput } = await model();
  const values = await valuesFor(KOPI);
  const lines = values.lines.map((line, index) =>
    index === 0 ? { ...line, unitPrice: "185.000", quantity: "1,5" } : line,
  );
  const result = buildInvoiceInput({ ...values, lines }, KEY);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.payload.lines[0].unitPriceIdr, "185000.0000");
  assert.equal(result.payload.lines[0].quantity, "1.5000");
});

// ---- Number convention: "." thousands, "," decimal, same for qty and price ---

async function buildWithLine(patch) {
  const { buildInvoiceInput } = await model();
  const values = await valuesFor(KOPI);
  const lines = values.lines.map((line, index) =>
    index === 0 ? { ...line, ...patch } : line,
  );
  const result = buildInvoiceInput({ ...values, lines }, KEY);
  return { result, key: values.lines[0].key };
}

test("legend-0xnm F18 a quantity typed with Indonesian grouping or decimal comma is read the id-ID way", async () => {
  for (const [typed, expected] of [
    ["1.000", "1000.0000"],
    ["12,125", "12.1250"],
    ["1,500", "1.5000"],
    ["1.234,5", "1234.5000"],
  ]) {
    const { result } = await buildWithLine({ quantity: typed });
    assert.equal(result.ok, true, `quantity ${typed}`);
    assert.equal(
      result.payload.lines[0].quantity,
      expected,
      `quantity ${typed}`,
    );
  }
});

test("legend-0xnm F18 a price typed with Indonesian grouping or decimal comma is read the id-ID way", async () => {
  for (const [typed, expected] of [
    ["1.000", "1000.0000"],
    ["185.000", "185000.0000"],
    ["12.500,5", "12500.5000"],
    ["12,125", "12.1250"],
  ]) {
    const { result } = await buildWithLine({ unitPrice: typed });
    assert.equal(result.ok, true, `price ${typed}`);
    assert.equal(
      result.payload.lines[0].unitPriceIdr,
      expected,
      `price ${typed}`,
    );
  }
});

test("legend-0xnm F18 a dotted number that is not thousands grouping is refused, never read as a decimal", async () => {
  for (const typed of ["12.5", "1.5", "12.50", "1234.5"]) {
    const qty = await buildWithLine({ quantity: typed });
    assert.equal(qty.result.ok, false, `quantity ${typed}`);
    assert.equal(
      qty.result.errors.lines[qty.key].quantity,
      "invalidQuantity",
      `quantity ${typed}`,
    );
    const price = await buildWithLine({ unitPrice: typed });
    assert.equal(price.result.ok, false, `price ${typed}`);
    assert.equal(
      price.result.errors.lines[price.key].unitPrice,
      "invalidPrice",
      `price ${typed}`,
    );
  }
});

// The default text is what the user sees and may leave untouched: it has to
// parse back to exactly the PO price / accepted quantity (no silent change).
test("legend-0xnm F18 PO default price and quantity text re-parse to the same value", async () => {
  const { goodsDraftsFromOrder, buildInvoiceInput } = await model();
  const order = orderByNumber(KOPI);
  const cases = [
    {
      price: "12.1250",
      priceText: "12,125",
      qty: "1000.0000",
      qtyText: "1.000",
    },
    {
      price: "185000.0000",
      priceText: "185.000",
      qty: "12.1250",
      qtyText: "12,125",
    },
    { price: "12500.5000", priceText: "12.500,5", qty: "3.0000", qtyText: "3" },
  ];
  for (const c of cases) {
    const lines = order.lines.map((line) => ({
      ...line,
      unitPriceIdr: c.price,
    }));
    const receipts = lines.map((line) => ({
      purchaseOrderLineId: line.id,
      quantityReceived: c.qty,
      quantityRejected: "0.0000",
    }));
    const drafts = goodsDraftsFromOrder(lines, receipts, describe);
    assert.equal(drafts[0].unitPrice, c.priceText, `price text for ${c.price}`);
    assert.equal(drafts[0].quantity, c.qtyText, `quantity text for ${c.qty}`);

    const values = await valuesFor(KOPI, { lines: drafts });
    const result = buildInvoiceInput(values, KEY);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.payload.lines[0].unitPriceIdr, c.price);
    assert.equal(result.payload.lines[0].quantity, c.qty);
  }
});

// ---- Catalog / text-contract ----------------------------------------------
// tests/text-contract.test.mjs already scans every web file for hardcoded copy
// and unknown t() keys; these checks make the new screen's catalog, its
// registration and the labels e2e/legend-0xnm.mock.spec.ts relies on explicit.

test("legend-0xnm the invoice entry and preview catalogs are registered in the Indonesian bundle", () => {
  for (const file of ["ws06-invoice-entry", "ws06-invoice-match-preview"]) {
    assert.match(
      read("packages/shared/src/i18n/messages/id.ts"),
      new RegExp(`from "\\./${file}\\.ts"`),
      file,
    );
    assert.match(
      read(`packages/shared/src/i18n/messages/${file}.ts`),
      /export const \w+Messages\b/,
    );
  }
});

test("legend-0xnm the catalog carries the labels the screen and its e2e use", () => {
  const t = createTranslator();
  const values = new Set(MESSAGE_KEYS.map((key) => t(key)));
  for (const label of [
    "Catat faktur",
    "Catat faktur supplier",
    "Catat faktur lain",
    "Lihat daftar faktur",
    "Simpan faktur",
    "Nomor faktur",
    "Tanggal faktur",
    "Jatuh tempo",
    "Purchase order",
    "PPN masukan (Rp)",
    "PPh 23 (Rp)",
    "Jumlah ditagih",
    "Harga satuan faktur (Rp)",
    "Faktur tersimpan.",
    "Nomor faktur wajib diisi.",
    "Jatuh tempo tidak boleh sebelum tanggal faktur.",
    "Belum ada PO yang bisa difakturkan",
    "Pratinjau 3-way match",
    "Angka dari server",
  ])
    assert.ok(values.has(label), `catalog text "${label}" is missing`);
});

test("legend-0xnm the entry route keeps the invoice permission guard and the form saves through the shared hook", () => {
  const route = read(
    "apps/web/src/routes/_kelola/kelola.pengadaan_.faktur.baru.tsx",
  );
  assert.match(route, /purchasingGuard\(\["purchasing\.invoice\.match"\]\)/);
  assert.match(route, /PurchasingFrame/);

  const form = read(
    "apps/web/src/features/ws06-purchasing/components/invoice-form-page.tsx",
  );
  assert.match(form, /useCreateSupplierInvoice/);
  assert.match(form, /useAttemptKey/);
  assert.match(form, /InvoiceMatchPreview/);

  const list = read(
    "apps/web/src/features/ws06-purchasing/components/invoice-page.tsx",
  );
  assert.match(list, /\/kelola\/pengadaan\/faktur\/baru/);
});
