// Purchasing contract tests (bead legend-ejk).
// PRD v1.7 §3.18 "Purchasing & Supplier", §4 Alur I, §6.E tables
// suppliers..supplier_payments. Acceptance criteria: INV-05 (partial goods
// receipt posts only the accepted quantity), plus TEN-02/TEN-03 for the
// endpoint inputs and the WS-00 event contract for the domain events.
// WS-07's posting rules consume goods_receipt.recorded and
// supplier_invoice.recorded, so their amount keys are asserted here too.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";
import * as shared from "../packages/shared/src/inventory/index.ts";
import { idr } from "../packages/shared/src/core/index.ts";

const fixtures = shared.cafeLegendPurchasingFixtures;
const otherUserId = "00000000-0000-4000-8000-000000009999";

const purchaseOrderByNumber = (number) => {
  const found = fixtures.purchaseOrderDetails.find(
    (detail) => detail.purchaseOrder.number === number,
  );
  assert.ok(found, `Fixture purchase order "${number}" is missing`);
  return found;
};
const receiptByNumber = (number) => {
  const found = fixtures.goodsReceiptDetails.find(
    (detail) => detail.receipt.number === number,
  );
  assert.ok(found, `Fixture goods receipt "${number}" is missing`);
  return found;
};
const invoiceByNumber = (number) => {
  const found = fixtures.supplierInvoiceDetails.find(
    (detail) => detail.invoice.number === number,
  );
  assert.ok(found, `Fixture supplier invoice "${number}" is missing`);
  return found;
};

test("INV-05 fixtures parse and only the accepted quantity enters stock (PRD §3.18 QC, §6.E goods_receipts)", () => {
  assert.equal(
    shared.purchasingFixtureSchema.safeParse(fixtures).success,
    true,
  );

  const partial = receiptByNumber("GR/BDG/2026/11/0017");
  const coffee = partial.lines.find(
    (line) => line.batchCode === "KOPI-GAYO-2611",
  );
  assert.equal(shared.acceptedQuantity(coffee), "12.0000");
  assert.equal(
    fixtures.receivedValueIdr[partial.receipt.purchaseOrderId],
    2_340_000,
  );
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  assert.equal(order.purchaseOrder.status, "partially_received");
  assert.equal(
    shared.purchaseOrderStatusAfterReceipt(order.lines, partial.lines),
    "partially_received",
  );

  const withRejects = receiptByNumber("GR/BDG/2026/11/0019");
  const cup = withRejects.lines.find(
    (line) => line.quantityRejected !== "0.0000",
  );
  assert.equal(shared.acceptedQuantity(cup), "3.0000");
  assert.equal(
    shared.goodsReceiptValueIdr(withRejects.lines, "half_up"),
    133_500,
  );
  assert.equal(
    shared.goodsReceiptValueIdr([cup], "half_up"),
    97_500,
    "QC-rejected packs are not stock value",
  );
});

test("INV-05 cumulative accepted receipts cannot exceed the ordered quantity (PRD §3.18 partial delivery)", () => {
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const prior = receiptByNumber("GR/BDG/2026/11/0017").lines;
  const coffeeLine = order.lines.find(
    (line) => line.inventoryItemId === prior[0].inventoryItemId,
  );
  const rest = [
    {
      purchaseOrderLineId: coffeeLine.id,
      inventoryItemId: coffeeLine.inventoryItemId,
      quantityReceived: "8.0000",
      quantityRejected: "0.0000",
    },
  ];
  assert.doesNotThrow(() =>
    shared.assertGoodsReceiptMatchesOrder(order.lines, prior, rest),
  );
  assert.equal(
    shared.purchaseOrderStatusAfterReceipt(order.lines, [...prior, ...rest]),
    "received",
  );

  assert.throws(
    () =>
      shared.assertGoodsReceiptMatchesOrder(order.lines, prior, [
        { ...rest[0], quantityReceived: "9.0000" },
      ]),
    (error) => error.code === "PURCHASE_ORDER_OVER_RECEIPT",
  );

  const foreignLine = purchaseOrderByNumber("PO/BDG/2026/10/0044").lines[0];
  assert.throws(
    () =>
      shared.assertGoodsReceiptMatchesOrder(order.lines, prior, [
        {
          purchaseOrderLineId: foreignLine.id,
          inventoryItemId: foreignLine.inventoryItemId,
          quantityReceived: "1.0000",
          quantityRejected: "0.0000",
        },
      ]),
    (error) => error.code === "PURCHASE_ORDER_LINE_MISMATCH",
  );

  assert.equal(
    shared.purchaseOrderStatusAfterReceipt(order.lines, [
      {
        purchaseOrderLineId: coffeeLine.id,
        quantityReceived: "1.0000",
        quantityRejected: "1.0000",
      },
    ]),
    null,
    "a fully QC-rejected receipt accepts nothing, so the PO status is unchanged",
  );
});

test("PRD §3.18 three-way match flags over-receipt and price deviation, tolerance is tenant data", () => {
  const matched = invoiceByNumber("INV/KP/2026/0914");
  assert.equal(matched.match?.status, "matched");
  assert.equal(
    matched.match?.rows.every((row) => row.issues.length === 0),
    true,
  );

  const discrepant = invoiceByNumber("KN/2026/11/0031");
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0044");
  const receipt = receiptByNumber("GR/BDG/2026/11/0019");
  assert.equal(discrepant.match?.status, "discrepancy");
  const cupRow = discrepant.match.rows.find((row) => row.issues.length > 0);
  assert.deepEqual([...cupRow.issues].sort(), [
    "price_outside_tolerance",
    "quantity_exceeds_receipt",
  ]);
  assert.equal(cupRow.orderedQty, "4.0000");
  assert.equal(cupRow.acceptedQty, "3.0000");
  assert.equal(cupRow.priceVarianceIdr, 6_000);
  assert.equal(discrepant.invoice.priceVarianceIdr, 6_000);

  const loose = shared.threeWayMatch(
    {
      invoice: discrepant.invoice,
      invoiceLines: discrepant.lines,
      purchaseOrderLines: order.lines,
      goodsReceiptLines: receipt.lines,
      toleranceBp: 500,
      computedAt: discrepant.invoice.matchedAt,
    },
    "half_up",
  );
  const looseCup = loose.rows.find((row) => row.issues.length > 0);
  assert.equal(looseCup.issues.includes("price_outside_tolerance"), false);
  assert.equal(looseCup.issues.includes("quantity_exceeds_receipt"), true);
  assert.equal(loose.status, "discrepancy");
});

test("legend-btcex receipt quantity issues expose the allowance after previous invoices", () => {
  const matched = invoiceByNumber("INV/KP/2026/0914");
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const receipt = receiptByNumber("GR/BDG/2026/11/0017");
  const line = matched.lines[0];
  const match = shared.threeWayMatch(
    {
      invoice: { ...matched.invoice, goodsIdr: 925_000, servicesIdr: 0 },
      invoiceLines: [{ ...line, quantity: "5.0000", lineTotalIdr: 925_000 }],
      purchaseOrderLines: order.lines,
      goodsReceiptLines: [
        {
          ...receipt.lines[0],
          quantityReceived: "10.0000",
          quantityRejected: "0.0000",
        },
      ],
      previouslyInvoicedLines: [
        { ...line, quantity: "6.0000", lineTotalIdr: 1_110_000 },
      ],
      toleranceBp: 0,
      computedAt: matched.invoice.matchedAt,
    },
    "half_up",
  );
  assert.equal(match.status, "discrepancy");
  assert.ok(match.rows[0].issues.includes("quantity_exceeds_receipt"));
  assert.equal(match.rows[0].acceptedQty, "10.0000");
  assert.equal(match.rows[0].remainingInvoiceableQty, "4.0000");
});

test("PRD §3.18 three-way match checks line totals and invoice header amounts", () => {
  const matched = invoiceByNumber("INV/KP/2026/0914");
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const receipt = receiptByNumber("GR/BDG/2026/11/0017");

  const badLine = shared.threeWayMatch(
    {
      invoice: matched.invoice,
      invoiceLines: matched.lines.map((line, index) =>
        index === 0 ? { ...line, lineTotalIdr: line.lineTotalIdr + 1 } : line,
      ),
      purchaseOrderLines: order.lines,
      goodsReceiptLines: receipt.lines,
      toleranceBp: 0,
      computedAt: matched.invoice.matchedAt,
    },
    "half_up",
  );
  assert.equal(
    badLine.rows.some((row) => row.issues.includes("line_total_mismatch")),
    true,
  );

  const badHeader = shared.threeWayMatch(
    {
      invoice: { ...matched.invoice, goodsIdr: matched.invoice.goodsIdr + 1 },
      invoiceLines: matched.lines,
      purchaseOrderLines: order.lines,
      goodsReceiptLines: receipt.lines,
      toleranceBp: 0,
      computedAt: matched.invoice.matchedAt,
    },
    "half_up",
  );
  assert.deepEqual(badHeader.headerIssues, ["invoice_total_mismatch"]);
  assert.equal(badHeader.status, "discrepancy");

  // Billing the same receipt again on a second invoice exceeds the cumulative cap.
  const rebilled = shared.threeWayMatch(
    {
      invoice: matched.invoice,
      invoiceLines: matched.lines,
      purchaseOrderLines: order.lines,
      goodsReceiptLines: receipt.lines,
      toleranceBp: 0,
      computedAt: matched.invoice.matchedAt,
      previouslyInvoicedLines: matched.lines,
    },
    "half_up",
  );
  assert.equal(rebilled.status, "discrepancy");
  assert.equal(
    rebilled.rows.some((row) =>
      row.issues.includes("quantity_exceeds_receipt"),
    ),
    true,
  );
});

test("PRD §3.18 an invoice with a price variance bills the invoice price once and clears GRNI at PO cost", () => {
  const discrepant = invoiceByNumber("KN/2026/11/0031");
  const invoicePriceGoods = discrepant.lines
    .filter((line) => line.kind === "goods")
    .reduce((total, line) => total + line.lineTotalIdr, 0);
  const services = discrepant.lines
    .filter((line) => line.kind !== "goods")
    .reduce((total, line) => total + line.lineTotalIdr, 0);
  assert.ok(discrepant.invoice.priceVarianceIdr !== 0);
  // goodsIdr is at PO price; goods + variance is what the supplier billed.
  assert.equal(
    discrepant.invoice.goodsIdr + discrepant.invoice.priceVarianceIdr,
    invoicePriceGoods,
  );
  assert.equal(
    discrepant.invoice.totalIdr,
    invoicePriceGoods + services + discrepant.invoice.ppnIdr,
  );
  assert.deepEqual(discrepant.match.headerIssues, []);
  // The recorded event refuses a split whose journal would not balance.
  const payload = {
    supplierInvoiceId: discrepant.invoice.id,
    supplierId: discrepant.invoice.supplierId,
    purchaseOrderId: discrepant.invoice.purchaseOrderId,
    number: discrepant.invoice.number,
    goodsIdr: discrepant.invoice.goodsIdr,
    priceVarianceIdr: discrepant.invoice.priceVarianceIdr,
    servicesIdr: discrepant.invoice.servicesIdr,
    ppnIdr: discrepant.invoice.ppnIdr,
    pph23Idr: discrepant.invoice.pph23Idr,
    payableIdr: discrepant.invoice.payableIdr,
    totalIdr: discrepant.invoice.totalIdr,
    recordedBy: discrepant.invoice.recordedBy,
    recordedAt: discrepant.invoice.recordedAt,
  };
  const schema = shared.supplierInvoiceRecordedEventPayloadSchema;
  assert.equal(schema.safeParse(payload).success, true);
  assert.equal(
    schema.safeParse({ ...payload, goodsIdr: invoicePriceGoods }).success,
    false,
  );
});

test("PRD §4 Alur I purchase request approval needs a different person and follows the state machine", () => {
  assert.equal(
    shared.transitionPurchaseRequest("draft", "submit"),
    "pending_approval",
  );
  assert.equal(
    shared.transitionPurchaseRequest("pending_approval", "approve"),
    "approved",
  );
  assert.equal(
    shared.transitionPurchaseRequest("approved", "convert"),
    "converted",
  );
  assert.equal(
    shared.transitionPurchaseRequest("pending_approval", "reject"),
    "rejected",
  );
  assert.throws(
    () => shared.transitionPurchaseRequest("draft", "convert"),
    (error) => error.code === "PURCHASE_REQUEST_INVALID_TRANSITION",
  );
  assert.throws(
    () => shared.transitionPurchaseRequest("converted", "cancel"),
    (error) => error.code === "PURCHASE_REQUEST_INVALID_TRANSITION",
  );

  const pending = fixtures.purchaseRequests.find(
    (request) => request.status === "pending_approval",
  );
  assert.doesNotThrow(() =>
    shared.assertPurchaseRequestApproval(pending, otherUserId),
  );
  assert.throws(
    () => shared.assertPurchaseRequestApproval(pending, pending.requestedBy),
    (error) => error.code === "PURCHASE_REQUEST_SELF_APPROVAL",
  );
  const converted = fixtures.purchaseRequests.find(
    (request) => request.status === "converted",
  );
  assert.notEqual(converted.decidedBy, converted.requestedBy);
  assert.throws(
    () =>
      shared.assertPurchaseRequestApproval(converted, converted.requestedBy),
    (error) => error.code === "PURCHASE_REQUEST_NOT_PENDING_APPROVAL",
  );
});

test("PRD §4 Alur I purchase order states cover approval, send, partial and full receipt", () => {
  assert.equal(
    shared.transitionPurchaseOrder("draft", "submit"),
    "pending_approval",
  );
  assert.equal(
    shared.transitionPurchaseOrder("pending_approval", "approve"),
    "approved",
  );
  assert.equal(
    shared.transitionPurchaseOrder("pending_approval", "reject"),
    "draft",
  );
  assert.equal(shared.transitionPurchaseOrder("approved", "send"), "sent");
  assert.equal(
    shared.transitionPurchaseOrder("sent", "receive_partial"),
    "partially_received",
  );
  assert.equal(
    shared.transitionPurchaseOrder("partially_received", "receive_full"),
    "received",
  );
  assert.equal(shared.transitionPurchaseOrder("received", "close"), "closed");
  assert.throws(
    () => shared.transitionPurchaseOrder("draft", "receive_full"),
    (error) => error.code === "PURCHASE_ORDER_INVALID_TRANSITION",
  );

  const draft = fixtures.purchaseOrders.find(
    (order) => order.status === "draft",
  );
  assert.equal(draft.source, "ai");
  assert.equal(draft.approvedBy, null);
  const mcp = fixtures.purchaseOrders.find((order) => order.source === "mcp");
  assert.equal(mcp.status, "approved");
  assert.notEqual(mcp.approvedBy, mcp.createdBy);
  assert.throws(
    () =>
      shared.assertPurchaseOrderApproval(
        { status: "pending_approval", createdBy: mcp.createdBy },
        mcp.createdBy,
      ),
    (error) => error.code === "PURCHASE_ORDER_SELF_APPROVAL",
  );
  assert.doesNotThrow(() =>
    shared.assertPurchaseOrderApproval(
      { status: "pending_approval", createdBy: mcp.createdBy },
      otherUserId,
    ),
  );

  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const totals = shared.purchaseOrderTotals(order.lines, idr(100), "half_up");
  assert.equal(totals.subtotalIdr, order.purchaseOrder.subtotalIdr);
  assert.equal(totals.totalIdr, order.purchaseOrder.subtotalIdr + 100);
});

test("PRD §3.18 supplier payment needs a matched invoice, another approver and outstanding funds", () => {
  assert.equal(
    shared.transitionSupplierPayment("pending_approval", "approve"),
    "approved",
  );
  assert.equal(shared.transitionSupplierPayment("approved", "pay"), "paid");
  assert.equal(
    shared.transitionSupplierPayment("pending_approval", "reject"),
    "rejected",
  );
  assert.throws(
    () => shared.transitionSupplierPayment("paid", "pay"),
    (error) => error.code === "SUPPLIER_PAYMENT_INVALID_TRANSITION",
  );

  const pending = fixtures.supplierPayments.find(
    (payment) => payment.status === "pending_approval",
  );
  assert.throws(
    () => shared.assertSupplierPaymentApproval(pending, pending.requestedBy),
    (error) => error.code === "SUPPLIER_PAYMENT_SELF_APPROVAL",
  );
  assert.doesNotThrow(() =>
    shared.assertSupplierPaymentApproval(pending, otherUserId),
  );
  const paid = fixtures.supplierPayments.find(
    (payment) => payment.status === "paid",
  );
  assert.throws(
    () => shared.assertSupplierPaymentApproval(paid, otherUserId),
    (error) => error.code === "SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL",
  );

  const matched = invoiceByNumber("INV/KP/2026/0914").invoice;
  const settled = invoiceByNumber("SSB/11/0412").invoice;
  const discrepant = invoiceByNumber("KN/2026/11/0031").invoice;
  assert.doesNotThrow(() => shared.assertSupplierInvoicePayable(matched));
  assert.throws(
    () => shared.assertSupplierInvoicePayable(discrepant),
    (error) => error.code === "SUPPLIER_INVOICE_NOT_MATCHED",
  );
  assert.throws(
    () => shared.assertSupplierInvoicePayable(settled),
    (error) => error.code === "SUPPLIER_INVOICE_NOT_PAYABLE",
  );
  assert.doesNotThrow(() =>
    shared.assertSupplierPaymentWithinInvoice(
      matched,
      matched.outstandingIdr,
      [],
    ),
  );
  assert.throws(
    () =>
      shared.assertSupplierPaymentWithinInvoice(
        matched,
        matched.outstandingIdr + 1,
        [],
      ),
    (error) => error.code === "SUPPLIER_INVOICE_OVERPAYMENT",
  );
  // A second request while the first is still open cannot overpay the invoice;
  // rejected or cancelled requests do not count.
  const half = Math.floor(matched.outstandingIdr / 2);
  assert.throws(
    () =>
      shared.assertSupplierPaymentWithinInvoice(
        matched,
        matched.outstandingIdr - half + 1,
        [{ amountIdr: half, status: "pending_approval" }],
      ),
    (error) => error.code === "SUPPLIER_INVOICE_OVERPAYMENT",
  );
  assert.doesNotThrow(() =>
    shared.assertSupplierPaymentWithinInvoice(matched, matched.outstandingIdr, [
      { amountIdr: half, status: "rejected" },
      { amountIdr: half, status: "cancelled" },
    ]),
  );

  assert.equal(
    shared.supplierInvoicePaymentStatus(matched, "2026-11-01"),
    "unpaid",
  );
  assert.equal(
    shared.supplierInvoicePaymentStatus(matched, "2026-11-16"),
    "overdue",
  );
  assert.equal(
    shared.supplierInvoicePaymentStatus(settled, "2026-11-01"),
    "paid",
  );
  assert.equal(
    shared.supplierInvoicePaymentStatus(
      { paidIdr: 100, outstandingIdr: 900, dueDate: "2026-11-15" },
      "2026-11-01",
    ),
    "partially_paid",
  );
});

test("PRD §3.18 supplier catalog resolves the price in force and computes its change", () => {
  const supplier = fixtures.suppliers.find(
    (row) => row.name === "CV Kopi Priangan",
  );
  const coffee = fixtures.supplierCatalog.find(
    (row) => row.supplierId === supplier.id && row.priceIdr === "185000.0000",
  );
  assert.equal(
    coffee.inventoryItemId,
    fixtures.supplierCatalog[0].inventoryItemId,
  );

  const september = shared.supplierPriceOnDate(fixtures.supplierCatalog, {
    supplierId: supplier.id,
    inventoryItemId: coffee.inventoryItemId,
    onDate: "2026-09-15",
  });
  assert.equal(september.priceIdr, "172000.0000");
  const october = shared.supplierPriceOnDate(fixtures.supplierCatalog, {
    supplierId: supplier.id,
    inventoryItemId: coffee.inventoryItemId,
    onDate: "2026-10-01",
  });
  assert.equal(october.priceIdr, "185000.0000");

  const history = shared.supplierPriceHistory(
    fixtures.supplierCatalog,
    supplier.id,
    coffee.inventoryItemId,
  );
  assert.deepEqual(
    history.map((row) => row.effectiveFrom),
    ["2026-10-01", "2026-08-01"],
  );
  assert.equal(
    shared.supplierPriceChangeBp("172000.0000", "185000.0000", "half_up"),
    756,
  );
  assert.equal(
    shared.supplierPriceChangeBp("0.0000", "185000.0000", "half_up"),
    null,
  );
});

test("PRD §3.18 supplier performance derives on-time, rejection and price variance", () => {
  const kemasan = fixtures.suppliers.find(
    (row) => row.name === "PT Kemasan Nusantara",
  );
  const performance = fixtures.supplierPerformances.find(
    (row) => row.supplierId === kemasan.id,
  );
  assert.equal(performance.deliveriesTotal, 2);
  assert.equal(performance.onTimeRateBp, 0);
  assert.equal(performance.rejectionRateBp, 1667);
  assert.equal(performance.priceVarianceBp, 337);
  assert.equal(performance.receivedQty, "6.0000");
  assert.equal(performance.rejectedQty, "1.0000");

  const sayur = fixtures.suppliers.find(
    (row) => row.name === "UD Sayur Lembang",
  );
  const empty = shared.supplierPerformance(
    {
      tenantId: sayur.tenantId,
      supplierId: sayur.id,
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
      deliveries: [],
      computedAt: "2026-11-01T04:00:00.000Z",
    },
    "half_up",
  );
  assert.equal(empty.onTimeRateBp, null);
  assert.equal(empty.rejectionRateBp, null);
  assert.equal(empty.priceVarianceBp, null);
});

test("PRD §3.18 purchase returns stay within the accepted receipt", () => {
  const purchaseReturn = fixtures.purchaseReturnDetails[0];
  assert.equal(purchaseReturn.purchaseReturn.reason, "damaged");
  assert.equal(purchaseReturn.purchaseReturn.valueIdr, 185_000);
  assert.equal(
    shared.purchaseReturnValueIdr(purchaseReturn.lines, "half_up"),
    185_000,
  );

  const accepted = new Map([
    [purchaseReturn.lines[0].purchaseOrderLineId, "12.0000"],
  ]);
  const returned = new Map([
    [purchaseReturn.lines[0].purchaseOrderLineId, "1.0000"],
  ]);
  const line = {
    purchaseOrderLineId: purchaseReturn.lines[0].purchaseOrderLineId,
    quantity: "11.0000",
  };
  assert.doesNotThrow(() =>
    shared.assertPurchaseReturnWithinReceipt(accepted, returned, [line]),
  );
  assert.throws(
    () =>
      shared.assertPurchaseReturnWithinReceipt(accepted, returned, [
        { ...line, quantity: "12.0000" },
      ]),
    (error) => error.code === "PURCHASE_RETURN_EXCEEDS_RECEIPT",
  );
  assert.throws(
    () => shared.assertPurchaseReturnWithinReceipt(new Map(), returned, [line]),
    (error) => error.code === "PURCHASE_RETURN_EXCEEDS_RECEIPT",
  );
});

test("PRD §3.18 petty purchase respects the outlet limit and requires a photo", () => {
  const outletId = fixtures.pettyPurchases[0].outletId;
  assert.equal(
    shared.pettyPurchaseLimitFor(fixtures.pettyPurchasePolicies, outletId),
    500_000,
  );
  const override = shared.pettyPurchasePolicySchema.parse({
    tenantId: fixtures.suppliers[0].tenantId,
    outletId,
    limitIdr: 750_000,
  });
  assert.equal(
    shared.pettyPurchaseLimitFor(
      [...fixtures.pettyPurchasePolicies, override],
      outletId,
    ),
    750_000,
  );

  assert.doesNotThrow(() =>
    shared.assertPettyPurchaseWithinLimit(idr(285_000), idr(500_000)),
  );
  assert.throws(
    () => shared.assertPettyPurchaseWithinLimit(idr(500_001), idr(500_000)),
    (error) => error.code === "PETTY_PURCHASE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => shared.assertPettyPurchaseWithinLimit(idr(1_000), null),
    (error) => error.code === "PETTY_PURCHASE_LIMIT_EXCEEDED",
    "deny by default when no policy exists",
  );

  const withoutPhoto = Object.fromEntries(
    Object.entries(fixtures.pettyPurchases[0]).filter(
      ([key]) => key !== "photoMediaId",
    ),
  );
  assert.equal(
    shared.pettyPurchaseSchema.safeParse(withoutPhoto).success,
    false,
  );
});

test("WS-06 purchasing events are registered once and their payloads validate (PRD §3 Kontrak Bersama)", () => {
  const entries = shared.purchasingEventCatalogEntries;
  assert.deepEqual(
    entries.map((entry) => entry.name),
    shared.purchasingEventNames,
  );
  assert.deepEqual([...shared.purchasingEventNames].sort(), [
    "goods_receipt.recorded",
    "petty_purchase.recorded",
    "purchase_order.approved",
    "purchase_order.created",
    "purchase_return.recorded",
    "supplier_invoice.matched",
    "supplier_invoice.recorded",
    "supplier_payment.paid",
  ]);
  for (const entry of entries) {
    assert.equal(entry.workstream, "WS-06");
    assert.equal(entry.version, 1);
    assert.equal(entry.payloadSchemaRef, `${entry.name}.v1`);
    assert.ok(
      events.eventCatalog.some((catalog) => catalog.name === entry.name),
      `${entry.name} is missing from the WS-00 catalog`,
    );
  }

  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042").purchaseOrder;
  const payload = {
    purchaseOrderId: order.id,
    supplierId: order.supplierId,
    number: order.number,
    totalIdr: order.totalIdr,
    approvedBy: order.approvedBy,
    approvedAt: order.approvedAt,
  };
  assert.equal(
    shared.purchaseOrderApprovedEventPayloadSchema.safeParse(payload).success,
    true,
  );
  const envelope = {
    ...events.eventFixture,
    name: "purchase_order.approved",
    aggregateType: "purchase_order",
    aggregateId: order.id,
    payloadSchemaRef: "purchase_order.approved.v1",
    payload,
  };
  const parsed = shared.purchasingEventSchema.parse(envelope);
  assert.equal(parsed.name, "purchase_order.approved");
  assert.equal(
    shared.purchasingEventSchema.safeParse({
      ...envelope,
      payload: events.eventFixture.payload,
    }).success,
    false,
    "the envelope validates the catalogued payload (defineDomainEvent)",
  );
  assert.equal(
    shared.purchasingEventSchema.safeParse({
      ...events.eventFixture,
      name: "payment.paid",
      aggregateType: "payment",
    }).success,
    false,
  );

  // WS-07's posting rules read these exact amount keys; a rename would break
  // the journal silently, so the contract test guards them.
  const invoiceShape = shared.supplierInvoiceRecordedEventPayloadSchema.shape;
  for (const key of [
    "goodsIdr",
    "priceVarianceIdr",
    "servicesIdr",
    "ppnIdr",
    "pph23Idr",
    "payableIdr",
  ])
    assert.ok(key in invoiceShape, `supplier_invoice.recorded lacks ${key}`);
  assert.ok(
    "receivedValueIdr" in shared.goodsReceiptRecordedEventPayloadSchema.shape,
  );
});

test("purchasing endpoints are unique and write inputs reject tenant fields and server money (TEN-02, TEN-03)", () => {
  const ids = shared.purchasingEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of shared.purchasingEndpoints) {
    assert.ok(endpoint.path.startsWith("/api/inventory/"), endpoint.path);
    const hasPathParam = endpoint.path
      .split("/")
      .some((part) => part.startsWith(":"));
    if (hasPathParam) assert.ok(endpoint.params, `${endpoint.id} params`);
  }

  const supplier = fixtures.suppliers[0];
  const validSupplier = {
    name: "CV Sumber Rejeki",
    paymentTermsDays: 14,
    idempotencyKey: "fixture-supplier-0001",
  };
  assert.equal(
    shared.createSupplierInputSchema.safeParse(validSupplier).success,
    true,
  );
  assert.equal(
    shared.createSupplierInputSchema.safeParse({
      ...validSupplier,
      tenantId: supplier.tenantId,
    }).success,
    false,
  );
  assert.equal(
    shared.updateSupplierInputSchema.safeParse({ name: "Nama Baru" }).success,
    false,
    "the optimistic lock timestamp is required",
  );

  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const orderLine = order.lines[0];
  const validOrder = {
    outletId: order.purchaseOrder.outletId,
    supplierId: supplier.id,
    expectedDate: "2026-11-06",
    source: "user",
    lines: [
      {
        inventoryItemId: orderLine.inventoryItemId,
        quantity: "2.0000",
        uomId: orderLine.uomId,
        unitPriceIdr: "185000.0000",
      },
    ],
    idempotencyKey: "fixture-order-0001",
  };
  assert.equal(
    shared.createPurchaseOrderInputSchema.safeParse(validOrder).success,
    true,
  );
  assert.equal(
    shared.createPurchaseOrderInputSchema.safeParse({
      ...validOrder,
      totalIdr: 370_000,
    }).success,
    false,
    "the client never submits server-computed totals",
  );
  assert.equal(
    shared.createPurchaseOrderInputSchema.safeParse({
      ...validOrder,
      tenantId: supplier.tenantId,
    }).success,
    false,
  );

  const receiptLine = receiptByNumber("GR/BDG/2026/11/0017").lines[0];
  const validReceipt = {
    outletId: order.purchaseOrder.outletId,
    purchaseOrderId: order.purchaseOrder.id,
    lines: [
      {
        purchaseOrderLineId: receiptLine.purchaseOrderLineId,
        locationId: receiptLine.locationId,
        quantityReceived: "1.0000",
        quantityRejected: "0.0000",
      },
    ],
    idempotencyKey: "fixture-receipt-0001",
  };
  assert.equal(
    shared.createGoodsReceiptInputSchema.safeParse(validReceipt).success,
    true,
  );
  assert.equal(
    shared.createGoodsReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], unitCostIdr: "185000.0000" }],
    }).success,
    false,
    "the receipt unit cost comes from the PO, not the client",
  );
  assert.equal(
    shared.createGoodsReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], expiresOn: "2026-12-01" }],
    }).success,
    false,
    "an expiry date needs a batch code",
  );

  assert.equal(
    shared.sendPurchaseOrderInputSchema.safeParse({
      channel: "email",
      idempotencyKey: "fixture-send-0001",
    }).success,
    true,
    "[50-F1] the server defaults the recipient to the supplier email",
  );
  assert.equal(
    shared.sendPurchaseOrderInputSchema.safeParse({
      channel: "email",
      email: "purchasing@supplier.example",
      idempotencyKey: "fixture-send-0001",
    }).success,
    true,
  );

  const invoiceBody = {
    outletId: order.purchaseOrder.outletId,
    supplierId: supplier.id,
    purchaseOrderId: order.purchaseOrder.id,
    number: "INV/TEST/0001",
    invoiceDate: "2026-11-02",
    dueDate: "2026-11-01",
    lines: [
      {
        purchaseOrderLineId: orderLine.id,
        kind: "goods",
        description: "Kopi 1 kg",
        quantity: "1.0000",
        unitPriceIdr: "185000.0000",
      },
    ],
    ppnIdr: 0,
    pph23Idr: 0,
    idempotencyKey: "fixture-invoice-0001",
  };
  assert.equal(
    shared.createSupplierInvoiceInputSchema.safeParse(invoiceBody).success,
    false,
    "dueDate may not precede invoiceDate",
  );
  assert.equal(
    shared.createSupplierInvoiceInputSchema.safeParse({
      ...invoiceBody,
      dueDate: "2026-11-16",
    }).success,
    true,
  );

  assert.equal(
    shared.createPettyPurchaseInputSchema.safeParse({
      outletId: order.purchaseOrder.outletId,
      vendorName: "Pasar Kosambi",
      description: "Garnish",
      amountIdr: 285_000,
      idempotencyKey: "fixture-petty-0001",
    }).success,
    false,
    "the photo is mandatory",
  );
});

test("[25a7-CT-1] a purchase order carries a required updatedAt and a nullable emailDeliveryStatus", () => {
  const { purchaseOrder } = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  assert.equal(
    shared.purchaseOrderSchema.safeParse(purchaseOrder).success,
    true,
  );
  const { updatedAt, ...withoutUpdatedAt } = purchaseOrder;
  assert.ok(updatedAt);
  assert.equal(
    shared.purchaseOrderSchema.safeParse(withoutUpdatedAt).success,
    false,
    "updatedAt is required",
  );
  const { emailDeliveryStatus, ...withoutStatus } = purchaseOrder;
  assert.ok(emailDeliveryStatus);
  assert.equal(
    shared.purchaseOrderSchema.safeParse(withoutStatus).success,
    false,
    "emailDeliveryStatus is required, null means never emailed",
  );
  for (const status of ["queued", "sent", "failed", null]) {
    assert.equal(
      shared.purchaseOrderSchema.safeParse({
        ...purchaseOrder,
        emailDeliveryStatus: status,
      }).success,
      true,
      String(status),
    );
  }
  assert.equal(
    shared.purchaseOrderSchema.safeParse({
      ...purchaseOrder,
      emailDeliveryStatus: "bounced",
    }).success,
    false,
  );
});

test("[25a7-CT-2] an email longer than 254 characters is rejected in every input", () => {
  const longEmail = `${"a".repeat(243)}@example.com`;
  const okEmail = `${"a".repeat(242)}@example.com`;
  assert.equal(longEmail.length, 255);
  assert.equal(okEmail.length, 254);
  const supplierBody = (email) => ({
    name: "CV Sumber Rejeki",
    paymentTermsDays: 14,
    email,
    idempotencyKey: "fixture-supplier-0002",
  });
  const contactBody = (email) => ({
    name: "Budi",
    phone: "+6281234567890",
    email,
    isPrimary: true,
    idempotencyKey: "fixture-contact-0001",
  });
  const sendBody = (email) => ({
    channel: "email",
    email,
    idempotencyKey: "fixture-send-0002",
  });
  const updateBody = (email) => ({
    email,
    expectedUpdatedAt: "2026-10-20T03:00:00.000Z",
  });
  const cases = [
    [shared.createSupplierInputSchema, supplierBody],
    [shared.updateSupplierInputSchema, updateBody],
    [shared.createSupplierContactInputSchema, contactBody],
    [shared.sendPurchaseOrderInputSchema, sendBody],
  ];
  for (const [schema, body] of cases) {
    assert.equal(schema.safeParse(body(okEmail)).success, true, "254 accepted");
    assert.equal(
      schema.safeParse(body(longEmail)).success,
      false,
      "255 rejected",
    );
  }
  const { purchaseOrder } = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  assert.equal(
    shared.purchaseOrderSchema.safeParse({
      ...purchaseOrder,
      sentTo: longEmail,
    }).success,
    false,
  );
});

test("[25a7-CT-3] the follow-up purchasing error codes exist", () => {
  for (const code of [
    "SUPPLIER_INACTIVE",
    "SUPPLIER_NAME_TAKEN",
    "PURCHASE_ORDER_NOT_SENDABLE",
    "PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE",
  ]) {
    assert.ok(shared.PURCHASING_ERROR_CODES.includes(code), code);
    assert.equal(
      shared.purchasingErrorCodeSchema.safeParse(code).success,
      true,
    );
  }
});

test("[50-F2] the share-link revoke endpoint is in the contract and strict", () => {
  const endpoint = shared.purchasingEndpoints.find(
    (item) => item.id === shared.revokePurchaseOrderShareLinks.id,
  );
  assert.ok(endpoint, "registered in purchasingEndpoints");
  assert.equal(endpoint.method, "POST");
  assert.equal(
    endpoint.path,
    "/api/inventory/purchase-orders/:purchaseOrderId/share-links/revoke",
  );
  assert.equal(
    shared.revokePurchaseOrderShareLinksInputSchema.safeParse({
      idempotencyKey: "fixture-revoke-0001",
    }).success,
    true,
  );
  assert.equal(
    shared.revokePurchaseOrderShareLinksInputSchema.safeParse({
      idempotencyKey: "fixture-revoke-0001",
      note: "Supplier changed",
      tenantId: "x",
    }).success,
    false,
  );
  assert.equal(
    shared.purchaseOrderShareLinksRevokedSchema.safeParse({ revoked: 2 })
      .success,
    true,
  );
  assert.equal(
    shared.purchaseOrderShareLinksRevokedSchema.safeParse({ revoked: -1 })
      .success,
    false,
  );
});

test("[50-F4] a document accepts at most 200 lines", () => {
  const supplier = fixtures.suppliers[0];
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const orderLine = {
    inventoryItemId: order.lines[0].inventoryItemId,
    quantity: "2.0000",
    uomId: order.lines[0].uomId,
    unitPriceIdr: "185000.0000",
  };
  const requestLine = {
    inventoryItemId: orderLine.inventoryItemId,
    quantity: "2.0000",
    uomId: orderLine.uomId,
  };
  const many = (line, count) => Array.from({ length: count }, () => line);
  const orderBody = (count) => ({
    outletId: order.purchaseOrder.outletId,
    supplierId: supplier.id,
    expectedDate: "2026-11-06",
    source: "user",
    lines: many(orderLine, count),
    idempotencyKey: "fixture-order-0200",
  });
  const requestBody = (count) => ({
    outletId: order.purchaseOrder.outletId,
    neededBy: "2026-11-06",
    lines: many(requestLine, count),
    idempotencyKey: "fixture-request-0200",
  });
  const updateBody = (count) => ({
    lines: many(orderLine, count),
    expectedUpdatedAt: "2026-10-20T03:00:00.000Z",
  });
  for (const [schema, body] of [
    [shared.createPurchaseOrderInputSchema, orderBody],
    [shared.createPurchaseRequestInputSchema, requestBody],
    [shared.updatePurchaseOrderInputSchema, updateBody],
  ]) {
    assert.equal(schema.safeParse(body(200)).success, true, "200 accepted");
    assert.equal(schema.safeParse(body(201)).success, false, "201 rejected");
  }
});

test("[APAR-I1] three-way match: net received cap (returns) and exact price tolerance", () => {
  const base = invoiceByNumber("INV/KP/2026/0914");
  const order = purchaseOrderByNumber("PO/BDG/2026/10/0042");
  const receipt = receiptByNumber("GR/BDG/2026/11/0017");
  const run = (extra) =>
    shared.threeWayMatch(
      {
        invoice: base.invoice,
        invoiceLines: base.lines,
        purchaseOrderLines: order.lines,
        goodsReceiptLines: receipt.lines,
        toleranceBp: 0,
        computedAt: base.invoice.matchedAt,
        ...extra,
      },
      "half_up",
    );
  assert.equal(run({}).status, "matched");

  // Returning part of a billed line leaves less than the invoice bills.
  const billed = base.lines.find((line) => line.purchaseOrderLineId !== null);
  const returned = run({
    returnedLines: [
      { purchaseOrderLineId: billed.purchaseOrderLineId, quantity: "0.0001" },
    ],
  });
  const row = returned.rows.find((item) => item.invoiceLineId === billed.id);
  assert.equal(returned.status, "discrepancy");
  assert.ok(row.issues.includes("quantity_exceeds_receipt"));
  // A return on another PO line does not touch this one.
  assert.equal(
    run({
      returnedLines: [
        { purchaseOrderLineId: crypto.randomUUID(), quantity: "1.0000" },
      ],
    }).status,
    "matched",
  );

  // Price tolerance is exact: PO 1000.0000, 200.4 bp over is outside 200 bp
  // even though the rounded variance equals 200.
  const orderLine = {
    ...order.lines[0],
    quantity: "10.0000",
    unitPriceIdr: "1000.0000",
  };
  const receiptLine = {
    purchaseOrderLineId: orderLine.id,
    quantityReceived: "10.0000",
    quantityRejected: "0.0000",
  };
  const priced = (unitPriceIdr, lineTotalIdr, toleranceBp) =>
    shared.threeWayMatch(
      {
        invoice: { ...base.invoice, goodsIdr: 0, servicesIdr: 0 },
        invoiceLines: [
          {
            ...billed,
            purchaseOrderLineId: orderLine.id,
            quantity: "1.0000",
            unitPriceIdr,
            lineTotalIdr,
          },
        ],
        purchaseOrderLines: [orderLine],
        goodsReceiptLines: [receiptLine],
        toleranceBp,
        computedAt: base.invoice.matchedAt,
      },
      "half_up",
    ).rows[0];
  assert.equal(
    priced("1020.0000", 1020, 200).issues.includes("price_outside_tolerance"),
    false,
    "exactly 200 bp passes",
  );
  const edge = priced("1020.0400", 1020, 200);
  assert.equal(edge.priceVarianceBp, 200);
  assert.ok(edge.issues.includes("price_outside_tolerance"));
  assert.ok(
    priced("1020.1000", 1020, 200).issues.includes("price_outside_tolerance"),
  );
  assert.ok(
    priced("1020.0000", 1020, 199).issues.includes("price_outside_tolerance"),
  );
});

test("[APAR-I1] invoice status, policy and decision contracts", () => {
  for (const detail of fixtures.supplierInvoiceDetails) {
    assert.equal(
      detail.invoice.status,
      detail.invoice.matchStatus === "matched" ? "matched" : "held",
    );
  }
  const invoice = fixtures.supplierInvoices[0];
  assert.equal(
    shared.supplierInvoiceSchema.safeParse({ ...invoice, status: "held" })
      .success,
    false,
    "held cannot carry matchStatus matched",
  );
  assert.equal(
    shared.supplierInvoiceSchema.safeParse({ ...invoice, status: "released" })
      .success,
    true,
  );
  assert.equal(shared.PURCHASING_DEFAULT_TOLERANCE_BP, 0);
  const policy = {
    tenantId: invoice.tenantId,
    threeWayMatchToleranceBp: 1000,
    updatedAt: null,
    updatedBy: null,
  };
  assert.equal(shared.purchasingPolicySchema.safeParse(policy).success, true);
  assert.equal(
    shared.purchasingPolicySchema.safeParse({
      ...policy,
      threeWayMatchToleranceBp: 1001,
    }).success,
    false,
  );
  const put = {
    threeWayMatchToleranceBp: 200,
    expectedUpdatedAt: null,
    idempotencyKey: "policy-key-0001",
  };
  assert.equal(
    shared.putPurchasingPolicyInputSchema.safeParse(put).success,
    true,
  );
  assert.equal(
    shared.putPurchasingPolicyInputSchema.safeParse({
      ...put,
      threeWayMatchToleranceBp: 1001,
    }).success,
    false,
  );
  const decide = { note: "Harga disetujui", idempotencyKey: "decide-key-0001" };
  assert.equal(
    shared.decideSupplierInvoiceInputSchema.safeParse(decide).success,
    true,
  );
  assert.equal(
    shared.decideSupplierInvoiceInputSchema.safeParse({
      ...decide,
      note: "singkat",
    }).success,
    false,
    "note needs 10 characters",
  );
  for (const [code, status] of [
    ["SUPPLIER_INVOICE_DUPLICATE", 409],
    ["SUPPLIER_INVOICE_NOT_HELD", 409],
    ["SUPPLIER_INVOICE_RELEASE_BLOCKED", 409],
    ["SUPPLIER_INVOICE_SELF_RELEASE", 403],
    ["SUPPLIER_INVOICE_POSTING_DISABLED", 409],
    ["PURCHASE_RETURN_EXCEEDS_PAYABLE", 409],
  ]) {
    assert.equal(shared.purchasingErrorHttpStatus[code], status, code);
    assert.ok(shared.purchasingErrorMessages[code], code);
  }
  for (const endpoint of [
    shared.releaseSupplierInvoice,
    shared.rejectSupplierInvoice,
    shared.getPurchasingPolicy,
    shared.putPurchasingPolicy,
  ])
    assert.ok(shared.purchasingEndpoints.includes(endpoint), endpoint.id);
});
