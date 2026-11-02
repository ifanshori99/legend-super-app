// Fixture-backed purchasing endpoints. State resets through the shared mock store.
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { idr } from "@starter/shared/core";
import {
  cafeLegendInventoryFixtures as inventory,
  cafeLegendPurchasingFixtures as fixtures,
  createPurchaseOrder,
  createPurchaseRequest,
  getPurchaseOrder,
  getPurchaseRequest,
  listInventoryItems,
  listPurchaseOrders,
  listPurchaseRequests,
  listSupplierCatalog,
  listSuppliers,
  listUoms,
  postPurchaseOrderTransition,
  postPurchaseRequestTransition,
  purchaseOrderDetailSchema,
  purchaseOrderLineTotalIdr,
  purchaseOrderSchema,
  purchaseOrderTotals,
  purchaseRequestDetailSchema,
  purchaseRequestSchema,
  sendPurchaseOrder,
  transitionPurchaseOrder,
  transitionPurchaseRequest,
} from "@starter/shared/inventory";

const store = createMockStore(() => ({
  requests: structuredClone(fixtures.purchaseRequestDetails),
  orders: structuredClone(fixtures.purchaseOrderDetails),
  receipts: new Map<string, { fingerprint: string; value: unknown }>(),
}));
const now = () => new Date().toISOString();
const mint = () => crypto.randomUUID();
const tenantId = fixtures.purchaseRequests[0].tenantId;
const requester = fixtures.purchaseRequests[0].requestedBy;
const approver = fixtures.purchaseRequests[0].decidedBy!;
const missing = (): never => {
  throw new ApiError(404, "NOT_FOUND", "Not found");
};
const conflict = (): never => {
  throw new ApiError(409, "CONFLICT", "Invalid transition");
};

function once<T>(key: string, payload: unknown, run: () => T): T {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get().receipts.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return conflict();
    return structuredClone(existing.value) as T;
  }
  const value = run();
  store.get().receipts.set(key, { fingerprint, value: structuredClone(value) });
  return value;
}

registerMock(listPurchaseRequests, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .requests.map((x) => x.request)
      .filter(
        (x) =>
          x.outletId === query.outletId &&
          (!query.status || x.status === query.status),
      ),
    query,
    (x) => x.id,
    scenario,
  ),
);
registerMock(listPurchaseOrders, ({ query, scenario }) =>
  paginateFixture(
    store
      .get()
      .orders.map((x) => x.purchaseOrder)
      .filter(
        (x) =>
          x.outletId === query.outletId &&
          (!query.status || x.status === query.status) &&
          (!query.supplierId || x.supplierId === query.supplierId) &&
          (!query.source || x.source === query.source),
      ),
    query,
    (x) => x.id,
    scenario,
  ),
);
registerMock(listSuppliers, ({ query, scenario }) =>
  paginateFixture(
    fixtures.suppliers.filter(
      (x) => !query.isActive || String(x.isActive) === query.isActive,
    ),
    query,
    (x) => x.id,
    scenario,
  ),
);
registerMock(listInventoryItems, ({ query, scenario }) =>
  paginateFixture(inventory.items, query, (x) => x.id, scenario),
);
registerMock(listUoms, ({ query, scenario }) =>
  paginateFixture(inventory.uoms, query, (x) => x.id, scenario),
);
registerMock(listSupplierCatalog, ({ params, query, scenario }) =>
  paginateFixture(
    fixtures.supplierCatalog.filter((x) => x.supplierId === params.supplierId),
    query,
    (x) => x.id,
    scenario,
  ),
);
registerMock(getPurchaseRequest, ({ params }) => ({
  data:
    store
      .get()
      .requests.find((x) => x.request.id === params.purchaseRequestId) ??
    missing(),
}));
registerMock(getPurchaseOrder, ({ params }) => ({
  data:
    store
      .get()
      .orders.find((x) => x.purchaseOrder.id === params.purchaseOrderId) ??
    missing(),
}));
registerMock(createPurchaseRequest, ({ body }) =>
  once(`pr-create:${body.idempotencyKey}`, body, () => {
    const id = mint();
    const time = now();
    const detail = purchaseRequestDetailSchema.parse({
      request: {
        id,
        tenantId,
        outletId: body.outletId,
        requestedBy: requester,
        status: "draft",
        neededBy: body.neededBy,
        note: body.note ?? null,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: time,
        updatedAt: time,
      },
      lines: body.lines.map((line) => ({
        ...line,
        id: mint(),
        tenantId,
        purchaseRequestId: id,
      })),
    });
    store.get().requests.unshift(detail);
    return { data: detail };
  }),
);
registerMock(postPurchaseRequestTransition, ({ params, body }) =>
  once(`pr-transition:${body.idempotencyKey}`, { params, body }, () => {
    const detail =
      store
        .get()
        .requests.find((x) => x.request.id === params.purchaseRequestId) ??
      missing();
    let status;
    try {
      status = transitionPurchaseRequest(detail.request.status, body.action);
    } catch {
      return conflict();
    }
    const decision = body.action === "approve" || body.action === "reject";
    if (body.action === "reject" && !body.note?.trim()) return conflict();
    detail.request = purchaseRequestSchema.parse({
      ...detail.request,
      status,
      updatedAt: now(),
      ...(decision
        ? {
            decidedBy: approver,
            decidedAt: now(),
            decisionNote: body.note ?? null,
          }
        : {}),
    });
    return { data: detail.request };
  }),
);
registerMock(createPurchaseOrder, ({ body }) =>
  once(`po-create:${body.idempotencyKey}`, body, () => {
    if (body.purchaseRequestId) {
      const request =
        store
          .get()
          .requests.find((x) => x.request.id === body.purchaseRequestId) ??
        missing();
      if (request.request.status !== "approved") return conflict();
    }
    const id = mint();
    const time = now();
    const lines = body.lines.map((line) => ({
      ...line,
      id: mint(),
      tenantId,
      purchaseOrderId: id,
      lineTotalIdr: purchaseOrderLineTotalIdr(
        line.quantity,
        line.unitPriceIdr,
        "half_up",
      ),
    }));
    const totals = purchaseOrderTotals(lines, idr(0), "half_up");
    const detail = purchaseOrderDetailSchema.parse({
      purchaseOrder: {
        id,
        tenantId,
        outletId: body.outletId,
        supplierId: body.supplierId,
        purchaseRequestId: body.purchaseRequestId ?? null,
        number: `PO/MOCK/${String(Date.now())}`,
        status: "draft",
        expectedDate: body.expectedDate,
        source: body.source,
        createdBy: requester,
        createdAt: time,
        approvedBy: null,
        approvedAt: null,
        sentAt: null,
        sentTo: null,
        closedAt: null,
        note: body.note ?? null,
        ...totals,
      },
      lines,
    });
    store.get().orders.unshift(detail);
    return { data: detail };
  }),
);
registerMock(postPurchaseOrderTransition, ({ params, body }) =>
  once(`po-transition:${body.idempotencyKey}`, { params, body }, () => {
    const detail =
      store
        .get()
        .orders.find((x) => x.purchaseOrder.id === params.purchaseOrderId) ??
      missing();
    let status;
    try {
      status = transitionPurchaseOrder(
        detail.purchaseOrder.status,
        body.action,
      );
    } catch {
      return conflict();
    }
    detail.purchaseOrder = purchaseOrderSchema.parse({
      ...detail.purchaseOrder,
      status,
      ...(body.action === "approve"
        ? { approvedBy: approver, approvedAt: now() }
        : {}),
      ...(body.action === "close" ? { closedAt: now() } : {}),
    });
    return { data: detail.purchaseOrder };
  }),
);
registerMock(sendPurchaseOrder, ({ params, body }) =>
  once(`po-send:${body.idempotencyKey}`, { params, body }, () => {
    const detail =
      store
        .get()
        .orders.find((x) => x.purchaseOrder.id === params.purchaseOrderId) ??
      missing();
    let status;
    try {
      status = transitionPurchaseOrder(detail.purchaseOrder.status, "send");
    } catch {
      return conflict();
    }
    detail.purchaseOrder = purchaseOrderSchema.parse({
      ...detail.purchaseOrder,
      status,
      sentAt: now(),
      sentTo: body.email ?? null,
    });
    return {
      data: {
        purchaseOrder: detail.purchaseOrder,
        channel: body.channel,
        sentTo: body.channel === "email" ? body.email! : null,
        shareUrl:
          body.channel === "share_link"
            ? `https://legend.example/purchase-orders/${detail.purchaseOrder.id}.pdf`
            : null,
        expiresAt:
          body.channel === "share_link"
            ? new Date(Date.now() + 86400000).toISOString()
            : null,
      },
    };
  }),
);
