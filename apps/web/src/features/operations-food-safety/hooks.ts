// The only way the food-safety components touch data: queries keep their
// endpoint keys; mutations invalidate every endpoint whose rows a write can
// change (docs/frontend.md "Custom hooks").
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listInventoryItems,
  listStockBatches,
  listUoms,
} from "@starter/shared/inventory";
import {
  listEquipment,
  listPrepLabels,
  listPrepLists,
  listTemperatureLogs,
  postPrepListTransition,
  printPrepLabel,
} from "@starter/shared/operations";
import * as api from "./api.ts";
import {
  equipmentQuery,
  inventoryItemsQuery,
  prepLabelsQuery,
  prepListQuery,
  prepListsQuery,
  stockBatchesQuery,
  temperatureLogsQuery,
  unitsQuery,
} from "./queries.ts";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

// ---- Reads ---------------------------------------------------------------

export function useTemperatureLogs(query: Query<typeof listTemperatureLogs>) {
  return useQuery(temperatureLogsQuery(query));
}

export function useTemperatureEquipment(query: Query<typeof listEquipment>) {
  return useQuery(equipmentQuery(query));
}

export function usePrepLabels(query: Query<typeof listPrepLabels>) {
  return useQuery(prepLabelsQuery(query));
}

export function usePrepLists(query: Query<typeof listPrepLists>) {
  return useQuery(prepListsQuery(query));
}

export function usePrepList(prepListId: string | undefined) {
  return useQuery({
    ...prepListQuery({ prepListId: prepListId ?? "" }),
    enabled: Boolean(prepListId),
  });
}

export function useInventoryItems(query: Query<typeof listInventoryItems>) {
  return useQuery(inventoryItemsQuery(query));
}

export function useUnits(query: Query<typeof listUoms>) {
  return useQuery(unitsQuery(query));
}

export function useStockBatches(query: Query<typeof listStockBatches>) {
  return useQuery(stockBatchesQuery(query));
}

// ---- Temperature log (OPS-02) --------------------------------------------

export function useCreateTemperatureLog() {
  const refresh = useInvalidate([listTemperatureLogs]);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createTemperatureLog>[0]) =>
      api.createTemperatureLog(body),
    onSuccess: () => refresh(),
  });
}

// ---- Prep labels (OPS-03) ------------------------------------------------

export function useCreatePrepLabel() {
  const refresh = useInvalidate([listPrepLabels]);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createPrepLabel>[0]) =>
      api.createPrepLabel(body),
    onSuccess: () => refresh(),
  });
}

export function usePrintPrepLabel() {
  const refresh = useInvalidate([listPrepLabels]);
  return useMutation({
    mutationFn: (variables: {
      params: Params<typeof printPrepLabel>;
      body: Body<typeof printPrepLabel>;
    }) => api.printPrepLabel(variables.params, variables.body),
    onSuccess: () => refresh(),
  });
}

// ---- Prep lists ----------------------------------------------------------

export function useCreatePrepList() {
  const refresh = useInvalidate([listPrepLists]);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createPrepList>[0]) =>
      api.createPrepList(body),
    onSuccess: () => refresh(),
  });
}

export function useTransitionPrepList() {
  const refresh = useInvalidate([listPrepLists]);
  return useMutation({
    mutationFn: (variables: {
      params: Params<typeof postPrepListTransition>;
      body: Body<typeof postPrepListTransition>;
    }) => api.transitionPrepList(variables.params, variables.body),
    onSuccess: () => refresh(),
  });
}
