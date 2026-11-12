// One typed caller per endpoint the food-safety screens use (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation.
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import {
  listInventoryItems,
  listStockBatches,
  listUoms,
} from "@starter/shared/inventory";
import {
  createPrepLabel as createPrepLabelEndpoint,
  createPrepList as createPrepListEndpoint,
  createTemperatureLog as createTemperatureLogEndpoint,
  getPrepList as getPrepListEndpoint,
  listEquipment as listEquipmentEndpoint,
  listPrepItemSettings as listPrepItemSettingsEndpoint,
  listPrepLabels as listPrepLabelsEndpoint,
  listPrepLists as listPrepListsEndpoint,
  listTemperatureLogs as listTemperatureLogsEndpoint,
  postPrepListTransition as postPrepListTransitionEndpoint,
  printPrepLabel as printPrepLabelEndpoint,
  putPrepItemSetting as putPrepItemSettingEndpoint,
} from "@starter/shared/operations";
import { callEndpoint } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type TemperatureLogPage = EndpointOutput<
  typeof listTemperatureLogsEndpoint
>;
export type PrepLabelPage = EndpointOutput<typeof listPrepLabelsEndpoint>;
export type PrepListPage = EndpointOutput<typeof listPrepListsEndpoint>;

// ---- Food safety ---------------------------------------------------------

export const listTemperatureLogs = (
  query: Query<typeof listTemperatureLogsEndpoint>,
) => callEndpoint(listTemperatureLogsEndpoint, { query });

export const createTemperatureLog = (
  body: Body<typeof createTemperatureLogEndpoint>,
) => callEndpoint(createTemperatureLogEndpoint, { body });

export const listPrepItemSettings = (
  query: Query<typeof listPrepItemSettingsEndpoint>,
) => callEndpoint(listPrepItemSettingsEndpoint, { query });

export const putPrepItemSetting = (
  params: Params<typeof putPrepItemSettingEndpoint>,
  body: Body<typeof putPrepItemSettingEndpoint>,
) => callEndpoint(putPrepItemSettingEndpoint, { params, body });

export const listPrepLabels = (query: Query<typeof listPrepLabelsEndpoint>) =>
  callEndpoint(listPrepLabelsEndpoint, { query });

export const createPrepLabel = (body: Body<typeof createPrepLabelEndpoint>) =>
  callEndpoint(createPrepLabelEndpoint, { body });

export const printPrepLabel = (
  params: Params<typeof printPrepLabelEndpoint>,
  body: Body<typeof printPrepLabelEndpoint>,
) => callEndpoint(printPrepLabelEndpoint, { params, body });

export const listPrepLists = (query: Query<typeof listPrepListsEndpoint>) =>
  callEndpoint(listPrepListsEndpoint, { query });

export const getPrepList = (params: Params<typeof getPrepListEndpoint>) =>
  callEndpoint(getPrepListEndpoint, { params });

export const createPrepList = (body: Body<typeof createPrepListEndpoint>) =>
  callEndpoint(createPrepListEndpoint, { body });

export const transitionPrepList = (
  params: Params<typeof postPrepListTransitionEndpoint>,
  body: Body<typeof postPrepListTransitionEndpoint>,
) => callEndpoint(postPrepListTransitionEndpoint, { params, body });

// ---- Read-only supporting catalogs --------------------------------------

export const listEquipment = (query: Query<typeof listEquipmentEndpoint>) =>
  callEndpoint(listEquipmentEndpoint, { query });

export const listItems = (query: Query<typeof listInventoryItems>) =>
  callEndpoint(listInventoryItems, { query });

export const listUnits = (query: Query<typeof listUoms>) =>
  callEndpoint(listUoms, { query });

export const listBatches = (query: Query<typeof listStockBatches>) =>
  callEndpoint(listStockBatches, { query });
