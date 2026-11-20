// Mock handlers for the receiving screens (bead legend-xkk; PRD v1.7 §3 F18,
// INV-05): goods receipts with QC/partial delivery, supplier invoices and the
// three-way match, supplier payments, purchase returns and petty purchases.
// Every handler mirrors the contract helpers (`assertGoodsReceiptMatchesOrder`,
// `threeWayMatch`, `assertPurchaseReturnWithinReceipt`,
// `assertPettyPurchaseWithinLimit`) instead of inventing rules, and creates are
// idempotent by the Idempotency-Key header.
//
// Loading this module registers the handlers. The mock runtime's glob only
// discovers `features/*/mock.ts`, and that file is owned by the purchasing bead,
// so `receiving-api.ts` imports this file (mock mode only).
//
// Import for side effects: the purchase order, supplier and item/location
// handlers are owned elsewhere and must not be registered twice.
import "./mock.ts";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  addIdr,
  businessDateOf,
  extendCostIdr,
  formatDecimal4,
  idr,
  parseDecimal4,
  subtractIdr,
  sumIdr,
  DEFAULT_BUSINESS_DAY_CUTOFF,
} from "@starter/shared/core";
import type { Decimal4, Idr } from "@starter/shared/core";
import {
  PurchasingError,
  acceptedQuantity,
  assertGoodsReceiptMatchesOrder,
  assertPettyPurchaseWithinLimit,
  assertPurchaseReturnWithinReceipt,
  assertSupplierInvoicePayable,
  assertSupplierPaymentApproval,
  assertSupplierPaymentWithinInvoice,
  cafeLegendPurchasingFixtures as fixtures,
  createGoodsReceipt,
  createPettyPurchase,
  createPurchaseReturn,
  createSupplierInvoice,
  createSupplierPayment,
  getGoodsReceipt,
  getPettyPurchase,
  getPettyPurchasePolicy,
  getPurchaseReturn,
  getPurchasingPolicy,
  getSupplierInvoice,
  getSupplierPayment,
  goodsReceiptDetailSchema,
  goodsReceiptValueIdr,
  journalizeGoodsReceipt,
  listGoodsReceipts,
  listPettyPurchases,
  listPurchaseReturns,
  listSupplierInvoices,
  listSupplierPayments,
  pettyPurchaseLimitFor,
  pettyPurchaseSchema,
  postSupplierInvoiceMatch,
  postSupplierPaymentTransition,
  putPurchasingPolicy,
  purchaseReturnDetailSchema,
  purchaseReturnLineSchema,
  purchaseReturnSchema,
  purchaseReturnValueIdr,
  rejectSupplierInvoice,
  releaseSupplierInvoice,
  supplierInvoiceDetailSchema,
  supplierInvoiceLineSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
  threeWayMatch,
  transitionSupplierPayment,
} from "@starter/shared/inventory";
import type {
  GoodsReceiptDetail,
  PettyPurchase,
  PurchaseReturnDetail,
  SupplierInvoiceDetail,
  SupplierInvoiceLine,
  SupplierPayment,
  ThreeWayMatch,
} from "@starter/shared/inventory";
import { todayBusinessDate } from "./receiving-lib.ts";
import { INVENTORY_TIME_ZONE } from "../ws06-inventory/outlet.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

type ReceiptKey = Map<string, { fingerprint: string; value: unknown }>;

type ReceivingState = {
  receipts: GoodsReceiptDetail[];
  invoices: SupplierInvoiceDetail[];
  payments: SupplierPayment[];
  returns: PurchaseReturnDetail[];
  petty: PettyPurchase[];
  /**
   * Tenant purchasing policy (PRD §3.18: the match tolerance is tenant
   * configuration, never a constant). Starts at the value the fixtures were
   * matched with (200 bp); the server default without a row is 0 bp.
   */
  policy: { toleranceBp: number; updatedAt: string | null };
  created: ReceiptKey;
  /** Receipt id → journal entry id, so a second journalize books nothing. */
  journalized: Map<string, string>;
};

const store = createMockStore<ReceivingState>(() => ({
  receipts: structuredClone(fixtures.goodsReceiptDetails),
  invoices: structuredClone(fixtures.supplierInvoiceDetails),
  payments: structuredClone(fixtures.supplierPayments),
  returns: structuredClone(fixtures.purchaseReturnDetails),
  petty: structuredClone(fixtures.pettyPurchases),
  policy: { toleranceBp: 200, updatedAt: null },
  created: new Map(),
  journalized: new Map(),
}));

const tenantId = fixtures.goodsReceipts[0].tenantId;
const receiver = fixtures.goodsReceipts[0].receivedBy;
const finance = fixtures.supplierInvoices[0].recordedBy;
const approver = fixtures.supplierPayments[1].approvedBy!;
const warehouse = fixtures.purchaseReturns[0].returnedBy;
const cashier = fixtures.pettyPurchases[0].paidBy;

const now = () => new Date().toISOString();
const mint = () => newIdempotencyKey();
// Function declarations (not arrow consts) so TypeScript narrows a preceding
// `if (!row) missing()`: a never-returning call only narrows control flow when
// the callee is a declared function or an explicitly typed const.
function missing(): never {
  throw new ApiError(404, "NOT_FOUND", "Data tidak ditemukan.");
}
function conflict(
  message = "Tindakan tidak diizinkan dari status ini.",
): never {
  throw new ApiError(409, "CONFLICT", message);
}

/** Contract business errors keep their domain code so the UI can explain it. */
function throwDomain(error: unknown): never {
  if (error instanceof PurchasingError)
    throw new ApiError(409, error.code, error.message);
  throw error;
}

/** One create per Idempotency-Key: a retry returns the stored response. */
function once<T>(key: string, payload: unknown, run: () => T): T {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get().created.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "CONFLICT",
        "Idempotency-Key sudah dipakai untuk permintaan lain.",
      );
    return structuredClone(existing.value) as T;
  }
  const value = run();
  store.get().created.set(key, {
    fingerprint,
    value: structuredClone(value),
  });
  return value;
}

const createKey = (
  headers: { "Idempotency-Key"?: string } | undefined,
  bodyKey: string,
) => headers?.["Idempotency-Key"] ?? bodyKey;

const businessDateOfInstant = (iso: string) =>
  businessDateOf(iso, {
    timeZone: INVENTORY_TIME_ZONE,
    cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
  });

const receiptOf = (id: string) =>
  store.get().receipts.find((detail) => detail.receipt.id === id) ?? missing();

const invoiceOf = (id: string) =>
  store.get().invoices.find((detail) => detail.invoice.id === id) ?? missing();

const orderOf = (id: string) =>
  fixtures.purchaseOrderDetails.find(
    (detail) => detail.purchaseOrder.id === id,
  );

/** Receipt lines already booked against one PO, across every receipt. */
function receiptLinesForOrder(purchaseOrderId: string) {
  return store
    .get()
    .receipts.filter(
      (detail) => detail.receipt.purchaseOrderId === purchaseOrderId,
    )
    .flatMap((detail) => detail.lines);
}

/** Goods lines of the other invoices on a PO: the receipt cap is cumulative. */
function previouslyInvoicedLines(
  purchaseOrderId: string,
  invoiceId: string,
): SupplierInvoiceLine[] {
  return store
    .get()
    .invoices.filter(
      (detail) =>
        detail.invoice.purchaseOrderId === purchaseOrderId &&
        detail.invoice.id !== invoiceId,
    )
    .flatMap((detail) => detail.lines);
}

function computeMatch(detail: SupplierInvoiceDetail): ThreeWayMatch {
  try {
    return threeWayMatch(
      {
        invoice: {
          id: detail.invoice.id,
          purchaseOrderId: detail.invoice.purchaseOrderId,
          goodsIdr: detail.invoice.goodsIdr,
          servicesIdr: detail.invoice.servicesIdr,
        },
        invoiceLines: detail.lines,
        purchaseOrderLines:
          orderOf(detail.invoice.purchaseOrderId)?.lines ?? [],
        goodsReceiptLines: receiptLinesForOrder(detail.invoice.purchaseOrderId),
        toleranceBp: store.get().policy.toleranceBp,
        computedAt: now(),
        previouslyInvoicedLines: previouslyInvoicedLines(
          detail.invoice.purchaseOrderId,
          detail.invoice.id,
        ),
      },
      "half_up",
    );
  } catch (error) {
    throwDomain(error);
  }
}

// ---- Goods receipts ------------------------------------------------------

registerMock(listGoodsReceipts, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .receipts.map((detail) => detail.receipt)
      .filter(
        (receipt) =>
          receipt.outletId === query.outletId &&
          (!query.purchaseOrderId ||
            receipt.purchaseOrderId === query.purchaseOrderId) &&
          (!query.supplierId || receipt.supplierId === query.supplierId) &&
          (!query.fromDate || receipt.receivedOn >= query.fromDate) &&
          (!query.toDate || receipt.receivedOn <= query.toDate),
      ),
    query,
    (receipt) => receipt.id,
    scenario,
  ),
);

registerMock(getGoodsReceipt, ({ params }) => ({
  data: receiptOf(params.goodsReceiptId),
}));

registerMock(createGoodsReceipt, ({ body, headers }) =>
  once(
    `gr:${createKey(headers, body.idempotencyKey)}`,
    body,
    (): { data: GoodsReceiptDetail } => {
      const order = orderOf(body.purchaseOrderId);
      if (!order) missing();
      const status = order.purchaseOrder.status;
      if (
        status !== "approved" &&
        status !== "sent" &&
        status !== "partially_received"
      )
        conflict("Penerimaan hanya untuk PO yang disetujui atau terkirim.");
      const prior = receiptLinesForOrder(order.purchaseOrder.id);
      const receiptId = mint();
      const lines = body.lines.map((line) => {
        const orderLine = order.lines.find(
          (candidate) => candidate.id === line.purchaseOrderLineId,
        );
        if (!orderLine)
          throw new ApiError(
            409,
            "PURCHASE_ORDER_LINE_MISMATCH",
            "Baris penerimaan bukan milik purchase order ini.",
          );
        // legend-tomda: same rule as the API.
        const zeroPrice = parseDecimal4(orderLine.unitPriceIdr) === 0n;
        if (
          zeroPrice &&
          line.isBonus !== true &&
          parseDecimal4(line.quantityReceived) >
            parseDecimal4(line.quantityRejected)
        )
          throw new ApiError(
            422,
            "GOODS_RECEIPT_BONUS_REQUIRED",
            "Baris berharga Rp0 harus ditandai bonus supplier.",
          );
        if (!zeroPrice && line.isBonus === true)
          throw new ApiError(
            422,
            "GOODS_RECEIPT_BONUS_PRICED_LINE",
            "Bonus supplier hanya untuk baris berharga Rp0.",
          );
        if (
          parseDecimal4(line.quantityRejected) >
          parseDecimal4(line.quantityReceived)
        )
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Jumlah ditolak tidak boleh melebihi jumlah diterima.",
            [
              {
                field: "quantityRejected",
                message: "Jumlah ditolak melebihi jumlah diterima.",
              },
            ],
          );
        return {
          id: mint(),
          tenantId,
          goodsReceiptId: receiptId,
          purchaseOrderLineId: orderLine.id,
          inventoryItemId: orderLine.inventoryItemId,
          locationId: line.locationId,
          quantityReceived: formatDecimal4(
            parseDecimal4(line.quantityReceived),
          ),
          quantityRejected: formatDecimal4(
            parseDecimal4(line.quantityRejected),
          ),
          unitCostIdr: orderLine.unitPriceIdr,
          batchCode: line.batchCode ?? null,
          expiresOn: line.expiresOn ?? null,
        };
      });
      try {
        assertGoodsReceiptMatchesOrder(order.lines, prior, lines);
      } catch (error) {
        throwDomain(error);
      }
      const createdAt = now();
      const detail = goodsReceiptDetailSchema.parse({
        receipt: {
          id: receiptId,
          tenantId,
          outletId: body.outletId,
          purchaseOrderId: body.purchaseOrderId,
          supplierId: order.purchaseOrder.supplierId,
          number: `GR/MOCK/${Date.now()}`,
          receivedBy: receiver,
          receivedAt: createdAt,
          receivedOn: body.receivedOn ?? businessDateOfInstant(createdAt),
          qcNotes: body.qcNotes ?? null,
          mediaIds: body.mediaIds ?? [],
          note: body.note ?? null,
          createdAt,
        },
        lines,
      });
      store.get().receipts.unshift(detail);
      return { data: detail };
    },
  ),
);

// The journal key is the receipt: the first call books, a repeat answers
// `already_posted` with the same entry. A receipt worth 0 books nothing (422).
// The 409 SUPPLIER_INVOICE_POSTING_DISABLED / GOODS_RECEIPT_JOURNAL_PARKED
// refusals are reachable with `window.__legendMock.failNext(
// "POST /api/inventory/goods-receipts/:goodsReceiptId/journalize", ...)`.
registerMock(journalizeGoodsReceipt, ({ params }) => {
  const detail = receiptOf(params.goodsReceiptId);
  const existing = store.get().journalized.get(detail.receipt.id);
  if (existing)
    return {
      data: {
        goodsReceiptId: detail.receipt.id,
        status: "already_posted" as const,
        journalEntryId: existing,
      },
    };
  if (goodsReceiptValueIdr(detail.lines, "half_up") === 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "A goods receipt worth 0 has nothing to journalize.",
    );
  const journalEntryId = mint();
  store.get().journalized.set(detail.receipt.id, journalEntryId);
  return {
    data: {
      goodsReceiptId: detail.receipt.id,
      status: "posted" as const,
      journalEntryId,
    },
  };
});

// ---- Supplier invoices and the three-way match ---------------------------

registerMock(listSupplierInvoices, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .invoices.map((detail) => detail.invoice)
      .filter(
        (invoice) =>
          invoice.outletId === query.outletId &&
          (!query.supplierId || invoice.supplierId === query.supplierId) &&
          (!query.purchaseOrderId ||
            invoice.purchaseOrderId === query.purchaseOrderId) &&
          (!query.matchStatus || invoice.matchStatus === query.matchStatus) &&
          (!query.fromDate || invoice.invoiceDate >= query.fromDate) &&
          (!query.toDate || invoice.invoiceDate <= query.toDate),
      ),
    query,
    (invoice) => invoice.id,
    scenario,
  ),
);

registerMock(getSupplierInvoice, ({ params }) => {
  const detail = invoiceOf(params.supplierInvoiceId);
  // A pending invoice has no recorded match yet; the preview lets the screen
  // show the discrepancies before the user records the match (PRD §3.18).
  if (detail.invoice.matchStatus === "pending")
    return {
      data: supplierInvoiceDetailSchema.parse({
        ...detail,
        match: computeMatch(detail),
      }),
    };
  return { data: detail };
});

registerMock(createSupplierInvoice, ({ body, headers }) =>
  once(
    `invoice:${createKey(headers, body.idempotencyKey)}`,
    body,
    (): { data: SupplierInvoiceDetail } => {
      const order = orderOf(body.purchaseOrderId);
      if (!order) missing();
      if (order.purchaseOrder.supplierId !== body.supplierId)
        conflict("Supplier faktur berbeda dari supplier purchase order.");
      const invoiceId = mint();
      const recordedAt = now();
      const lines = body.lines.map((line) =>
        supplierInvoiceLineSchema.parse({
          id: mint(),
          tenantId,
          supplierInvoiceId: invoiceId,
          purchaseOrderLineId: line.purchaseOrderLineId ?? null,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unitPriceIdr: line.unitPriceIdr,
          lineTotalIdr: extendCostIdr(
            formatDecimal4(parseDecimal4(line.quantity)),
            formatDecimal4(parseDecimal4(line.unitPriceIdr)),
            "half_up",
          ),
        }),
      );
      const invoicedGoodsIdr: Idr = sumIdr(
        lines
          .filter((line) => line.kind === "goods")
          .map((line) => line.lineTotalIdr),
      );
      const servicesIdr: Idr = sumIdr(
        lines
          .filter((line) => line.kind === "service")
          .map((line) => line.lineTotalIdr),
      );
      const variance = computeMatch({
        invoice: supplierInvoiceSchema.parse({
          id: invoiceId,
          tenantId,
          outletId: body.outletId,
          supplierId: body.supplierId,
          purchaseOrderId: body.purchaseOrderId,
          number: body.number,
          invoiceDate: body.invoiceDate,
          dueDate: body.dueDate,
          goodsIdr: invoicedGoodsIdr,
          priceVarianceIdr: 0,
          servicesIdr,
          // The preview only reads the header goods/services amounts; taxes
          // are not part of the three-way match.
          ppnIdr: 0,
          pph23Idr: 0,
          totalIdr: invoicedGoodsIdr + servicesIdr,
          payableIdr: invoicedGoodsIdr + servicesIdr,
          paidIdr: 0,
          // A held invoice is not a payable yet (schema: outstanding = 0).
          outstandingIdr: 0,
          status: "held",
          matchStatus: "pending",
          matchedAt: null,
          matchNote: null,
          recordedBy: finance,
          recordedAt,
        }),
        lines,
        match: null,
      }).priceVarianceIdr;
      const goodsIdr = subtractIdr(invoicedGoodsIdr, variance);
      const totalIdr = addIdr(
        addIdr(addIdr(goodsIdr, variance), servicesIdr),
        idr(body.ppnIdr),
      );
      const payableIdr = subtractIdr(totalIdr, idr(body.pph23Idr));
      const invoice = supplierInvoiceSchema.parse({
        id: invoiceId,
        tenantId,
        outletId: body.outletId,
        supplierId: body.supplierId,
        purchaseOrderId: body.purchaseOrderId,
        number: body.number,
        invoiceDate: body.invoiceDate,
        dueDate: body.dueDate,
        goodsIdr,
        priceVarianceIdr: variance,
        servicesIdr,
        ppnIdr: body.ppnIdr,
        pph23Idr: body.pph23Idr,
        totalIdr,
        payableIdr,
        paidIdr: 0,
        // A held invoice is not a payable yet (schema: outstanding = 0).
        outstandingIdr: 0,
        status: "held",
        matchStatus: "pending",
        matchedAt: null,
        matchNote: null,
        recordedBy: finance,
        recordedAt,
      });
      const detail = supplierInvoiceDetailSchema.parse({
        invoice,
        lines,
        match: null,
      });
      store.get().invoices.unshift(detail);
      return { data: detail };
    },
  ),
);

registerMock(postSupplierInvoiceMatch, ({ params, body, headers }) =>
  once(
    `invoice-match:${createKey(headers, body.idempotencyKey)}`,
    { params, body },
    (): { data: SupplierInvoiceDetail } => {
      const detail = invoiceOf(params.supplierInvoiceId);
      const match = computeMatch(detail);
      const note = body.note?.trim() ?? "";
      if (match.status === "discrepancy" && note === "")
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Isi catatan match untuk menjelaskan selisih.",
          [{ field: "note", message: "Catatan match wajib saat ada selisih." }],
        );
      const invoice = supplierInvoiceSchema.parse({
        ...detail.invoice,
        status: match.status === "matched" ? "matched" : "held",
        outstandingIdr:
          match.status === "matched"
            ? subtractIdr(detail.invoice.payableIdr, detail.invoice.paidIdr)
            : 0,
        matchStatus: match.status,
        matchedAt: now(),
        matchNote: note === "" ? null : note,
      });
      detail.invoice = invoice;
      detail.match = match;
      return { data: detail };
    },
  ),
);

/** Release or reject of a held invoice (finance; the reason is mandatory). */
function decideHeldInvoice(
  supplierInvoiceId: string,
  decision: "released" | "rejected",
  note: string,
): { data: SupplierInvoiceDetail } {
  const detail = invoiceOf(supplierInvoiceId);
  if (detail.invoice.status !== "held")
    throw new ApiError(
      409,
      "SUPPLIER_INVOICE_NOT_HELD",
      "Faktur pemasok tidak sedang ditahan.",
    );
  detail.invoice = supplierInvoiceSchema.parse({
    ...detail.invoice,
    status: decision,
    outstandingIdr:
      decision === "released"
        ? subtractIdr(detail.invoice.payableIdr, detail.invoice.paidIdr)
        : 0,
    matchStatus: decision === "released" ? "matched" : "discrepancy",
    matchedAt: detail.invoice.matchedAt ?? now(),
    matchNote: detail.invoice.matchNote ?? note,
  });
  return { data: detail };
}

registerMock(releaseSupplierInvoice, ({ params, body, headers }) =>
  once(
    `invoice-release:${createKey(headers, body.idempotencyKey)}`,
    { params, body },
    () => decideHeldInvoice(params.supplierInvoiceId, "released", body.note),
  ),
);

registerMock(rejectSupplierInvoice, ({ params, body, headers }) =>
  once(
    `invoice-reject:${createKey(headers, body.idempotencyKey)}`,
    { params, body },
    () => decideHeldInvoice(params.supplierInvoiceId, "rejected", body.note),
  ),
);

// ---- Purchasing policy ---------------------------------------------------

const policyView = () => {
  const { toleranceBp, updatedAt } = store.get().policy;
  return {
    tenantId,
    threeWayMatchToleranceBp: toleranceBp,
    updatedAt,
    updatedBy: updatedAt === null ? null : finance,
  };
};

registerMock(getPurchasingPolicy, () => ({ data: policyView() }));

registerMock(putPurchasingPolicy, ({ body, headers }) =>
  once(
    `purchasing-policy:${createKey(headers, body.idempotencyKey)}`,
    body,
    () => {
      const policy = store.get().policy;
      if (body.expectedUpdatedAt !== policy.updatedAt)
        throw new ApiError(
          412,
          "PRECONDITION_FAILED",
          "Kebijakan sudah berubah. Muat ulang lalu coba lagi.",
        );
      policy.toleranceBp = body.threeWayMatchToleranceBp;
      policy.updatedAt = now();
      return { data: policyView() };
    },
  ),
);

// ---- Supplier payments ---------------------------------------------------

registerMock(listSupplierPayments, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .payments.filter(
        (payment) =>
          (!query.supplierId || payment.supplierId === query.supplierId) &&
          (!query.supplierInvoiceId ||
            payment.supplierInvoiceId === query.supplierInvoiceId) &&
          (!query.status || payment.status === query.status),
      ),
    query,
    (payment) => payment.id,
    scenario,
  ),
);

registerMock(getSupplierPayment, ({ params }) => ({
  data:
    store
      .get()
      .payments.find((payment) => payment.id === params.supplierPaymentId) ??
    missing(),
}));

registerMock(createSupplierPayment, ({ body, headers }) =>
  once(
    `payment:${createKey(headers, body.idempotencyKey)}`,
    body,
    (): { data: SupplierPayment } => {
      const detail = invoiceOf(body.supplierInvoiceId);
      const amount = idr(body.amountIdr);
      try {
        assertSupplierInvoicePayable(detail.invoice);
        assertSupplierPaymentWithinInvoice(
          detail.invoice,
          amount,
          store
            .get()
            .payments.filter(
              (payment) => payment.supplierInvoiceId === body.supplierInvoiceId,
            ),
        );
      } catch (error) {
        throwDomain(error);
      }
      const createdAt = now();
      const payment = supplierPaymentSchema.parse({
        id: mint(),
        tenantId,
        supplierId: detail.invoice.supplierId,
        supplierInvoiceId: body.supplierInvoiceId,
        amountIdr: amount,
        method: body.method,
        reference: body.reference ?? null,
        status: "pending_approval",
        requestedBy: finance,
        requestedAt: createdAt,
        approvedBy: null,
        approvedAt: null,
        paidAt: null,
        note: body.note ?? null,
        createdAt,
      });
      store.get().payments.unshift(payment);
      return { data: payment };
    },
  ),
);

registerMock(postSupplierPaymentTransition, ({ params, body, headers }) =>
  once(
    `payment-transition:${createKey(headers, body.idempotencyKey)}`,
    { params, body },
    (): { data: SupplierPayment } => {
      const current =
        store
          .get()
          .payments.find(
            (payment) => payment.id === params.supplierPaymentId,
          ) ?? missing();
      let status;
      try {
        status = transitionSupplierPayment(current.status, body.action);
      } catch (error) {
        throwDomain(error);
      }
      if (body.action === "approve") {
        try {
          assertSupplierPaymentApproval(current, approver);
        } catch (error) {
          throwDomain(error);
        }
      }
      const approved = status === "approved" || status === "paid";
      const payment = supplierPaymentSchema.parse({
        ...current,
        status,
        reference: body.reference ?? current.reference,
        note: body.note ?? current.note,
        approvedBy: approved ? approver : current.approvedBy,
        approvedAt: approved
          ? (current.approvedAt ?? now())
          : current.approvedAt,
        paidAt: status === "paid" ? now() : current.paidAt,
      });
      const index = store
        .get()
        .payments.findIndex((row) => row.id === payment.id);
      store.get().payments[index] = payment;
      if (status === "paid") {
        const detail = store
          .get()
          .invoices.find((row) => row.invoice.id === payment.supplierInvoiceId);
        if (detail) {
          const paidIdr = addIdr(detail.invoice.paidIdr, payment.amountIdr);
          detail.invoice = supplierInvoiceSchema.parse({
            ...detail.invoice,
            paidIdr,
            outstandingIdr: subtractIdr(detail.invoice.payableIdr, paidIdr),
          });
        }
      }
      return { data: payment };
    },
  ),
);

// ---- Purchase returns ----------------------------------------------------

registerMock(listPurchaseReturns, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .returns.map((detail) => detail.purchaseReturn)
      .filter(
        (row) =>
          row.outletId === query.outletId &&
          (!query.supplierId || row.supplierId === query.supplierId) &&
          (!query.purchaseOrderId ||
            row.purchaseOrderId === query.purchaseOrderId),
      ),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(getPurchaseReturn, ({ params }) => ({
  data:
    store
      .get()
      .returns.find(
        (detail) => detail.purchaseReturn.id === params.purchaseReturnId,
      ) ?? missing(),
}));

registerMock(createPurchaseReturn, ({ body, headers }) =>
  once(
    `return:${createKey(headers, body.idempotencyKey)}`,
    body,
    (): { data: PurchaseReturnDetail } => {
      const receipt = body.goodsReceiptId
        ? receiptOf(body.goodsReceiptId)
        : undefined;
      const purchaseOrderId =
        body.purchaseOrderId ?? receipt?.receipt.purchaseOrderId ?? null;
      const sourceLines = purchaseOrderId
        ? receiptLinesForOrder(purchaseOrderId)
        : (receipt?.lines ?? []);
      const accepted = new Map<string, Decimal4>();
      for (const line of sourceLines) {
        accepted.set(
          line.purchaseOrderLineId,
          formatDecimal4(
            parseDecimal4(accepted.get(line.purchaseOrderLineId) ?? "0.0000") +
              parseDecimal4(acceptedQuantity(line)),
          ),
        );
      }
      const returned = new Map<string, Decimal4>();
      for (const detail of store.get().returns) {
        if (detail.purchaseReturn.purchaseOrderId !== purchaseOrderId) continue;
        for (const line of detail.lines) {
          if (line.purchaseOrderLineId === null) continue;
          returned.set(
            line.purchaseOrderLineId,
            formatDecimal4(
              parseDecimal4(
                returned.get(line.purchaseOrderLineId) ?? "0.0000",
              ) + parseDecimal4(line.quantity),
            ),
          );
        }
      }
      const order = purchaseOrderId ? orderOf(purchaseOrderId) : undefined;
      const returnId = mint();
      const lines = body.lines.map((line) => {
        const receiptLine = sourceLines.find((candidate) =>
          line.purchaseOrderLineId
            ? candidate.purchaseOrderLineId === line.purchaseOrderLineId
            : candidate.inventoryItemId === line.inventoryItemId,
        );
        const orderLine = line.purchaseOrderLineId
          ? order?.lines.find(
              (candidate) => candidate.id === line.purchaseOrderLineId,
            )
          : undefined;
        const unitCostIdr: Decimal4 =
          receiptLine?.unitCostIdr ??
          orderLine?.unitPriceIdr ??
          formatDecimal4(0n);
        return purchaseReturnLineSchema.parse({
          id: mint(),
          tenantId,
          purchaseReturnId: returnId,
          inventoryItemId: line.inventoryItemId,
          purchaseOrderLineId: line.purchaseOrderLineId ?? null,
          quantity: line.quantity,
          unitCostIdr,
          lineValueIdr: extendCostIdr(
            formatDecimal4(parseDecimal4(line.quantity)),
            unitCostIdr,
            "half_up",
          ),
          batchCode: line.batchCode ?? receiptLine?.batchCode ?? null,
        });
      });
      try {
        assertPurchaseReturnWithinReceipt(accepted, returned, lines);
      } catch (error) {
        throwDomain(error);
      }
      const detail = purchaseReturnDetailSchema.parse({
        purchaseReturn: purchaseReturnSchema.parse({
          id: returnId,
          tenantId,
          outletId: body.outletId,
          supplierId: receipt?.receipt.supplierId ?? body.supplierId,
          purchaseOrderId,
          goodsReceiptId: body.goodsReceiptId ?? null,
          number: `RET/MOCK/${Date.now()}`,
          returnedOn: body.returnedOn,
          returnedBy: warehouse,
          reason: body.reason,
          valueIdr: purchaseReturnValueIdr(lines, "half_up"),
          note: body.note ?? null,
          createdAt: now(),
        }),
        lines,
      });
      store.get().returns.unshift(detail);
      return { data: detail };
    },
  ),
);

// ---- Petty purchases (PRD §3.18 Pembelian Sederhana) ---------------------

registerMock(listPettyPurchases, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .petty.filter(
        (purchase) =>
          purchase.outletId === query.outletId &&
          (!query.fromDate || purchase.businessDate >= query.fromDate) &&
          (!query.toDate || purchase.businessDate <= query.toDate),
      ),
    query,
    (purchase) => purchase.id,
    scenario,
  ),
);

registerMock(getPettyPurchase, ({ params }) => ({
  data:
    store
      .get()
      .petty.find((purchase) => purchase.id === params.pettyPurchaseId) ??
    missing(),
}));

registerMock(getPettyPurchasePolicy, ({ query }) => {
  const limit = pettyPurchaseLimitFor(
    fixtures.pettyPurchasePolicies,
    query.outletId,
  );
  // Deny by default: no policy row means the purchase is refused (contract).
  if (limit === null) missing();
  return {
    data: {
      tenantId,
      outletId: query.outletId,
      limitIdr: limit,
    },
  };
});

registerMock(createPettyPurchase, ({ body, headers }) =>
  once(
    `petty:${createKey(headers, body.idempotencyKey)}`,
    body,
    (): { data: PettyPurchase } => {
      const limit = pettyPurchaseLimitFor(
        fixtures.pettyPurchasePolicies,
        body.outletId,
      );
      try {
        assertPettyPurchaseWithinLimit(idr(body.amountIdr), limit);
      } catch (error) {
        throwDomain(error);
      }
      const paidAt = body.paidAt ?? now();
      const purchase = pettyPurchaseSchema.parse({
        id: mint(),
        tenantId,
        outletId: body.outletId,
        vendorName: body.vendorName,
        description: body.description,
        amountIdr: idr(body.amountIdr),
        photoMediaId: body.photoMediaId,
        paidBy: cashier,
        paidAt,
        businessDate:
          body.businessDate ??
          (body.paidAt ? businessDateOfInstant(paidAt) : todayBusinessDate()),
        note: body.note ?? null,
        createdAt: now(),
      });
      store.get().petty.unshift(purchase);
      return { data: purchase };
    },
  ),
);
