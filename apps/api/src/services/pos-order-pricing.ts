// Server-side pricing for POS / captain / manual-ojol orders (bead legend-kk7;
// PRD v1.7 §3 F8 "Pesanan Langsung", F11 pajak & service charge; ORD-03 money
// rule reused for POS: the client sends ids and quantities, never a price).
//
// Reuses the QR order building blocks (qr-order-pricing.ts): `resolveLine`
// (variant/modifier validation and snapshot) and `loadTaxConfig` (published
// tax rules + settings), and the shared tax engine `calculateTax` in the PRD
// order discount -> service charge -> tax. Differences from the guest menu:
//
// - The price comes from the channel's own price list (`readChannelPriceGrid`
//   with the §10 menu channel of the order: dine_in / takeaway / gofood /
//   grabfood / shopeefood / reservation).
// - A POS item does not need a guest photo (a cashier sells from the grid);
//   it must be active, not deleted, in a live category and priced.
// - Service charge: a dine-in order on a table session uses the zone's rate
//   (same rule as the QR bill of that table, PRD §3 F9 "Zona"); every other
//   order uses the tenant's published service-charge rules (F11), which the
//   engine filters by order type.

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  idr,
  outletIdSchema,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { MenuChannel } from "@starter/shared/menu";
import type { OrderChannel, ServiceType } from "@starter/shared/pos";
import {
  qrOrderErrorHttpStatus,
  qrOrderErrorMessages,
  QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
} from "@starter/shared/qr-order";
import {
  calculateTax,
  type TaxCalculationInput,
  type TaxCalculationResult,
} from "@starter/shared/tax";
import {
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  type floorZones,
} from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { closedShowerMenuItemIds } from "./facility-shower-gate.ts";
import { readAvailabilityDecisions } from "./menu-availability.ts";
import type { Tx } from "./menu-internals.ts";
import { readChannelPriceGrid } from "./menu-pricing.service.ts";
import {
  loadTaxConfig,
  selectServiceChargeRules,
  type CatalogueGroup,
  type CatalogueItem,
  type CatalogueModifier,
  type QrTaxConfig,
} from "./qr-order-pricing.ts";

export { resolveLine } from "./qr-order-pricing.ts";

type ZoneRow = typeof floorZones.$inferSelect;

/**
 * §10 menu/price channel of an order. Ojol and reservation orders use their
 * own channel price list; POS, captain and kiosk use the dine-in or takeaway
 * list by service type. Decision (PRD silent): a `delivery` order from the
 * outlet's own counter is priced as takeaway (no own-delivery price list).
 */
export function posPriceChannel(
  channel: OrderChannel,
  serviceType: ServiceType,
): MenuChannel {
  switch (channel) {
    case "gofood":
    case "grabfood":
    case "shopeefood":
    case "reservation":
      return channel;
    // A facility breakfast order is a delivered meal: dine-in or takeaway
    // list by service type, like POS.
    case "qr":
    case "pos":
    case "captain":
    case "kiosk":
    case "facility":
      return serviceType === "dine_in" ? "dine_in" : "takeaway";
    default: {
      const unreachable: never = channel;
      return unreachable;
    }
  }
}

/** The orderable POS catalogue entries of `itemIds` at `now`. */
export async function loadPosCatalogue(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    brandId: string;
    outletId: OutletId;
    timeZone: string;
    businessDate: string;
    channel: MenuChannel;
    itemIds: readonly string[];
    now: Date;
  },
): Promise<Map<string, CatalogueItem>> {
  const tenantId = context.tenant.tenantId;
  const ids = [...new Set(input.itemIds)];
  const catalogue = new Map<string, CatalogueItem>();
  if (ids.length === 0) return catalogue;

  const rows = await tx
    .select()
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, input.brandId),
        inArray(menuItems.id, ids),
        isNull(menuItems.deletedAt),
        eq(menuItems.isActive, true),
      ),
    );
  if (rows.length === 0) return catalogue;
  const categoryRows = await tx
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, tenantId),
        eq(menuCategories.brandId, input.brandId),
        inArray(
          menuCategories.id,
          rows.map((row) => row.categoryId),
        ),
        isNull(menuCategories.deletedAt),
      ),
    );
  const liveCategories = new Set(categoryRows.map((row) => row.id));
  const items = rows.filter((row) => liveCategories.has(row.categoryId));
  if (items.length === 0) return catalogue;
  const itemIds = items.map((row) => row.id);

  const grid = await readChannelPriceGrid(tx, context, {
    outletId: input.outletId,
    channel: input.channel,
    businessDate: input.businessDate,
    itemIds,
  });
  const plainPrice = new Map<string, number>();
  const variantPrice = new Map<string, number>();
  for (const entry of grid.entries) {
    if (entry.variantId === null) plainPrice.set(entry.itemId, entry.priceIdr);
    else variantPrice.set(entry.variantId, entry.priceIdr);
  }

  const variantRows = await tx
    .select()
    .from(itemVariants)
    .where(
      and(
        eq(itemVariants.tenantId, tenantId),
        inArray(itemVariants.menuItemId, itemIds),
        isNull(itemVariants.deletedAt),
      ),
    );
  const links = await tx
    .select({
      menuItemId: menuItemModifierGroups.menuItemId,
      groupId: menuItemModifierGroups.groupId,
    })
    .from(menuItemModifierGroups)
    .where(
      and(
        eq(menuItemModifierGroups.tenantId, tenantId),
        inArray(menuItemModifierGroups.menuItemId, itemIds),
        isNull(menuItemModifierGroups.deletedAt),
      ),
    );
  const groupIds = [...new Set(links.map((link) => link.groupId))];
  const groupRows = groupIds.length
    ? await tx
        .select()
        .from(modifierGroups)
        .where(
          and(
            eq(modifierGroups.tenantId, tenantId),
            inArray(modifierGroups.id, groupIds),
            isNull(modifierGroups.deletedAt),
          ),
        )
    : [];
  const modifierRows = groupIds.length
    ? await tx
        .select()
        .from(modifiers)
        .where(
          and(
            eq(modifiers.tenantId, tenantId),
            inArray(modifiers.groupId, groupIds),
            isNull(modifiers.deletedAt),
          ),
        )
    : [];
  const groupById = new Map(groupRows.map((row) => [row.id, row]));
  const availability = await readAvailabilityDecisions(tx, {
    tenantId,
    outletId: input.outletId,
    itemIds,
    at: input.now,
    timeZone: input.timeZone,
    businessDate: input.businessDate,
  });
  // 1269 F0: an item that sells a closed shower is not sellable (ORD-05 path).
  const closedShower = await closedShowerMenuItemIds(
    tx,
    tenantId,
    input.outletId,
    itemIds,
  );

  for (const row of items) {
    const variants = new Map<
      string,
      { id: string; name: string; priceIdr: number }
    >();
    for (const variant of variantRows) {
      if (variant.menuItemId !== row.id) continue;
      const price = variantPrice.get(variant.id);
      if (price !== undefined && price > 0)
        variants.set(variant.id, {
          id: variant.id,
          name: variant.name,
          priceIdr: price,
        });
    }
    const plain = plainPrice.get(row.id);
    const plainPriceIdr = plain !== undefined && plain > 0 ? plain : null;
    // Not priced on this channel: not sellable here.
    if (plainPriceIdr === null && variants.size === 0) continue;
    const groups: CatalogueGroup[] = [];
    const itemModifiers = new Map<string, CatalogueModifier>();
    for (const link of links) {
      if (link.menuItemId !== row.id) continue;
      const group = groupById.get(link.groupId);
      if (!group) continue;
      groups.push({
        id: group.id,
        name: group.name,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
      });
      for (const option of modifierRows)
        if (option.groupId === group.id)
          itemModifiers.set(option.id, {
            id: option.id,
            groupId: group.id,
            name: option.name,
            priceIdr: option.priceIdr,
          });
    }
    const decision = availability.get(row.id);
    catalogue.set(row.id, {
      id: row.id,
      categoryId: row.categoryId,
      name: row.name,
      course: row.course,
      stationTargetSeconds: null,
      plainPriceIdr,
      variants,
      groups,
      modifiers: itemModifiers,
      sellable: !closedShower.has(row.id) && (decision?.sellable ?? true),
    });
  }
  return catalogue;
}

// ---- Tax and service charge ---------------------------------------------------

/** Published tax rules, settings and service charge rules (shared QR loader). */
export type PosTaxConfig = QrTaxConfig;

export async function loadPosTaxConfig(
  tx: Tx,
  context: ScopedTenantContext,
  outletIdInput: string,
): Promise<PosTaxConfig> {
  return loadTaxConfig(tx, context, outletIdSchema.parse(outletIdInput));
}

export type PosBillLine = {
  /** order_items.id (ULID). */
  lineId: string;
  menuItemId: string;
  categoryId: string;
  quantity: number;
  unitPriceIdr: number;
  modifiersTotalIdr: number;
};

export type PosBill = {
  subtotalIdr: Idr;
  discountIdr: Idr;
  serviceChargeIdr: Idr;
  taxIdr: Idr;
  roundingIdr: Idr;
  totalIdr: Idr;
  /**
   * Inclusive prices (harga nett, legend-npnh): `subtotalIdr` is the gross line
   * sum with service and tax already inside it, and `totalIdr` is subtotal -
   * discount + rounding (orders_total_check branches on this).
   */
  pricesIncludeTax: boolean;
  tax: TaxCalculationResult | null;
};

export function lineSubtotalIdr(line: {
  unitPriceIdr: number;
  modifiersTotalIdr: number;
  quantity: number;
}): number {
  return (line.unitPriceIdr + line.modifiersTotalIdr) * line.quantity;
}

/**
 * The bill of the live lines: discount (bill level) -> service -> tax ->
 * rounding, by the shared engine. Fails closed on a configuration gap
 * (TaxError) and on a cart mixing inclusive and exclusive rules (no single
 * total formula, like QR). A tax-inclusive rule yields an inclusive bill
 * (legend-npnh): the same engine and formula as the QR order (legend-zmc2).
 */
export function computePosBill(input: {
  context: ScopedTenantContext;
  outletId: OutletId;
  businessDate: string;
  channel: MenuChannel;
  zone: ZoneRow | null;
  lines: readonly PosBillLine[];
  orderDiscountIdr: number;
  taxConfig: PosTaxConfig;
}): PosBill {
  const subtotal = input.lines.reduce(
    (sum, line) => sum + lineSubtotalIdr(line),
    0,
  );
  if (input.lines.length === 0)
    return {
      subtotalIdr: idr(0),
      discountIdr: idr(0),
      serviceChargeIdr: idr(0),
      taxIdr: idr(0),
      roundingIdr: idr(0),
      totalIdr: idr(0),
      pricesIncludeTax: false,
      tax: null,
    };
  const discount = Math.min(Math.max(0, input.orderDiscountIdr), subtotal);
  const tax = calculateTax(
    {
      outletId: input.outletId,
      businessDate: input.businessDate,
      channel: input.channel,
      zoneId: input.zone?.id ?? null,
      regionCode: null,
      lines: input.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.menuItemId,
        categoryId: line.categoryId,
        itemClass: "food_beverage" as const,
        grossIdr: idr(lineSubtotalIdr(line)),
        discountIdr: idr(0),
        components: [],
      })),
      orderDiscountIdr: idr(discount),
    } as TaxCalculationInput,
    {
      taxRules: input.taxConfig.taxRules,
      serviceChargeRules: selectServiceChargeRules(
        input.zone,
        input.context,
        input.taxConfig.serviceChargeRules,
      ),
      settings: input.taxConfig.settings,
    },
  );
  const inclusiveRules = tax.taxes.filter(
    (summary) => summary.priceIncludesTax,
  );
  if (inclusiveRules.length > 0 && inclusiveRules.length < tax.taxes.length)
    throw new HttpError(
      qrOrderErrorHttpStatus.QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
      QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
      qrOrderErrorMessages.QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
    );
  return {
    subtotalIdr: idr(subtotal),
    discountIdr: tax.discountIdr,
    serviceChargeIdr: tax.serviceChargeIdr,
    taxIdr: tax.taxIdr,
    roundingIdr: tax.roundingIdr,
    totalIdr: tax.totalIdr,
    pricesIncludeTax: inclusiveRules.length > 0,
    tax,
  };
}
