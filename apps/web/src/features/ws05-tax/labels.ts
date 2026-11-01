// Catalog keys for every enum the tax screens render. The values are data
// from the contract; the text is always the catalog's (DESIGN.md "Do").
import type { MessageKey } from "@starter/shared/i18n";
import type {
  ItemTaxClass,
  PackageAllocationMethod,
  RuleVersionStatus,
  TaxChannel,
  TaxType,
} from "@starter/shared/tax";
import type { RoundingMode } from "@starter/shared/core";

export const TAX_TYPE_KEYS: Record<TaxType, MessageKey> = {
  pbjt: "tax.taxType.pbjt",
  ppn: "tax.taxType.ppn",
  other: "tax.taxType.other",
};

export const CHANNEL_KEYS: Record<TaxChannel, MessageKey> = {
  dine_in: "tax.channels.dine_in",
  takeaway: "tax.channels.takeaway",
  gofood: "tax.channels.gofood",
  grabfood: "tax.channels.grabfood",
  shopeefood: "tax.channels.shopeefood",
  reservation: "tax.channels.reservation",
};

export const ITEM_CLASS_KEYS: Record<ItemTaxClass, MessageKey> = {
  food_beverage: "tax.itemClass.food_beverage",
  facility: "tax.itemClass.facility",
};

export const VERSION_STATUS_KEYS: Record<RuleVersionStatus, MessageKey> = {
  draft: "tax.versionStatus.draft",
  published: "tax.versionStatus.published",
  archived: "tax.versionStatus.archived",
};

export const ROUNDING_KEYS: Record<RoundingMode, MessageKey> = {
  half_up: "tax.rounding.half_up",
  half_even: "tax.rounding.half_even",
  down: "tax.rounding.down",
  floor: "tax.rounding.floor",
  ceil: "tax.rounding.ceil",
};

export const PACKAGE_ALLOCATION_KEYS: Record<
  PackageAllocationMethod,
  MessageKey
> = {
  fixed_bp: "tax.packageAllocation.fixed_bp",
  standalone_price_ratio: "tax.packageAllocation.standalone_price_ratio",
};

/** Channels in contract order, for the multi-select checkboxes. */
export const TAX_CHANNELS: readonly TaxChannel[] = [
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
];

/** Classes in contract order, for the multi-select checkboxes. */
export const ITEM_CLASSES: readonly ItemTaxClass[] = [
  "food_beverage",
  "facility",
];
