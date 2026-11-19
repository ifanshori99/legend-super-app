// One function per ordering call; components never call these (they use the
// hooks in ./hooks.ts). None of these calls has a usable shared endpoint yet
// (see ./CONTRACT-GAPS.md), so they run on the mock engine in mock mode and
// fail with CONTRACT_PENDING everywhere else: the screen then says so instead
// of showing made-up data.
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { demoMenuPhoto, demoMenuPhotoRef } from "@/lib/demo-media";
import { DEMO_PHOTO_NAMES } from "./fixtures";
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
  type SubmitOrderRequest,
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

/** DEMO-CONTRACT: cashier catalog with modifiers, courses and sold-out flag. */
export async function fetchCatalog(): Promise<Catalog> {
  const catalog = await local("katalog kasir", (e) => e.catalog(), "query");
  return {
    ...catalog,
    items: catalog.items.map((item) => ({
      ...item,
      imageUrl:
        item.imageUrl ??
        demoMenuPhoto(DEMO_PHOTO_NAMES[item.id] ?? "") ??
        demoMenuPhotoRef(item.id),
    })),
  };
}

/** DEMO-CONTRACT: the call number the next takeaway order gets ("A-12"). */
export function fetchNextCallNumber(): Promise<string> {
  return local("nomor panggilan", (e) => e.nextCallNumber(), "query");
}

/** DEMO-CONTRACT: createPosOrder has no modifiers, courses or hold per line. */
export function submitOrder(
  _outletId: string,
  input: SubmitOrderRequest,
): Promise<PosOrderView> {
  return local("buat pesanan", (e) => e.submitOrder(input));
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

export function fetchParkedDrafts(): Promise<ParkedDraft[]> {
  return local("pesanan ditahan", (e) => e.parkedDrafts(), "query");
}

export function parkDraft(
  _outletId: string,
  input: ParkDraftInput,
): Promise<ParkedDraft> {
  return local("tahan pesanan", (e) => e.parkDraft(input));
}

export function resumeDraft(
  _outletId: string,
  id: string,
): Promise<ParkedDraft> {
  return local("lanjutkan pesanan ditahan", (e) => e.resumeDraft(id));
}

// ---- Captain ---------------------------------------------------------------

export function fetchCaptainTables(): Promise<CaptainTable[]> {
  return local("daftar meja captain", (e) => e.captainTables(), "query");
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
