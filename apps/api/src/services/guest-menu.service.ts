// Guest/public menu read models (PRD v1.7 §10 QR Order, §8 "Konten Menu";
// owner Q17/Q23, bead legend-qf0i).
//
// Two public surfaces read the same catalogue:
//   - `GET /api/qr/menu/:qrToken` — the QR order menu of one table (WS-03);
//   - `GET /api/public/site/menu` — the brand website's online menu (WS-08 F21).
//
// Both are guest reads, so both apply owner Q23: an active item is only shown
// with a photo. Rows created before the rule can still be active with
// `media_id` NULL; the back office keeps listing them (with the "Foto wajib"
// badge) while these services skip them — the SQL predicate
// `guestMenuItemCondition` narrows the query and `menuItemVisibleToGuests`
// re-checks the row before it is mapped, so one contract rule drives every
// public read.
//
// Prices are the outlet's dine-in price list (latest version effective today)
// and, per the owner decision of 1 Nov 2026, exclude tax and service charge
// unless the outlet's F&B tax rule is price-inclusive (legend-49pw).
// The tax note is the rule the WS-05 resolver (`resolveTaxRule`) picks for a
// representative F&B dine-in line of the outlet, so the note can never list a
// rule the engine would override; the tax engine still owns the real
// calculation — the menu only prints the note, so no rounding happens here.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  businessDateOf,
  CoreError,
  brandIdSchema,
  idr,
  outletIdSchema,
  toIsoDateTime,
  type BrandId,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  menuItemVisibleToGuests,
  type MenuSchedule,
} from "@starter/shared/menu";
import {
  assertQrTokenMatchesTable,
  qrMenuSchema,
  tableIdSchema,
  type QrMenu,
  type QrMenuItem,
  type QrMenuModifierGroup,
  type ZoneHours,
} from "@starter/shared/qr-order";
import {
  effectiveRuleVersions,
  resolveServiceChargeRule,
  resolveTaxRule,
  TaxError,
  type TaxRule,
} from "@starter/shared/tax";
import {
  publicMenuPageSchema,
  type PublicMenuPage,
} from "@starter/shared/website";
import { db } from "../db";
import {
  brands,
  floorZones,
  itemAvailability,
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  outlets,
  tables,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  guestMenuItemCondition,
  loadMediaUrls,
  noMediaUrls,
  type MenuMediaUrls,
  type Tx,
} from "./menu-internals";
import {
  minutesOfDay,
  readAvailabilityDecisions,
  wallClockAt,
  withinWindows,
} from "./menu-availability";
import { outletBusinessDayClock } from "./outlet-clock";
import { readChannelPriceGrid } from "./menu-pricing.service";
import { loadTaxConfig, selectServiceChargeRules } from "./qr-order-pricing";
import { verifyTableQrToken } from "./qr-token";

/** The contract caps a guest item's lists; the database does not. */
const MAX_LABELS = 6;
const MAX_ALLERGENS = 10;
const MAX_VARIANTS = 8;
const MAX_MODIFIER_GROUPS = 8;
const MAX_DESCRIPTION = 500;
/** The QR menu and the website are the dine-in channel (PRD §10). */
const GUEST_CHANNEL = "dine_in" as const;

type GuestCatalogue = {
  categories: { id: string; name: string; sortOrder: number }[];
  items: QrMenuItem[];
  updatedAt: Date;
};

function notFound(): CoreError {
  return new CoreError("NOT_FOUND", "QR meja tidak dikenali");
}

// ---- Zone hours ------------------------------------------------------------

/**
 * Is the zone ordering right now? Wall clock of the outlet (PRD: business hours
 * follow the outlet time zone), compared against `zone.hours`; a zone with no
 * window never opens. The menu itself stays readable — only ordering is
 * refused, so the guest can still browse (contract `orderingOpen`).
 */
export function zoneOrderingOpen(
  hours: readonly ZoneHours[],
  at: Date,
  timeZone: string,
): boolean {
  return withinWindows(hours, at, timeZone, "closed");
}

/**
 * Start of the next sales window later the same local day, or null when none
 * opens before midnight (legend-nx3f: "Tersedia mulai HH:mm" only promises a
 * window today; a window on another day stays `sold_out`). A window with
 * `start === end` is a full day, so it is never "later".
 */
export function nextWindowStartToday(
  windows: readonly MenuSchedule[],
  at: Date,
  timeZone: string,
): Date | null {
  const clock = wallClockAt(at, timeZone);
  if (!clock) return null;
  const starts = windows
    .filter((window) => window.daysOfWeek.includes(clock.weekday))
    .filter((window) => minutesOfDay(window.start) !== minutesOfDay(window.end))
    .map((window) => minutesOfDay(window.start))
    .filter((start) => start > clock.minutes);
  if (starts.length === 0) return null;
  const minuteStart = Math.floor(at.getTime() / 60_000) * 60_000;
  return new Date(minuteStart + (Math.min(...starts) - clock.minutes) * 60_000);
}

// ---- Catalogue -------------------------------------------------------------

/**
 * The guest catalogue of one brand outlet: visible categories, visible items
 * with their dine-in price, variants, modifier groups and 86 state.
 *
 * Q23: an active item without `media_id` is dropped here (SQL predicate plus
 * the shared predicate on the row), so no caller can build a guest payload
 * that still carries it.
 */
async function readGuestCatalogue(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    brandId: BrandId;
    outletId: OutletId;
    now: Date;
    /** The outlet's IANA zone: schedules follow its wall clock. */
    timeZone: string;
    /** Owner Q39: price lists and daily limits follow the business date. */
    businessDayCutoff: string;
  },
  resolveMediaUrls: MenuMediaUrls,
): Promise<GuestCatalogue> {
  const tenantId = context.tenant.tenantId;
  const today = businessDateOf(input.now, {
    timeZone: input.timeZone,
    cutoff: input.businessDayCutoff,
  });

  const categories = await tx
    .select({
      id: menuCategories.id,
      name: menuCategories.name,
      sortOrder: menuCategories.sortOrder,
      updatedAt: menuCategories.updatedAt,
    })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, tenantId),
        eq(menuCategories.brandId, input.brandId),
        isNull(menuCategories.deletedAt),
      ),
    )
    .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.id));

  const rows = await tx
    .select()
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, input.brandId),
        isNull(menuItems.deletedAt),
        guestMenuItemCondition(),
      ),
    )
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.id));

  // The freshest menu row drives `menuUpdatedAt`; a brand with no rows answers
  // the request clock, which is the only honest "what we read" stamp.
  const stamps = [...categories, ...rows].map((row) => row.updatedAt);
  const updatedAt = stamps.reduce(
    (latest, stamp) => (stamp > latest ? stamp : latest),
    stamps[0] ?? input.now,
  );
  if (rows.length === 0)
    return {
      categories: categories.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
      })),
      items: [],
      updatedAt,
    };

  const categoryIds = new Set(categories.map((row) => row.id));
  // Belt and braces: the SQL predicate above already enforced this, but the
  // rule is the contract's (`menuItemVisibleToGuests`), so re-check per row.
  const visible = rows.filter(
    (row) =>
      categoryIds.has(row.categoryId) &&
      menuItemVisibleToGuests({
        isActive: row.isActive,
        mediaId: row.mediaId,
      }),
  );
  if (visible.length === 0)
    return {
      categories: categories.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
      })),
      items: [],
      updatedAt,
    };

  const itemIds = visible.map((row) => row.id);
  // The effective dine-in price grid: one resolver shared with the POS/ojol
  // order paths (bead legend-h2a), so a channel price can never read two ways.
  const grid = await readChannelPriceGrid(tx, context, {
    outletId: input.outletId,
    channel: GUEST_CHANNEL,
    businessDate: today,
    itemIds,
  });
  const priceList = grid.priceList;
  const prices = grid.entries;
  const plainPrice = new Map<string, number>();
  const variantPrice = new Map<string, number>();
  for (const row of prices) {
    if (row.variantId === null) plainPrice.set(row.itemId, row.priceIdr);
    else variantPrice.set(row.variantId, row.priceIdr);
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
    )
    .orderBy(asc(itemVariants.name), asc(itemVariants.id));
  const variantsByItem = new Map<string, typeof variantRows>();
  for (const row of variantRows) {
    const list = variantsByItem.get(row.menuItemId) ?? [];
    list.push(row);
    variantsByItem.set(row.menuItemId, list);
  }

  const links = await tx
    .select({
      menuItemId: menuItemModifierGroups.menuItemId,
      groupId: menuItemModifierGroups.groupId,
      sortOrder: menuItemModifierGroups.sortOrder,
      updatedAt: menuItemModifierGroups.updatedAt,
    })
    .from(menuItemModifierGroups)
    .where(
      and(
        eq(menuItemModifierGroups.tenantId, tenantId),
        inArray(menuItemModifierGroups.menuItemId, itemIds),
        isNull(menuItemModifierGroups.deletedAt),
      ),
    )
    .orderBy(
      asc(menuItemModifierGroups.sortOrder),
      asc(menuItemModifierGroups.groupId),
    );
  const groupIds = [...new Set(links.map((row) => row.groupId))];
  const groups = groupIds.length
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
  const groupById = new Map(groups.map((row) => [row.id, row]));
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
        .orderBy(asc(modifiers.name), asc(modifiers.id))
    : [];
  const modifiersByGroup = new Map<string, typeof modifierRows>();
  for (const row of modifierRows) {
    const list = modifiersByGroup.get(row.groupId) ?? [];
    list.push(row);
    modifiersByGroup.set(row.groupId, list);
  }
  const groupsByItem = new Map<string, QrMenuModifierGroup[]>();
  for (const link of links) {
    const group = groupById.get(link.groupId);
    if (!group) continue;
    const options = (modifiersByGroup.get(group.id) ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      priceIdr: row.priceIdr,
      soldOut: false,
    }));
    // The contract refuses an empty group and a maxSelect beyond its options.
    if (options.length === 0 || group.maxSelect > options.length) continue;
    const list = groupsByItem.get(link.menuItemId) ?? [];
    if (list.length >= MAX_MODIFIER_GROUPS) continue;
    list.push({
      id: group.id,
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      modifiers: options,
    });
    groupsByItem.set(link.menuItemId, list);
  }

  // Ketersediaan (PRD §8): the 86 state, the schedule window of this instant
  // and today's remaining daily quantity decide whether the item can be added
  // (ORD-05). Outside its window or out of daily stock it answers `sold_out`,
  // the only unavailable state the QR/public contracts carry; a passed
  // `soldOutUntil` already counts as restored.
  const availability = await readAvailabilityDecisions(tx, {
    tenantId,
    outletId: input.outletId,
    itemIds,
    at: input.now,
    timeZone: input.timeZone,
    businessDate: today,
  });
  const soldOut = new Set(
    [...availability.entries()]
      .filter(([, decision]) => !decision.sellable)
      .map(([itemId]) => itemId),
  );
  const outsideSchedule = [...availability.entries()]
    .filter(
      ([, decision]) =>
        decision.reason === "outside_schedule" &&
        // A later window does not help while today's daily stock is spent.
        (decision.remaining === null || decision.remaining > 0),
    )
    .map(([itemId]) => itemId);
  const availableFrom = new Map<string, Date>();
  if (outsideSchedule.length > 0) {
    const scheduleRows = await tx
      .select({
        menuItemId: itemAvailability.menuItemId,
        schedule: itemAvailability.schedule,
      })
      .from(itemAvailability)
      .where(
        and(
          eq(itemAvailability.tenantId, tenantId),
          eq(itemAvailability.outletId, input.outletId),
          inArray(itemAvailability.menuItemId, outsideSchedule),
          isNull(itemAvailability.deletedAt),
        ),
      );
    for (const row of scheduleRows) {
      const next = nextWindowStartToday(
        row.schedule,
        input.now,
        input.timeZone,
      );
      if (next) availableFrom.set(row.menuItemId, next);
    }
  }

  const mediaUrls = await loadMediaUrls(
    tx,
    context,
    visible.map((row) => row.mediaId).filter((id) => id !== null),
    resolveMediaUrls,
  );

  const items: QrMenuItem[] = [];
  for (const row of visible) {
    const variants = (variantsByItem.get(row.id) ?? [])
      .map((variant) => ({
        id: variant.id,
        name: variant.name,
        priceIdr: variantPrice.get(variant.id),
      }))
      .filter(
        (variant): variant is { id: string; name: string; priceIdr: number } =>
          variant.priceIdr !== undefined && variant.priceIdr > 0,
      )
      .slice(0, MAX_VARIANTS);
    // A variant item may carry its prices per variant only; the contract still
    // wants a headline price, and it must be the lowest variant price.
    const plain = plainPrice.get(row.id);
    const base =
      variants.length > 0
        ? Math.min(...variants.map((variant) => variant.priceIdr))
        : plain;
    // No price means the item cannot be sold on this channel, so it is not a
    // guest menu item at all.
    if (base === undefined || base <= 0) continue;
    const priceIdr = base;
    const later = availableFrom.get(row.id);
    items.push({
      id: row.id,
      categoryId: row.categoryId,
      name: row.name,
      description: row.description.slice(0, MAX_DESCRIPTION),
      type: row.type === "combo" ? "combo" : "single",
      priceIdr: idr(priceIdr),
      labels: row.labels.slice(0, MAX_LABELS),
      allergens: row.allergens.slice(0, MAX_ALLERGENS),
      photoUrl: row.mediaId ? (mediaUrls.get(row.mediaId) ?? null) : null,
      variants: variants.map((variant) => ({
        ...variant,
        priceIdr: idr(variant.priceIdr),
      })),
      modifierGroups: groupsByItem.get(row.id) ?? [],
      ...(later
        ? {
            status: "unavailable_until" as const,
            availableFrom: toIsoDateTime(later),
          }
        : { status: soldOut.has(row.id) ? "sold_out" : "available" }),
      sortOrder: row.sortOrder,
    });
  }

  // Every row the payload derives from counts: a price, modifier, variant or
  // 86 change must move `menuUpdatedAt`, not only an item rename.
  const freshAt = [
    ...(priceList ? [priceList.updatedAt] : []),
    ...prices.map((row) => row.updatedAt),
    ...[...availability.values()].map((decision) => decision.updatedAt),
    ...variantRows.map((row) => row.updatedAt),
    ...groups.map((row) => row.updatedAt),
    ...modifierRows.map((row) => row.updatedAt),
    ...links.map((row) => row.updatedAt),
  ].reduce((latest, stamp) => (stamp > latest ? stamp : latest), updatedAt);

  return {
    categories: categories.map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
    })),
    items,
    updatedAt: freshAt,
  };
}

type GuestTaxNote = {
  taxes: { name: string; rateBp: number }[];
  /** True only when EVERY picked rule is price-inclusive. */
  pricesIncludeTaxAndService: boolean;
  taxPriceMode: "inclusive" | "exclusive" | "mixed";
  /** The rate the engine would charge in this zone (zone rule, else outlet rule). */
  serviceChargeBp: number;
};

/** Nil UUID: the representative line is not a real menu item. */
const NOTE_ITEM_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The tax note of the menu (legend-lf8g): the rules the WS-05 resolver picks
 * for the guest items (food_beverage, dine-in) of the outlet, resolved per item
 * so category- and item-specific rules count, and listed once each. Follows the
 * same item/category/outlet/channel/region specificity as the real calculation.
 * An item whose rule is missing or ambiguous (the engine fails closed on both)
 * adds nothing; no items at all falls back to one representative line. Nothing
 * is computed from it.
 *
 * `taxPriceMode` follows the picked rules' `priceIncludesTax`, the flag
 * `calculateTax` (POS, QR order) honours: all inclusive, all exclusive, or
 * mixed (the guest sees a neutral note; checkout refuses a mixed cart). The
 * `tax_settings` value is only the default for rules created later.
 *
 * The service charge rate uses the same selection as the quote
 * (`selectServiceChargeRules`): a zone with no charge falls back to the
 * outlet's published service charge rule.
 */
async function readGuestTaxNote(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    zone: typeof floorZones.$inferSelect;
    today: string;
    items: readonly { id: string; categoryId: string }[];
  },
): Promise<GuestTaxNote> {
  const config = await loadTaxConfig(tx, context, input.outletId);
  const rules = effectiveRuleVersions(
    config.taxRules,
    input.outletId,
    input.today,
  );
  const taxContext = {
    outletId: input.outletId,
    channel: GUEST_CHANNEL,
    zoneId: input.zone.id,
    // Outlets carry no PBJT region code yet; region-bound rules do not match.
    regionCode: null,
  };
  const lines =
    input.items.length > 0
      ? input.items.map((item) => ({
          itemId: item.id,
          categoryId: item.categoryId,
        }))
      : [{ itemId: NOTE_ITEM_ID, categoryId: null }];
  const picked = new Map<string, TaxRule>();
  for (const line of lines)
    try {
      const rule = resolveTaxRule(rules, taxContext, {
        ...line,
        itemClass: "food_beverage",
      });
      picked.set(rule.id, rule);
    } catch (error) {
      if (!(error instanceof TaxError)) throw error;
    }
  const inclusive = [...picked.values()].filter(
    (rule) => rule.priceIncludesTax,
  ).length;
  const taxPriceMode =
    inclusive === 0
      ? "exclusive"
      : inclusive === picked.size
        ? "inclusive"
        : "mixed";

  let serviceChargeBp = 0;
  try {
    serviceChargeBp =
      resolveServiceChargeRule(
        effectiveRuleVersions(
          selectServiceChargeRules(
            input.zone,
            context,
            config.serviceChargeRules,
          ),
          input.outletId,
          input.today,
        ),
        taxContext,
        "food_beverage",
      )?.rateBp ?? 0;
  } catch (error) {
    // Ambiguous service rules: the engine fails closed, the note shows none.
    if (!(error instanceof TaxError)) throw error;
  }
  return {
    taxes: [...picked.values()].map((rule) => ({
      name: rule.name,
      rateBp: rule.rateBp,
    })),
    pricesIncludeTaxAndService: taxPriceMode === "inclusive",
    taxPriceMode,
    serviceChargeBp,
  };
}

// ---- QR menu ---------------------------------------------------------------

async function brandAndOutletRefs(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
) {
  const [outlet] = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  const [brand] = await tx
    .select()
    .from(brands)
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)));
  if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
  return { outlet, brand };
}

/**
 * Guest items that can be ordered right now at one outlet (read-only wrapper
 * of the private catalogue read, same Q23 / price / 86 rules): status
 * `available`, in the menu's own order. Used by the guest suggestions read
 * model, which must never offer an item the guest cannot order.
 */
export async function listOrderableGuestItems(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; now: Date },
): Promise<QrMenuItem[]> {
  const { outlet } = await brandAndOutletRefs(
    tx,
    context.tenant.tenantId,
    input.outletId,
  );
  const catalogue = await readGuestCatalogue(
    tx,
    context,
    {
      brandId: brandIdSchema.parse(outlet.brandId),
      outletId: input.outletId,
      now: input.now,
      timeZone: outlet.timezone,
      businessDayCutoff: outlet.businessDayCutoff,
    },
    noMediaUrls,
  );
  return catalogue.items.filter((item) => item.status === "available");
}

/**
 * `GET /api/qr/menu/:qrToken` (contract `getQrMenu`): the guest menu of the
 * scanned table. Public by signed token — the token resolves tenant, outlet and
 * table (TEN-02/ORD-04), never a request parameter.
 */
export async function getQrMenu(
  context: ScopedTenantContext,
  qrToken: string,
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<QrMenu> {
  const verified = verifyTableQrToken({
    token: qrToken,
    resolvedTenantId: context.tenant.tenantId,
  });
  return withTenant(db, context, async (tx) => {
    const [table] = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.qrTokenHash, verified.hash),
        ),
      )
      .limit(1);
    // Every failure is the same NOT_FOUND: no oracle for valid ids (ORD-04).
    if (!table) throw notFound();
    assertQrTokenMatchesTable(verified.payload, context.tenant.tenantId, {
      id: tableIdSchema.parse(table.id),
      tenantId: table.tenantId,
      outletId: table.outletId,
      status: table.status,
    });
    const [zone] = await tx
      .select()
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eq(floorZones.id, table.zoneId),
        ),
      )
      .limit(1);
    if (!zone) throw notFound();
    if (zone.status === "inactive")
      throw new CoreError("CONFLICT", "Zona meja sedang tidak aktif.");

    const { outlet, brand } = await brandAndOutletRefs(
      tx,
      context.tenant.tenantId,
      table.outletId,
    );
    const catalogue = await readGuestCatalogue(
      tx,
      context,
      {
        brandId: brandIdSchema.parse(outlet.brandId),
        outletId: outletIdSchema.parse(outlet.id),
        now,
        timeZone: outlet.timezone,
        businessDayCutoff: outlet.businessDayCutoff,
      },
      resolveMediaUrls,
    );
    const taxNote = await readGuestTaxNote(tx, context, {
      outletId: outletIdSchema.parse(outlet.id),
      zone,
      today: businessDateOf(now, outletBusinessDayClock(outlet)),
      items: catalogue.items,
    });

    return qrMenuSchema.parse({
      brand: {
        id: brand.id,
        tenantId: brand.tenantId,
        slug: brand.slug,
        name: brand.name,
      },
      outlet: {
        id: outlet.id,
        tenantId: outlet.tenantId,
        brandId: outlet.brandId,
        code: outlet.code,
        name: outlet.name,
        timeZone: outlet.timezone,
        businessDayCutoff: outlet.businessDayCutoff,
        status: outlet.status,
      },
      table: {
        id: table.id,
        code: table.code,
        capacity: table.capacity,
      },
      zone: {
        id: zone.id,
        name: zone.name,
        paymentMode: zone.paymentMode,
        serviceChargeBp: taxNote.serviceChargeBp,
        minimumSpendIdr: zone.minimumSpendIdr,
      },
      orderingOpen: zoneOrderingOpen(zone.hours, now, outlet.timezone),
      pricing: {
        pricesIncludeTaxAndService: taxNote.pricesIncludeTaxAndService,
        taxPriceMode: taxNote.taxPriceMode,
        serviceChargeBp: taxNote.serviceChargeBp,
        taxes: taxNote.taxes,
      },
      categories: catalogue.categories,
      items: catalogue.items,
      menuUpdatedAt: toIsoDateTime(catalogue.updatedAt),
    });
  });
}

// ---- Public website menu ---------------------------------------------------

/**
 * `GET /api/public/site/menu` (contract `getPublicMenuPage`): the online menu
 * of the brand the request host resolves to (TEN-08, D-CORE-3). The brand's
 * first outlet is the public one; a brand with no publishable item has no
 * online menu, which answers NOT_FOUND instead of an empty page.
 */
export async function getPublicMenuPage(
  context: ScopedTenantContext,
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<PublicMenuPage> {
  return withTenant(db, context, async (tx) => {
    const [brand] = await tx
      .select()
      .from(brands)
      .where(
        and(
          eq(brands.tenantId, context.tenant.tenantId),
          ...(context.tenant.brandId
            ? [eq(brands.id, context.tenant.brandId)]
            : []),
        ),
      )
      .orderBy(asc(brands.createdAt), asc(brands.id))
      .limit(1);
    if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
    const [outlet] = await tx
      .select()
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.brandId, brand.id),
          eq(outlets.status, "active"),
        ),
      )
      .orderBy(asc(outlets.createdAt), asc(outlets.id))
      .limit(1);
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");

    const catalogue = await readGuestCatalogue(
      tx,
      context,
      {
        brandId: brandIdSchema.parse(brand.id),
        outletId: outletIdSchema.parse(outlet.id),
        now,
        timeZone: outlet.timezone,
        businessDayCutoff: outlet.businessDayCutoff,
      },
      resolveMediaUrls,
    );
    const sections = catalogue.categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        // menu_categories has no description column yet (PRD §6 C).
        description: null,
        sortOrder: category.sortOrder,
        items: catalogue.items
          .filter((item) => item.categoryId === category.id)
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            priceIdr: item.priceIdr,
            // Contract: the website shows an absolute https URL; a storage
            // provider that is not configured yet answers null (legend-3sbl).
            imageUrl:
              item.photoUrl && item.photoUrl.startsWith("https://")
                ? item.photoUrl
                : null,
            labels: item.labels.slice(0, 5),
            allergens: item.allergens,
            isAvailable: item.status === "available",
          })),
      }))
      .filter((section) => section.items.length > 0);
    if (sections.length === 0)
      throw new CoreError(
        "NOT_FOUND",
        "Menu publik belum tersedia untuk brand ini.",
      );

    return publicMenuPageSchema.parse({
      sections,
      pricesExcludeTaxAndService: true,
      updatedAt: toIsoDateTime(catalogue.updatedAt),
    });
  });
}
