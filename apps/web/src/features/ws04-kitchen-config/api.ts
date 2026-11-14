// One typed caller per kitchen config & analytics endpoint (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these: they use the
// hooks in ./hooks.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getPacing,
  getServingTimeSummary,
  listCapacityRules,
  listKitchenStations,
  listOrderIssues,
  updateCapacityRules,
  updateKitchenStations,
} from "@starter/shared/kitchen";
import type { OutletId } from "@starter/shared/core";
import { listStations } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint.ts";
import type { StationUpdate } from "./station-order.ts";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type ServingSummaryQuery = Query<typeof getServingTimeSummary>;
export type OrderIssueQuery = Query<typeof listOrderIssues>;
export type CapacityRulesBody = Body<typeof updateCapacityRules>;
export type CapacityRulesParams = Params<typeof updateCapacityRules>;

/** The KDS tabs/config of this outlet (F12 "KDS per Stasiun"). */
export async function fetchKitchenStations(
  outletId: OutletId,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    listKitchenStations,
    { params: { outletId } },
    { signal },
  );
  return data;
}

/**
 * Replaces the order and flags of every station (bead legend-sonf).
 */
export async function saveKitchenStations(
  outletId: OutletId,
  stations: StationUpdate[],
) {
  const { data } = await callEndpoint(updateKitchenStations, {
    params: { outletId },
    body: { stations },
  });
  return data;
}

/**
 * Station names and target times live in the menu contract (PRD §6
 * `stations`); kitchen config reads them, the menu back office owns them.
 */
export async function fetchMenuStations(
  outletId: OutletId,
  signal?: AbortSignal,
) {
  const page = await callEndpoint(
    listStations,
    { query: { outletId, limit: 100 } },
    { signal },
  );
  return page.data;
}

/** Every capacity window of the outlet, before replacing one station's list. */
export async function fetchCapacityRules(
  outletId: OutletId,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    listCapacityRules,
    { params: { outletId } },
    { signal },
  );
  return data;
}

/** Current pacing per station: used points against the active window. */
export async function fetchPacing(outletId: OutletId, signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getPacing,
    { params: { outletId } },
    { signal },
  );
  return data;
}

export async function saveCapacityRules(
  outletId: OutletId,
  stationId: string,
  rules: CapacityRulesBody["rules"],
) {
  const { data } = await callEndpoint(updateCapacityRules, {
    params: { outletId, stationId },
    body: { rules },
  });
  return data;
}

/** Serving-time analytics by station, hour, employee or item (F12). */
export async function fetchServingTimeSummary(
  outletId: OutletId,
  query: ServingSummaryQuery,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getServingTimeSummary,
    { params: { outletId }, query },
    { signal },
  );
  return data;
}

/** Remake/comp log, newest first, cursor-paginated (KDS-07). */
export async function fetchOrderIssues(
  outletId: OutletId,
  query: OrderIssueQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listOrderIssues,
    { params: { outletId }, query },
    { signal },
  );
}
