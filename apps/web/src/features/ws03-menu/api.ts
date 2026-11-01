// One typed caller per menu back-office endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Components never call these directly: they use
// the hooks in ./hooks.ts, which own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createCategory as createCategoryEndpoint,
  createCombo as createComboEndpoint,
  createItem as createItemEndpoint,
  createModifier as createModifierEndpoint,
  createModifierGroup as createModifierGroupEndpoint,
  createPriceList as createPriceListEndpoint,
  createStation as createStationEndpoint,
  createVariant as createVariantEndpoint,
  deleteCategory as deleteCategoryEndpoint,
  deleteCombo as deleteComboEndpoint,
  deleteItem as deleteItemEndpoint,
  deleteModifier as deleteModifierEndpoint,
  deleteModifierGroup as deleteModifierGroupEndpoint,
  deletePriceList as deletePriceListEndpoint,
  deleteStation as deleteStationEndpoint,
  deleteVariant as deleteVariantEndpoint,
  reorderCategories as reorderCategoriesEndpoint,
  reorderItems as reorderItemsEndpoint,
  setAvailabilityStatus as setAvailabilityStatusEndpoint,
  setItemModifierGroups as setItemModifierGroupsEndpoint,
  setPriceListItems as setPriceListItemsEndpoint,
  updateAvailability as updateAvailabilityEndpoint,
  updateCategory as updateCategoryEndpoint,
  updateCombo as updateComboEndpoint,
  updateItem as updateItemEndpoint,
  updateModifier as updateModifierEndpoint,
  updateModifierGroup as updateModifierGroupEndpoint,
  updatePriceList as updatePriceListEndpoint,
  updateStation as updateStationEndpoint,
  updateVariant as updateVariantEndpoint,
  uploadMenuImage as uploadMenuImageEndpoint,
} from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

// ---- Categories ----------------------------------------------------------

export const createCategory = (body: Body<typeof createCategoryEndpoint>) =>
  callEndpoint(createCategoryEndpoint, { body });

export const updateCategory = (
  params: Params<typeof updateCategoryEndpoint>,
  body: Body<typeof updateCategoryEndpoint>,
) => callEndpoint(updateCategoryEndpoint, { params, body });

export const deleteCategory = (params: Params<typeof deleteCategoryEndpoint>) =>
  callEndpoint(deleteCategoryEndpoint, { params });

export const reorderCategories = (
  body: Body<typeof reorderCategoriesEndpoint>,
) => callEndpoint(reorderCategoriesEndpoint, { body });

// ---- Stations ------------------------------------------------------------

export const createStation = (body: Body<typeof createStationEndpoint>) =>
  callEndpoint(createStationEndpoint, { body });

export const updateStation = (
  params: Params<typeof updateStationEndpoint>,
  body: Body<typeof updateStationEndpoint>,
) => callEndpoint(updateStationEndpoint, { params, body });

export const deleteStation = (params: Params<typeof deleteStationEndpoint>) =>
  callEndpoint(deleteStationEndpoint, { params });

// ---- Items ---------------------------------------------------------------

export const createItem = (body: Body<typeof createItemEndpoint>) =>
  callEndpoint(createItemEndpoint, { body });

export const updateItem = (
  params: Params<typeof updateItemEndpoint>,
  body: Body<typeof updateItemEndpoint>,
) => callEndpoint(updateItemEndpoint, { params, body });

export const deleteItem = (params: Params<typeof deleteItemEndpoint>) =>
  callEndpoint(deleteItemEndpoint, { params });

export const reorderItems = (body: Body<typeof reorderItemsEndpoint>) =>
  callEndpoint(reorderItemsEndpoint, { body });

export const setItemModifierGroups = (
  params: Params<typeof setItemModifierGroupsEndpoint>,
  body: Body<typeof setItemModifierGroupsEndpoint>,
) => callEndpoint(setItemModifierGroupsEndpoint, { params, body });

// ---- Variants ------------------------------------------------------------

export const createVariant = (
  params: Params<typeof createVariantEndpoint>,
  body: Body<typeof createVariantEndpoint>,
) => callEndpoint(createVariantEndpoint, { params, body });

export const updateVariant = (
  params: Params<typeof updateVariantEndpoint>,
  body: Body<typeof updateVariantEndpoint>,
) => callEndpoint(updateVariantEndpoint, { params, body });

export const deleteVariant = (params: Params<typeof deleteVariantEndpoint>) =>
  callEndpoint(deleteVariantEndpoint, { params });

// ---- Modifier groups -----------------------------------------------------

export const createModifierGroup = (
  body: Body<typeof createModifierGroupEndpoint>,
) => callEndpoint(createModifierGroupEndpoint, { body });

export const updateModifierGroup = (
  params: Params<typeof updateModifierGroupEndpoint>,
  body: Body<typeof updateModifierGroupEndpoint>,
) => callEndpoint(updateModifierGroupEndpoint, { params, body });

export const deleteModifierGroup = (
  params: Params<typeof deleteModifierGroupEndpoint>,
) => callEndpoint(deleteModifierGroupEndpoint, { params });

export const createModifier = (
  params: Params<typeof createModifierEndpoint>,
  body: Body<typeof createModifierEndpoint>,
) => callEndpoint(createModifierEndpoint, { params, body });

export const updateModifier = (
  params: Params<typeof updateModifierEndpoint>,
  body: Body<typeof updateModifierEndpoint>,
) => callEndpoint(updateModifierEndpoint, { params, body });

export const deleteModifier = (params: Params<typeof deleteModifierEndpoint>) =>
  callEndpoint(deleteModifierEndpoint, { params });

// ---- Combos --------------------------------------------------------------

export const createCombo = (body: Body<typeof createComboEndpoint>) =>
  callEndpoint(createComboEndpoint, { body });

export const updateCombo = (
  params: Params<typeof updateComboEndpoint>,
  body: Body<typeof updateComboEndpoint>,
) => callEndpoint(updateComboEndpoint, { params, body });

export const deleteCombo = (params: Params<typeof deleteComboEndpoint>) =>
  callEndpoint(deleteComboEndpoint, { params });

// ---- Price lists ---------------------------------------------------------

export const createPriceList = (body: Body<typeof createPriceListEndpoint>) =>
  callEndpoint(createPriceListEndpoint, { body });

export const updatePriceList = (
  params: Params<typeof updatePriceListEndpoint>,
  body: Body<typeof updatePriceListEndpoint>,
) => callEndpoint(updatePriceListEndpoint, { params, body });

export const deletePriceList = (
  params: Params<typeof deletePriceListEndpoint>,
) => callEndpoint(deletePriceListEndpoint, { params });

export const setPriceListItems = (
  params: Params<typeof setPriceListItemsEndpoint>,
  body: Body<typeof setPriceListItemsEndpoint>,
) => callEndpoint(setPriceListItemsEndpoint, { params, body });

// ---- Availability --------------------------------------------------------

export const updateAvailability = (
  params: Params<typeof updateAvailabilityEndpoint>,
  body: Body<typeof updateAvailabilityEndpoint>,
) => callEndpoint(updateAvailabilityEndpoint, { params, body });

export const setAvailabilityStatus = (
  params: Params<typeof setAvailabilityStatusEndpoint>,
  body: Body<typeof setAvailabilityStatusEndpoint>,
) => callEndpoint(setAvailabilityStatusEndpoint, { params, body });

// ---- Media ---------------------------------------------------------------

export const uploadMenuImage = (body: Body<typeof uploadMenuImageEndpoint>) =>
  callEndpoint(uploadMenuImageEndpoint, { body });
