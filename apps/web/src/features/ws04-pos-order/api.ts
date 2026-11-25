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
  placeOrder,
  parkCart,
  resumeParked,
  type CreateBody,
  type ParkBody,
  type SubmitBody,
} from "./order-flow";
import { mapCatalog, mapFloor, mapOrder, mapParked } from "./order-wire";
import { runPosOrderMock, type PosOrderEngine } from "./mock-engine";
import {
  CONTRACT_PENDING,
  type AddToTableRequest,
  type CaptainTable,
  type Catalog,
  type FireLinesInput,
  type FireTableLinesInput,
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
 * server prices it. `draftKey` scopes the persisted intent to the cart.
 */
export async function submitOrder(
  outletId: string,
  actorId: string,
  draftKey: string,
  input: SubmitOrderInput,
): Promise<PosOrderView> {
  if (API_MOCK)
    return local("buat pesanan", (e) =>
      e.submitOrder({
        ...input,
        idempotencyKey: mockKeyFor(`order:${draftKey}`, [outletId, input]),
      }),
    );
  return mapOrder(
    await placeOrder(flowDeps(outletId, actorId, draftKey), input),
  );
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
  const [parked, catalog] = await Promise.all([
    parkCart(flowDeps(outletId, actorId, draftKey), input),
    fetchCatalog(outletId),
  ]);
  return mapParked(parked, catalog, newLineId).draft;
}

/**
 * Consumes the parked snapshot and returns it as cart lines. A line whose item
 * left the catalog is not restored; `missing` says how many.
 */
export async function resumeDraft(
  outletId: string,
  actorId: string,
  id: string,
): Promise<ParkedDraft & { missing: number }> {
  if (API_MOCK)
    return local("lanjutkan pesanan ditahan", (e) => ({
      ...e.resumeDraft(id),
      missing: 0,
    }));
  const parked = await resumeParked(flowDeps(outletId, actorId, "kasir"), id);
  const catalog = await fetchCatalog(outletId);
  const mapped = mapParked(parked, catalog, newLineId);
  return { ...mapped.draft, missing: mapped.missing };
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
