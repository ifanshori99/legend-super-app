// Server-side pricing for QR orders (bead legend-e2x; PRD v1.7 §3 F10 "Menu &
// Keranjang", F11; ORD-03, ORD-05, ORD-11).
//
// ORD-03: every rupiah comes from the server. A cart line carries only ids and
// a quantity from the client; this module resolves the dine-in channel price
// (menu-pricing.service.ts `readChannelPriceGrid`, the same resolver the guest
// menu and POS use), the variant and modifier prices, and the availability
// decision (menu-availability.ts). The quote runs the shared tax engine
// (`calculateTax`) in the PRD order discount -> service charge -> tax; menu
// prices exclude tax and service charge (owner decision 2026-11-01).
//
// The QR service charge is the zone's `service_charge_bp` (PRD §3 F9 "Zona":
// each zone carries its own service charge, and the guest menu prints that
// rate). It enters the engine as one zone-scoped service-charge rule so the
// engine still decides the tax base (`includeServiceInBase`) and rounding.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  idr,
  outletIdSchema,
  type OutletId,
  toIsoDateTime,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { menuItemVisibleToGuests } from "@starter/shared/menu";
import {
  orderQuoteSchema,
  qrOrderErrorMessages,
  qrOrderErrorHttpStatus,
  QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
  type OrderQuote,
} from "@starter/shared/qr-order";
import {
  calculateTax,
  orderNetSubtotalIdr,
  resolveTaxSettings,
  type ServiceChargeRule,
  type TaxCalculationInput,
  type TaxCalculationResult,
  type TaxRule,
  type TaxSettings,
} from "@starter/shared/tax";
import {
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  stations,
  serviceChargeRules,
  taxRules,
  taxSettings,
  type floorZones,
} from "../db/schema/index.ts";
import type { CartLineModifierSnapshot } from "../db/schema/qr-order.ts";
import { HttpError } from "../lib/http-error.ts";
import { closedShowerMenuItemIds } from "./facility-shower-gate.ts";
import { guestMenuItemCondition, type Tx } from "./menu-internals.ts";
import { isLinePaused } from "./kds-pacing.service.ts";
import { readAvailabilityDecisions } from "./menu-availability.ts";
import { readChannelPriceGrid } from "./menu-pricing.service.ts";
import type { OrderPromoQuote } from "./order-promo-port.ts";
import type { ServingEstimate } from "./qr-order-ports.ts";

/** The QR menu is the dine-in channel (PRD §10; guest-menu.service.ts). */
export const QR_PRICE_CHANNEL = "dine_in" as const;

type ZoneRow = typeof floorZones.$inferSelect;

export type CatalogueModifier = {
  id: string;
  groupId: string;
  name: string;
  priceIdr: number;
};

export type CatalogueGroup = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
};

export type CatalogueItem = {
  id: string;
  categoryId: string;
  name: string;
  course: string | null;
  stationTargetSeconds: number | null;
  /** Dine-in price without a variant; null when only variants are priced. */
  plainPriceIdr: number | null;
  /** Priced variants only; an unpriced variant cannot be sold here. */
  variants: Map<string, { id: string; name: string; priceIdr: number }>;
  groups: CatalogueGroup[];
  modifiers: Map<string, CatalogueModifier>;
  /** ORD-05: 86, outside its schedule window or daily stock used up. */
  sellable: boolean;
};

/**
 * The orderable catalogue entries of `itemIds` for one outlet at `now`. An id
 * that is missing from the map is not sellable on the QR channel at all
 * (deleted, inactive, no photo per Q23, other brand, or no dine-in price).
 */
export async function loadCatalogue(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    brandId: string;
    outletId: OutletId;
    timeZone: string;
    businessDate: string;
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
        guestMenuItemCondition(),
      ),
    );
  const visible = rows.filter((row) =>
    menuItemVisibleToGuests({ isActive: row.isActive, mediaId: row.mediaId }),
  );
  if (visible.length === 0) return catalogue;
  const categoryRows = await tx
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, tenantId),
        eq(menuCategories.brandId, input.brandId),
        inArray(
          menuCategories.id,
          visible.map((row) => row.categoryId),
        ),
        isNull(menuCategories.deletedAt),
      ),
    );
  const liveCategories = new Set(categoryRows.map((row) => row.id));
  const items = visible.filter((row) => liveCategories.has(row.categoryId));
  if (items.length === 0) return catalogue;
  const itemIds = items.map((row) => row.id);

  const grid = await readChannelPriceGrid(tx, context, {
    outletId: input.outletId,
    channel: QR_PRICE_CHANNEL,
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

  const stationIds = [
    ...new Set(
      items
        .map((row) => row.stationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const stationRows = stationIds.length
    ? await tx
        .select({ id: stations.id, targetSeconds: stations.targetSeconds })
        .from(stations)
        .where(
          and(
            eq(stations.tenantId, tenantId),
            inArray(stations.id, stationIds),
            isNull(stations.deletedAt),
          ),
        )
    : [];
  const stationTarget = new Map(
    stationRows.map((row) => [row.id, row.targetSeconds]),
  );

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
    // No dine-in price at all: not a QR menu item (guest-menu.service.ts).
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
    // An item without an availability row has no schedule, limit or 86.
    const decision = availability.get(row.id);
    catalogue.set(row.id, {
      id: row.id,
      categoryId: row.categoryId,
      name: row.name,
      course: row.course,
      stationTargetSeconds:
        row.stationId === null
          ? null
          : (stationTarget.get(row.stationId) ?? null),
      plainPriceIdr,
      variants,
      groups,
      modifiers: itemModifiers,
      sellable: !closedShower.has(row.id) && (decision?.sellable ?? true),
    });
  }
  return catalogue;
}

export type LineRequest = {
  menuItemId: string;
  variantId: string | null;
  quantity: number;
  modifierIds: readonly string[];
  /** KDS-05 paused lines for the channel; a hit is refused as `sold_out`. */
  paused?: ReadonlySet<string>;
};

export type ResolvedLine = {
  name: string;
  unitPriceIdr: Idr;
  modifiers: CartLineModifierSnapshot[];
  modifiersTotalIdr: Idr;
};

export type LineResolution =
  | { ok: true; line: ResolvedLine }
  | { ok: false; reason: "sold_out" }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Prices one requested line against the catalogue. `sold_out` covers both an
 * unavailable item (ORD-05) and an item no longer on the QR menu; `invalid` is
 * a request the menu never allowed (wrong variant, modifier outside the
 * item's groups, min/max selection broken).
 */
export function resolveLine(
  item: CatalogueItem | undefined,
  request: LineRequest,
): LineResolution {
  if (!item || !item.sellable) return { ok: false, reason: "sold_out" };
  if (
    request.paused &&
    isLinePaused(request.paused, request.menuItemId, request.variantId)
  )
    return { ok: false, reason: "sold_out" };
  let unitPrice: number;
  let name = item.name;
  if (item.variants.size > 0) {
    if (request.variantId === null)
      return {
        ok: false,
        reason: "invalid",
        message: "Pilih varian untuk menu ini.",
      };
    const variant = item.variants.get(request.variantId);
    if (!variant)
      return {
        ok: false,
        reason: "invalid",
        message: "Varian tidak tersedia untuk menu ini.",
      };
    unitPrice = variant.priceIdr;
    name = `${item.name} - ${variant.name}`.slice(0, 150);
  } else {
    if (request.variantId !== null)
      return {
        ok: false,
        reason: "invalid",
        message: "Menu ini tidak memiliki varian.",
      };
    if (item.plainPriceIdr === null) return { ok: false, reason: "sold_out" };
    unitPrice = item.plainPriceIdr;
  }

  if (new Set(request.modifierIds).size !== request.modifierIds.length)
    return {
      ok: false,
      reason: "invalid",
      message: "Modifier yang sama dipilih dua kali.",
    };
  const chosen: CartLineModifierSnapshot[] = [];
  const perGroup = new Map<string, number>();
  for (const modifierId of request.modifierIds) {
    const option = item.modifiers.get(modifierId);
    if (!option)
      return {
        ok: false,
        reason: "invalid",
        message: "Modifier tidak tersedia untuk menu ini.",
      };
    chosen.push({
      modifierId: option.id,
      groupId: option.groupId,
      name: option.name,
      priceIdr: option.priceIdr,
    });
    perGroup.set(option.groupId, (perGroup.get(option.groupId) ?? 0) + 1);
  }
  for (const group of item.groups) {
    const count = perGroup.get(group.id) ?? 0;
    if (count < group.minSelect || count > group.maxSelect)
      return {
        ok: false,
        reason: "invalid",
        message: `Pilihan "${group.name}" harus ${group.minSelect}-${group.maxSelect}.`,
      };
  }
  const modifiersTotal = chosen.reduce(
    (sum, option) => sum + option.priceIdr,
    0,
  );
  return {
    ok: true,
    line: {
      name,
      unitPriceIdr: idr(unitPrice),
      modifiers: chosen,
      modifiersTotalIdr: idr(modifiersTotal),
    },
  };
}

// ---- Tax configuration ---------------------------------------------------------

export type QrTaxConfig = {
  taxRules: TaxRule[];
  settings: TaxSettings[];
  /** Published outlet/tenant service charge rules: the fallback when the zone
   * itself carries no charge (see `selectServiceChargeRules`). */
  serviceChargeRules: ServiceChargeRule[];
  ruleNames: Map<string, string>;
};

/**
 * Published tax rules and calculation settings of the tenant that can reach
 * this outlet. Rows are mapped field by field (not re-validated): the engine
 * reads only the rule fields, and published rows were validated on publish.
 */
export async function loadTaxConfig(
  tx: Tx,
  context: ScopedTenantContext,
  outletIdInput: string,
): Promise<QrTaxConfig> {
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(outletIdInput);
  const [ruleRows, settingsRows, serviceRows] = await Promise.all([
    tx
      .select()
      .from(taxRules)
      .where(
        and(
          eq(taxRules.tenantId, tenantId),
          eq(taxRules.status, "published"),
          or(isNull(taxRules.outletId), eq(taxRules.outletId, outletId)),
        ),
      ),
    tx
      .select()
      .from(taxSettings)
      .where(
        and(
          eq(taxSettings.tenantId, tenantId),
          eq(taxSettings.status, "published"),
          or(isNull(taxSettings.outletId), eq(taxSettings.outletId, outletId)),
        ),
      ),
    tx
      .select()
      .from(serviceChargeRules)
      .where(
        and(
          eq(serviceChargeRules.tenantId, tenantId),
          eq(serviceChargeRules.status, "published"),
          or(
            isNull(serviceChargeRules.outletId),
            eq(serviceChargeRules.outletId, outletId),
          ),
        ),
      ),
  ]);
  const rules = ruleRows.map(
    (row) =>
      ({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        code: row.code,
        name: row.name,
        taxType: row.taxType,
        rateBp: row.rateBp,
        regionCode: row.regionCode,
        channels: row.channels,
        appliesTo: row.appliesTo,
        priceIncludesTax: row.priceIncludesTax,
        includeServiceInBase: row.includeServiceInBase,
        isActive: row.isActive,
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        status: row.status,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        publishedBy: row.publishedBy,
        createdAt: row.createdAt.toISOString(),
      }) as TaxRule,
  );
  const settings = settingsRows.map(
    (row) =>
      ({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        calculationOrder: row.calculationOrder,
        pricesIncludeTax: row.pricesIncludeTax,
        serviceRoundingMode: row.serviceRoundingMode,
        taxRoundingMode: row.taxRoundingMode,
        inclusiveBaseRoundingMode: row.inclusiveBaseRoundingMode,
        billRounding: row.billRounding,
        packageAllocation: row.packageAllocation,
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        status: row.status,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        publishedBy: row.publishedBy,
        createdAt: row.createdAt.toISOString(),
      }) as TaxSettings,
  );
  const serviceRules = serviceRows.map(
    (row) =>
      ({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        code: row.code,
        name: row.name,
        rateBp: row.rateBp,
        zoneId: row.zoneId,
        orderTypes: row.orderTypes,
        itemClasses: row.itemClasses,
        isActive: row.isActive,
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        status: row.status,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        publishedBy: row.publishedBy,
        createdAt: row.createdAt.toISOString(),
      }) as unknown as ServiceChargeRule,
  );
  return {
    taxRules: rules,
    settings,
    serviceChargeRules: serviceRules,
    ruleNames: new Map<string, string>(
      ruleRows.map((row) => [row.id, row.name]),
    ),
  };
}

/**
 * The service charge rules the engine sees for one order, shared by QR and POS
 * so both price a zone the same way: a zone with a charge is one engine rule
 * (see the header); a zone with none (or no zone) falls back to the outlet's
 * published service charge rules, as the POS always did.
 */
export function selectServiceChargeRules(
  zone: ZoneRow | null,
  context: ScopedTenantContext,
  configured: readonly ServiceChargeRule[],
): ServiceChargeRule[] {
  if (zone === null || zone.serviceChargeBp <= 0) return [...configured];
  return [
    {
      id: zone.id,
      tenantId: context.tenant.tenantId,
      outletId: zone.outletId,
      code: "ZONE-SC",
      name: "Service charge zona",
      rateBp: zone.serviceChargeBp,
      zoneId: zone.id,
      orderTypes: [],
      itemClasses: ["food_beverage"],
      isActive: true,
      version: 1,
      effectiveFrom: "2000-01-01",
      status: "published",
      publishedAt: zone.updatedAt.toISOString(),
      publishedBy: null,
      createdAt: zone.createdAt.toISOString(),
    } as unknown as ServiceChargeRule,
  ];
}

// ---- Quote ----------------------------------------------------------------------

export type PricedQuoteLine = {
  cartLineId: string;
  menuItemId: string;
  categoryId: string;
  name: string;
  quantity: number;
  unitPriceIdr: Idr;
  modifiersTotalIdr: Idr;
};

/** Unbranded drafts; `orderQuoteSchema` brands them when the quote parses. */
export type RemovedLineDraft = {
  cartLineId: string;
  menuItemId: string;
  name: string;
  reason: "sold_out";
};
export type PriceChangeDraft = {
  cartLineId: string;
  name: string;
  previousUnitPriceIdr: number;
  unitPriceIdr: number;
};

export type QuoteBuild = {
  quote: OrderQuote;
  /** Null for an empty quote (nothing to tax). */
  tax: TaxCalculationResult | null;
};

function lineSubtotal(line: PricedQuoteLine): number {
  return (line.unitPriceIdr + line.modifiersTotalIdr) * line.quantity;
}

/**
 * Builds the contract quote from server-priced lines. The tax engine runs
 * discount -> service -> tax and fails closed (TaxError) on a configuration
 * gap. A tax-inclusive rule yields an inclusive quote (`pricesIncludeTaxAndService`);
 * a cart mixing inclusive and exclusive rules is refused.
 */
export function buildQuote(input: {
  context: ScopedTenantContext;
  sessionId: string;
  cartVersion: number;
  outletId: OutletId;
  businessDate: string;
  zone: ZoneRow;
  lines: readonly PricedQuoteLine[];
  removedLines: readonly RemovedLineDraft[];
  priceChanges: readonly PriceChangeDraft[];
  promo: OrderPromoQuote | null;
  promoCode: string | null;
  taxConfig: QrTaxConfig | null;
  servingEstimate: ServingEstimate | null;
  now: Date;
}): QuoteBuild {
  const computedAt = toIsoDateTime(input.now);
  const subtotals = input.lines.map(lineSubtotal);
  const subtotal = subtotals.reduce((sum, value) => sum + value, 0);
  const estimate =
    input.servingEstimate === null
      ? null
      : {
          minMinutes: input.servingEstimate.minMinutes,
          maxMinutes: input.servingEstimate.maxMinutes,
          computedAt,
        };

  if (input.lines.length === 0 || input.taxConfig === null) {
    return {
      quote: orderQuoteSchema.parse({
        sessionId: input.sessionId,
        cartVersion: input.cartVersion,
        lines: [],
        subtotalIdr: 0,
        discountLines: [],
        discountIdr: 0,
        serviceCharge: {
          rateBp: input.zone.serviceChargeBp,
          baseIdr: 0,
          amountIdr: 0,
        },
        taxLines: [],
        taxIdr: 0,
        rounding: { incrementIdr: 1, mode: "half_up", adjustmentIdr: 0 },
        totalIdr: 0,
        removedLines: input.removedLines,
        priceChanges: input.priceChanges,
        minimumSpend: {
          requiredIdr: input.zone.minimumSpendIdr,
          shortfallIdr: input.zone.minimumSpendIdr,
        },
        servingEstimate: estimate,
        computedAt,
      }),
      tax: null,
    };
  }

  // The promo engine already caps a discount at the discountable amount; the
  // clamp keeps the tax engine's "discount <= bill" precondition regardless.
  const discount = Math.min(input.promo?.totalDiscountIdr ?? 0, subtotal);
  const settings = resolveTaxSettings(
    input.taxConfig.settings,
    input.outletId,
    input.businessDate,
  );
  const engineServiceRules = selectServiceChargeRules(
    input.zone,
    input.context,
    input.taxConfig.serviceChargeRules,
  );
  const tax = calculateTax(
    {
      outletId: input.outletId,
      businessDate: input.businessDate,
      channel: QR_PRICE_CHANNEL,
      zoneId: input.zone.id,
      // Outlets carry no PBJT region code yet; region-bound rules do not match.
      regionCode: null,
      lines: input.lines.map((line, index) => ({
        lineId: line.cartLineId,
        itemId: line.menuItemId,
        categoryId: line.categoryId,
        itemClass: "food_beverage" as const,
        grossIdr: idr(subtotals[index]),
        discountIdr: idr(0),
        components: [],
      })),
      orderDiscountIdr: idr(discount),
    } as TaxCalculationInput,
    {
      taxRules: input.taxConfig.taxRules,
      serviceChargeRules: engineServiceRules,
      settings: input.taxConfig.settings,
    },
  );
  // Inclusive prices (legend-49pw): decided by the resolved rules, as in
  // `calculateTax`. A cart that mixes inclusive and exclusive rules has no single
  // total formula, so it fails closed.
  const inclusiveRules = tax.taxes.filter(
    (summary) => summary.priceIncludesTax,
  );
  if (inclusiveRules.length > 0 && inclusiveRules.length < tax.taxes.length)
    throw new HttpError(
      qrOrderErrorHttpStatus.QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
      QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
      qrOrderErrorMessages.QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED,
    );
  const inclusive = inclusiveRules.length > 0;
  // The rate the engine charged: the zone's, or the outlet rule it fell back to.
  const serviceRateBp =
    input.zone.serviceChargeBp > 0
      ? input.zone.serviceChargeBp
      : (engineServiceRules.find(
          (rule) => rule.id === tax.lines[0]?.serviceChargeRuleId,
        )?.rateBp ?? 0);
  const byLine = new Map(tax.lines.map((line) => [line.lineId, line]));
  const net = subtotal - tax.discountIdr;
  const discountLines =
    tax.discountIdr > 0
      ? [
          {
            label: input.promoCode ? `Promo ${input.promoCode}` : "Promo",
            source: input.promoCode ? ("voucher" as const) : ("promo" as const),
            amountIdr: tax.discountIdr,
          },
        ]
      : [];
  const rounding = settings.billRounding ?? {
    incrementIdr: 1,
    mode: settings.taxRoundingMode,
  };
  const quote = orderQuoteSchema.parse({
    sessionId: input.sessionId,
    cartVersion: input.cartVersion,
    lines: input.lines.map((line, index) => {
      const taxed = byLine.get(line.cartLineId);
      const lineDiscount = taxed?.discountIdr ?? 0;
      return {
        cartLineId: line.cartLineId,
        menuItemId: line.menuItemId,
        name: line.name,
        quantity: line.quantity,
        unitPriceIdr: line.unitPriceIdr,
        modifiersTotalIdr: line.modifiersTotalIdr,
        lineSubtotalIdr: subtotals[index],
        discountIdr: lineDiscount,
        lineTotalIdr: subtotals[index] - lineDiscount,
        taxRuleId: taxed?.taxRuleId ?? null,
      };
    }),
    subtotalIdr: subtotal,
    discountLines,
    discountIdr: tax.discountIdr,
    pricesIncludeTaxAndService: inclusive,
    serviceCharge: {
      rateBp: serviceRateBp,
      // Inclusive: the base the service charge was backed out of.
      baseIdr: inclusive ? tax.baseIdr : net,
      amountIdr: tax.serviceChargeIdr,
    },
    taxLines: tax.taxes.map((summary) => ({
      taxRuleId: summary.taxRuleId,
      name: (
        input.taxConfig?.ruleNames.get(summary.taxRuleId) ?? summary.code
      ).slice(0, 150),
      rateBp: summary.rateBp,
      baseIdr: summary.taxBaseIdr,
      amountIdr: summary.taxIdr,
    })),
    taxIdr: tax.taxIdr,
    rounding: {
      incrementIdr: rounding.incrementIdr,
      mode: rounding.mode,
      adjustmentIdr: tax.roundingIdr,
    },
    totalIdr: tax.totalIdr,
    removedLines: input.removedLines,
    priceChanges: input.priceChanges,
    minimumSpend: {
      requiredIdr: input.zone.minimumSpendIdr,
      // Q53 (legend-v9fh): measured before tax and service charge, also when
      // the prices include them (inclusive); exclusive keeps `net`.
      shortfallIdr: Math.max(
        0,
        input.zone.minimumSpendIdr -
          orderNetSubtotalIdr({
            subtotalIdr: net,
            serviceChargeIdr: tax.serviceChargeIdr,
            taxIdr: tax.taxIdr,
            pricesIncludeTax: inclusive,
          }),
      ),
    },
    servingEstimate: estimate,
    computedAt,
  });
  return { quote, tax };
}
