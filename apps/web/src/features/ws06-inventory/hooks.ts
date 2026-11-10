// The only way components touch inventory data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createInventoryItemAlternate as createAlternateEndpoint,
  createUomConversion as createConversionEndpoint,
  getInventoryItem,
  listInventoryItemAlternates,
  listInventoryItems,
  listStockBalances,
  listStockLocations,
  listStockTransfers,
  listUomConversions,
  listUoms,
  updateInventoryItem as updateItemEndpoint,
  updateStockLocation as updateLocationEndpoint,
} from "@starter/shared/inventory";
import * as api from "./api";
import {
  alternatesQuery,
  balancesQuery,
  conversionsQuery,
  itemQuery,
  itemsQuery,
  locationsQuery,
  transfersQuery,
  unitsQuery,
} from "./queries";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];
type ParamsOf<E extends AnyEndpoint> = EndpointInput<E>["params"];
type BodyOf<E extends AnyEndpoint> = EndpointInput<E>["body"];

type ParamsAndBody<P extends AnyEndpoint, B extends AnyEndpoint> = {
  params: ParamsOf<P>;
  body: BodyOf<B>;
};

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function useInventoryMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  invalidate: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate(invalidate);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

// ---- Queries -------------------------------------------------------------

export function useInventoryItems(query: QueryOf<typeof listInventoryItems>) {
  return useQuery(itemsQuery(query));
}

export function useInventoryItem(itemId: string | undefined) {
  return useQuery({
    ...itemQuery({ itemId: itemId ?? "" }),
    enabled: Boolean(itemId && itemId !== "baru"),
  });
}

export function useUnits(query: QueryOf<typeof listUoms>) {
  return useQuery(unitsQuery(query));
}

export function useConversions(itemId: string | undefined) {
  return useQuery({
    ...conversionsQuery({ itemId: itemId ?? "" }),
    enabled: Boolean(itemId),
  });
}

export function useStockLocations(outletId: string | undefined) {
  return useQuery({
    ...locationsQuery({ outletId: outletId ?? "", limit: 100 }),
    enabled: Boolean(outletId),
  });
}

export function useStockBalances(outletId: string | undefined) {
  return useQuery({
    ...balancesQuery({ outletId: outletId ?? "", limit: 100 }),
    enabled: Boolean(outletId),
  });
}

export function useItemAlternates(itemId: string | undefined) {
  return useQuery({
    ...alternatesQuery({ itemId: itemId ?? "" }),
    enabled: Boolean(itemId && itemId !== "baru"),
  });
}

export function useStockTransfers(outletId: string | undefined) {
  return useQuery({
    ...transfersQuery({ outletId: outletId ?? "", limit: 50 }),
    enabled: Boolean(outletId),
  });
}

// ---- Mutations -----------------------------------------------------------

export function useCreateInventoryItem() {
  return useInventoryMutation(api.createItem, [
    listInventoryItems,
    getInventoryItem,
  ]);
}

export function useUpdateInventoryItem() {
  return useInventoryMutation(
    (
      variables: ParamsAndBody<
        typeof updateItemEndpoint,
        typeof updateItemEndpoint
      >,
    ) => api.updateItem(variables.params, variables.body),
    [listInventoryItems, getInventoryItem],
  );
}

export function useCreateStockLocation() {
  return useInventoryMutation(api.createLocation, [
    listStockLocations,
    listStockBalances,
    listStockTransfers,
  ]);
}

export function useUpdateStockLocation() {
  return useInventoryMutation(
    (
      variables: ParamsAndBody<
        typeof updateLocationEndpoint,
        typeof updateLocationEndpoint
      >,
    ) => api.updateLocation(variables.params, variables.body),
    [listStockLocations, listStockBalances, listStockTransfers],
  );
}

export function useCreateAlternate() {
  return useInventoryMutation(
    (
      variables: ParamsAndBody<
        typeof createAlternateEndpoint,
        typeof createAlternateEndpoint
      >,
    ) => api.createAlternate(variables.params, variables.body),
    [listInventoryItemAlternates, getInventoryItem],
  );
}

export function useDeleteAlternate() {
  return useInventoryMutation(api.deleteAlternate, [
    listInventoryItemAlternates,
    getInventoryItem,
  ]);
}

export function useCreateConversion() {
  return useInventoryMutation(
    (
      variables: ParamsAndBody<
        typeof createConversionEndpoint,
        typeof createConversionEndpoint
      >,
    ) => api.createConversion(variables.params, variables.body),
    [listUomConversions],
  );
}

export function useDeleteConversion() {
  return useInventoryMutation(api.deleteConversion, [listUomConversions]);
}

export function useCreateStockTransfer() {
  return useInventoryMutation(api.createTransfer, [
    listStockTransfers,
    listStockBalances,
    listStockLocations,
  ]);
}
