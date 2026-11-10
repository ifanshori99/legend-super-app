// Fixture-backed purchasing endpoints. State resets through the shared mock store.
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { listSupplierCatalogMock, listSuppliersMock } from "./supplier-mock.ts";
import { idr } from "@starter/shared/core";
import {
  cafeLegendPurchasingFixtures as fixtures,
  createPurchaseOrder,
  createPurchaseRequest,
  getPurchaseOrder,
  getPurchaseRequest,
  listPurchaseOrders,
  listPurchaseRequests,
  listSupplierCatalog,
  listSuppliers,
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
// Inventory owns items, units, locations, balances and par levels (bead
// legend-qdc). Registering them here as well left the mock registry with two
// handlers per endpoint, so whichever feature module loaded last won — and this
// copy returned fixture order instead of the contract's name order, which made
// /kelola/inventori/satuan default to the wrong item. Importing the owning
// feature keeps one handler per endpoint no matter which screen loads first.
import "../ws06-inventory/mock.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const printStoragePrefix = "legend-mock-po-print:";
const printStorageKey = (id: string) => `${printStoragePrefix}${id}`;
let initialSeed = true;
const store = createMockStore(() => {
  // The first seed is a page load; later seeds are explicit mock resets.
  if (!initialSeed && typeof window !== "undefined") {
    try {
      const keys = Object.keys(window.localStorage).filter((key) =>
        key.startsWith(printStoragePrefix),
      );
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // Storage can be disabled.
    }
  }
  initialSeed = false;
  return {
    requests: structuredClone(fixtures.purchaseRequestDetails),
    orders: structuredClone(fixtures.purchaseOrderDetails),
    receipts: new Map<string, { fingerprint: string; value: unknown }>(),
  };
});
// Preserve a sent document for the print route in a new tab or after reload.
// Persisted documents do not appear in lists after reload.

function savePrintOrder(
  detail: (typeof fixtures.purchaseOrderDetails)[number],
) {
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        printStorageKey(detail.purchaseOrder.id),
        JSON.stringify(detail),
      );
  } catch {
    // In-memory view remains available if storage is disabled.
  }
}
function savedPrintOrder(id: string) {
  try {
    if (typeof window === "undefined") return undefined;
    const raw = window.localStorage.getItem(printStorageKey(id));
    if (!raw) return undefined;
    const parsed = purchaseOrderDetailSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.purchaseOrder.id === id
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}
const now = () => new Date().toISOString();
const mint = () => newIdempotencyKey();
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
registerMock(listSuppliers, listSuppliersMock);
registerMock(listSupplierCatalog, listSupplierCatalogMock);
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
    savedPrintOrder(params.purchaseOrderId) ??
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
        updatedAt: time,
        approvedBy: null,
        approvedAt: null,
        sentAt: null,
        sentTo: null,
        emailDeliveryStatus: null,
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
      updatedAt: now(),
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
      updatedAt: now(),
      sentTo: body.email ?? null,
      emailDeliveryStatus:
        body.channel === "email"
          ? "sent"
          : detail.purchaseOrder.emailDeliveryStatus,
    });
    savePrintOrder(detail);
    return {
      data: {
        purchaseOrder: detail.purchaseOrder,
        channel: body.channel,
        sentTo: body.channel === "email" ? body.email! : null,
        shareUrl:
          body.channel === "share_link"
            ? `${typeof window === "undefined" ? "https://legend.example" : window.location.origin}/kelola/pengadaan/po/${detail.purchaseOrder.id}/cetak`
            : null,
        expiresAt:
          body.channel === "share_link"
            ? new Date(Date.now() + 86400000).toISOString()
            : null,
      },
    };
  }),
);
