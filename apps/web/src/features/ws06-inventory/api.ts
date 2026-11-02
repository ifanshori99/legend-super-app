// One typed caller per inventory endpoint these screens use (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation. Detail, create and
// transition calls unwrap the `{ data }` envelope so screens hold the domain
// object; list calls keep the cursor page as the API returns it.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createStockCount as createStockCountEndpoint,
  createWasteLog as createWasteLogEndpoint,
  getStockCount,
  listInventoryItems,
  listStockCounts,
  listStockLocations,
  listUoms,
  listWasteLogs,
  postStockCountTransition as postStockCountTransitionEndpoint,
  updateStockCountLine as updateStockCountLineEndpoint,
} from "@starter/shared/inventory";
import { listItems as listMenuItemsEndpoint } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Lookups -------------------------------------------------------------

export const listItems = (query: Query<typeof listInventoryItems>) =>
  callEndpoint(listInventoryItems, { query });

export const listLocations = (query: Query<typeof listStockLocations>) =>
  callEndpoint(listStockLocations, { query });

export const listUnits = (query: Query<typeof listUoms>) =>
  callEndpoint(listUoms, { query });

export const listMenu = (query: Query<typeof listMenuItemsEndpoint>) =>
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

export async function createCount(
  body: Body<typeof createStockCountEndpoint>,
) {
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
