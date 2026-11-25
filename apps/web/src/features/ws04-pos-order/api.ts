// One function per ordering call; components never call these (they use the
// hooks in ./hooks.ts). The cashier calls (catalog, call number, create +
// submit, park, resume, floor tables) use the shared endpoints; the mock engine
// answers in mock mode. The captain and waiter-call functions below have no
// usable endpoint yet (see ./CONTRACT-GAPS.md): they run on the mock engine in
// mock mode and fail with CONTRACT_PENDING everywhere else.
import {
  createPosOrder,
  createPosParkedOrder,
  firePosOrderItems,
  getNextPosCallNumber,
  getPosCatalog,
  getPosOrder,
  listPosOrders,
  listPosParkedOrders,
  resumePosParkedOrder,
  submitPosOrder,
} from "@starter/shared/pos";
import {
  acknowledgeServiceRequest,
  getFloorBoard,
  listServiceRequests,
  openStaffSession,
  resolveServiceRequest,
} from "@starter/shared/qr-order";
import { listReservations } from "@starter/shared/reservation";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { demoMenuPhoto } from "@/lib/demo-media";
import { DEMO_PHOTO_NAMES } from "./fixtures";
import {
  closeFireIntent,
  closeOpenIntent,
  fireItems,
  openTableSession,
  pendingFireItems,
  pendingFireOrderIds,
  placeCaptainOrder,
  readPendingOpenPax,
} from "./captain-flow";
import {
  assertSeated,
  captainMeta,
  mapServiceRequest,
  mapTableOrders,
  type ReservationHold,
  holdFor,
} from "./captain-wire";
import {
  closeOrderIntent,
  closeParkIntent,
  closeResumeIntent,
  pendingParkText as readParkText,
  placeOrder,
  parkCart,
  pendingResumeIds,
  pendingOrderText as readPendingText,
  resumeParkedInto,
  type CreateBody,
  type ParkBody,
  type SubmitBody,
} from "./order-flow";
import {
  draftFromPark,
  mapCatalog,
  mapFloor,
  mapOrder,
  mapParked,
} from "./order-wire";
import { hasForeignIntent } from "./intent-store";
import { runPosOrderMock, type PosOrderEngine } from "./mock-engine";
import {
  CONTRACT_PENDING,
  type CaptainSendInput,
  type CaptainTable,
  type Catalog,
  type FireLinesInput,
  type FireTableLinesInput,
  type OrderMeta,
  type ParkDraftInput,
  type ParkedDraft,
  type PosOrderView,
  type ServiceCall,
  type SubmitOrderInput,
  type TableOrdersView,
} from "./types";

/** The error a call without a contract gives outside mock mode. */
export function contractPending(feature: string): ApiError {
  return new ApiError(
    501,
    CONTRACT_PENDING,
    `Fitur ini belum tersambung ke server (${feature}).`,
  );
}

/** Local contract: the mock engine in mock mode, CONTRACT_PENDING otherwise. */
function local<T>(
  feature: string,
  call: (engine: PosOrderEngine) => T,
  kind: "query" | "mutation" = "mutation",
): Promise<T> {
  if (!API_MOCK) return Promise.reject(contractPending(feature));
  return runPosOrderMock(call, kind);
}

// ---- Cashier ---------------------------------------------------------------

const mockKeys = new Map<string, string>();

/** Mock mode only: the same input keeps its key until the call succeeds. */
function mockKeyFor(slot: string, input: unknown): string {
  const fingerprint = JSON.stringify(input);
  const known = mockKeys.get(slot);
  if (known?.startsWith(`${fingerprint}|`))
    return known.slice(fingerprint.length + 1);
  const key = `${slot}:${globalThis.crypto.randomUUID()}`;
  mockKeys.set(slot, `${fingerprint}|${key}`);
  return key;
}

function withPhotos(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.map((item) => ({
      ...item,
      imageUrl: item.imageUrl ?? demoMenuPhoto(DEMO_PHOTO_NAMES[item.id] ?? ""),
    })),
  };
}

/** Cashier catalog with variants, modifiers, courses and the sold-out flag. */
export async function fetchCatalog(outletId: string): Promise<Catalog> {
  if (API_MOCK)
    return withPhotos(
      await local("katalog kasir", (e) => e.catalog(), "query"),
    );
  const { data } = await callEndpoint(getPosCatalog, {
    params: { outletId },
    query: { channel: "pos", serviceType: "dine_in" },
  });
  return mapCatalog(data);
}

/** The call number the next takeaway order will probably get (a hint only). */
export async function fetchNextCallNumber(outletId: string): Promise<string> {
  if (API_MOCK)
    return local("nomor panggilan", (e) => e.nextCallNumber(), "query");
  const { data } = await callEndpoint(getNextPosCallNumber, {
    params: { outletId },
  });
  return data.code;
}

function flowDeps(outletId: string, actorId: string, draftKey: string) {
  return {
    storage: window.sessionStorage,
    makeKey: () => globalThis.crypto.randomUUID(),
    scope: { outletId, actorId, subject: draftKey },
    create: async (body: CreateBody) => {
      const { data } = await callEndpoint(createPosOrder, {
        params: { outletId },
        body: body as never,
      });
      return data;
    },
    submit: async (orderId: string, body: SubmitBody) => {
      const { data } = await callEndpoint(submitPosOrder, {
        params: { outletId, orderId: orderId as never },
        body,
      });
      return data;
    },
    park: async (body: ParkBody) => {
      const { data } = await callEndpoint(createPosParkedOrder, {
        params: { outletId },
        body: body as never,
      });
      return data;
    },
    resume: async (parkedId: string, body: { idempotencyKey: string }) => {
      const { data } = await callEndpoint(resumePosParkedOrder, {
        params: { outletId, parkedOrderId: parkedId as never },
        body,
      });
      return data;
    },
  };
}

/**
 * Create then submit the order. The body carries ids and quantities only; the
 * server prices it. `draftKey` scopes the persisted intent to the cart; `meta`
 * is kept with the intent so an unclear send can be brought back as it was.
 */
export async function submitOrder(
  outletId: string,
  actorId: string,
  draftKey: string,
  input: SubmitOrderInput,
  meta?: OrderMeta,
): Promise<PosOrderView> {
  if (API_MOCK)
    return local("buat pesanan", (e) =>
      e.submitOrder({
        ...input,
        idempotencyKey: mockKeyFor(`order:${draftKey}`, [outletId, input]),
      }),
    );
  return mapOrder(
    await placeOrder(flowDeps(outletId, actorId, draftKey), input, meta),
  );
}

/** The unresolved send of this cart as stored text (null: none, or mock). */
export function pendingOrderText(
  outletId: string,
  actorId: string,
  draftKey: string,
): string | null {
  if (API_MOCK || typeof window === "undefined") return null;
  return readPendingText(window.sessionStorage, {
    outletId,
    actorId,
    subject: draftKey,
  });
}

/** The unresolved park of this cart as stored text (null: none, or mock). */
export function pendingParkText(
  outletId: string,
  actorId: string,
  draftKey: string,
): string | null {
  if (API_MOCK || typeof window === "undefined") return null;
  return readParkText(window.sessionStorage, {
    outletId,
    actorId,
    subject: draftKey,
  });
}

/** The cashier checked the parked list: close an unclear park. */
export function closePendingPark(
  outletId: string,
  actorId: string,
  draftKey: string,
): void {
  closeParkIntent(window.sessionStorage, {
    outletId,
    actorId,
    subject: draftKey,
  });
}

/** The cashier checked: close an unclear resume of this parked cart. */
export function closePendingResume(
  outletId: string,
  actorId: string,
  parkedId: string,
): void {
  closeResumeIntent(
    window.sessionStorage,
    { outletId, actorId, subject: "" },
    parkedId,
  );
}

/** Another cashier of this outlet has a send whose answer is not known. */
export function otherCashierPending(
  outletId: string,
  actorId: string,
): boolean {
  if (API_MOCK || typeof window === "undefined" || outletId === "")
    return false;
  return hasForeignIntent(window.sessionStorage, { outletId, actorId });
}

/** The cashier checked the open orders: close a refused (reused) key. */
export function closePendingOrder(
  outletId: string,
  actorId: string,
  draftKey: string,
): void {
  closeOrderIntent(window.sessionStorage, {
    outletId,
    actorId,
    subject: draftKey,
  });
}

/** DEMO-CONTRACT: fire by line id (firePosOrderItems needs server item ids). */
export function fireLines(
  _outletId: string,
  input: FireLinesInput,
): Promise<PosOrderView> {
  return local("kirim item ditahan", (e) =>
    e.fireLines(input.orderId, input.lineIds),
  );
}

export async function fetchParkedDrafts(
  outletId: string,
): Promise<ParkedDraft[]> {
  if (API_MOCK)
    return local("pesanan ditahan", (e) => e.parkedDrafts(), "query");
  const [{ data }, catalog] = await Promise.all([
    callEndpoint(listPosParkedOrders, { params: { outletId }, query: {} }),
    fetchCatalog(outletId),
  ]);
  return data.map(
    (parked) =>
      mapParked(parked, catalog, () => `line-${globalThis.crypto.randomUUID()}`)
        .draft,
  );
}

export async function parkDraft(
  outletId: string,
  actorId: string,
  draftKey: string,
  input: ParkDraftInput,
  meta?: OrderMeta,
): Promise<ParkedDraft> {
  if (API_MOCK) return local("tahan pesanan", (e) => e.parkDraft(input));
  // The catalog is not needed: the draft shown is the cart that was parked.
  const parked = await parkCart(
    flowDeps(outletId, actorId, draftKey),
    input,
    meta,
  );
  return draftFromPark(parked, input);
}

/** Parked carts whose resume was sent but never answered. */
export function pendingResumes(outletId: string, actorId: string): string[] {
  if (API_MOCK) return [];
  return pendingResumeIds(window.sessionStorage, {
    outletId,
    actorId,
    subject: "kasir",
  });
}

/**
 * Consumes the parked snapshot and gives it back as cart lines through
 * `onApplied`, which runs BEFORE the key is forgotten (so a refresh or a lost
 * reply cannot lose the cart). A line whose item or option left the catalog is
 * not restored; `missing` says how many. Null: it was already applied.
 */
export async function resumeDraft(
  outletId: string,
  actorId: string,
  id: string,
  onApplied: (draft: ParkedDraft) => void,
): Promise<(ParkedDraft & { missing: number }) | null> {
  if (API_MOCK)
    return local("lanjutkan pesanan ditahan", (e) => {
      const draft = e.resumeDraft(id);
      onApplied(draft);
      return { ...draft, missing: 0 };
    });
  const result: { applied: (ParkedDraft & { missing: number }) | null } = {
    applied: null,
  };
  await resumeParkedInto(
    flowDeps(outletId, actorId, "kasir"),
    id,
    () => fetchCatalog(outletId),
    (parked, catalog) => {
      const mapped = mapParked(parked, catalog, newLineId);
      onApplied(mapped.draft);
      result.applied = { ...mapped.draft, missing: mapped.missing };
    },
  );
  return result.applied;
}

const newLineId = () => `line-${globalThis.crypto.randomUUID()}`;

// ---- Captain ---------------------------------------------------------------

/** The floor board as table choices (the cashier picks a seated table). */
export async function fetchCaptainTables(
  outletId: string,
): Promise<CaptainTable[]> {
  if (API_MOCK)
    return local("daftar meja captain", (e) => e.captainTables(), "query");
  const { data } = await callEndpoint(getFloorBoard, {
    params: { outletId },
    query: {},
  });
  return mapFloor(data);
}

/**
 * The orders of the table's session, one per send (never merged). A table
 * without a session has none: no session, no order.
 */
export async function fetchTableOrder(
  outletId: string,
  tableId: string,
): Promise<TableOrdersView> {
  if (API_MOCK)
    return local(
      "pesanan meja",
      (e) => {
        const view = e.tableOrder(tableId);
        return { table: view.table, orders: view.order ? [view.order] : [] };
      },
      "query",
    );
  const table = (await fetchCaptainTables(outletId)).find(
    (entry) => entry.id === tableId,
  );
  if (!table) throw new ApiError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  if (table.sessionId === null) return { table, orders: [] };
  const { data: summaries } = await callEndpoint(listPosOrders, {
    params: { outletId },
    query: {
      status: "awaiting_payment,sent",
      tableSessionId: table.sessionId as never,
      limit: 100,
    } as never,
  });
  const details = await Promise.all(
    summaries.map(async (summary) => {
      const { data } = await callEndpoint(getPosOrder, {
        params: { outletId, orderId: summary.id },
      });
      return data;
    }),
  );
  return mapTableOrders(table, details);
}

/**
 * Seat a walk-in party at an empty table (keyed, so a lost reply gives the
 * same session). A replay that answers a closed session is refused.
 */
export async function openTable(
  outletId: string,
  actorId: string,
  tableId: string,
  pax: number,
): Promise<void> {
  if (API_MOCK) {
    await local("dudukkan tamu", (e) => e.openTable(tableId, pax));
    return;
  }
  await openTableSession(
    {
      storage: window.sessionStorage,
      makeKey: () => globalThis.crypto.randomUUID(),
      scope: { outletId, actorId },
      open: async (body) => {
        const { data } = await callEndpoint(openStaffSession, {
          params: { outletId, tableId: tableId as never },
          body,
        });
        return data;
      },
    },
    tableId,
    pax,
  );
}

/** The guest count of an unclear seat of this table (null: none). */
export function pendingOpenPax(
  outletId: string,
  actorId: string,
  tableId: string,
): number | null {
  if (API_MOCK || typeof window === "undefined") return null;
  return readPendingOpenPax(
    window.sessionStorage,
    { outletId, actorId },
    tableId,
  );
}

/** The captain checked the table: close an unclear or refused seat. */
export function closePendingOpen(
  outletId: string,
  actorId: string,
  tableId: string,
): void {
  closeOpenIntent(window.sessionStorage, { outletId, actorId }, tableId);
}

/**
 * A reservation that holds this table and has not seated yet (the hold does
 * not change the table status, so the captain is warned before seating).
 */
export async function fetchReservationHold(
  outletId: string,
  tableId: string,
  date: string,
): Promise<ReservationHold | null> {
  if (API_MOCK) return null;
  const { data } = await callEndpoint(listReservations, {
    params: { outletId },
    query: { date, limit: 100 } as never,
  });
  return holdFor(data, tableId, Date.now());
}

/**
 * Send the cart as a NEW order on the table's session (`captain` channel,
 * create then submit, keyed). Never a merge into an earlier order.
 */
export async function addToTable(
  outletId: string,
  actorId: string,
  draftKey: string,
  input: CaptainSendInput,
): Promise<PosOrderView> {
  if (API_MOCK) {
    const view = await local("tambah ke meja", (e) =>
      e.addToTable({
        tableId: input.tableId,
        lines: input.lines,
        idempotencyKey: mockKeyFor(`captain:${draftKey}`, [
          outletId,
          input.tableId,
          input.lines,
        ]),
      }),
    );
    if (!view.order) throw contractPending("tambah ke meja");
    return view.order;
  }
  return mapOrder(
    await placeCaptainOrder(
      flowDeps(outletId, actorId, draftKey),
      input.tableSessionId ?? "",
      input.lines,
      captainMeta({ label: input.tableLabel, sessionId: input.tableSessionId }),
    ),
  );
}

/**
 * Fire held items by the server's item ids. The ids are grouped by the order
 * that owns them (read fresh, so a stale screen cannot fire another item); an
 * item the server does not hold is refused. Orders are fired one by one and it
 * stops at the first one that fails.
 */
export async function fireTableLines(
  outletId: string,
  actorId: string,
  input: FireTableLinesInput,
): Promise<void> {
  if (API_MOCK) {
    await local("kirim item meja", (e) =>
      e.fireTableLines(input.tableId, input.lineIds),
    );
    return;
  }
  const view = await fetchTableOrder(outletId, input.tableId);
  assertSeated(view.table);
  const wanted = new Set(input.lineIds);
  const groups = view.orders
    .map((order) => ({
      order,
      ids: order.lines
        .filter((line) => wanted.has(line.lineId) && line.status === "held")
        .map((line) => line.lineId),
    }))
    .filter((group) => group.ids.length > 0);
  if (groups.reduce((sum, group) => sum + group.ids.length, 0) !== wanted.size)
    throw new ApiError(
      409,
      "ITEM_NOT_HELD",
      "Sebagian item sudah dikirim atau tidak ada. Muat ulang pesanan meja.",
    );
  for (const { order, ids } of groups) {
    await fireItems(
      {
        storage: window.sessionStorage,
        makeKey: () => globalThis.crypto.randomUUID(),
        scope: { outletId, actorId },
        fire: async (orderId, body) => {
          const { data } = await callEndpoint(firePosOrderItems, {
            params: { outletId, orderId: orderId as never },
            body: body as never,
          });
          return data;
        },
      },
      order.orderId,
      ids,
      order.status ?? "sent",
    );
  }
}

/** Orders with a fire whose answer is not known, and the items they hold. */
export function pendingFires(
  outletId: string,
  actorId: string,
): { orderId: string; itemIds: string[] }[] {
  if (API_MOCK || typeof window === "undefined") return [];
  const who = { outletId, actorId };
  return pendingFireOrderIds(window.sessionStorage, who).flatMap((orderId) => {
    const itemIds = pendingFireItems(window.sessionStorage, who, orderId);
    return itemIds ? [{ orderId, itemIds }] : [];
  });
}

/** The captain checked the order: close an unclear or refused fire. */
export function closePendingFire(
  outletId: string,
  actorId: string,
  orderId: string,
): void {
  closeFireIntent(window.sessionStorage, { outletId, actorId }, orderId);
}

// ---- Waiter calls ----------------------------------------------------------

/** Open waiter calls of the outlet: new ones and accepted ones. */
export async function fetchServiceCalls(
  outletId: string,
): Promise<ServiceCall[]> {
  if (API_MOCK)
    return local("panggilan waiter", (e) => e.serviceCalls(), "query");
  const pages = await Promise.all(
    (["pending", "acknowledged"] as const).map((status) =>
      callEndpoint(listServiceRequests, {
        params: { outletId },
        query: { status, limit: 100 } as never,
      }),
    ),
  );
  return pages
    .flatMap((page) => page.data)
    .flatMap((request) => mapServiceRequest(request) ?? []);
}

export async function acknowledgeCall(
  _outletId: string,
  id: string,
): Promise<ServiceCall> {
  if (API_MOCK) return local("terima panggilan", (e) => e.acknowledgeCall(id));
  const { data } = await callEndpoint(acknowledgeServiceRequest, {
    params: { serviceRequestId: id as never },
  });
  return mapServiceRequest(data) ?? contractFail("terima panggilan");
}

/** The server refuses a bill request that was not accepted first (409). */
export async function resolveCall(
  _outletId: string,
  id: string,
): Promise<ServiceCall> {
  if (API_MOCK) return local("selesaikan panggilan", (e) => e.resolveCall(id));
  const { data } = await callEndpoint(resolveServiceRequest, {
    params: { serviceRequestId: id as never },
    body: {},
  });
  return mapServiceRequest(data) ?? contractFail("selesaikan panggilan");
}

function contractFail(feature: string): never {
  throw contractPending(feature);
}
