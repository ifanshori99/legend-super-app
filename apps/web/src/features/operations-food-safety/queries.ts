// Query keys and options for the food-safety screens. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md "Typed endpoints and mock mode").
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listInventoryItems,
  listStockBatches,
  listUoms,
} from "@starter/shared/inventory";
import {
  getPrepList,
  listEquipment,
  listPrepItemSettings,
  listPrepLabels,
  listPrepLists,
  listTemperatureLogs,
} from "@starter/shared/operations";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const temperatureLogsQuery = (
  query: Query<typeof listTemperatureLogs>,
) => endpointQueryOptions(listTemperatureLogs, { query });

export const equipmentQuery = (query: Query<typeof listEquipment>) =>
  endpointQueryOptions(listEquipment, { query });

export const prepItemSettingsQuery = (
  query: Query<typeof listPrepItemSettings>,
) => endpointQueryOptions(listPrepItemSettings, { query });

export const prepLabelsQuery = (query: Query<typeof listPrepLabels>) =>
  endpointQueryOptions(listPrepLabels, { query });

export const prepListsQuery = (query: Query<typeof listPrepLists>) =>
  endpointQueryOptions(listPrepLists, { query });

export const prepListQuery = (params: Params<typeof getPrepList>) =>
  endpointQueryOptions(getPrepList, { params });

export const inventoryItemsQuery = (query: Query<typeof listInventoryItems>) =>
  endpointQueryOptions(listInventoryItems, { query });

export const unitsQuery = (query: Query<typeof listUoms>) =>
  endpointQueryOptions(listUoms, { query });

export const stockBatchesQuery = (query: Query<typeof listStockBatches>) =>
  endpointQueryOptions(listStockBatches, { query });
