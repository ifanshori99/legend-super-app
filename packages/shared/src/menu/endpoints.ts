// Typed endpoint contracts for the menu back office (PRD v1.7 §8 "Master Menu
// & Harga": Struktur Menu, Paket & Combo, Harga per Kanal, Ketersediaan,
// Routing Stasiun, Konten Menu). The API validates with these same objects;
// the web app's typed client and mock mode read them (docs/frontend.md "Typed
// endpoints and mock mode").
//
// Scope: brand-owned records (categories, items, variants, modifier groups,
// combos) are brand scoped, outlet-owned records (stations, price lists,
// availability) are outlet scoped. `brandId` / `outletId` are optional on
// input: the server falls back to the caller's trusted brand/outlet context,
// so a client can never widen its scope by sending them (TEN-02). A submitted
// `tenantId` is rejected by `clientInputSchema`.
//
// Money is whole rupiah (`idrSchema`); dates are business dates in the outlet
// time zone (`businessDateSchema`).

import {
  z,
  uuidSchema,
  brandIdSchema,
  outletIdSchema,
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  idr,
  idrSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  availabilitySchema,
  categorySchema,
  comboSchema,
  comboComponentSchema,
  menuItemSchema,
  modifierGroupSchema,
  modifierSchema,
  priceListItemSchema,
  priceListSchema,
  scheduleSchema,
  stationSchema,
  stationTypeSchema,
  variantSchema,
  channelSchema,
} from "./schemas.ts";

const name = z.string().min(1).max(150);
const price = idrSchema.refine((value) => value >= 0);

const categoryIdParams = z.strictObject({ categoryId: uuidSchema });
const stationIdParams = z.strictObject({ stationId: uuidSchema });
const itemIdParams = z.strictObject({ itemId: uuidSchema });
const variantIdParams = z.strictObject({ variantId: uuidSchema });
const groupIdParams = z.strictObject({ groupId: uuidSchema });
const modifierIdParams = z.strictObject({ modifierId: uuidSchema });
const comboIdParams = z.strictObject({ comboId: uuidSchema });
const priceListIdParams = z.strictObject({ priceListId: uuidSchema });
const availabilityIdParams = z.strictObject({ availabilityId: uuidSchema });

const page = <Item extends z.ZodType>(item: Item) => cursorPageSchema(item);

/**
 * Back-office item shape: the stored item plus the resolved photo URL. The
 * storage workstream owns media (WS-00); the admin screen must not build a
 * URL from a raw media id.
 */
export const menuItemAdminSchema = menuItemSchema.extend({
  mediaUrl: z.string().max(2048).nullable(),
});

/**
 * Image upload for menu content (PRD §8 "Konten Menu": foto). The browser
 * resizes before sending; the API stores the bytes through the WS-00 storage
 * adapter and answers a media id plus its public URL. A future presigned-PUT
 * transport may replace the body, not the response shape.
 *
 * NOTE (review legend-cyu.12): this body (up to ~800 KB base64) exceeds the
 * API's single 100 kB JSON limit (apps/api/src/middleware/body.ts). The route
 * that implements this endpoint must mount its own larger limit for this path
 * only, or switch to the presigned-PUT transport — see the follow-up bead.
 */
export const MENU_IMAGE_MAX_BYTES = 600_000;
export const menuImageUploadInputSchema = clientInputSchema({
  fileName: z.string().min(1).max(120),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  /** Base64 (no data: prefix). Keep the request under 600 KB decoded. */
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MENU_IMAGE_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Data gambar harus base64"),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  /**
   * Outlet that hosts the stored object (media is outlet-level storage, TEN-02).
   * Optional: missing means the caller's first reachable outlet. An outlet the
   * caller does not reach is refused with 403.
   */
  outletId: uuidSchema.optional(),
});
export const menuImageSchema = z.strictObject({
  mediaId: uuidSchema,
  mediaUrl: z.string().max(2048),
});

// ---- Categories (brand scoped, display order) -----------------------------

export const categoryListQuerySchema = cursorPageQuerySchema.extend({
  brandId: brandIdSchema.optional(),
  search: z.string().max(150).optional(),
});

export const createCategoryInputSchema = clientInputSchema({
  brandId: brandIdSchema.optional(),
  name,
  parentId: uuidSchema.nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const updateCategoryInputSchema = clientInputSchema({
  name: name.optional(),
  parentId: uuidSchema.nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

/**
 * Display order (PRD §8 "urutan tampil"). `orderedIds` is the position list:
 * the id at index i gets `sortOrder = i`. Ids must all exist and share one
 * parent (one brand for categories, one category for items), else 404 / 422.
 * Rows not in the list keep their sortOrder, so send the full sibling list to
 * get a dense order. Rows already at their index are not written (no event).
 */
export const reorderInputSchema = clientInputSchema({
  orderedIds: z.array(uuidSchema).min(1).max(500),
});

export const listCategories = defineEndpoint({
  method: "GET",
  path: "/api/menu/categories",
  query: categoryListQuerySchema,
  response: page(categorySchema),
});

export const createCategory = defineEndpoint({
  method: "POST",
  path: "/api/menu/categories",
  body: createCategoryInputSchema,
  response: dataResponseSchema(categorySchema),
});

export const updateCategory = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/categories/:categoryId",
  params: categoryIdParams,
  body: updateCategoryInputSchema,
  response: dataResponseSchema(categorySchema),
});

export const deleteCategory = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/categories/:categoryId",
  params: categoryIdParams,
});

export const reorderCategories = defineEndpoint({
  method: "PUT",
  path: "/api/menu/categories/order",
  body: reorderInputSchema,
});

export { stationTypeSchema };

// ---- Stations (outlet scoped, routing) ------------------------------------

export const stationListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema.optional(),
});

export const createStationInputSchema = clientInputSchema({
  outletId: outletIdSchema.optional(),
  name,
  type: stationTypeSchema,
  printerDeviceId: uuidSchema.nullable().optional(),
  targetSeconds: z.number().int().positive().max(86_400).nullable().optional(),
});

export const updateStationInputSchema = clientInputSchema({
  name: name.optional(),
  type: stationTypeSchema.optional(),
  printerDeviceId: uuidSchema.nullable().optional(),
  targetSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  // legend-4xai: the station's `updatedAt` as the form loaded it. Required
  // with `printerDeviceId`; a newer change makes the write a 409.
  expectedUpdatedAt: isoDateTimeSchema.optional(),
});

export const listStations = defineEndpoint({
  method: "GET",
  path: "/api/menu/stations",
  query: stationListQuerySchema,
  response: page(stationSchema),
});

export const createStation = defineEndpoint({
  method: "POST",
  path: "/api/menu/stations",
  body: createStationInputSchema,
  response: dataResponseSchema(stationSchema),
});

export const updateStation = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/stations/:stationId",
  params: stationIdParams,
  body: updateStationInputSchema,
  response: dataResponseSchema(stationSchema),
});

export const deleteStation = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/stations/:stationId",
  params: stationIdParams,
});

// ---- Items (brand scoped, content, routing) -------------------------------

export const menuItemSortSchema = z.enum(["display", "name", "category"]);

export const itemListQuerySchema = cursorPageQuerySchema.extend({
  brandId: brandIdSchema.optional(),
  categoryId: uuidSchema.optional(),
  stationId: uuidSchema.optional(),
  search: z.string().max(150).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  sort: menuItemSortSchema.default("display"),
});

/**
 * New items start as drafts (owner Q23): an item needs a photo before it can be
 * active, and the import template has no photo column, so imported rows are
 * drafts too. Sending `isActive: true` is the explicit publish action and fails
 * with MENU_PHOTO_REQUIRED while `mediaId` is absent.
 */
export const createItemInputSchema = clientInputSchema({
  brandId: brandIdSchema.optional(),
  categoryId: uuidSchema,
  name,
  description: z.string().max(1000).default(""),
  type: z.enum(["single", "combo"]).default("single"),
  stationId: uuidSchema.nullable().optional(),
  stationType: stationTypeSchema.nullable().optional(),
  course: z.string().max(20).nullable().optional(),
  recipeId: uuidSchema.nullable().optional(),
  taxRuleId: uuidSchema.nullable().optional(),
  labels: z.array(name).max(20).default([]),
  allergens: z.array(name).max(30).default([]),
  mediaId: uuidSchema.nullable().optional(),
  isActive: z.boolean().default(false),
  isBreakfast: z.boolean().default(false),
  sortOrder: z.number().int().nonnegative().optional(),
});

/**
 * `isActive: true` is the activate/publish action and needs a photo (Q23): the
 * item must end up with a `mediaId`, either the stored one or one sent in the
 * same request. Clearing `mediaId` on an active item is refused until it is
 * deactivated first (MENU_PHOTO_REQUIRED).
 */
export const updateItemInputSchema = clientInputSchema({
  categoryId: uuidSchema.optional(),
  name: name.optional(),
  description: z.string().max(1000).optional(),
  type: z.enum(["single", "combo"]).optional(),
  stationId: uuidSchema.nullable().optional(),
  stationType: stationTypeSchema.nullable().optional(),
  course: z.string().max(20).nullable().optional(),
  recipeId: uuidSchema.nullable().optional(),
  taxRuleId: uuidSchema.nullable().optional(),
  labels: z.array(name).max(20).optional(),
  allergens: z.array(name).max(30).optional(),
  mediaId: uuidSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  isBreakfast: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

/** Modifier groups attached to an item, in display order. */
export const itemModifierGroupsSchema = z.strictObject({
  groupIds: z.array(uuidSchema).max(20),
});

export const setItemModifierGroupsInputSchema = clientInputSchema({
  groupIds: z.array(uuidSchema).max(20),
});

export const listItems = defineEndpoint({
  method: "GET",
  path: "/api/menu/items",
  query: itemListQuerySchema,
  response: page(menuItemAdminSchema),
});

export const getItem = defineEndpoint({
  method: "GET",
  path: "/api/menu/items/:itemId",
  params: itemIdParams,
  response: dataResponseSchema(menuItemAdminSchema),
});

export const createItem = defineEndpoint({
  method: "POST",
  path: "/api/menu/items",
  body: createItemInputSchema,
  response: dataResponseSchema(menuItemAdminSchema),
});

export const updateItem = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/items/:itemId",
  params: itemIdParams,
  body: updateItemInputSchema,
  response: dataResponseSchema(menuItemAdminSchema),
});

export const deleteItem = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/items/:itemId",
  params: itemIdParams,
});

export const reorderItems = defineEndpoint({
  method: "PUT",
  path: "/api/menu/items/order",
  body: reorderInputSchema,
});

export const getItemModifierGroups = defineEndpoint({
  method: "GET",
  path: "/api/menu/items/:itemId/modifier-groups",
  params: itemIdParams,
  response: dataResponseSchema(itemModifierGroupsSchema),
});

export const setItemModifierGroups = defineEndpoint({
  method: "PUT",
  path: "/api/menu/items/:itemId/modifier-groups",
  params: itemIdParams,
  body: setItemModifierGroupsInputSchema,
  response: dataResponseSchema(itemModifierGroupsSchema),
});

// ---- Variants -------------------------------------------------------------

export const variantListQuerySchema = cursorPageQuerySchema;

export const createVariantInputSchema = clientInputSchema({
  name,
  recipeId: uuidSchema.nullable().optional(),
});

export const updateVariantInputSchema = clientInputSchema({
  name: name.optional(),
  recipeId: uuidSchema.nullable().optional(),
});

export const listVariants = defineEndpoint({
  method: "GET",
  path: "/api/menu/items/:itemId/variants",
  params: itemIdParams,
  query: variantListQuerySchema,
  response: page(variantSchema),
});

export const createVariant = defineEndpoint({
  method: "POST",
  path: "/api/menu/items/:itemId/variants",
  params: itemIdParams,
  body: createVariantInputSchema,
  response: dataResponseSchema(variantSchema),
});

export const updateVariant = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/variants/:variantId",
  params: variantIdParams,
  body: updateVariantInputSchema,
  response: dataResponseSchema(variantSchema),
});

export const deleteVariant = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/variants/:variantId",
  params: variantIdParams,
});

// ---- Modifier groups and modifiers ---------------------------------------

export const modifierGroupListQuerySchema = cursorPageQuerySchema.extend({
  search: z.string().max(150).optional(),
});

export const createModifierGroupInputSchema = clientInputSchema({
  name,
  minSelect: z.number().int().nonnegative().max(50).default(0),
  maxSelect: z.number().int().nonnegative().max(50).default(1),
}).refine((value) => value.minSelect <= value.maxSelect, {
  path: ["maxSelect"],
  message: "Jumlah maksimum tidak boleh kurang dari minimum",
});

// A partial update cannot see the stored side, so the API re-checks
// min <= max against the merged row; when both arrive, reject here too.
export const updateModifierGroupInputSchema = clientInputSchema({
  name: name.optional(),
  minSelect: z.number().int().nonnegative().max(50).optional(),
  maxSelect: z.number().int().nonnegative().max(50).optional(),
}).refine(
  (value) =>
    value.minSelect === undefined ||
    value.maxSelect === undefined ||
    value.minSelect <= value.maxSelect,
  {
    path: ["maxSelect"],
    message: "Jumlah maksimum tidak boleh kurang dari minimum",
  },
);

export const createModifierInputSchema = clientInputSchema({
  name,
  priceIdr: price.default(idr(0)),
  recipeId: uuidSchema.nullable().optional(),
  stationId: uuidSchema.nullable().optional(),
});

export const updateModifierInputSchema = clientInputSchema({
  name: name.optional(),
  priceIdr: price.optional(),
  recipeId: uuidSchema.nullable().optional(),
  stationId: uuidSchema.nullable().optional(),
});

export const modifierListQuerySchema = cursorPageQuerySchema;

export const listModifierGroups = defineEndpoint({
  method: "GET",
  path: "/api/menu/modifier-groups",
  query: modifierGroupListQuerySchema,
  response: page(modifierGroupSchema),
});

export const createModifierGroup = defineEndpoint({
  method: "POST",
  path: "/api/menu/modifier-groups",
  body: createModifierGroupInputSchema,
  response: dataResponseSchema(modifierGroupSchema),
});

export const updateModifierGroup = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/modifier-groups/:groupId",
  params: groupIdParams,
  body: updateModifierGroupInputSchema,
  response: dataResponseSchema(modifierGroupSchema),
});

export const deleteModifierGroup = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/modifier-groups/:groupId",
  params: groupIdParams,
});

export const listModifiers = defineEndpoint({
  method: "GET",
  path: "/api/menu/modifier-groups/:groupId/modifiers",
  params: groupIdParams,
  query: modifierListQuerySchema,
  response: page(modifierSchema),
});

export const createModifier = defineEndpoint({
  method: "POST",
  path: "/api/menu/modifier-groups/:groupId/modifiers",
  params: groupIdParams,
  body: createModifierInputSchema,
  response: dataResponseSchema(modifierSchema),
});

export const updateModifier = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/modifiers/:modifierId",
  params: modifierIdParams,
  body: updateModifierInputSchema,
  response: dataResponseSchema(modifierSchema),
});

export const deleteModifier = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/modifiers/:modifierId",
  params: modifierIdParams,
});

// ---- Combos (PRD §8 "Paket & Combo": contents + revenue allocation) -------

export const comboListQuerySchema = cursorPageQuerySchema.extend({
  search: z.string().max(150).optional(),
});

export const createComboInputSchema = clientInputSchema({
  comboItemId: uuidSchema,
  components: z.array(comboComponentSchema).min(1),
}).refine(
  (value) =>
    value.components.reduce((sum, c) => sum + c.revenueAllocationBp, 0) ===
    10000,
  { path: ["components"], message: "Alokasi pendapatan harus berjumlah 100%" },
);

export const updateComboInputSchema = clientInputSchema({
  components: z.array(comboComponentSchema).min(1),
}).refine(
  (value) =>
    value.components.reduce((sum, c) => sum + c.revenueAllocationBp, 0) ===
    10000,
  { path: ["components"], message: "Alokasi pendapatan harus berjumlah 100%" },
);

export const listCombos = defineEndpoint({
  method: "GET",
  path: "/api/menu/combos",
  query: comboListQuerySchema,
  response: page(comboSchema),
});

export const createCombo = defineEndpoint({
  method: "POST",
  path: "/api/menu/combos",
  body: createComboInputSchema,
  response: dataResponseSchema(comboSchema),
});

export const updateCombo = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/combos/:comboId",
  params: comboIdParams,
  body: updateComboInputSchema,
  response: dataResponseSchema(comboSchema),
});

export const deleteCombo = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/combos/:comboId",
  params: comboIdParams,
});

// ---- Channel price lists (PRD §8 "Harga per Kanal", effective dates) ------

export const priceListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema.optional(),
  channel: channelSchema.optional(),
});

export const createPriceListInputSchema = clientInputSchema({
  outletId: outletIdSchema.optional(),
  channel: channelSchema,
  effectiveFrom: businessDateSchema,
});

export const updatePriceListInputSchema = clientInputSchema({
  effectiveFrom: businessDateSchema.optional(),
});

export const priceListEntrySchema = clientInputSchema({
  itemId: uuidSchema,
  variantId: uuidSchema.nullable().default(null),
  priceIdr: price,
});

/** Saving the price grid is one write: the body is the complete entry list. */
export const setPriceListItemsInputSchema = clientInputSchema({
  items: z.array(priceListEntrySchema).max(1000),
});

export const listPriceLists = defineEndpoint({
  method: "GET",
  path: "/api/menu/price-lists",
  query: priceListQuerySchema,
  response: page(priceListSchema),
});

export const createPriceList = defineEndpoint({
  method: "POST",
  path: "/api/menu/price-lists",
  body: createPriceListInputSchema,
  response: dataResponseSchema(priceListSchema),
});

export const updatePriceList = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/price-lists/:priceListId",
  params: priceListIdParams,
  body: updatePriceListInputSchema,
  response: dataResponseSchema(priceListSchema),
});

export const deletePriceList = defineEndpoint({
  method: "DELETE",
  path: "/api/menu/price-lists/:priceListId",
  params: priceListIdParams,
});

export const listPriceListItems = defineEndpoint({
  method: "GET",
  path: "/api/menu/price-lists/:priceListId/items",
  params: priceListIdParams,
  query: cursorPageQuerySchema,
  response: page(priceListItemSchema),
});

export const setPriceListItems = defineEndpoint({
  method: "PUT",
  path: "/api/menu/price-lists/:priceListId/items",
  params: priceListIdParams,
  body: setPriceListItemsInputSchema,
});

// ---- Availability: schedules, daily limits, 86 (PRD §8 "Ketersediaan") ----

export const availabilityQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema.optional(),
  status: z.enum(["available", "sold_out"]).optional(),
});

export const updateAvailabilityInputSchema = clientInputSchema({
  schedule: z.array(scheduleSchema).max(20).optional(),
  dailyLimit: z.number().int().nonnegative().max(100_000).nullable().optional(),
  soldOutUntil: isoDateTimeSchema.nullable().optional(),
});

export const availabilityActionSchema = z.enum(["sell_out", "restore"]);

/**
 * 86 toggle. Broadcasts to every sales channel (PRD §8), so a retry must not
 * emit a second event: the client sends one idempotency key per action.
 */
export const availabilityActionInputSchema = clientInputSchema({
  action: availabilityActionSchema,
  soldOutUntil: isoDateTimeSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const listAvailability = defineEndpoint({
  method: "GET",
  path: "/api/menu/availability",
  query: availabilityQuerySchema,
  response: page(availabilitySchema),
});

export const updateAvailability = defineEndpoint({
  method: "PATCH",
  path: "/api/menu/availability/:availabilityId",
  params: availabilityIdParams,
  body: updateAvailabilityInputSchema,
  response: dataResponseSchema(availabilitySchema),
});

export const setAvailabilityStatus = defineEndpoint({
  method: "POST",
  path: "/api/menu/availability/:availabilityId/status",
  params: availabilityIdParams,
  body: availabilityActionInputSchema,
  response: dataResponseSchema(availabilitySchema),
});

// ---- Media (menu content photos) -----------------------------------------

export const uploadMenuImage = defineEndpoint({
  method: "POST",
  path: "/api/menu/media",
  body: menuImageUploadInputSchema,
  response: dataResponseSchema(menuImageSchema),
});

export type MenuItemAdmin = z.infer<typeof menuItemAdminSchema>;
export type MenuImage = z.infer<typeof menuImageSchema>;
export type MenuItemListQuery = z.infer<typeof itemListQuerySchema>;
export type MenuImageUploadInput = z.infer<typeof menuImageUploadInputSchema>;
export type AvailabilityActionInput = z.infer<
  typeof availabilityActionInputSchema
>;
export type PriceListEntry = z.infer<typeof priceListEntrySchema>;
export type ReorderInput = z.infer<typeof reorderInputSchema>;
