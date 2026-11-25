// In-memory "server" behind VITE_API_MOCK for the cashier ordering and captain
// flows (beads legend-59v, legend-76t): the catalog with modifiers, orders with
// held lines, a parked-draft list, the captain's tables and the waiter calls.
// It enforces the rules the real API will: the client never sets a price (every
// line is re-priced from the catalog, modifier deltas included), a sold-out
// item or a missing required modifier is refused, a repeated idempotency key
// answers with the first result instead of making a second order, and a bill
// request is accepted before it is resolved.
//
// State is plain JSON so it survives a reload (sessionStorage, see
// `getPosOrderEngine`). `?demo=<seed>` (./demo-seed.ts) seeds the mockup
// states; only this file and the runner below read it. Relative imports only:
// Node tests load it directly.
import { ApiError, NETWORK_ERROR_MESSAGE } from "../../lib/api/errors.ts";
import {
  SCENARIO_STORAGE_KEY,
  getLatencyMs,
  getScenario,
  isMockScenario,
  setScenario,
} from "../../lib/mock/control.ts";
import { cartTotals, validateModifiers } from "./cart-logic.ts";
import { orderDemoSeed, readDemoSeed } from "./demo-seed.ts";
import {
  CALL_NUMBER_PREFIX,
  FIRST_CALL_NUMBER,
  FIRST_ORDER_SEQUENCE,
  MAX_ORDER_LINES,
  cachedCatalog,
  demoA01Lines,
  demoCalls,
  demoTables,
  emptyCatalog,
  liveCatalog,
} from "./fixtures.ts";
import type {
  AddToTableRequest,
  CaptainTable,
  CartLine,
  Catalog,
  MenuItem,
  OrderLine,
  OrderingConnectivity,
  ParkDraftInput,
  ParkedDraft,
  PosOrderView,
  SaleChannel,
  SelectedModifier,
  ServiceCall,
  SubmitOrderRequest,
  TableOrderView,
} from "./types.ts";

export const ENGINE_STORAGE_KEY = "legend-pos-order-engine";

const MAX_NOTE_LENGTH = 200;
const MAX_QUANTITY = 99;

interface EngineOrder {
  orderId: string;
  number: string;
  channel: SaleChannel;
  /** Set for orders opened from a captain table. */
  tableId: string | null;
  tableLabel: string | null;
  callNumber: string | null;
  lines: OrderLine[];
}

export interface EngineState {
  seed: string | null;
  orders: EngineOrder[];
  parked: ParkedDraft[];
  tables: CaptainTable[];
  calls: ServiceCall[];
  /** Idempotency key to the order it made. */
  idempotency: Record<string, string>;
  counters: {
    order: number;
    line: number;
    draft: number;
    session: number;
    callNumber: number;
  };
}

const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type EngineOptions = {
  clock?: () => number;
  /** The raw `?demo=` value; the browser engine reads the page URL. */
  readSeed?: () => string | null;
};

export function createPosOrderEngine(options: EngineOptions = {}) {
  const clock = options.clock ?? Date.now;
  const readSeed = options.readSeed ?? (() => null);
  let state: EngineState | null = null;

  const nowIso = () => new Date(clock()).toISOString();
  const currentSeed = () => orderDemoSeed(readSeed());

  // ---- Seeding ------------------------------------------------------------

  function seedState(): EngineState {
    const seed = currentSeed();
    const base: EngineState = {
      seed,
      orders: [],
      parked: [],
      tables: [],
      calls: [],
      idempotency: {},
      counters: {
        order: FIRST_ORDER_SEQUENCE - 1,
        line: 0,
        draft: 0,
        session: 0,
        callNumber: FIRST_CALL_NUMBER,
      },
    };
    if (seed === "kosong") return base;
    base.tables = demoTables();
    base.calls = demoCalls();
    base.orders = [
      {
        orderId: "order-a01",
        number: "POS-0051",
        channel: "dine_in",
        tableId: "table-a01",
        tableLabel: "A01",
        callNumber: null,
        lines: demoA01Lines(),
      },
    ];
    return base;
  }

  function ensure(): EngineState {
    if (!state) state = seedState();
    return state;
  }

  // ---- Helpers ------------------------------------------------------------

  function catalog(): Catalog {
    const seed = ensure().seed;
    if (seed === "kosong") return emptyCatalog(nowIso());
    if (seed === "offline") return cachedCatalog();
    return liveCatalog(nowIso());
  }

  function nextLineId(): string {
    const s = ensure();
    s.counters.line += 1;
    return `line-${pad(s.counters.line, 4)}`;
  }

  function findOrder(orderId: string): EngineOrder {
    const order = ensure().orders.find((entry) => entry.orderId === orderId);
    if (!order)
      throw new ApiError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    return order;
  }

  function findTable(tableId: string): CaptainTable {
    const found = ensure().tables.find((entry) => entry.id === tableId);
    if (!found) throw new ApiError(404, "NOT_FOUND", "Meja tidak ditemukan.");
    return found;
  }

  function tableOrderOf(tableId: string): EngineOrder | null {
    return ensure().orders.find((entry) => entry.tableId === tableId) ?? null;
  }

  function orderView(order: EngineOrder): PosOrderView {
    return {
      orderId: order.orderId,
      number: order.number,
      channel: order.channel,
      tableLabel: order.tableLabel,
      callNumber: order.callNumber,
      lines: order.lines,
      subtotalIdr: cartTotals(
        order.lines.map((line) => ({ ...line, hold: false })),
      ).subtotalIdr,
    };
  }

  function tableView(tableId: string): TableOrderView {
    const order = tableOrderOf(tableId);
    return {
      table: findTable(tableId),
      order: order ? orderView(order) : null,
    };
  }

  /**
   * The client never sets a price. Each line is rebuilt from the catalog item:
   * name, base price, course and every chosen option's name and price delta.
   * A sold-out item, an unknown or repeated option or a missing required group
   * is refused. Parking a draft ("park") only checks the shape: a sold-out item
   * or a missing required group can still be kept aside, the order itself will
   * refuse it later.
   */
  function normalizeLines(
    lines: readonly CartLine[],
    mode: "order" | "park" = "order",
  ): CartLine[] {
    if (lines.length === 0)
      throw new ApiError(422, "EMPTY_ORDER", "Pilih menu sebelum melanjutkan.");
    if (lines.length > MAX_ORDER_LINES)
      throw new ApiError(
        422,
        "TOO_MANY_LINES",
        "Terlalu banyak baris pesanan.",
      );
    const items = new Map(catalog().items.map((entry) => [entry.id, entry]));
    return lines.map((line) => {
      const item: MenuItem | undefined = items.get(line.menuItemId);
      if (!item)
        throw new ApiError(
          404,
          "ITEM_UNAVAILABLE",
          "Menu tidak tersedia. Muat ulang katalog.",
        );
      if (mode === "order" && item.soldOut)
        throw new ApiError(409, "ITEM_SOLD_OUT", `${item.name} sedang habis.`);
      if (
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > MAX_QUANTITY
      )
        throw new ApiError(
          422,
          "INVALID_QUANTITY",
          "Jumlah harus 1 sampai 99.",
        );
      const modifiers: SelectedModifier[] = line.modifiers.map((picked) => {
        const group = item.modifierGroups.find(
          (entry) => entry.id === picked.groupId,
        );
        const option = group?.options.find(
          (entry) => entry.id === picked.optionId,
        );
        if (!group || !option)
          throw new ApiError(422, "INVALID_MODIFIER", "Pilihan tidak dikenal.");
        return {
          groupId: group.id,
          optionId: option.id,
          name: option.name,
          priceDeltaIdr: option.priceDeltaIdr,
        };
      });
      const repeated = modifiers.some(
        (picked, index) =>
          modifiers.findIndex(
            (entry) =>
              entry.groupId === picked.groupId &&
              entry.optionId === picked.optionId,
          ) !== index,
      );
      if (repeated)
        throw new ApiError(
          422,
          "INVALID_MODIFIER",
          "Pilihan tidak boleh dipilih dua kali.",
        );
      const check = validateModifiers(item, modifiers);
      if (mode === "order" && !check.ok) {
        const group = item.modifierGroups.find(
          (entry) => entry.id === check.missingGroupIds[0],
        );
        throw new ApiError(
          422,
          "MODIFIER_REQUIRED",
          `Pilih ${(group?.name ?? "opsi").toLowerCase()} sebelum menambahkan.`,
        );
      }
      const variant =
        item.variants.find((entry) => entry.id === line.variantId) ?? null;
      if (item.variants.length > 0 && !variant)
        throw new ApiError(
          422,
          "VARIANT_REQUIRED",
          `Pilih varian ${item.name} sebelum menambahkan.`,
        );
      return {
        lineId: line.lineId,
        menuItemId: item.id,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        name: item.name,
        unitPriceIdr: variant?.priceIdr ?? item.priceIdr,
        quantity: line.quantity,
        modifiers,
        note: line.note.trim().slice(0, MAX_NOTE_LENGTH),
        course: item.course,
        hold: line.hold,
      };
    });
  }

  function toOrderLines(lines: readonly CartLine[]): OrderLine[] {
    return lines.map((line) => ({
      lineId: nextLineId(),
      menuItemId: line.menuItemId,
      name: line.variantName
        ? `${line.name} (${line.variantName})`
        : line.name,
      unitPriceIdr: line.unitPriceIdr,
      quantity: line.quantity,
      modifiers: line.modifiers,
      note: line.note,
      course: line.course,
      status: line.hold ? ("held" as const) : ("sent" as const),
    }));
  }

  function fire(order: EngineOrder, lineIds: readonly string[]) {
    if (lineIds.length === 0)
      throw new ApiError(422, "NO_LINES", "Pilih item yang akan dikirim.");
    const targets = lineIds.map((id) => {
      const line = order.lines.find((entry) => entry.lineId === id);
      if (!line) throw new ApiError(404, "NOT_FOUND", "Item tidak ditemukan.");
      return line;
    });
    // A line that is already sent stays sent: firing twice is harmless.
    for (const line of targets) line.status = "sent";
  }

  function refreshOpenCall(tableId: string) {
    const s = ensure();
    const tableRow = s.tables.find((entry) => entry.id === tableId);
    if (tableRow)
      tableRow.hasOpenCall = s.calls.some(
        (call) => call.tableId === tableId && call.status !== "resolved",
      );
  }

  // ---- Reads --------------------------------------------------------------

  const api = {
    /** "kosong" | "offline" | "gagal" | "memuat" | null. */
    seed: () => ensure().seed,

    catalog,

    connectivity(): OrderingConnectivity {
      const offline = ensure().seed === "offline";
      return {
        mode: offline ? "edge_only" : "online",
        catalogUpdatedAt: offline ? catalog().updatedAt : null,
      };
    },

    /** The call number the next takeaway order gets, "A-12". Not consumed. */
    nextCallNumber: () =>
      `${CALL_NUMBER_PREFIX}${ensure().counters.callNumber}`,

    parkedDrafts: () => ensure().parked,

    captainTables: () => ensure().tables,

    tableOrder: (tableId: string) => tableView(tableId),

    /** Newest first. */
    serviceCalls: () =>
      [...ensure().calls].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),

    // ---- Cashier orders ---------------------------------------------------

    submitOrder(input: SubmitOrderRequest): PosOrderView {
      const s = ensure();
      const known = s.idempotency[input.idempotencyKey];
      if (known) return orderView(findOrder(known));
      const seated = input.tableSessionId
        ? s.tables.find((entry) => entry.sessionId === input.tableSessionId)
        : undefined;
      const tableLabel = seated?.label ?? null;
      if (input.channel === "dine_in" && !tableLabel)
        throw new ApiError(422, "TABLE_REQUIRED", "Pilih meja untuk dine-in.");
      const externalRef = input.ojol?.externalRef.trim() ?? "";
      if (
        input.channel === "ojol_manual" &&
        (!input.ojol || externalRef === "" || externalRef.length > 100)
      )
        throw new ApiError(
          422,
          "OJOL_REFERENCE_REQUIRED",
          "Isi nomor pesanan platform.",
        );
      const lines = toOrderLines(normalizeLines(input.lines));
      s.counters.order += 1;
      let callNumber: string | null = null;
      if (input.channel === "takeaway") {
        callNumber = api.nextCallNumber();
        s.counters.callNumber += 1;
      }
      const order: EngineOrder = {
        orderId: `order-${pad(s.counters.order, 4)}`,
        number: `POS-${pad(s.counters.order, 4)}`,
        channel: input.channel,
        tableId: null,
        tableLabel: input.channel === "dine_in" ? tableLabel : null,
        callNumber,
        lines,
      };
      s.orders.push(order);
      s.idempotency[input.idempotencyKey] = order.orderId;
      return orderView(order);
    },

    fireLines(orderId: string, lineIds: string[]): PosOrderView {
      const order = findOrder(orderId);
      fire(order, lineIds);
      return orderView(order);
    },

    parkDraft(input: ParkDraftInput): ParkedDraft {
      const s = ensure();
      const lines = normalizeLines(input.lines, "park");
      s.counters.draft += 1;
      const channelName: Record<SaleChannel, string> = {
        dine_in: "Dine-in",
        takeaway: "Takeaway",
        ojol_manual: "Online / ojol",
      };
      const draft: ParkedDraft = {
        id: `draft-${pad(s.counters.draft, 4)}`,
        label: `${channelName[input.channel]} · Draf ${s.counters.draft}`,
        channel: input.channel,
        tableSessionId: input.tableSessionId,
        ojol: input.ojol,
        lines,
        parkedAt: nowIso(),
        subtotalIdr: cartTotals(lines).subtotalIdr,
      };
      s.parked.push(draft);
      return draft;
    },

    /** Gives the draft back and removes it from the list. */
    resumeDraft(id: string): ParkedDraft {
      const s = ensure();
      const index = s.parked.findIndex((entry) => entry.id === id);
      if (index < 0)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Pesanan ditahan tidak ditemukan.",
        );
      return s.parked.splice(index, 1)[0] as ParkedDraft;
    },

    // ---- Captain ----------------------------------------------------------

    /** Adds to the table's running order, or opens one for an empty table. */
    addToTable(input: AddToTableRequest): TableOrderView {
      const s = ensure();
      const tableRow = findTable(input.tableId);
      if (s.idempotency[input.idempotencyKey]) return tableView(input.tableId);
      const lines = toOrderLines(normalizeLines(input.lines));
      let order = tableOrderOf(tableRow.id);
      // Validate before anything is created: a refused call leaves no order.
      if ((order?.lines.length ?? 0) + lines.length > MAX_ORDER_LINES)
        throw new ApiError(
          422,
          "TOO_MANY_LINES",
          "Terlalu banyak baris pesanan.",
        );
      if (!order) {
        s.counters.order += 1;
        order = {
          orderId: `order-${pad(s.counters.order, 4)}`,
          number: `POS-${pad(s.counters.order, 4)}`,
          channel: "dine_in",
          tableId: tableRow.id,
          tableLabel: tableRow.label,
          callNumber: null,
          lines: [],
        };
        s.orders.push(order);
      }
      order.lines.push(...lines);
      if (tableRow.status === "empty") {
        s.counters.session += 1;
        tableRow.status = "occupied";
        tableRow.guestCount = Math.max(1, tableRow.guestCount);
        tableRow.sessionId = `session-${pad(s.counters.session, 4)}`;
      }
      s.idempotency[input.idempotencyKey] = order.orderId;
      return tableView(tableRow.id);
    },

    fireTableLines(tableId: string, lineIds: string[]): TableOrderView {
      findTable(tableId);
      const order = tableOrderOf(tableId);
      if (!order)
        throw new ApiError(404, "NOT_FOUND", "Meja ini belum punya pesanan.");
      fire(order, lineIds);
      return tableView(tableId);
    },

    // ---- Waiter calls -----------------------------------------------------

    acknowledgeCall(id: string): ServiceCall {
      const call = ensure().calls.find((entry) => entry.id === id);
      if (!call)
        throw new ApiError(404, "NOT_FOUND", "Panggilan tidak ditemukan.");
      if (call.status === "resolved")
        throw new ApiError(
          409,
          "CALL_ALREADY_RESOLVED",
          "Panggilan ini sudah selesai.",
        );
      call.status = "acknowledged";
      return call;
    },

    /** A bill request is accepted before it is resolved; other calls may close at once. */
    resolveCall(id: string): ServiceCall {
      const call = ensure().calls.find((entry) => entry.id === id);
      if (!call)
        throw new ApiError(404, "NOT_FOUND", "Panggilan tidak ditemukan.");
      if (call.type === "request_bill" && call.status === "new")
        throw new ApiError(
          409,
          "CALL_NOT_ACKNOWLEDGED",
          "Terima permintaan tagihan dulu.",
        );
      call.status = "resolved";
      refreshOpenCall(call.tableId);
      return call;
    },

    // ---- State ------------------------------------------------------------

    snapshot: (): EngineState => clone(ensure()),
    restore(snapshot: EngineState) {
      // A snapshot made under another `?demo=` seed is stale: reseed instead.
      if (snapshot.seed !== currentSeed()) return;
      state = clone(snapshot);
    },
    reset() {
      state = null;
    },
  };
  return api;
}

export type PosOrderEngine = ReturnType<typeof createPosOrderEngine>;

// ---- Browser singleton -----------------------------------------------------

let singleton: PosOrderEngine | null = null;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The engine for this page load, hydrated from sessionStorage once. */
export function getPosOrderEngine(): PosOrderEngine {
  if (singleton) return singleton;
  singleton = createPosOrderEngine({ readSeed: readDemoSeed });
  const storage = browserStorage();
  if (!storage) return singleton;
  try {
    const raw = storage.getItem(ENGINE_STORAGE_KEY);
    if (raw) singleton.restore(JSON.parse(raw) as EngineState);
  } catch {
    // A stale or tampered snapshot must never break the mock: start clean.
    try {
      storage.removeItem(ENGINE_STORAGE_KEY);
    } catch {
      // Storage blocked: nothing to clean.
    }
  }
  return singleton;
}

function persistEngine() {
  const storage = browserStorage();
  if (!storage || !singleton) return;
  try {
    storage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(singleton.snapshot()));
  } catch {
    // Quota or private mode: the mock keeps working without reload memory.
  }
}

/** Runs one engine call and snapshots the state after it (browser only). */
export function callPosOrderEngine<T>(call: (engine: PosOrderEngine) => T): T {
  const result = call(getPosOrderEngine());
  persistEngine();
  return clone(result);
}

let scenarioAdopted = false;

/**
 * `?mock=` and the remembered scenario are normally read when the first typed
 * mock call runs (lib/mock/transport.ts). The local contracts here can run
 * first, so read them once ourselves; setScenario is idempotent with the
 * transport's own read.
 */
function adoptScenarioFromBrowser() {
  if (scenarioAdopted || typeof window === "undefined") return;
  scenarioAdopted = true;
  try {
    const raw =
      new URLSearchParams(window.location.search).get("mock") ??
      window.localStorage.getItem(SCENARIO_STORAGE_KEY);
    if (isMockScenario(raw)) setScenario(raw);
  } catch {
    // Storage blocked or no location: keep the current scenario.
  }
}

/**
 * Runs one engine call like a request: the active scenario (offline, error)
 * and the mock latency first. `kind: "query"` also honours the `?demo=gagal`
 * (the read fails) and `?demo=memuat` (the read never finishes) seeds.
 */
export async function runPosOrderMock<T>(
  call: (engine: PosOrderEngine) => T,
  kind: "query" | "mutation" = "mutation",
): Promise<T> {
  adoptScenarioFromBrowser();
  const scenario = getScenario();
  const latency = getLatencyMs();
  if (latency > 0) await new Promise((done) => setTimeout(done, latency));
  if (scenario === "offline")
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  if (scenario === "error")
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "Terjadi kesalahan pada server. Coba lagi sebentar lagi.",
    );
  if (kind === "query") {
    const seed = getPosOrderEngine().seed();
    if (seed === "memuat") return new Promise<T>(() => {});
    if (seed === "gagal")
      throw new ApiError(
        500,
        "INTERNAL_ERROR",
        "Terjadi kesalahan pada server. Coba lagi sebentar lagi.",
      );
  }
  return callPosOrderEngine(call);
}
