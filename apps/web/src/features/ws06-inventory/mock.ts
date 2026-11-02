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
  formatDecimal4,
  parseDecimal4,
} from "@starter/shared/core";
import {
  cafeLegendInventoryFixtures,
  createInventoryItem,
  createInventoryItemAlternate,
  createStockLocation,
  createStockTransfer,
  createUomConversion,
  deleteInventoryItemAlternate,
  deleteUomConversion,
  foldStockLedger,
  getInventoryItem,
  inventoryItemAlternateSchema,
  inventoryItemSchema,
  listInventoryItemAlternates,
  listInventoryItems,
  listParLevels,
  listStockBalances,
  listStockBatches,
  listStockLedger,
  listStockLocations,
  listStockTransfers,
  listUomConversions,
  listUoms,
  stockBalanceSchema,
  stockLedgerEntrySchema,
  stockLocationSchema,
  stockTransferSchema,
  uomConversionSchema,
  updateInventoryItem,
  updateStockLocation,
  type InventoryItem,
  type InventoryItemAlternate,
  type StockBalance,
  type StockLedgerEntry,
  type StockLocation,
  type StockTransfer,
  type UomConversion,
} from "@starter/shared/inventory";
import { businessDateOf } from "./stock-lib.ts";

const fixtures = cafeLegendInventoryFixtures;
const inventory = cafeLegendInventoryFixtures;
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
};

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
