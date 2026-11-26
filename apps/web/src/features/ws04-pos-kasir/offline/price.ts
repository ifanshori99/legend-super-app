// O3 pricing of an offline sale from the kit alone (bead legend-wasr7.7).
// The tablet only knows the kit: list prices of the dine-in/takeaway
// catalogue, the tax and service-charge rules. No promo, voucher, points or
// manual discount offline (CTO O2: "Promo tidak berlaku saat offline"), no
// table zone. The figures are computed by the shared tax engine the cloud uses
// to check them (pos-offline-batch `amountsMatchSnapshot`); the cloud never
// recomputes the money, it only flags a difference.
import { createUlid, idr } from "@starter/shared/core";
import {
  OFFLINE_KIT_SERVICE_TYPES,
  type OfflineSaleLine,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { calculateTax, type TaxCalculationInput } from "@starter/shared/tax";

export type OfflineServiceType = (typeof OFFLINE_KIT_SERVICE_TYPES)[number];

export type OfflineCartLine = {
  menuItemId: string;
  variantId: string | null;
  quantity: number;
  /** Chosen modifier options (catalogue option ids). */
  modifierIds: readonly string[];
};

export type OfflineCart = {
  serviceType: OfflineServiceType;
  lines: readonly OfflineCartLine[];
};

export type OfflinePricedSale = {
  serviceType: OfflineServiceType;
  lines: OfflineSaleLine[];
  subtotalIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
  pricesIncludeTax: boolean;
  taxes: {
    taxRuleId: string;
    code: string;
    version: number;
    taxType: string;
    rateBp: number;
    priceIncludesTax: boolean;
    grossIdr: number;
    taxBaseIdr: number;
    serviceChargeIdr: number;
    taxIdr: number;
  }[];
};

/** A cart the kit cannot price; nothing is queued. */
export class OfflineSaleError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "OfflineSaleError";
    this.code = code;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The tablet's calendar day of `at` (the outlet's own clock). */
function localDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function priceLine(
  kit: PosOfflineKit,
  serviceType: OfflineServiceType,
  line: OfflineCartLine,
): OfflineSaleLine {
  const item = kit.catalogs[serviceType].items.find((row) =>
    same(row.id, line.menuItemId),
  );
  if (!item) throw new OfflineSaleError("ITEM_NOT_IN_KIT");
  if (item.soldOut) throw new OfflineSaleError("ITEM_SOLD_OUT");
  if (
    !Number.isInteger(line.quantity) ||
    line.quantity < 1 ||
    line.quantity > 99
  )
    throw new OfflineSaleError("QUANTITY_INVALID");
  let unitPriceIdr: number;
  let name = item.name;
  if (line.variantId === null) {
    if (item.plainPriceIdr === null)
      throw new OfflineSaleError("VARIANT_REQUIRED");
    unitPriceIdr = item.plainPriceIdr;
  } else {
    const variant = item.variants.find((row) => same(row.id, line.variantId!));
    if (!variant) throw new OfflineSaleError("VARIANT_NOT_IN_KIT");
    unitPriceIdr = variant.priceIdr;
    name = `${item.name} ${variant.name}`.slice(0, 150);
  }
  if (
    new Set(line.modifierIds.map((id) => id.toLowerCase())).size !==
    line.modifierIds.length
  )
    throw new OfflineSaleError("MODIFIER_REPEATED");
  const modifiers: OfflineSaleLine["modifiers"] = [];
  for (const modifierId of line.modifierIds) {
    const group = item.modifierGroups.find((row) =>
      row.options.some((option) => same(option.id, modifierId)),
    );
    const option = group?.options.find((row) => same(row.id, modifierId));
    if (!group || !option) throw new OfflineSaleError("MODIFIER_NOT_IN_KIT");
    modifiers.push({
      modifierId: option.id,
      groupId: group.id,
      name: option.label,
      priceIdr: idr(option.priceDeltaIdr),
    });
  }
  for (const group of item.modifierGroups) {
    const chosen = modifiers.filter((row) =>
      same(row.groupId, group.id),
    ).length;
    const min = group.required ? Math.max(group.min, 1) : group.min;
    if (chosen < min || (group.max > 0 && chosen > group.max))
      throw new OfflineSaleError("MODIFIER_CHOICE_INVALID");
  }
  const modifiersTotalIdr = modifiers.reduce(
    (sum, row) => sum + row.priceIdr,
    0,
  );
  return {
    menuItemId: item.id,
    variantId: line.variantId === null ? null : line.variantId.toLowerCase(),
    name,
    quantity: line.quantity,
    unitPriceIdr: idr(unitPriceIdr),
    modifiers,
    modifiersTotalIdr: idr(modifiersTotalIdr),
    lineTotalIdr: idr((unitPriceIdr + modifiersTotalIdr) * line.quantity),
  };
}

/**
 * The bill of an offline cart at `paidAt`: list prices of the kit, service
 * charge and tax of its snapshot, the outlet's cash rounding. Throws
 * OfflineSaleError for anything the kit does not know.
 */
export function priceOfflineSale(
  kit: PosOfflineKit,
  cart: OfflineCart,
  paidAt: Date,
): OfflinePricedSale {
  if (!OFFLINE_KIT_SERVICE_TYPES.includes(cart.serviceType))
    throw new OfflineSaleError("SERVICE_TYPE_INVALID");
  if (cart.lines.length === 0) throw new OfflineSaleError("CART_EMPTY");
  const lines = cart.lines.map((line) =>
    priceLine(kit, cart.serviceType, line),
  );
  const subtotalIdr = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const categoryOf = (menuItemId: string) =>
    kit.catalogs[cart.serviceType].items.find((row) =>
      same(row.id, menuItemId),
    )!.categoryId;
  const at = paidAt.getTime();
  let tax: ReturnType<typeof calculateTax>;
  try {
    tax = calculateTax(
      {
        outletId: kit.outletId,
        businessDate: localDate(paidAt),
        channel: cart.serviceType,
        zoneId: null,
        regionCode: null,
        lines: lines.map((line, index) => ({
          lineId: createUlid(at + index),
          itemId: line.menuItemId,
          categoryId: categoryOf(line.menuItemId),
          itemClass: "food_beverage" as const,
          grossIdr: idr(line.lineTotalIdr),
          discountIdr: idr(0),
          components: [],
        })),
        orderDiscountIdr: idr(0),
      } as TaxCalculationInput,
      {
        taxRules: kit.tax.taxRules,
        serviceChargeRules: kit.tax.serviceChargeRules,
        settings: kit.tax.settings,
      },
    );
  } catch {
    throw new OfflineSaleError("TAX_CONFIG_INVALID");
  }
  const inclusive = tax.taxes.filter((summary) => summary.priceIncludesTax);
  // The cloud refuses a cart mixing inclusive and exclusive rules.
  if (inclusive.length > 0 && inclusive.length < tax.taxes.length)
    throw new OfflineSaleError("TAX_CONFIG_INVALID");
  return {
    serviceType: cart.serviceType,
    lines,
    subtotalIdr,
    serviceChargeIdr: tax.serviceChargeIdr,
    taxIdr: tax.taxIdr,
    roundingIdr: tax.roundingIdr,
    totalIdr: tax.totalIdr,
    pricesIncludeTax: inclusive.length > 0,
    taxes: tax.taxes.map((summary) => {
      const ruleLines = tax.lines.filter(
        (line) => line.taxRuleId === summary.taxRuleId,
      );
      return {
        taxRuleId: summary.taxRuleId,
        code: summary.code,
        version: summary.version,
        taxType: summary.taxType,
        rateBp: summary.rateBp,
        priceIncludesTax: summary.priceIncludesTax,
        grossIdr: ruleLines.reduce((sum, line) => sum + line.grossIdr, 0),
        taxBaseIdr: summary.taxBaseIdr,
        serviceChargeIdr: ruleLines.reduce(
          (sum, line) => sum + line.serviceChargeIdr,
          0,
        ),
        taxIdr: summary.taxIdr,
      };
    }),
  };
}
