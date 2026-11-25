// One function per ordering call; components never call these (they use the
// hooks in ./hooks.ts). The cashier calls (catalog, call number, create +
// submit, park, resume, floor tables) use the shared endpoints; the mock engine
// answers in mock mode. The captain and waiter-call functions below have no
// usable endpoint yet (see ./CONTRACT-GAPS.md): they run on the mock engine in
// mock mode and fail with CONTRACT_PENDING everywhere else.
import {
  createPosOrder,
  createPosParkedOrder,
  getNextPosCallNumber,
  getPosCatalog,
  listPosParkedOrders,
  resumePosParkedOrder,
  submitPosOrder,
} from "@starter/shared/pos";
import { getFloorBoard } from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { demoMenuPhoto } from "@/lib/demo-media";
import { DEMO_PHOTO_NAMES } from "./fixtures";
import {
  closeOrderIntent,
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
import { runPosOrderMock, type PosOrderEngine } from "./mock-engine";
import {
  CONTRACT_PENDING,
  type AddToTableRequest,
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
  type TableOrderView,
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
): Promise<ParkedDraft> {
  if (API_MOCK) return local("tahan pesanan", (e) => e.parkDraft(input));
  // The catalog is not needed: the draft shown is the cart that was parked.
  const parked = await parkCart(flowDeps(outletId, actorId, draftKey), input);
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

export function fetchTableOrder(
  _outletId: string,
  tableId: string,
): Promise<TableOrderView> {
  return local("pesanan meja", (e) => e.tableOrder(tableId), "query");
}

export function addToTable(
  _outletId: string,
  input: AddToTableRequest,
): Promise<TableOrderView> {
  return local("tambah ke meja", (e) => e.addToTable(input));
}

export function fireTableLines(
  _outletId: string,
  input: FireTableLinesInput,
): Promise<TableOrderView> {
  return local("kirim item meja", (e) =>
    e.fireTableLines(input.tableId, input.lineIds),
  );
}

// ---- Waiter calls ----------------------------------------------------------

/** DEMO-CONTRACT: listServiceRequests has no table label or display reason. */
export function fetchServiceCalls(): Promise<ServiceCall[]> {
  return local("panggilan waiter", (e) => e.serviceCalls(), "query");
}

export function acknowledgeCall(
  _outletId: string,
  id: string,
): Promise<ServiceCall> {
  return local("terima panggilan", (e) => e.acknowledgeCall(id));
}

export function resolveCall(
  _outletId: string,
  id: string,
): Promise<ServiceCall> {
  return local("selesaikan panggilan", (e) => e.resolveCall(id));
}
