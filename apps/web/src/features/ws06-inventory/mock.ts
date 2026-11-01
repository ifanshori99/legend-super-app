// Mock mode for the stock-control screens: serves the shared Cafe Legend
// inventory fixtures (and the purchasing fixtures for the draft PR), so every
// screen works with VITE_API_MOCK=true (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: filtering and ordering the same way,
// strict input parsing done by the runtime, and idempotent draft creation.
import {
  cafeLegendInventoryFixtures,
  cafeLegendPurchasingFixtures,
  createPurchaseRequest,
  listInventoryItems,
  listParLevels,
  listStockBalances,
  listStockBatches,
  listStockLedger,
  listStockLocations,
  listUoms,
  purchaseRequestDetailSchema,
  purchaseRequestLineSchema,
  purchaseRequestSchema,
  type PurchaseRequest,
  type PurchaseRequestDetail,
  type PurchaseRequestLine,
} from "@starter/shared/inventory";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { businessDateOf } from "./lib.ts";

const inventory = cafeLegendInventoryFixtures;
const purchasing = cafeLegendPurchasingFixtures;

// ---- Reads ---------------------------------------------------------------

registerMock(listInventoryItems, ({ query, scenario }) =>
  paginateFixture(
    inventory.items.filter(
      (item) =>
        (!query.category || item.category === query.category) &&
        (!query.type || item.type === query.type),
    ),
    query,
    (item) => item.id,
    scenario,
  ),
);

registerMock(listUoms, ({ query, scenario }) =>
  paginateFixture(inventory.uoms, query, (uom) => uom.id, scenario),
);

registerMock(listStockLocations, ({ query, scenario }) =>
  paginateFixture(
    inventory.locations.filter(
      (location) => location.outletId === query.outletId,
    ),
    query,
    (location) => location.id,
    scenario,
  ),
);

registerMock(listStockBalances, ({ query, scenario }) =>
  paginateFixture(
    inventory.balances.filter(
      (balance) =>
        balance.outletId === query.outletId &&
        (!query.locationId || balance.locationId === query.locationId) &&
        (!query.inventoryItemId ||
          balance.inventoryItemId === query.inventoryItemId),
    ),
    query,
    (balance) => `${balance.locationId}:${balance.inventoryItemId}`,
    scenario,
  ),
);

registerMock(listParLevels, ({ query, scenario }) =>
  paginateFixture(
    inventory.parLevels.filter(
      (level) =>
        level.outletId === query.outletId &&
        (!query.locationId || level.locationId === query.locationId) &&
        (!query.inventoryItemId ||
          level.inventoryItemId === query.inventoryItemId),
    ),
    query,
    (level) => level.id,
    scenario,
  ),
);

registerMock(listStockBatches, ({ query, scenario }) =>
  paginateFixture(
    inventory.batches.filter(
      (batch) =>
        batch.outletId === query.outletId &&
        (!query.locationId || batch.locationId === query.locationId) &&
        (!query.inventoryItemId ||
          batch.inventoryItemId === query.inventoryItemId) &&
        (!query.expiresOnOrBefore ||
          (batch.expiresOn !== null &&
            batch.expiresOn <= query.expiresOnOrBefore)),
    ),
    query,
    (batch) => batch.id,
    scenario,
  ),
);

// The stock card reads newest first, the way the API orders a ledger scan;
// business-date filters use the outlet time zone (D-CORE-6).
registerMock(listStockLedger, ({ query, scenario }) => {
  const rows = inventory.ledger
    .filter(
      (entry) =>
        entry.outletId === query.outletId &&
        (!query.locationId || entry.locationId === query.locationId) &&
        (!query.inventoryItemId ||
          entry.inventoryItemId === query.inventoryItemId) &&
        (!query.movementType || entry.movementType === query.movementType) &&
        (!query.fromDate ||
          businessDateOf(entry.occurredAt) >= query.fromDate) &&
        (!query.toDate || businessDateOf(entry.occurredAt) <= query.toDate),
    )
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
    );
  return paginateFixture(rows, query, (entry) => entry.id, scenario);
});

// ---- Draft purchase request (AI-08 suggestions → PR, PRD §4 Alur I) ------

type PurchaseRequestState = {
  requests: PurchaseRequest[];
  lines: PurchaseRequestLine[];
  /** Idempotency: the API returns the first result for a repeated key. */
  byKey: Record<string, PurchaseRequestDetail>;
};

const purchaseRequestStore = createMockStore<PurchaseRequestState>(() => ({
  requests: [...purchasing.purchaseRequests],
  lines: [...purchasing.purchaseRequestLines],
  byKey: {},
}));

registerMock(createPurchaseRequest, ({ body }) => {
  const state = purchaseRequestStore.get();
  const existing = state.byKey[body.idempotencyKey];
  if (existing) return { data: existing };

  // The server fills requester and tenant from the session (TEN-02); the mock
  // reuses the fixture requester so the response parses like a real one.
  const now = new Date().toISOString();
  const request = purchaseRequestSchema.parse({
    id: crypto.randomUUID(),
    tenantId: purchasing.purchaseRequests[0].tenantId,
    outletId: body.outletId,
    requestedBy: purchasing.purchaseRequests[0].requestedBy,
    status: "draft",
    neededBy: body.neededBy,
    note: body.note ?? null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: now,
    updatedAt: now,
  });
  const lines = body.lines.map((line) =>
    purchaseRequestLineSchema.parse({
      id: crypto.randomUUID(),
      tenantId: request.tenantId,
      purchaseRequestId: request.id,
      inventoryItemId: line.inventoryItemId,
      quantity: line.quantity,
      uomId: line.uomId,
    }),
  );
  const detail = purchaseRequestDetailSchema.parse({ request, lines });
  purchaseRequestStore.set({
    requests: [request, ...state.requests],
    lines: [...state.lines, ...lines],
    byKey: { ...state.byKey, [body.idempotencyKey]: detail },
  });
  return { data: detail };
});
