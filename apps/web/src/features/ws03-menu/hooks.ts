// The only way components touch menu data: queries keep their endpoint keys,
// mutations invalidate every endpoint whose rows a write can change.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import type { OutletId } from "@starter/shared/core";
import {
  getItem,
  getItemModifierGroups,
  listAvailability,
  listCategories,
  listCombos,
  listItems,
  listModifierGroups,
  listModifiers,
  listPriceListItems,
  listPriceLists,
  listStations,
  listVariants,
} from "@starter/shared/menu";
import type { orgEndpoints } from "@starter/shared/platform";
import * as api from "./api";
import {
  allCategoriesQuery,
  allItemsQuery,
  allPriceListsQuery,
  availabilityQuery,
  categoriesQuery,
  combosQuery,
  itemQuery,
  itemModifierGroupsQuery,
  itemsQuery,
  modifierGroupsQuery,
  modifiersQuery,
  outletsQuery,
  priceListItemsQuery,
  priceListsQuery,
  stationsQuery,
  variantsQuery,
} from "./queries";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function useMenuMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  invalidate: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate(invalidate);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

/** Refetch everything a menu write can affect (e.g. after a shop-wide 86). */
export function useRefreshMenu() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      (
        [
          listCategories,
          listItems,
          getItem,
          listVariants,
          listModifierGroups,
          listModifiers,
          getItemModifierGroups,
          listCombos,
          listPriceLists,
          listPriceListItems,
          listAvailability,
          listStations,
        ] as readonly AnyEndpoint[]
      ).map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

// ---- Queries -------------------------------------------------------------

export function useItems(query: QueryOf<typeof listItems>) {
  return useQuery(itemsQuery(query));
}

/** Every page of the menu (printable sheet); `useItems` reads one page. */
export function useAllItems(query: QueryOf<typeof listItems>) {
  return useQuery(allItemsQuery(query));
}

export function useAllCategories(query: QueryOf<typeof listCategories>) {
  return useQuery(allCategoriesQuery(query));
}

export function useAllPriceLists(query: QueryOf<typeof listPriceLists>) {
  return useQuery(allPriceListsQuery(query));
}

export function useItem(itemId: string | undefined) {
  return useQuery({
    ...itemQuery({ itemId: itemId ?? "" }),
    enabled: Boolean(itemId && itemId !== "baru"),
  });
}

export function useItemModifierGroups(itemId: string | undefined) {
  return useQuery({
    ...itemModifierGroupsQuery({ itemId: itemId ?? "" }),
    enabled: Boolean(itemId && itemId !== "baru"),
  });
}

export function useCategories(query: QueryOf<typeof listCategories>) {
  return useQuery(categoriesQuery(query));
}

export function useStations(query: QueryOf<typeof listStations>) {
  return useQuery(stationsQuery(query));
}

/** Stations of several outlets, one query per outlet (same order as `outletIds`). */
export function useOutletStations(outletIds: readonly OutletId[]) {
  return useQueries({
    queries: outletIds.map((outletId) =>
      stationsQuery({ outletId, limit: 100 }),
    ),
  });
}

/** Outlets of the tenant, for the optional per-outlet station override. */
export function useOutlets(query: QueryOf<typeof orgEndpoints.listOutlets>) {
  return useQuery(outletsQuery(query));
}

export function useVariants(itemId: string | undefined) {
  return useQuery({
    ...variantsQuery({ itemId: itemId ?? "" }, { limit: 100 }),
    enabled: Boolean(itemId && itemId !== "baru"),
  });
}

export function useModifierGroups(query: QueryOf<typeof listModifierGroups>) {
  return useQuery(modifierGroupsQuery(query));
}

export function useModifiers(groupId: string | undefined) {
  return useQuery({
    ...modifiersQuery({ groupId: groupId ?? "" }, { limit: 100 }),
    enabled: Boolean(groupId),
  });
}

export function useCombos(query: QueryOf<typeof listCombos>) {
  return useQuery(combosQuery(query));
}

export function usePriceLists(query: QueryOf<typeof listPriceLists>) {
  return useQuery(priceListsQuery(query));
}

export function usePriceListItems(priceListId: string | undefined) {
  return useQuery({
    ...priceListItemsQuery({ priceListId: priceListId ?? "" }, { limit: 100 }),
    enabled: Boolean(priceListId),
  });
}

export function useAvailability(query: QueryOf<typeof listAvailability>) {
  return useQuery(availabilityQuery(query));
}

// ---- Category mutations --------------------------------------------------

export function useCreateCategory() {
  return useMenuMutation(api.createCategory, [listCategories, listItems]);
}

export function useUpdateCategory() {
  return useMenuMutation(
    (input: {
      categoryId: string;
      body: Parameters<typeof api.updateCategory>[1];
    }) => api.updateCategory({ categoryId: input.categoryId }, input.body),
    [listCategories, listItems],
  );
}

export function useDeleteCategory() {
  return useMenuMutation(
    (categoryId: string) => api.deleteCategory({ categoryId }),
    [listCategories, listItems],
  );
}

export function useReorderCategories() {
  return useMenuMutation(api.reorderCategories, [listCategories, listItems]);
}

// ---- Station mutations ---------------------------------------------------

export function useCreateStation() {
  return useMenuMutation(api.createStation, [listStations, listItems]);
}

export function useUpdateStation() {
  return useMenuMutation(
    (input: {
      stationId: string;
      body: Parameters<typeof api.updateStation>[1];
    }) => api.updateStation({ stationId: input.stationId }, input.body),
    [listStations, listItems],
  );
}

export function useDeleteStation() {
  return useMenuMutation(
    (stationId: string) => api.deleteStation({ stationId }),
    [listStations, listItems],
  );
}

// ---- Item mutations ------------------------------------------------------

export function useCreateItem() {
  return useMenuMutation(api.createItem, [
    listItems,
    listCategories,
    listAvailability,
    listPriceListItems,
  ]);
}

export function useUpdateItem() {
  return useMenuMutation(
    (input: { itemId: string; body: Parameters<typeof api.updateItem>[1] }) =>
      api.updateItem({ itemId: input.itemId }, input.body),
    [listItems, getItem],
  );
}

export function useDeleteItem() {
  return useMenuMutation(
    (itemId: string) => api.deleteItem({ itemId }),
    [listItems, getItem, listAvailability, listPriceListItems, listCombos],
  );
}

export function useReorderItems() {
  return useMenuMutation(api.reorderItems, [listItems, getItem]);
}

export function useSetItemModifierGroups() {
  return useMenuMutation(
    (input: {
      itemId: string;
      body: Parameters<typeof api.setItemModifierGroups>[1];
    }) => api.setItemModifierGroups({ itemId: input.itemId }, input.body),
    [getItemModifierGroups, listModifierGroups],
  );
}

// ---- Variant mutations ---------------------------------------------------

export function useCreateVariant() {
  return useMenuMutation(
    (input: {
      itemId: string;
      body: Parameters<typeof api.createVariant>[1];
    }) => api.createVariant({ itemId: input.itemId }, input.body),
    [listVariants],
  );
}

export function useUpdateVariant() {
  return useMenuMutation(
    (input: {
      variantId: string;
      body: Parameters<typeof api.updateVariant>[1];
    }) => api.updateVariant({ variantId: input.variantId }, input.body),
    [listVariants],
  );
}

export function useDeleteVariant() {
  return useMenuMutation(
    (variantId: string) => api.deleteVariant({ variantId }),
    [listVariants],
  );
}

// ---- Modifier mutations --------------------------------------------------

export function useCreateModifierGroup() {
  return useMenuMutation(api.createModifierGroup, [
    listModifierGroups,
    getItemModifierGroups,
  ]);
}

export function useUpdateModifierGroup() {
  return useMenuMutation(
    (input: {
      groupId: string;
      body: Parameters<typeof api.updateModifierGroup>[1];
    }) => api.updateModifierGroup({ groupId: input.groupId }, input.body),
    [listModifierGroups, getItemModifierGroups],
  );
}

export function useDeleteModifierGroup() {
  return useMenuMutation(
    (groupId: string) => api.deleteModifierGroup({ groupId }),
    [listModifierGroups, listModifiers, getItemModifierGroups],
  );
}

export function useCreateModifier() {
  return useMenuMutation(
    (input: {
      groupId: string;
      body: Parameters<typeof api.createModifier>[1];
    }) => api.createModifier({ groupId: input.groupId }, input.body),
    [listModifiers],
  );
}

export function useUpdateModifier() {
  return useMenuMutation(
    (input: {
      modifierId: string;
      body: Parameters<typeof api.updateModifier>[1];
    }) => api.updateModifier({ modifierId: input.modifierId }, input.body),
    [listModifiers],
  );
}

export function useDeleteModifier() {
  return useMenuMutation(
    (modifierId: string) => api.deleteModifier({ modifierId }),
    [listModifiers],
  );
}

// ---- Combo mutations -----------------------------------------------------

export function useCreateCombo() {
  return useMenuMutation(api.createCombo, [listCombos, listItems]);
}

export function useUpdateCombo() {
  return useMenuMutation(
    (input: { comboId: string; body: Parameters<typeof api.updateCombo>[1] }) =>
      api.updateCombo({ comboId: input.comboId }, input.body),
    [listCombos],
  );
}

export function useDeleteCombo() {
  return useMenuMutation(
    (comboId: string) => api.deleteCombo({ comboId }),
    [listCombos],
  );
}

// ---- Price list mutations ------------------------------------------------

export function useCreatePriceList() {
  return useMenuMutation(api.createPriceList, [
    listPriceLists,
    listPriceListItems,
  ]);
}

export function useUpdatePriceList() {
  return useMenuMutation(
    (input: {
      priceListId: string;
      body: Parameters<typeof api.updatePriceList>[1];
    }) => api.updatePriceList({ priceListId: input.priceListId }, input.body),
    [listPriceLists, listPriceListItems],
  );
}

export function useDeletePriceList() {
  return useMenuMutation(
    (priceListId: string) => api.deletePriceList({ priceListId }),
    [listPriceLists, listPriceListItems],
  );
}

export function useSetPriceListItems() {
  return useMenuMutation(
    (input: {
      priceListId: string;
      body: Parameters<typeof api.setPriceListItems>[1];
    }) => api.setPriceListItems({ priceListId: input.priceListId }, input.body),
    [listPriceListItems, listPriceLists],
  );
}

// ---- Availability mutations ----------------------------------------------

export function useUpdateAvailability() {
  return useMenuMutation(
    (input: {
      availabilityId: string;
      body: Parameters<typeof api.updateAvailability>[1];
    }) =>
      api.updateAvailability(
        { availabilityId: input.availabilityId },
        input.body,
      ),
    [listAvailability],
  );
}

export function useSetAvailabilityStatus() {
  return useMenuMutation(
    (input: {
      availabilityId: string;
      body: Parameters<typeof api.setAvailabilityStatus>[1];
    }) =>
      api.setAvailabilityStatus(
        { availabilityId: input.availabilityId },
        input.body,
      ),
    [listAvailability, listItems],
  );
}

// ---- Media ---------------------------------------------------------------

/** Uploads one already-resized menu photo; returns its media id and URL. */
export function useUploadMenuImage() {
  return useMutation({ mutationFn: api.uploadMenuImage });
}
