// One typed caller per stock-count and waste endpoint (docs/frontend.md
// "Typed endpoints and mock mode"). Kept beside `api.ts` / `stock-api.ts` so
// the opname bead never rewrote the shared inventory callers. Detail, create
// and transition calls unwrap the `{ data }` envelope so screens hold the
// domain object; lists keep the cursor page exactly as the API returns it.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createStockCount as createStockCountEndpoint,
  createWasteLog as createWasteLogEndpoint,
  getStockCount,
  listStockCounts,
  listWasteLogs,
  postStockCountTransition as postStockCountTransitionEndpoint,
  updateStockCountLine as updateStockCountLineEndpoint,
} from "@starter/shared/inventory";
import { listItems as listMenuItemsEndpoint } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

/** Menu items are a waste target (PRD §16 "Waste": bahan atau menu). */
export const listMenuItems = (query: Query<typeof listMenuItemsEndpoint>) =>
  callEndpoint(listMenuItemsEndpoint, { query });

// ---- Stock counts (PRD §16 "Stok Opname", INV-03) ------------------------

export const listCounts = (query: Query<typeof listStockCounts>) =>
  callEndpoint(listStockCounts, { query });

export async function getCount(
  params: Params<typeof getStockCount>,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(getStockCount, { params }, { signal });
  return data;
}

export async function createCount(body: Body<typeof createStockCountEndpoint>) {
  const { data } = await callEndpoint(createStockCountEndpoint, { body });
  return data;
}

export async function updateCountLine(
  params: Params<typeof updateStockCountLineEndpoint>,
  body: Body<typeof updateStockCountLineEndpoint>,
) {
  const { data } = await callEndpoint(updateStockCountLineEndpoint, {
    params,
    body,
  });
  return data;
}

export async function transitionCount(
  params: Params<typeof postStockCountTransitionEndpoint>,
  body: Body<typeof postStockCountTransitionEndpoint>,
) {
  const { data } = await callEndpoint(postStockCountTransitionEndpoint, {
    params,
    body,
  });
  return data;
}

// ---- Waste and spoilage (PRD §16 "Waste & Spoilage") ---------------------

export const listWaste = (query: Query<typeof listWasteLogs>) =>
  callEndpoint(listWasteLogs, { query });

export async function recordWaste(body: Body<typeof createWasteLogEndpoint>) {
  const { data } = await callEndpoint(createWasteLogEndpoint, { body });
  return data;
}
