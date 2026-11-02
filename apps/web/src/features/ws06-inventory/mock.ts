// Mock mode for stock opname and waste (VITE_API_MOCK=true): serves and
// mutates the shared Cafe Legend inventory fixtures, so every screen works
// without a backend and the Playwright spec covers the happy path.
//
// Handlers behave like the API will: strict input parsing (done by the
// runtime), the same error codes, idempotent document/transition creates, and
// the INV-03 rule that a counter never approves their own count. The demo has
// no Legend session yet, so the mock casts the counter as the fixture barista
// and the approver as the fixture outlet manager — two different people.
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  decimal4Schema,
  extendCostIdr,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  assertStockCountApproval,
  cafeLegendInventoryFixtures,
  createStockCount,
  createWasteLog,
  foldStockLedger,
  getStockCount,
  listInventoryItems,
  listStockCounts,
  listStockLocations,
  listUoms,
  listWasteLogs,
  postStockCountTransition,
  stockBalanceSchema,
  stockCountLineSchema,
  stockCountSchema,
  stockCountVarianceIdr,
  stockLedgerEntrySchema,
  transitionStockCount,
  updateStockCountLine,
  wasteLogSchema,
  type InventoryItem,
  type StockBalance,
  type StockCount,
  type StockCountDetail,
  type StockCountLine,
  type StockLedgerEntry,
  type StockLocation,
  type WasteLog,
} from "@starter/shared/inventory";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";

const fixtures = cafeLegendInventoryFixtures;
const tenantId = fixtures.items[0].tenantId;
const outletId = fixtures.locations[0].outletId;
const counterId = fixtures.stockCounts[0].countedBy;
const approverId = fixtures.stockCounts[1].approvedBy ?? counterId;
const fixtureBusinessDate = fixtures.stockCounts[0].businessDate;

const itemById = new Map<string, InventoryItem>(
  fixtures.items.map((item) => [item.id, item]),
);
const locationById = new Map<string, StockLocation>(
  fixtures.locations.map((location) => [location.id, location]),
);
const menuItemById = new Map(
  cafeLegendMenuFixtures.items.map((item) => [item.id, item]),
);

const balanceKey = (locationId: string, inventoryItemId: string) =>
  `${locationId}:${inventoryItemId}`;

const seededBalances = new Map<string, StockBalance>(
  fixtures.balances.map((balance) => [
    balanceKey(balance.locationId, balance.inventoryItemId),
    balance,
  ]),
);

const qty = (value: string): Decimal4 => decimal4Schema.parse(value);

/** System quantity snapshot for a new count line, from the seeded balances. */
function systemQtyAt(locationId: string, inventoryItemId: string): Decimal4 {
  return qty(
    seededBalances.get(balanceKey(locationId, inventoryItemId))?.quantity ??
      "0.0000",
  );
}

/** Moving-average cost per base unit; the location's average wins. */
function avgCostAt(locationId: string, inventoryItemId: string): Decimal4 {
  const exact = seededBalances.get(balanceKey(locationId, inventoryItemId));
  if (exact) return qty(exact.avgCostIdr);
  const any = fixtures.balances.find(
    (balance) => balance.inventoryItemId === inventoryItemId,
  );
  return qty(any?.avgCostIdr ?? "0.0000");
}

function menuCostOf(menuItemId: string): Decimal4 {
  const row = fixtures.menuCosts.find(
    (cost) =>
      cost.menuItemId === menuItemId &&
      cost.variantId === null &&
      cost.modifierId === null,
  );
  return qty(row?.theoreticalCostIdr ?? "0.0000");
}

const activeItems = [...fixtures.items].sort((a, b) =>
  a.name.localeCompare(b.name, "id-ID"),
);

function nowIso(): string {
  return new Date().toISOString();
}

/** New ids are v4 UUIDs: the contract's branded id schemas are `z.uuid`. */
function newId(): string {
  return crypto.randomUUID();
}

function line(
  stockCountId: string,
  inventoryItemId: string,
  systemQty: Decimal4,
  countedQty: Decimal4 | null,
  unitCostIdr: Decimal4,
): StockCountLine {
  return stockCountLineSchema.parse({
    id: newId(),
    tenantId,
    stockCountId,
    inventoryItemId,
    systemQty,
    countedQty,
    varianceIdr:
      countedQty === null
        ? null
        : stockCountVarianceIdr(
            { systemQty, countedQty, unitCostIdr },
            "half_up",
          ),
  });
}

function seedDetail(input: {
  locationId: string;
  type: StockCount["type"];
  status: StockCount["status"];
  blind: boolean;
  countedBy?: string;
  approvedBy?: string | null;
  countedAt?: string | null;
  approvedAt?: string | null;
  note?: string | null;
  itemIds: readonly string[];
  counted?: Readonly<Record<string, string | null>>;
}): StockCountDetail {
  const id = newId();
  const count = stockCountSchema.parse({
    id,
    tenantId,
    outletId,
    locationId: input.locationId,
    type: input.type,
    status: input.status,
    blind: input.blind,
    businessDate: fixtureBusinessDate,
    countedBy: input.countedBy ?? counterId,
    approvedBy: input.approvedBy ?? null,
    countedAt: input.countedAt ?? null,
    approvedAt: input.approvedAt ?? null,
    note: input.note ?? null,
  });
  const lines = input.itemIds.map((itemId) =>
    line(
      id,
      itemId,
      systemQtyAt(input.locationId, itemId),
      input.counted?.[itemId] ? qty(input.counted[itemId] as string) : null,
      avgCostAt(input.locationId, itemId),
    ),
  );
  return { count, lines };
}

const locationByType = (type: StockLocation["type"]) =>
  fixtures.locations.find((location) => location.type === type) ??
  fixtures.locations[0];

function seedDetails(): StockCountDetail[] {
  const cloned = structuredClone(fixtures.stockCountDetails);
  const gudang = locationByType("warehouse");
  const bar = locationByType("bar");
  const chiller = locationByType("chiller");
  const draftItems = activeItems.slice(0, 3).map((item) => item.id);
  const approvedItems = activeItems.slice(0, 2).map((item) => item.id);
  const now = nowIso();

  // Draft, a running blind cycle and an approved (not yet posted) full count
  // make every row of the list state machine reviewable; the shared fixtures
  // already provide a submitted count and a posted one.
  const extras: StockCountDetail[] = [
    seedDetail({
      locationId: gudang.id,
      type: "full",
      status: "draft",
      blind: false,
      note: "Opname bulanan gudang utama",
      itemIds: draftItems,
    }),
    seedDetail({
      locationId: bar.id,
      type: "cycle",
      status: "counting",
      blind: true,
      note: "Hitung ulang sirup bar",
      itemIds: activeItems.slice(2, 4).map((item) => item.id),
      counted: { [activeItems[2].id]: "1.5000" },
    }),
    seedDetail({
      locationId: chiller.id,
      type: "full",
      status: "approved",
      blind: false,
      countedAt: now,
      approvedBy: approverId,
      approvedAt: now,
      note: "Sudah disetujui, menunggu pembukuan",
      itemIds: approvedItems,
      counted: Object.fromEntries(
        approvedItems.map((itemId) => [
          itemId,
          formatDecimal4(
            parseDecimal4(systemQtyAt(chiller.id, itemId)) -
              parseDecimal4("0.2000"),
          ),
        ]),
      ),
    }),
    seedDetail({
      locationId: bar.id,
      type: "cycle",
      status: "cancelled",
      blind: false,
      note: "Dibatalkan: jadwal bentrok",
      itemIds: activeItems.slice(0, 1).map((item) => item.id),
    }),
  ];
  return [...extras, ...cloned];
}

type OpnameState = {
  counts: StockCountDetail[];
  wasteLogs: WasteLog[];
  ledger: StockLedgerEntry[];
  balances: StockBalance[];
};

function seedState(): OpnameState {
  const menuCost = fixtures.menuCosts[0];
  const menuItem = menuCost ? menuItemById.get(menuCost.menuItemId) : undefined;
  const gudang = locationByType("warehouse");
  const coffee = activeItems.find((item) =>
    item.name.toLocaleLowerCase("id-ID").includes("kopi"),
  );
  const seededWaste = structuredClone(fixtures.wasteLogs);
  const derivedWaste: WasteLog[] = [];
  if (menuItem) {
    derivedWaste.push(
      wasteLogSchema.parse({
        id: newId(),
        tenantId,
        outletId,
        locationId: gudang.id,
        targetType: "menu_item",
        targetId: menuItem.id,
        quantity: "2.0000",
        reason: "overproduction",
        mediaId: null,
        valueIdr: extendCostIdr(
          qty("2.0000"),
          menuCostOf(menuItem.id),
          "half_up",
        ),
        loggedBy: counterId,
        occurredAt: "2026-11-01T08:30:00.000Z",
        note: "Sisa hidangan display sore",
      }),
    );
  }
  if (coffee) {
    derivedWaste.push(
      wasteLogSchema.parse({
        id: newId(),
        tenantId,
        outletId,
        locationId: gudang.id,
        targetType: "inventory_item",
        targetId: coffee.id,
        quantity: "0.1000",
        reason: "dropped",
        mediaId: newId(),
        valueIdr: extendCostIdr(
          qty("0.1000"),
          avgCostAt(gudang.id, coffee.id),
          "half_up",
        ),
        loggedBy: counterId,
        occurredAt: "2026-11-01T07:10:00.000Z",
        note: "Kemasan jatuh saat bongkar muat",
      }),
    );
  }
  return {
    counts: seedDetails(),
    wasteLogs: [...derivedWaste, ...seededWaste],
    ledger: structuredClone(fixtures.ledger),
    balances: structuredClone(fixtures.balances),
  };
}

const store = createMockStore<OpnameState>(seedState);
/** Idempotency for writes: key → the document/transition the first call made. */
const documents = createMockStore(() => new Map<string, unknown>());

const state = () => store.get();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function invalid(field: string, message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, [{ field, message }]);
}

/** Creates a value once per idempotency key, like the API will. */
function once<T>(key: string, create: () => T): T {
  const seen = documents.get().get(key);
  if (seen !== undefined) return seen as T;
  const value = create();
  documents.get().set(key, value);
  return value;
}

function findDetail(stockCountId: string): StockCountDetail {
  const detail = state().counts.find((row) => row.count.id === stockCountId);
  return detail ?? notFound("Sesi opname");
}

function replaceDetail(next: StockCountDetail): StockCountDetail {
  store.set({
    ...state(),
    counts: state().counts.map((row) =>
      row.count.id === next.count.id ? next : row,
    ),
  });
  return next;
}

function requireLocation(locationId: string): StockLocation {
  const found = locationById.get(locationId);
  return found ?? notFound("Lokasi stok");
}

function requireItem(itemId: string): InventoryItem {
  const item = itemById.get(itemId);
  return item ?? notFound("Item bahan");
}

/** Values the variance of every counted line with the location's cost. */
function valuate(detail: StockCountDetail): StockCountDetail {
  const lines = detail.lines.map((line) =>
    stockCountLineSchema.parse({
      ...line,
      varianceIdr:
        line.countedQty === null
          ? null
          : stockCountVarianceIdr(
              {
                systemQty: line.systemQty,
                countedQty: line.countedQty,
                unitCostIdr: avgCostAt(
                  detail.count.locationId,
                  line.inventoryItemId,
                ),
              },
              "half_up",
            ),
    }),
  );
  return { ...detail, lines };
}

/** INV-01: a posted count appends one `adjustment` row per real variance. */
function postAdjustments(detail: StockCountDetail): void {
  const created = detail.lines
    .filter((line) => {
      if (line.countedQty === null) return false;
      return (
        parseDecimal4(line.systemQty) !== parseDecimal4(line.countedQty)
      );
    })
    .map((line) =>
      stockLedgerEntrySchema.parse({
        id: newId(),
        tenantId,
        outletId,
        locationId: detail.count.locationId,
        inventoryItemId: line.inventoryItemId,
        movementType: "adjustment",
        quantity: formatDecimal4(
          parseDecimal4(line.countedQty as Decimal4) -
            parseDecimal4(line.systemQty),
        ),
        unitCostIdr: avgCostAt(
          detail.count.locationId,
          line.inventoryItemId,
        ),
        batchId: null,
        sourceType: "stock_count",
        sourceId: detail.count.id,
        occurredAt: nowIso(),
      }),
    );
  const ledger = [...state().ledger, ...created];
  const balances = foldStockLedger(ledger, "half_up").map((balance) =>
    stockBalanceSchema.parse(balance),
  );
  store.set({ ...state(), ledger, balances });
}

// ---- Lookups -------------------------------------------------------------

registerMock(listInventoryItems, ({ query, scenario }) => {
  const rows = fixtures.items
    .filter(
      (row) => query.category === undefined || row.category === query.category,
    )
    .filter((row) => query.type === undefined || row.type === query.type)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(listStockLocations, ({ query, scenario }) => {
  const rows = fixtures.locations
    .filter((row) => row.outletId === query.outletId)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(listUoms, ({ query, scenario }) =>
  paginateFixture(
    [...fixtures.uoms].sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    query,
    (row) => row.id,
    scenario,
  ),
);

// ---- Stock counts --------------------------------------------------------

registerMock(listStockCounts, ({ query, scenario }) => {
  const rows = state()
    .counts.map((row) => row.count)
    .filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.locationId === undefined || row.locationId === query.locationId,
    )
    .filter((row) => query.status === undefined || row.status === query.status)
    .filter((row) => query.type === undefined || row.type === query.type)
    .sort((a, b) => {
      if (a.businessDate !== b.businessDate)
        return a.businessDate < b.businessDate ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getStockCount, ({ params, scenario }) => {
  // In the empty scenario the detail screen shows its not-found state.
  if (scenario === "empty") notFound("Sesi opname");
  return { data: findDetail(params.stockCountId) };
});

registerMock(createStockCount, ({ body }) => {
  const detail = once(`count:${body.idempotencyKey}`, () => {
    requireLocation(body.locationId);
    const itemIds =
      body.type === "full"
        ? activeItems.map((item) => item.id)
        : (body.inventoryItemIds ?? []);
    if (itemIds.length === 0)
      invalid("inventoryItemIds", "Pilih minimal satu item.");
    for (const itemId of itemIds) requireItem(itemId);
    const id = newId();
    const count = stockCountSchema.parse({
      id,
      tenantId,
      outletId,
      locationId: body.locationId,
      type: body.type,
      status: "draft",
      blind: body.blind,
      businessDate: body.businessDate,
      countedBy: counterId,
      approvedBy: null,
      countedAt: null,
      approvedAt: null,
      note: body.note ?? null,
    });
    const lines = itemIds.map((itemId) =>
      line(
        id,
        itemId,
        systemQtyAt(body.locationId, itemId),
        null,
        avgCostAt(body.locationId, itemId),
      ),
    );
    const created = { count, lines };
    store.set({ ...state(), counts: [created, ...state().counts] });
    return created;
  });
  return { data: detail };
});

registerMock(updateStockCountLine, ({ params, body }) => {
  const detail = findDetail(params.stockCountId);
  if (detail.count.status !== "counting")
    throw new ApiError(
      409,
      "CONFLICT",
      "Baris hanya dapat diisi saat hitungan berjalan.",
    );
  const current = detail.lines.find((row) => row.id === params.lineId);
  if (!current) notFound("Baris hitungan");
  const updated = stockCountLineSchema.parse({
    ...current,
    countedQty: body.countedQty,
    varianceIdr: null,
  });
  replaceDetail({
    ...detail,
    lines: detail.lines.map((row) => (row.id === updated.id ? updated : row)),
  });
  return { data: updated };
});

registerMock(postStockCountTransition, ({ params, body }) => {
  const result = once(
    `transition:${params.stockCountId}:${body.idempotencyKey}`,
    () => {
      const detail = findDetail(params.stockCountId);
      const nextStatus = transitionStockCount(detail.count.status, body.action);
      const now = nowIso();
      let next: StockCountDetail = {
        count: { ...detail.count, status: nextStatus },
        lines: detail.lines,
      };

      if (body.action === "submit") {
        if (detail.lines.some((row) => row.countedQty === null))
          invalid("action", "Isi jumlah fisik semua baris sebelum mengirim.");
        next = valuate(next);
        next.count = { ...next.count, countedAt: now };
      }
      if (body.action === "approve") {
        // INV-03: a different person approves. The mock's approver is the
        // outlet manager, never the barista who counted.
        assertStockCountApproval(detail.count, approverId);
        next = valuate(next);
        next.count = {
          ...next.count,
          approvedBy: approverId,
          approvedAt: now,
        };
      }
      if (body.action === "reject") {
        next.count = {
          ...next.count,
          approvedBy: null,
          approvedAt: null,
        };
      }
      if (body.action === "post") postAdjustments(detail);
      if (body.note !== undefined && body.note !== null)
        next.count = { ...next.count, note: body.note };
      return replaceDetail({
        count: stockCountSchema.parse(next.count),
        lines: next.lines,
      });
    },
  );
  return { data: result.count };
});

// ---- Waste ---------------------------------------------------------------

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
  const log = once(`waste:${body.idempotencyKey}`, () => {
    requireLocation(body.locationId);
    let unitCostIdr: Decimal4;
    if (body.targetType === "inventory_item") {
      requireItem(body.targetId);
      unitCostIdr = avgCostAt(body.locationId, body.targetId);
    } else {
      if (!menuItemById.has(body.targetId)) notFound("Menu");
      unitCostIdr = menuCostOf(body.targetId);
    }
    const created = wasteLogSchema.parse({
      id: newId(),
      tenantId,
      outletId,
      locationId: body.locationId,
      targetType: body.targetType,
      targetId: body.targetId,
      quantity: body.quantity,
      reason: body.reason,
      mediaId: body.mediaId ?? null,
      // The server values the loss; a client-supplied value is rejected by
      // the contract. quantity x moving-average cost (or recipe HPP).
      valueIdr: extendCostIdr(
        qty(body.quantity),
        unitCostIdr,
        "half_up",
      ),
      loggedBy: counterId,
      occurredAt: body.occurredAt ?? nowIso(),
      note: body.note ?? null,
    });
    store.set({
      ...state(),
      wasteLogs: [created, ...state().wasteLogs],
    });
    return created;
  });
  return { data: log };
});
