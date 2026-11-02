// Mock mode for the inventory back office: serves and mutates the shared Cafe
// Legend inventory fixtures, so every screen works with VITE_API_MOCK=true and
// the Playwright spec covers the happy path (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: strict input parsing (done by the
// runtime), the same error codes, idempotent document creates, and a transfer
// that appends its paired ledger rows and refolds the balances (INV-01).
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  cafeLegendFixtures,
  createUlid,
  decimal4Schema,
  extendCostIdr,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  assertStockCountApproval,
  cafeLegendInventoryFixtures,
  cafeLegendPurchasingFixtures,
  createInventoryItem,
  createPurchaseRequest,
  createInventoryItemAlternate,
  createStockCount,
  createStockLocation,
  createStockTransfer,
  createUomConversion,
  createWasteLog,
  deleteInventoryItemAlternate,
  deleteUomConversion,
  foldStockLedger,
  getInventoryItem,
  getStockCount,
  inventoryItemAlternateSchema,
  inventoryItemSchema,
  listInventoryItemAlternates,
  listInventoryItems,
  listParLevels,
  listStockBalances,
  listStockBatches,
  listStockCounts,
  listStockLedger,
  listStockLocations,
  listStockTransfers,
  listUomConversions,
  listUoms,
  listWasteLogs,
  postStockCountTransition,
  purchaseRequestDetailSchema,
  purchaseRequestLineSchema,
  purchaseRequestSchema,
  stockBalanceSchema,
  stockCountLineSchema,
  stockCountSchema,
  stockCountVarianceIdr,
  stockLedgerEntrySchema,
  stockLocationSchema,
  stockTransferSchema,
  transitionStockCount,
  uomConversionSchema,
  updateInventoryItem,
  updateStockCountLine,
  updateStockLocation,
  wasteLogSchema,
  type InventoryItem,
  type InventoryItemAlternate,
  type PurchaseRequest,
  type PurchaseRequestDetail,
  type PurchaseRequestLine,
  type StockBalance,
  type StockCount,
  type StockCountDetail,
  type StockCountLine,
  type StockLedgerEntry,
  type StockLocation,
  type StockTransfer,
  type UomConversion,
  type WasteLog,
} from "@starter/shared/inventory";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";
import { businessDateOf } from "./stock-lib.ts";

const fixtures = cafeLegendInventoryFixtures;
const inventory = cafeLegendInventoryFixtures;
const purchasing = cafeLegendPurchasingFixtures;
const uoms = fixtures.uoms;
const tenantId = fixtures.items[0].tenantId;
const fixtureOutletId = fixtures.locations[0].outletId;
const fixtureUserId = fixtures.wasteLogs[0].loggedBy;
const knownOutlets = new Set(cafeLegendFixtures.outlets.map((row) => row.id));

type InventoryState = {
  items: InventoryItem[];
  alternates: InventoryItemAlternate[];
  conversions: UomConversion[];
  locations: StockLocation[];
  transfers: StockTransfer[];
  ledger: StockLedgerEntry[];
  balances: StockBalance[];
  /** Stock opname sessions and the waste log share this store: a posted
   * count and a waste entry both append to `ledger` and refold `balances`. */
  counts: StockCountDetail[];
  wasteLogs: WasteLog[];
};

const qty4 = (value: string): Decimal4 => decimal4Schema.parse(value);

/** Deterministic ids for seeded demo rows: SSR and the browser must agree. */
const seedUuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function seedState(): InventoryState {
  const seeded = structuredClone(fixtures);
  return {
    items: seeded.items,
    alternates: seeded.itemAlternates,
    conversions: seeded.uomConversions,
    locations: seeded.locations,
    transfers: seeded.stockTransfers,
    ledger: seeded.ledger,
    balances: seeded.balances,
    counts: seedStockCounts(seeded),
    wasteLogs: seedWasteLogs(seeded),
  };
}

const store = createMockStore<InventoryState>(seedState);
/** Idempotency for creates: key → the document the first request minted. */
const documents = createMockStore(() => new Map<string, unknown>());

const state = () => store.get();
const now = () => new Date().toISOString();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function conflict(message: string): never {
  throw new ApiError(409, "CONFLICT", message);
}

function invalid(field: string, message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, [{ field, message }]);
}

/** Creates a document once per idempotency key, like the API will. */
function once<T>(key: string, create: () => T): T {
  const seen = documents.get().get(key);
  if (seen !== undefined) return seen as T;
  const value = create();
  documents.get().set(key, value);
  return value;
}

function requireItem(itemId: string): InventoryItem {
  const item = state().items.find((row) => row.id === itemId);
  return item ?? notFound("Item bahan");
}

// ---- Items ---------------------------------------------------------------

registerMock(listInventoryItems, ({ query, scenario }) => {
  const rows = state()
    .items.filter(
      (row) => query.category === undefined || row.category === query.category,
    )
    .filter((row) => query.type === undefined || row.type === query.type)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getInventoryItem, ({ params, scenario }) => {
  // The "empty" scenario has no items, so the detail screen can show its
  // not-found state.
  if (scenario === "empty") notFound("Item bahan");
  return { data: requireItem(params.itemId) };
});

registerMock(createInventoryItem, ({ body }) => {
  const item = once(`item:${body.idempotencyKey}`, () => {
    if (!uoms.some((row) => row.id === body.baseUomId))
      invalid("baseUomId", "Satuan dasar tidak dikenal.");
    const created = inventoryItemSchema.parse({
      id: crypto.randomUUID(),
      tenantId,
      name: body.name,
      category: body.category,
      type: body.type,
      baseUomId: body.baseUomId,
      isPerishable: body.isPerishable,
      isActive: true,
      parMin: body.parMin ?? null,
      parMax: body.parMax ?? null,
      updatedAt: now(),
    });
    store.set({ ...state(), items: [...state().items, created] });
    return created;
  });
  return { data: item };
});

registerMock(updateInventoryItem, ({ params, body }) => {
  const current = requireItem(params.itemId);
  // Optimistic concurrency: a stale form must reload, never overwrite (CORE
  // PRECONDITION_FAILED, the contract's `expectedUpdatedAt`).
  if (current.updatedAt !== body.expectedUpdatedAt)
    throw new ApiError(
      412,
      "PRECONDITION_FAILED",
      "Item sudah berubah di perangkat lain. Muat ulang halaman lalu ulangi perubahan.",
    );
  const patch = Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => key !== "expectedUpdatedAt" && value !== undefined,
    ),
  );
  const merged = { ...current, ...patch };
  if (
    merged.parMin !== null &&
    merged.parMax !== null &&
    parseDecimal4(merged.parMax) < parseDecimal4(merged.parMin)
  )
    invalid("parMax", "Par maksimum tidak boleh kurang dari par minimum.");
  const next = inventoryItemSchema.parse({
    ...merged,
    updatedAt: now(),
  });
  store.set({
    ...state(),
    items: state().items.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

// ---- Alternates ----------------------------------------------------------

registerMock(listInventoryItemAlternates, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  requireItem(params.itemId);
  return {
    data: state()
      .alternates.filter((row) => row.inventoryItemId === params.itemId)
      .sort((a, b) => a.priority - b.priority),
  };
});

registerMock(createInventoryItemAlternate, ({ params, body }) => {
  const item = requireItem(params.itemId);
  const alternate = state().items.find(
    (row) => row.id === body.alternateItemId,
  );
  if (!alternate)
    invalid("alternateItemId", "Bahan alternatif tidak ditemukan.");
  if (alternate.id === item.id)
    invalid(
      "alternateItemId",
      "Item tidak boleh menjadi alternatif dirinya sendiri.",
    );
  if (
    state().alternates.some(
      (row) =>
        row.inventoryItemId === item.id && row.alternateItemId === alternate.id,
    )
  )
    conflict("Bahan alternatif itu sudah ada di daftar.");
  const created = inventoryItemAlternateSchema.parse({
    id: crypto.randomUUID(),
    tenantId,
    inventoryItemId: item.id,
    alternateItemId: alternate.id,
    priority: body.priority ?? 0,
  });
  store.set({
    ...state(),
    alternates: [...state().alternates, created],
  });
  return { data: created };
});

registerMock(deleteInventoryItemAlternate, ({ params }) => {
  const alternate = state().alternates.find(
    (row) =>
      row.id === params.alternateId && row.inventoryItemId === params.itemId,
  );
  if (!alternate) notFound("Bahan alternatif");
  store.set({
    ...state(),
    alternates: state().alternates.filter((row) => row.id !== alternate.id),
  });
});

// ---- Units and conversions ----------------------------------------------

registerMock(listUoms, ({ query, scenario }) =>
  paginateFixture(uoms, query, (row) => row.id, scenario),
);

registerMock(listUomConversions, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  requireItem(params.itemId);
  return {
    data: state().conversions.filter(
      (row) => row.inventoryItemId === params.itemId,
    ),
  };
});

registerMock(createUomConversion, ({ params, body }) => {
  const item = requireItem(params.itemId);
  if (!uoms.some((row) => row.id === body.fromUomId))
    invalid("fromUomId", "Satuan asal tidak dikenal.");
  if (!uoms.some((row) => row.id === body.toUomId))
    invalid("toUomId", "Satuan tujuan tidak dikenal.");
  // The conversion graph walks both directions, so a reverse pair would loop.
  const duplicate = state().conversions.some(
    (row) =>
      row.inventoryItemId === item.id &&
      ((row.fromUomId === body.fromUomId && row.toUomId === body.toUomId) ||
        (row.fromUomId === body.toUomId && row.toUomId === body.fromUomId)),
  );
  if (duplicate)
    conflict(
      "Konversi untuk pasangan satuan itu sudah ada. Hapus dulu yang lama.",
    );
  const created = uomConversionSchema.parse({
    id: crypto.randomUUID(),
    tenantId,
    inventoryItemId: item.id,
    fromUomId: body.fromUomId,
    toUomId: body.toUomId,
    factor: body.factor,
  });
  store.set({
    ...state(),
    conversions: [...state().conversions, created],
  });
  return { data: created };
});

registerMock(deleteUomConversion, ({ params }) => {
  const conversion = state().conversions.find(
    (row) =>
      row.id === params.conversionId && row.inventoryItemId === params.itemId,
  );
  if (!conversion) notFound("Konversi satuan");
  store.set({
    ...state(),
    conversions: state().conversions.filter((row) => row.id !== conversion.id),
  });
});

// ---- Stock locations -----------------------------------------------------

registerMock(listStockLocations, ({ query, scenario }) =>
  paginateFixture(
    state().locations.filter((row) => row.outletId === query.outletId),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(createStockLocation, ({ body }) => {
  const location = once(`location:${body.idempotencyKey}`, () => {
    if (!knownOutlets.has(body.outletId))
      invalid("outletId", "Outlet tidak dikenal.");
    const created = stockLocationSchema.parse({
      id: crypto.randomUUID(),
      tenantId,
      outletId: body.outletId,
      name: body.name,
      type: body.type,
      isActive: true,
    });
    store.set({
      ...state(),
      locations: [...state().locations, created],
    });
    return created;
  });
  return { data: location };
});

registerMock(updateStockLocation, ({ params, body }) => {
  const current = state().locations.find((row) => row.id === params.locationId);
  if (!current) notFound("Lokasi stok");
  const patch = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
  const next = stockLocationSchema.parse({ ...current, ...patch });
  store.set({
    ...state(),
    locations: state().locations.map((row) =>
      row.id === next.id ? next : row,
    ),
  });
  return { data: next };
});

// ---- Balances and transfers ---------------------------------------------

registerMock(listStockBalances, ({ query, scenario }) => {
  const rows = state()
    .balances.filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.locationId === undefined || row.locationId === query.locationId,
    )
    .filter(
      (row) =>
        query.inventoryItemId === undefined ||
        row.inventoryItemId === query.inventoryItemId,
    );
  return paginateFixture(
    rows,
    query,
    (row) => `${row.locationId}:${row.inventoryItemId}`,
    scenario,
  );
});

registerMock(listStockTransfers, ({ query, scenario }) => {
  const rows = state()
    .transfers.filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.locationId === undefined ||
        row.fromLocationId === query.locationId ||
        row.toLocationId === query.locationId,
    )
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(createStockTransfer, ({ body }) => {
  const transfer = once(`transfer:${body.idempotencyKey}`, () => {
    if (body.outletId !== fixtureOutletId)
      invalid("outletId", "Outlet tidak dikenal.");
    const from = state().locations.find(
      (row) => row.id === body.fromLocationId,
    );
    if (!from)
      invalid("fromLocationId", "Lokasi asal tidak dikenal di outlet ini.");
    const to = state().locations.find((row) => row.id === body.toLocationId);
    if (!to)
      invalid("toLocationId", "Lokasi tujuan tidak dikenal di outlet ini.");
    for (const [index, line] of body.lines.entries())
      if (!state().items.some((row) => row.id === line.inventoryItemId))
        invalid(
          `lines.${index}.inventoryItemId`,
          "Item bahan tidak ditemukan.",
        );

    const occurredAt = now();
    const created = stockTransferSchema.parse({
      id: createUlid(),
      tenantId,
      outletId: body.outletId,
      fromLocationId: from.id,
      toLocationId: to.id,
      lines: body.lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
      })),
      movedBy: fixtureUserId,
      occurredAt,
      note: body.note ?? null,
    });

    // One source document, two append-only ledger rows per line (PRD §16
    // "Kartu Stok Append-only"); the transferred value follows the source's
    // moving-average unit cost.
    const entries: StockLedgerEntry[] = created.lines.flatMap((line) => {
      const balance = state().balances.find(
        (row) =>
          row.locationId === from.id &&
          row.inventoryItemId === line.inventoryItemId,
      );
      const unitCostIdr = balance?.avgCostIdr ?? formatDecimal4(0n);
      const quantity = parseDecimal4(line.quantity);
      const row = (
        locationId: string,
        movementType: "transfer_out" | "transfer_in",
        signedQuantity: string,
      ) =>
        stockLedgerEntrySchema.parse({
          id: createUlid(),
          tenantId,
          outletId: body.outletId,
          locationId,
          inventoryItemId: line.inventoryItemId,
          movementType,
          quantity: signedQuantity,
          unitCostIdr,
          batchId: null,
          sourceType: "stock_transfer",
          sourceId: created.id,
          occurredAt,
        });
      return [
        row(from.id, "transfer_out", formatDecimal4(-quantity)),
        row(to.id, "transfer_in", formatDecimal4(quantity)),
      ];
    });

    const ledger = [...state().ledger, ...entries];
    store.set({
      ...state(),
      transfers: [created, ...state().transfers],
      ledger,
      balances: foldStockLedger(ledger, "half_up").map((row) =>
        stockBalanceSchema.parse(row),
      ),
    });
    return created;
  });
  return { data: transfer };
});

// ---- Stock control (legend-vxj): par levels, batches, stock card, AI-08 ----
// The stock card reads the same mutable ledger the transfer handler appends
// to, so a transfer made in mock mode shows up on the stock card.

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
  const rows = state()
    .ledger.filter(
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

// ---- Stock opname and waste (legend-fzx)

// Seeded sessions cover every state of the machine, so the list and the
// approval screen are reviewable without clicking through; the shared
// fixtures already provide a submitted blind count and a posted full count.

function seededBalance(
  seeded: typeof fixtures,
  locationId: string,
  inventoryItemId: string,
): StockBalance | undefined {
  return seeded.balances.find(
    (row) =>
      row.locationId === locationId && row.inventoryItemId === inventoryItemId,
  );
}

function seedStockCounts(seeded: typeof fixtures): StockCountDetail[] {
  const counter = seeded.stockCounts[0].countedBy;
  const approver = seeded.stockCounts[1].approvedBy ?? counter;
  const businessDate = seeded.stockCounts[0].businessDate;
  const locationOfType = (type: StockLocation["type"]) =>
    seeded.locations.find((row) => row.type === type) ?? seeded.locations[0];
  const items = [...seeded.items].sort((a, b) =>
    a.name.localeCompare(b.name, "id-ID"),
  );
  const systemQty = (locationId: string, itemId: string) =>
    seededBalance(seeded, locationId, itemId)?.quantity ?? "0.0000";
  const avgCost = (locationId: string, itemId: string) =>
    seededBalance(seeded, locationId, itemId)?.avgCostIdr ??
    seeded.balances.find((row) => row.inventoryItemId === itemId)?.avgCostIdr ??
    "0.0000";

  const build = (input: {
    seed: number;
    locationId: string;
    type: StockCount["type"];
    status: StockCount["status"];
    blind: boolean;
    note: string | null;
    itemIds: readonly string[];
    counted?: Readonly<Record<string, string>>;
    approvedBy?: string | null;
    countedAt?: string | null;
    approvedAt?: string | null;
  }): StockCountDetail => {
    const id = seedUuid(input.seed);
    const count = stockCountSchema.parse({
      id,
      tenantId,
      outletId: fixtureOutletId,
      locationId: input.locationId,
      type: input.type,
      status: input.status,
      blind: input.blind,
      businessDate,
      countedBy: counter,
      approvedBy: input.approvedBy ?? null,
      countedAt: input.countedAt ?? null,
      approvedAt: input.approvedAt ?? null,
      note: input.note,
    });
    const lines = input.itemIds.map((itemId, index) => {
      const system = systemQty(input.locationId, itemId);
      const counted = input.counted?.[itemId] ?? null;
      return stockCountLineSchema.parse({
        id: seedUuid(input.seed * 100 + index + 1),
        tenantId,
        stockCountId: id,
        inventoryItemId: itemId,
        systemQty: system,
        countedQty: counted,
        varianceIdr:
          counted === null
            ? null
            : stockCountVarianceIdr(
                {
                  systemQty: qty4(system),
                  countedQty: qty4(counted),
                  unitCostIdr: qty4(avgCost(input.locationId, itemId)),
                },
                "half_up",
              ),
      });
    });
    return { count, lines };
  };

  const gudang = locationOfType("warehouse");
  const bar = locationOfType("bar");
  const chiller = locationOfType("chiller");
  const draftItems = items.slice(0, 3).map((item) => item.id);
  const approvedItems = items.slice(0, 2).map((item) => item.id);
  const approvedCounted = Object.fromEntries(
    approvedItems.map((itemId) => [
      itemId,
      formatDecimal4(
        parseDecimal4(systemQty(chiller.id, itemId)) - parseDecimal4("0.2000"),
      ),
    ]),
  );
  const timestamp = new Date().toISOString();

  return [
    build({
      seed: 7901,
      locationId: gudang.id,
      type: "full",
      status: "draft",
      blind: false,
      note: "Opname bulanan gudang utama",
      itemIds: draftItems,
    }),
    build({
      seed: 7902,
      locationId: bar.id,
      type: "cycle",
      status: "counting",
      blind: true,
      note: "Hitung ulang sirup bar",
      itemIds: items.slice(2, 4).map((item) => item.id),
      counted: { [items[2].id]: "1.5000" },
    }),
    build({
      seed: 7903,
      locationId: chiller.id,
      type: "full",
      status: "approved",
      blind: false,
      note: "Sudah disetujui, menunggu pembukuan",
      itemIds: approvedItems,
      counted: approvedCounted,
      countedAt: timestamp,
      approvedBy: approver,
      approvedAt: timestamp,
    }),
    build({
      seed: 7904,
      locationId: bar.id,
      type: "cycle",
      status: "cancelled",
      blind: false,
      note: "Dibatalkan: jadwal bentrok",
      itemIds: items.slice(0, 1).map((item) => item.id),
    }),
    ...seeded.stockCountDetails,
  ];
}

function seedWasteLogs(seeded: typeof fixtures): WasteLog[] {
  const gudang =
    seeded.locations.find((row) => row.type === "warehouse") ??
    seeded.locations[0];
  // Pick a menu item whose recipe cost exists, so the demo loss is not Rp 0.
  const menuCost = seeded.menuCosts.find(
    (row) =>
      row.variantId === null &&
      row.modifierId === null &&
      row.theoreticalCostIdr !== null,
  );
  const menuItem = menuCost
    ? cafeLegendMenuFixtures.items.find((row) => row.id === menuCost.menuItemId)
    : undefined;
  const coffee = seeded.items.find((item) =>
    item.name.toLocaleLowerCase("id-ID").includes("kopi"),
  );
  const derived: WasteLog[] = [];
  if (menuItem && menuCost) {
    derived.push(
      wasteLogSchema.parse({
        id: seedUuid(7951),
        tenantId,
        outletId: fixtureOutletId,
        locationId: gudang.id,
        targetType: "menu_item",
        targetId: menuItem.id,
        quantity: "2.0000",
        reason: "overproduction",
        mediaId: null,
        valueIdr: extendCostIdr(
          qty4("2.0000"),
          qty4(menuCost?.theoreticalCostIdr ?? "0.0000"),
          "half_up",
        ),
        loggedBy: fixtureUserId,
        occurredAt: "2026-11-01T08:30:00.000Z",
        note: "Sisa hidangan display sore",
      }),
    );
  }
  if (coffee) {
    derived.push(
      wasteLogSchema.parse({
        id: seedUuid(7952),
        tenantId,
        outletId: fixtureOutletId,
        locationId: gudang.id,
        targetType: "inventory_item",
        targetId: coffee.id,
        quantity: "0.1000",
        reason: "dropped",
        mediaId: seedUuid(7953),
        valueIdr: extendCostIdr(
          qty4("0.1000"),
          qty4(
            seededBalance(seeded, gudang.id, coffee.id)?.avgCostIdr ?? "0.0000",
          ),
          "half_up",
        ),
        loggedBy: fixtureUserId,
        occurredAt: "2026-11-01T07:10:00.000Z",
        note: "Kemasan jatuh saat bongkar muat",
      }),
    );
  }
  return [...derived, ...seeded.wasteLogs];
}

const opnameCounterId = fixtures.stockCounts[0].countedBy;
const opnameApproverId = fixtures.stockCounts[1].approvedBy ?? opnameCounterId;

function currentBalance(
  locationId: string,
  inventoryItemId: string,
): StockBalance | undefined {
  return state().balances.find(
    (row) =>
      row.locationId === locationId && row.inventoryItemId === inventoryItemId,
  );
}

function currentSystemQty(locationId: string, inventoryItemId: string) {
  return currentBalance(locationId, inventoryItemId)?.quantity ?? "0.0000";
}

function currentAvgCost(locationId: string, inventoryItemId: string) {
  return (
    currentBalance(locationId, inventoryItemId)?.avgCostIdr ??
    state().balances.find((row) => row.inventoryItemId === inventoryItemId)
      ?.avgCostIdr ??
    "0.0000"
  );
}

function opnameLine(
  stockCountId: string,
  inventoryItemId: string,
  systemQty: string,
  countedQty: string | null,
  unitCostIdr: string,
): StockCountLine {
  return stockCountLineSchema.parse({
    id: crypto.randomUUID(),
    tenantId,
    stockCountId,
    inventoryItemId,
    systemQty,
    countedQty,
    varianceIdr:
      countedQty === null
        ? null
        : stockCountVarianceIdr(
            {
              systemQty: qty4(systemQty),
              countedQty: qty4(countedQty),
              unitCostIdr: qty4(unitCostIdr),
            },
            "half_up",
          ),
  });
}

function findCount(stockCountId: string): StockCountDetail {
  const detail = state().counts.find((row) => row.count.id === stockCountId);
  return detail ?? notFound("Sesi opname");
}

function replaceCount(next: StockCountDetail): StockCountDetail {
  store.set({
    ...state(),
    counts: state().counts.map((row) =>
      row.count.id === next.count.id ? next : row,
    ),
  });
  return next;
}

/** Values every counted line with the location's moving-average cost. */
function valueCount(detail: StockCountDetail): StockCountDetail {
  return {
    ...detail,
    lines: detail.lines.map((line) =>
      stockCountLineSchema.parse({
        ...line,
        varianceIdr:
          line.countedQty === null
            ? null
            : stockCountVarianceIdr(
                {
                  systemQty: line.systemQty,
                  countedQty: line.countedQty,
                  unitCostIdr: qty4(
                    currentAvgCost(
                      detail.count.locationId,
                      line.inventoryItemId,
                    ),
                  ),
                },
                "half_up",
              ),
      }),
    ),
  };
}

/** INV-01: a posted count appends one `adjustment` row per real variance. */
function postCountAdjustments(detail: StockCountDetail): void {
  const occurredAt = now();
  const entries: StockLedgerEntry[] = detail.lines.flatMap((line) => {
    if (line.countedQty === null) return [];
    const delta =
      parseDecimal4(line.countedQty) - parseDecimal4(line.systemQty);
    if (delta === 0n) return [];
    return [
      stockLedgerEntrySchema.parse({
        // Ledger ids are canonical ULIDs (D-CORE-1), unlike document uuids.
        id: createUlid(),
        tenantId,
        outletId: fixtureOutletId,
        locationId: detail.count.locationId,
        inventoryItemId: line.inventoryItemId,
        movementType: "adjustment",
        quantity: formatDecimal4(delta),
        unitCostIdr: qty4(
          currentAvgCost(detail.count.locationId, line.inventoryItemId),
        ),
        batchId: null,
        sourceType: "stock_count",
        sourceId: detail.count.id,
        occurredAt,
      }),
    ];
  });
  const ledger = [...state().ledger, ...entries];
  store.set({
    ...state(),
    ledger,
    balances: foldStockLedger(ledger, "half_up").map((row) =>
      stockBalanceSchema.parse(row),
    ),
  });
}

registerMock(listStockCounts, ({ query, scenario }) => {
  const rows = state()
    .counts.map((row) => row.count)
    .filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.locationId === undefined || row.locationId === query.locationId,
    )
    .filter((row) => query.status === undefined || row.status === query.status)
    .filter((row) => query.type === undefined || row.type === query.type);
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getStockCount, ({ params, scenario }) => {
  // The empty scenario has no sessions, so the detail shows its not-found state.
  if (scenario === "empty") notFound("Sesi opname");
  return { data: findCount(params.stockCountId) };
});

registerMock(createStockCount, ({ body }) => {
  const detail = once(`stock-count:${body.idempotencyKey}`, () => {
    if (body.outletId !== fixtureOutletId)
      invalid("outletId", "Outlet tidak dikenal.");
    if (!state().locations.some((row) => row.id === body.locationId))
      invalid("locationId", "Lokasi stok tidak dikenal di outlet ini.");
    const itemIds =
      body.type === "full"
        ? state()
            .items.filter((row) => row.isActive)
            .map((row) => row.id)
        : (body.inventoryItemIds ?? []);
    if (itemIds.length === 0)
      invalid("inventoryItemIds", "Pilih minimal satu item.");
    for (const itemId of itemIds) requireItem(itemId);
    const id = crypto.randomUUID();
    const count = stockCountSchema.parse({
      id,
      tenantId,
      outletId: fixtureOutletId,
      locationId: body.locationId,
      type: body.type,
      status: "draft",
      blind: body.blind,
      businessDate: body.businessDate,
      countedBy: opnameCounterId,
      approvedBy: null,
      countedAt: null,
      approvedAt: null,
      note: body.note ?? null,
    });
    const lines = itemIds.map((itemId) =>
      opnameLine(
        id,
        itemId,
        currentSystemQty(body.locationId, itemId),
        null,
        currentAvgCost(body.locationId, itemId),
      ),
    );
    const created = { count, lines };
    store.set({ ...state(), counts: [created, ...state().counts] });
    return created;
  });
  return { data: detail };
});

registerMock(updateStockCountLine, ({ params, body }) => {
  const detail = findCount(params.stockCountId);
  if (detail.count.status !== "counting")
    conflict("Baris hanya dapat diisi saat hitungan berjalan.");
  const current = detail.lines.find((row) => row.id === params.lineId);
  if (!current) notFound("Baris hitungan");
  const updated = stockCountLineSchema.parse({
    ...current,
    countedQty: body.countedQty,
    varianceIdr: null,
  });
  replaceCount({
    ...detail,
    lines: detail.lines.map((row) => (row.id === updated.id ? updated : row)),
  });
  return { data: updated };
});

registerMock(postStockCountTransition, ({ params, body }) => {
  const result = once(
    `stock-count-transition:${params.stockCountId}:${body.idempotencyKey}`,
    () => {
      const detail = findCount(params.stockCountId);
      const nextStatus = transitionStockCount(detail.count.status, body.action);
      const timestamp = now();
      let next: StockCountDetail = {
        count: { ...detail.count, status: nextStatus },
        lines: detail.lines,
      };

      if (body.action === "submit") {
        if (detail.lines.some((row) => row.countedQty === null))
          invalid("action", "Isi jumlah fisik semua baris sebelum mengirim.");
        next = valueCount(next);
        next.count = { ...next.count, countedAt: timestamp };
      }
      if (body.action === "approve") {
        // INV-03: the approver is the fixture manager, never the barista who
        // counted. The demo has no session, so this is the two-person rule.
        assertStockCountApproval(detail.count, opnameApproverId);
        next = valueCount(next);
        next.count = {
          ...next.count,
          approvedBy: opnameApproverId,
          approvedAt: timestamp,
        };
      }
      if (body.action === "reject") {
        next.count = { ...next.count, approvedBy: null, approvedAt: null };
      }
      if (body.action === "post") postCountAdjustments(detail);
      if (body.note !== undefined && body.note !== null)
        next.count = { ...next.count, note: body.note };
      return replaceCount({
        count: stockCountSchema.parse(next.count),
        lines: next.lines,
      });
    },
  );
  return { data: result.count };
});

registerMock(listWasteLogs, ({ query, scenario }) => {
  const rows = state()
    .wasteLogs.filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.locationId === undefined || row.locationId === query.locationId,
    )
    .filter((row) => query.reason === undefined || row.reason === query.reason)
    .filter(
      (row) =>
        query.fromDate === undefined ||
        row.occurredAt.slice(0, 10) >= query.fromDate,
    )
    .filter(
      (row) =>
        query.toDate === undefined ||
        row.occurredAt.slice(0, 10) <= query.toDate,
    )
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(createWasteLog, ({ body }) => {
  const log = once(`waste-log:${body.idempotencyKey}`, () => {
    if (body.outletId !== fixtureOutletId)
      invalid("outletId", "Outlet tidak dikenal.");
    if (!state().locations.some((row) => row.id === body.locationId))
      invalid("locationId", "Lokasi stok tidak dikenal di outlet ini.");

    let unitCostIdr: Decimal4;
    let ledgerItemId: string | null = null;
    if (body.targetType === "inventory_item") {
      requireItem(body.targetId);
      unitCostIdr = qty4(currentAvgCost(body.locationId, body.targetId));
      ledgerItemId = body.targetId;
    } else {
      if (!cafeLegendMenuFixtures.items.some((row) => row.id === body.targetId))
        notFound("Menu");
      const menuCost = fixtures.menuCosts.find(
        (row) =>
          row.menuItemId === body.targetId &&
          row.variantId === null &&
          row.modifierId === null,
      );
      unitCostIdr = qty4(menuCost?.theoreticalCostIdr ?? "0.0000");
    }

    const occurredAt = body.occurredAt ?? now();
    const created = wasteLogSchema.parse({
      id: crypto.randomUUID(),
      tenantId,
      outletId: fixtureOutletId,
      locationId: body.locationId,
      targetType: body.targetType,
      targetId: body.targetId,
      quantity: body.quantity,
      reason: body.reason,
      mediaId: body.mediaId ?? null,
      // The server values the loss; a client-supplied value is rejected.
      valueIdr: extendCostIdr(qty4(body.quantity), unitCostIdr, "half_up"),
      loggedBy: fixtureUserId,
      occurredAt,
      note: body.note ?? null,
    });

    // PRD §16: waste is a stock movement. A menu target has no single
    // ingredient to deduct, so only the loss value is recorded.
    let ledger = state().ledger;
    if (ledgerItemId) {
      const entry = stockLedgerEntrySchema.parse({
        // Ledger ids are canonical ULIDs (D-CORE-1).
        id: createUlid(),
        tenantId,
        outletId: fixtureOutletId,
        locationId: body.locationId,
        inventoryItemId: ledgerItemId,
        movementType: "waste",
        quantity: formatDecimal4(-parseDecimal4(body.quantity)),
        unitCostIdr,
        batchId: null,
        sourceType: "waste_log",
        sourceId: created.id,
        occurredAt,
      });
      ledger = [...ledger, entry];
    }
    store.set({
      ...state(),
      wasteLogs: [created, ...state().wasteLogs],
      ledger,
      balances: foldStockLedger(ledger, "half_up").map((row) =>
        stockBalanceSchema.parse(row),
      ),
    });
    return created;
  });
  return { data: log };
});
