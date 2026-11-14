// Catalog down-sync cloud -> outlet edge (bead legend-97p; PRD v1.7 §3 F8
// Master Menu & Harga, §3 F16 Resep & BOM, §5 "cloud wins" for master data).
// `GET /api/edge-sync/catalog?stream=<stream>&since=<cursor>&limit=<1..100>`.
//
// One stream per table; the edge pulls stream by stream and keeps one cursor
// per stream. Rows are read-only on the edge (never written back to the cloud
// through this path). Amounts are copied exactly: `priceIdr` is the whole
// rupiah integer of the cloud row, `quantity` / `theoreticalCostIdr` the exact
// NUMERIC(14,4) decimal string. Nothing is converted or rounded in transit.
//
// Tombstones: a soft-deleted row travels with `deletedAt` set (the edge removes
// or hides its copy). `recipes` have no tombstone (deactivated through
// `isActive`, never deleted). Recipes and price lists travel as WHOLE
// documents: a `recipes` record carries all its lines (`lines`), a `price_lists`
// record carries all its live items (`items`). There are no `recipe_lines` or
// `price_list_items` streams: the cloud bumps the parent's `updated_at` on every
// line / item change, so one parent version always matches its children and the
// edge replaces the children in the same transaction (a header never exists
// without its lines / items, and two versions never mix).
//
// Scope: the edge only receives the brand of its own outlet (`outlets.brand_id`
// of the credential) for categories, items and recipes; price lists are only
// those of its own outlet.
//
// Version stamp (bead legend-24318): every record carries `syncTxid`, the id of
// the cloud transaction that last wrote the row (decimal digits, compare as
// BigInt). Records of `price_lists` and `recipes` carry the PARENT's stamp (the
// children travel inside the parent document). The cloud only sends rows whose
// stamp is below the oldest still-open transaction and pages in
// `(syncTxid, key)` order. The edge replaces a local row only when the incoming
// `syncTxid` is strictly greater than the stored one, so an older copy never
// overwrites a newer one, whatever order pages arrive in.
//
// Cursor is opaque to the edge. `nextCursor` is the position of the last
// record of the page (or the echoed `since` for an empty page, null when the
// stream has never produced a row): the edge stores it as the checkpoint once
// the page is applied. `hasMore` says whether another page follows. Cursors
// are tagged `cat2` (`["cat2", "<syncTxid>", ...keys]`); an older tag (`cat1`)
// or a malformed cursor is rejected and the edge pulls the stream from the
// start again (applying is idempotent).

import {
  businessDateSchema,
  cursorSchema,
  decimal4Schema,
  idrSchema,
  isoDateTimeSchema,
  PAGE_LIMIT_MAX,
  uuidSchema,
  userIdSchema,
  z,
} from "../core/index.ts";

import {
  promotionObjectSchema,
  promotionOutletScopeSchema,
  promoStackingPolicySchema,
  voucherObjectSchema,
} from "../crm/promo.ts";

export const EDGE_CATALOG_SYNC_PATH = "/api/edge-sync/catalog";

/**
 * Pull order. `stations` and `inventory_items` come first so the rows that
 * items, modifiers and recipes point to (`stationId`, `outputItemId`) already
 * exist on the edge when those streams are applied. `recipes` follow right
 * after `inventory_items` and before `menu_items` and `item_variants`: those
 * carry `recipe_id` with a composite foreign key to `recipes` on the edge too
 * (legend-3kdd). `modifiers` carry `recipe_id` without that key on the edge
 * (recipes are brand-scoped, modifiers tenant-level) and do not wait.
 */
export const CATALOG_SYNC_STREAMS = [
  "stations",
  "printers",
  "inventory_items",
  "recipes",
  "menu_categories",
  "modifier_groups",
  "modifiers",
  "menu_items",
  "item_variants",
  "menu_item_modifier_groups",
  "price_lists",
  "promotions",
  "vouchers",
] as const;
export const catalogSyncStreamSchema = z.enum(CATALOG_SYNC_STREAMS);
export type CatalogSyncStream = z.infer<typeof catalogSyncStreamSchema>;

export const CATALOG_SYNC_LIMIT_DEFAULT = PAGE_LIMIT_MAX;

/**
 * Catalog sync protocol version the cloud stamps on every page, empty pages
 * included, when the request says the edge understands it (`protocolVersion`
 * query parameter). Raise it when the page contract changes in a way an older
 * edge or cloud must not apply.
 *
 * Release order: cloud first, then edge. An older edge (strict page schema,
 * no parameter) gets pages without the field, as before. A newer edge asks for
 * the version; an older cloud rejects the unknown parameter (HTTP 400), which
 * the edge reports as CATALOG_CLOUD_OUTDATED.
 */
export const CATALOG_PROTOCOL_VERSION = 2;
/** Oldest cloud version the edge still accepts (first one with `syncTxid`). */
export const CATALOG_PROTOCOL_MIN_VERSION = 2;

export const catalogSyncQuerySchema = z.strictObject({
  stream: catalogSyncStreamSchema,
  since: cursorSchema.optional(),
  /** Highest page protocol the edge understands; absent on an older edge. */
  protocolVersion: z.coerce.number().int().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(CATALOG_SYNC_LIMIT_DEFAULT),
});
export type CatalogSyncQuery = z.infer<typeof catalogSyncQuerySchema>;

const STATION_TYPES = [
  "coffee_bar",
  "beverage_bar",
  "hot_kitchen",
  "cold_kitchen",
  "pastry",
] as const;
const MENU_CHANNELS = [
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
] as const;

const name = z.string().min(1).max(150);

/** Decimal digits of the cloud `sync_txid` BIGINT; compare with BigInt. */
export const syncTxidSchema = z.string().regex(/^\d+$/);
const stamps = {
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable(),
  syncTxid: syncTxidSchema,
};

/** Production routing per outlet; scope = the credential's outlet. */
export const stationSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  name,
  type: z.enum(STATION_TYPES),
  /** Plain UUID (no `devices` row required on the edge). */
  printerDeviceId: uuidSchema.nullable(),
  targetSeconds: z.number().int().nullable(),
  ...stamps,
});

/**
 * Printer registry of an outlet (legend-fbf4v); scope = the credential's
 * outlet. The cloud deletes a printer for good, so a deletion travels as a
 * TOMBSTONE record (`id`, scope, `deletedAt`) and the edge removes its row.
 * `status`, `lastSeenAt` and `offlineSince` are measured by the print agent on
 * the edge and never travel. `stationId` and the fallback are plain UUIDs.
 */
const livePrinterSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  label: z.string().min(1).max(255),
  role: z.enum(["receipt", "station"]),
  stationId: uuidSchema.nullable(),
  transport: z.enum(["network", "usb"]),
  host: z.string().max(255).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  devicePath: z.string().max(255).nullable(),
  paperWidth: z.union([z.literal(32), z.literal(48)]),
  fallbackPrinterId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: z.null(),
  syncTxid: syncTxidSchema,
});
const printerTombstoneSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  deletedAt: isoDateTimeSchema,
  syncTxid: syncTxidSchema,
});
export const printerSyncRecordSchema = z.union([
  livePrinterSyncRecordSchema,
  printerTombstoneSyncRecordSchema,
]);

/**
 * Tenant-wide raw material / semi-finished good. No tombstone in the cloud
 * (switched off with `isActive`, never deleted). `idempotencyKey` is not sent.
 * `parMin` / `parMax` are the exact NUMERIC(14,4) decimal strings.
 */
export const inventoryItemSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  name,
  category: z.string().min(1).max(50),
  type: z.enum(["raw_material", "semi_finished"]),
  baseUomId: uuidSchema,
  isPerishable: z.boolean(),
  isActive: z.boolean(),
  parMin: decimal4Schema.nullable(),
  parMax: decimal4Schema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  syncTxid: syncTxidSchema,
});

export const menuCategorySyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  brandId: uuidSchema,
  name,
  parentId: uuidSchema.nullable(),
  sortOrder: z.number().int(),
  ...stamps,
});

export const menuItemSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  brandId: uuidSchema,
  categoryId: uuidSchema,
  name,
  description: z.string(),
  type: z.enum(["single", "combo"]),
  stationId: uuidSchema.nullable(),
  stationType: z.enum(STATION_TYPES).nullable(),
  course: z.string().max(20).nullable(),
  recipeId: uuidSchema.nullable(),
  taxRuleId: uuidSchema.nullable(),
  labels: z.array(z.string()),
  allergens: z.array(z.string()),
  mediaId: uuidSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  ...stamps,
});

export const itemVariantSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  menuItemId: uuidSchema,
  name,
  recipeId: uuidSchema.nullable(),
  ...stamps,
});

export const modifierGroupSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  name,
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(0).max(50),
  ...stamps,
});

export const modifierSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  groupId: uuidSchema,
  name,
  /** Whole rupiah, exactly the cloud value. */
  priceIdr: idrSchema,
  recipeId: uuidSchema.nullable(),
  stationId: uuidSchema.nullable(),
  ...stamps,
});

/** Join row; no `id` column in the cloud: the key is (menuItemId, groupId). */
export const menuItemModifierGroupSyncRecordSchema = z.strictObject({
  tenantId: uuidSchema,
  menuItemId: uuidSchema,
  groupId: uuidSchema,
  sortOrder: z.number().int(),
  ...stamps,
});

/**
 * One live item of a price list. Only live (not soft-deleted) items travel, so
 * there is no `deletedAt`: an item missing from `items` is gone.
 */
export const priceListItemRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  priceListId: uuidSchema,
  itemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  /** Whole rupiah, exactly the cloud value. Never converted or rounded. */
  priceIdr: idrSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * `items` = ALL live items of the list at export time (empty when none), read
 * in the same statement as the header: the edge replaces its items with this
 * set (deletes the others) in the same transaction as the header upsert.
 */
export const priceListSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  channel: z.enum(MENU_CHANNELS),
  effectiveFrom: businessDateSchema,
  items: z.array(priceListItemRecordSchema),
  ...stamps,
});

/** One line of a recipe; no `updated_at` / `deleted_at` in the cloud. */
export const recipeLineRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  recipeId: uuidSchema,
  sortOrder: z.number().int(),
  componentType: z.enum(["item", "recipe"]),
  componentId: uuidSchema,
  quantity: decimal4Schema,
  uomId: uuidSchema,
  wastePctBp: z.number().int().min(0).max(9999),
});

/**
 * No tombstone: a recipe is deactivated (`isActive`), never deleted.
 * `lines` = ALL lines the recipe has in the cloud at export time (empty when
 * every line was removed), read in the same statement as the recipe row: the
 * edge replaces its lines with this set (deletes the others) in the same
 * transaction as the recipe upsert.
 */
export const recipeSyncRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  brandId: uuidSchema,
  name,
  outputItemId: uuidSchema.nullable(),
  yieldQuantity: decimal4Schema,
  yieldUomId: uuidSchema,
  version: z.number().int().min(1),
  isActive: z.boolean(),
  theoreticalCostIdr: decimal4Schema,
  updatedBy: z.string().min(1),
  lines: z.array(recipeLineRecordSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  syncTxid: syncTxidSchema,
});

/**
 * A complete rule document, including the requesting outlet's switch. The
 * promo code hash never travels (a SHA-256 of a short code is brute-forceable
 * if an outlet disk is stolen): `codeRef` is an irreversible stand-in derived
 * from the promotion id, `null` when the promotion has no code. The edge
 * refuses every code anyway (Q66), so it never needs the real hash.
 */
export const promotionSyncRecordSchema = promotionObjectSchema
  .omit({ codeHash: true })
  .extend({
    codeRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    outletId: uuidSchema,
    outletScope: promotionOutletScopeSchema,
    usesTotal: z.number().int().nonnegative(),
    createdBy: userIdSchema.nullable(),
    updatedBy: userIdSchema.nullable(),
    syncTxid: syncTxidSchema,
    outletOverrides: z.array(
      z.strictObject({
        outletId: uuidSchema,
        enabled: z.boolean(),
        updatedBy: userIdSchema.nullable(),
        updatedAt: isoDateTimeSchema,
      }),
    ),
    stackingSettings: z
      .strictObject({
        stackingPolicy: promoStackingPolicySchema,
        updatedBy: userIdSchema.nullable(),
        updatedAt: isoDateTimeSchema,
        syncTxid: syncTxidSchema,
      })
      .nullable(),
  });

/** Single-use state travels read-only; edge redemption requires cloud authority. */
export const voucherSyncRecordSchema = voucherObjectSchema
  .omit({ codeHash: true })
  .extend({
    issuedBy: userIdSchema.nullable(),
    syncTxid: syncTxidSchema,
  });

export const catalogSyncRecordSchemas = {
  stations: stationSyncRecordSchema,
  printers: printerSyncRecordSchema,
  inventory_items: inventoryItemSyncRecordSchema,
  menu_categories: menuCategorySyncRecordSchema,
  modifier_groups: modifierGroupSyncRecordSchema,
  modifiers: modifierSyncRecordSchema,
  menu_items: menuItemSyncRecordSchema,
  item_variants: itemVariantSyncRecordSchema,
  menu_item_modifier_groups: menuItemModifierGroupSyncRecordSchema,
  price_lists: priceListSyncRecordSchema,
  recipes: recipeSyncRecordSchema,
  promotions: promotionSyncRecordSchema,
  vouchers: voucherSyncRecordSchema,
} as const;

export type StationSyncRecord = z.infer<typeof stationSyncRecordSchema>;
export type PrinterSyncRecord = z.infer<typeof printerSyncRecordSchema>;
export type InventoryItemSyncRecord = z.infer<
  typeof inventoryItemSyncRecordSchema
>;
export type MenuCategorySyncRecord = z.infer<
  typeof menuCategorySyncRecordSchema
>;
export type MenuItemSyncRecord = z.infer<typeof menuItemSyncRecordSchema>;
export type ItemVariantSyncRecord = z.infer<typeof itemVariantSyncRecordSchema>;
export type ModifierGroupSyncRecord = z.infer<
  typeof modifierGroupSyncRecordSchema
>;
export type ModifierSyncRecord = z.infer<typeof modifierSyncRecordSchema>;
export type MenuItemModifierGroupSyncRecord = z.infer<
  typeof menuItemModifierGroupSyncRecordSchema
>;
export type PriceListSyncRecord = z.infer<typeof priceListSyncRecordSchema>;
export type PriceListItemRecord = z.infer<typeof priceListItemRecordSchema>;
export type RecipeSyncRecord = z.infer<typeof recipeSyncRecordSchema>;
export type RecipeLineRecord = z.infer<typeof recipeLineRecordSchema>;
export type PromotionSyncRecord = z.infer<typeof promotionSyncRecordSchema>;
export type VoucherSyncRecord = z.infer<typeof voucherSyncRecordSchema>;

export type CatalogSyncRecordOf<S extends CatalogSyncStream> = z.infer<
  (typeof catalogSyncRecordSchemas)[S]
>;

function pageOf<S extends CatalogSyncStream>(stream: S) {
  return z.strictObject({
    /**
     * Explicit protocol version, sent only to an edge that asked for it. The
     * edge checks it before parsing the page and refuses a page without it.
     */
    protocolVersion: z.number().int().min(1).optional(),
    stream: z.literal(stream),
    records: z.array(catalogSyncRecordSchemas[stream]),
    /** Position after the last record; the checkpoint once the page is applied. */
    nextCursor: cursorSchema.nullable(),
    hasMore: z.boolean(),
  });
}

export const catalogSyncPageSchema = z.discriminatedUnion("stream", [
  pageOf("stations"),
  pageOf("printers"),
  pageOf("inventory_items"),
  pageOf("recipes"),
  pageOf("menu_categories"),
  pageOf("modifier_groups"),
  pageOf("modifiers"),
  pageOf("menu_items"),
  pageOf("item_variants"),
  pageOf("menu_item_modifier_groups"),
  pageOf("price_lists"),
  pageOf("promotions"),
  pageOf("vouchers"),
]);
export type CatalogSyncPage = z.infer<typeof catalogSyncPageSchema>;
