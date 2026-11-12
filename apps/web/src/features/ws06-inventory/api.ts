// One typed caller per inventory endpoint this back office uses (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createInventoryItem as createInventoryItemEndpoint,
  createInventoryItemAlternate as createAlternateEndpoint,
  createStockLocation as createStockLocationEndpoint,
  createStockTransfer as createStockTransferEndpoint,
  createUom as createUomEndpoint,
  createUomConversion as createUomConversionEndpoint,
  deleteInventoryItemAlternate as deleteAlternateEndpoint,
  deleteUomConversion as deleteUomConversionEndpoint,
  getInventoryItem,
  listInventoryItemAlternates,
  listInventoryItems,
  listStockBalances,
  listStockLocations,
  listStockTransfers,
  listUomConversions,
  listUoms,
  updateInventoryItem as updateInventoryItemEndpoint,
  updateStockLocation as updateStockLocationEndpoint,
  updateUom as updateUomEndpoint,
} from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Reads ---------------------------------------------------------------

export const listItems = (query: Query<typeof listInventoryItems>) =>
  callEndpoint(listInventoryItems, { query });

export const getItem = (params: Params<typeof getInventoryItem>) =>
  callEndpoint(getInventoryItem, { params });

export const listUnits = (query: Query<typeof listUoms>) =>
  callEndpoint(listUoms, { query });

export const listConversions = (params: Params<typeof listUomConversions>) =>
  callEndpoint(listUomConversions, { params });

export const listLocations = (query: Query<typeof listStockLocations>) =>
  callEndpoint(listStockLocations, { query });

export const listBalances = (query: Query<typeof listStockBalances>) =>
  callEndpoint(listStockBalances, { query });

export const listAlternates = (
  params: Params<typeof listInventoryItemAlternates>,
) => callEndpoint(listInventoryItemAlternates, { params });

export const listTransfers = (query: Query<typeof listStockTransfers>) =>
  callEndpoint(listStockTransfers, { query });

// ---- Item writes ---------------------------------------------------------

export const createItem = (body: Body<typeof createInventoryItemEndpoint>) =>
  callEndpoint(createInventoryItemEndpoint, { body });

export const updateItem = (
  params: Params<typeof updateInventoryItemEndpoint>,
  body: Body<typeof updateInventoryItemEndpoint>,
) => callEndpoint(updateInventoryItemEndpoint, { params, body });

// ---- Setup writes --------------------------------------------------------

export const createLocation = (
  body: Body<typeof createStockLocationEndpoint>,
) => callEndpoint(createStockLocationEndpoint, { body });

export const updateLocation = (
  params: Params<typeof updateStockLocationEndpoint>,
  body: Body<typeof updateStockLocationEndpoint>,
) => callEndpoint(updateStockLocationEndpoint, { params, body });

export const createAlternate = (
  params: Params<typeof createAlternateEndpoint>,
  body: Body<typeof createAlternateEndpoint>,
) => callEndpoint(createAlternateEndpoint, { params, body });

export const deleteAlternate = (
  params: Params<typeof deleteAlternateEndpoint>,
) => callEndpoint(deleteAlternateEndpoint, { params });

export const createConversion = (
  params: Params<typeof createUomConversionEndpoint>,
  body: Body<typeof createUomConversionEndpoint>,
) => callEndpoint(createUomConversionEndpoint, { params, body });

export const deleteConversion = (
  params: Params<typeof deleteUomConversionEndpoint>,
) => callEndpoint(deleteUomConversionEndpoint, { params });

export const createTransfer = (
  body: Body<typeof createStockTransferEndpoint>,
) => callEndpoint(createStockTransferEndpoint, { body });

export const createUom = (body: Body<typeof createUomEndpoint>) =>
  callEndpoint(createUomEndpoint, { body });

export const updateUom = (
  params: Params<typeof updateUomEndpoint>,
  body: Body<typeof updateUomEndpoint>,
) => callEndpoint(updateUomEndpoint, { params, body });
