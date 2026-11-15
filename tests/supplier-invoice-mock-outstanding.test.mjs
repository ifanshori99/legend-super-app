// legend-rrkvo: changing a held invoice into a payable must satisfy the
// response schema without losing the amount still owed to its supplier.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { registerWebAlias } from "./helpers/web-alias.mjs";
import {
  cafeLegendPurchasingFixtures as fixtures,
  supplierInvoiceSchema,
} from "../packages/shared/src/inventory/index.ts";

registerWebAlias();
const { dispatchMock, resetMocks } =
  await import("../apps/web/src/lib/mock/runtime.ts");
await import("../apps/web/src/features/ws06-purchasing/receiving-mock.ts");
const post = (path, body) => dispatchMock({ method: "POST", path, body });
const invoicePath = "/api/inventory/supplier-invoices";
const coffee = fixtures.purchaseOrderDetails.find(
  (detail) => detail.purchaseOrder.number === "PO/BDG/2026/10/0042",
);
const receipt = fixtures.goodsReceiptDetails.find(
  (detail) => detail.receipt.purchaseOrderId === coffee.purchaseOrder.id,
);

beforeEach(resetMocks);

async function createRemainingInvoice() {
  // Add the next partial delivery: the seeded invoice already bills 12 kg.
  await post("/api/inventory/goods-receipts", {
    outletId: coffee.purchaseOrder.outletId,
    purchaseOrderId: coffee.purchaseOrder.id,
    receivedOn: "2026-11-14",
    lines: [
      {
        purchaseOrderLineId: coffee.lines[0].id,
        locationId: receipt.lines[0].locationId,
        quantityReceived: "5.0000",
        quantityRejected: "0.0000",
      },
    ],
    idempotencyKey: randomUUID(),
  });
  return (
    await post(invoicePath, {
      outletId: coffee.purchaseOrder.outletId,
      supplierId: coffee.purchaseOrder.supplierId,
      purchaseOrderId: coffee.purchaseOrder.id,
      number: "INV-795-REMAINING",
      invoiceDate: "2026-11-14",
      dueDate: "2026-11-28",
      lines: [
        {
          purchaseOrderLineId: coffee.lines[0].id,
          kind: "goods",
          description: "Penerimaan kopi susulan",
          quantity: "5.0000",
          unitPriceIdr: coffee.lines[0].unitPriceIdr,
        },
      ],
      ppnIdr: 0,
      pph23Idr: 0,
      idempotencyKey: randomUUID(),
    })
  ).data;
}

test("legend-rrkvo matching a new clean invoice returns payable minus paid as outstanding", async () => {
  const created = await createRemainingInvoice();
  assert.equal(created.invoice.status, "held");
  assert.equal(created.invoice.outstandingIdr, 0);
  const { data } = await post(`${invoicePath}/${created.invoice.id}/match`, {
    idempotencyKey: randomUUID(),
  });
  assert.equal(data.invoice.status, "matched");
  assert.equal(data.invoice.payableIdr, 925_000);
  assert.equal(data.invoice.paidIdr, 0);
  assert.equal(data.invoice.outstandingIdr, 925_000);
  assert.equal(supplierInvoiceSchema.safeParse(data.invoice).success, true);
});

test("legend-rrkvo releasing a held invoice returns payable minus paid as outstanding", async () => {
  const created = await createRemainingInvoice();
  const { data } = await post(`${invoicePath}/${created.invoice.id}/release`, {
    note: "Penerimaan susulan sudah diperiksa",
    idempotencyKey: randomUUID(),
  });
  assert.equal(data.invoice.status, "released");
  assert.equal(data.invoice.payableIdr, 925_000);
  assert.equal(data.invoice.paidIdr, 0);
  assert.equal(data.invoice.outstandingIdr, 925_000);
  assert.equal(supplierInvoiceSchema.safeParse(data.invoice).success, true);
});
