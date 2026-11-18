import {
  z,
  uuidSchema,
  tenantIdSchema,
  brandIdSchema,
  outletIdSchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
} from "../core/index.ts";
import { eventCatalogEntrySchema } from "../events/catalog.ts";

const name = z.string().min(1).max(150);
const scope = { id: uuidSchema, tenantId: tenantIdSchema };
const outletScope = { ...scope, outletId: outletIdSchema };
const price = idrSchema.refine((value) => value >= 0);
export const categorySchema = z.strictObject({
  ...scope,
  brandId: brandIdSchema,
  name,
  parentId: uuidSchema.nullable(),
  sortOrder: z.number().int(),
});
export const stationSchema = z.strictObject({
  ...outletScope,
  name,
  type: z.string().min(1).max(20),
  printerDeviceId: uuidSchema.nullable(),
  targetSeconds: z.number().int().positive().nullable(),
  updatedAt: isoDateTimeSchema,
});
export const stationTypeSchema = z.enum([
  "coffee_bar",
  "beverage_bar",
  "hot_kitchen",
  "cold_kitchen",
  "pastry",
]);
export const menuItemSchema = z.strictObject({
  ...scope,
  brandId: brandIdSchema,
  categoryId: uuidSchema,
  name,
  description: z.string(),
  type: z.enum(["single", "combo"]),
  stationId: uuidSchema.nullable(),
  /**
   * Brand-level station TYPE; each outlet resolves it to its own station of
   * that type, and `stationId` is only an override inside its outlet
   * (legend-s2dh). Optional in the DTO so older payloads and mocks still
   * parse; the API always sends it.
   */
  stationType: stationTypeSchema.nullable().optional(),
  course: z.string().max(20).nullable(),
  recipeId: uuidSchema.nullable(),
  taxRuleId: uuidSchema.nullable(),
  labels: z.array(name),
  allergens: z.array(name),
  mediaId: uuidSchema.nullable(),
  isActive: z.boolean(),
  /** legend-lgyfh: offered in the facility breakfast menu (default false). */
  isBreakfast: z.boolean().default(false),
  sortOrder: z.number().int(),
});
export const variantSchema = z.strictObject({
  ...scope,
  menuItemId: uuidSchema,
  name,
  recipeId: uuidSchema.nullable(),
});
export const modifierGroupSchema = z
  .strictObject({
    ...scope,
    name,
    minSelect: z.number().int().nonnegative(),
    maxSelect: z.number().int().nonnegative(),
  })
  .refine((v) => v.minSelect <= v.maxSelect, {
    path: ["maxSelect"],
    message: "Maximum must be at least minimum",
  });
export const modifierSchema = z.strictObject({
  ...scope,
  groupId: uuidSchema,
  name,
  priceIdr: price,
  recipeId: uuidSchema.nullable(),
  stationId: uuidSchema.nullable(),
});
/**
 * Item ↔ modifier group link: one row of `menu_item_modifier_groups`. The
 * table has no id of its own; (itemId, groupId) is unique and `sortOrder` is
 * the display position inside the item (0-based, dense after every write).
 */
export const itemModifierGroupLinkSchema = z.strictObject({
  itemId: uuidSchema,
  groupId: uuidSchema,
  sortOrder: z.number().int().nonnegative(),
});
export const comboComponentSchema = z.strictObject({
  menuItemId: uuidSchema,
  options: z.array(uuidSchema),
  revenueAllocationBp: basisPointsSchema,
});
export const comboSchema = z
  .strictObject({
    ...scope,
    comboItemId: uuidSchema,
    components: z.array(comboComponentSchema).min(1),
  })
  .refine(
    (v) =>
      v.components.reduce((sum, c) => sum + c.revenueAllocationBp, 0) === 10000,
    {
      path: ["components"],
      message: "Revenue allocations must total 10000 basis points",
    },
  );
export const channelSchema = z.enum([
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
]);
export const priceListSchema = z.strictObject({
  ...outletScope,
  channel: channelSchema,
  effectiveFrom: businessDateSchema,
});
export const priceListItemSchema = z.strictObject({
  ...scope,
  priceListId: uuidSchema,
  itemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  priceIdr: price,
});
export const scheduleSchema = z.strictObject({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export const availabilitySchema = z.strictObject({
  ...outletScope,
  menuItemId: uuidSchema,
  schedule: z.array(scheduleSchema),
  dailyLimit: z.number().int().nonnegative().nullable(),
  soldOutUntil: isoDateTimeSchema.nullable(),
  status: z.enum(["available", "sold_out"]),
});
export type AvailabilityStatus = z.infer<typeof availabilitySchema>["status"];
export type AvailabilityAction = "sell_out" | "restore";
const transitions: Record<
  AvailabilityStatus,
  Partial<Record<AvailabilityAction, AvailabilityStatus>>
> = { available: { sell_out: "sold_out" }, sold_out: { restore: "available" } };
export function transitionAvailability(
  status: AvailabilityStatus,
  action: AvailabilityAction,
): AvailabilityStatus {
  const next = transitions[status]?.[action];
  if (!next) throw new RangeError("Invalid availability transition");
  return next;
}
/**
 * One row of the bulk import template (PRD §8 "Impor Massal"). The template has
 * no photo column, so an imported item is created as a draft: it cannot be
 * active until someone uploads its photo (owner Q23).
 */
export const importRowSchema = z.strictObject({
  category: name,
  name,
  description: z.string(),
  type: z.enum(["single", "combo"]),
  priceIdr: price,
  station: name,
  course: z.string().max(20),
  labels: z.array(name),
  allergens: z.array(name),
});
export const menuFixtureSchema = z.strictObject({
  categories: z.array(categorySchema),
  stations: z.array(stationSchema),
  items: z.array(menuItemSchema),
  variants: z.array(variantSchema),
  modifierGroups: z.array(modifierGroupSchema),
  modifiers: z.array(modifierSchema),
  itemModifierGroups: z.array(itemModifierGroupLinkSchema),
  combos: z.array(comboSchema),
  priceLists: z.array(priceListSchema),
  priceListItems: z.array(priceListItemSchema),
  availability: z.array(availabilitySchema),
  importRows: z.array(importRowSchema),
});
export const menuEventCatalog = [
  "menu.updated",
  "item.sold_out",
  "item.restored",
].map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-03",
  }),
);
export type Category = z.infer<typeof categorySchema>;
export type Station = z.infer<typeof stationSchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type ModifierGroup = z.infer<typeof modifierGroupSchema>;
export type Modifier = z.infer<typeof modifierSchema>;
export type ItemModifierGroupLink = z.infer<typeof itemModifierGroupLinkSchema>;
export type Combo = z.infer<typeof comboSchema>;
export type PriceList = z.infer<typeof priceListSchema>;
export type PriceListItem = z.infer<typeof priceListItemSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type MenuImportRow = z.infer<typeof importRowSchema>;
export type MenuFixture = z.infer<typeof menuFixtureSchema>;
export type MenuChannel = z.infer<typeof channelSchema>;
export type MenuSchedule = z.infer<typeof scheduleSchema>;
