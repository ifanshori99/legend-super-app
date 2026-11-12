// Cashier/captain catalog read model. Pricing and availability share the sale
// path's helpers; unavailable choices remain visible instead of disappearing.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import {
  posCatalogSchema,
  type OrderChannel,
  type PosCatalog,
  type ServiceType,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
} from "../db/schema/index.ts";
import { isLinePaused, readPausedMenuLines } from "./kds-pacing.service.ts";
import { readAvailabilityDecisions } from "./menu-availability.ts";
import {
  loadMediaUrls,
  noMediaUrls,
  type MenuMediaUrls,
} from "./menu-internals.ts";
import { readChannelPriceGrid } from "./menu-pricing.service.ts";
import { posPriceChannel } from "./pos-order-pricing.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";

export async function getPosCatalog(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: { channel: OrderChannel; serviceType: ServiceType },
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<PosCatalog> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const outlet = await loadOutlet(tx, context, outletId);
    const businessDate = businessDateFor(outlet, now);
    const channel = posPriceChannel(query.channel, query.serviceType);
    const categoryRows = await tx
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
          eq(menuCategories.brandId, outlet.brandId),
          isNull(menuCategories.deletedAt),
        ),
      )
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.id));
    const grid = await readChannelPriceGrid(tx, context, {
      outletId,
      channel,
      businessDate,
    });
    const pricedIds = [...new Set(grid.entries.map((entry) => entry.itemId))];
    const rows = pricedIds.length
      ? await tx
          .select({
            id: menuItems.id,
            categoryId: menuItems.categoryId,
            categoryName: menuCategories.name,
            name: menuItems.name,
            mediaId: menuItems.mediaId,
            course: menuItems.course,
            updatedAt: menuItems.updatedAt,
          })
          .from(menuItems)
          .innerJoin(
            menuCategories,
            and(
              eq(menuCategories.tenantId, menuItems.tenantId),
              eq(menuCategories.id, menuItems.categoryId),
              eq(menuCategories.brandId, outlet.brandId),
              isNull(menuCategories.deletedAt),
            ),
          )
          .where(
            and(
              eq(menuItems.tenantId, tenantId),
              eq(menuItems.brandId, outlet.brandId),
              inArray(menuItems.id, pricedIds),
              eq(menuItems.isActive, true),
              isNull(menuItems.deletedAt),
            ),
          )
          .orderBy(
            asc(menuCategories.sortOrder),
            asc(menuItems.sortOrder),
            asc(menuItems.id),
          )
      : [];
    const itemIds = rows.map((row) => row.id);
    const stamps = [
      ...categoryRows.map((row) => row.updatedAt),
      ...rows.map((row) => row.updatedAt),
      ...(grid.priceList ? [grid.priceList.updatedAt] : []),
      ...grid.entries.map((row) => row.updatedAt),
    ];
    const categories = categoryRows.map(({ id, name, sortOrder }) => ({
      id,
      name,
      sortOrder,
    }));
    const updatedAt = () =>
      stamps
        .reduce(
          (latest, stamp) => (stamp > latest ? stamp : latest),
          stamps[0] ?? now,
        )
        .toISOString();
    if (itemIds.length === 0)
      return posCatalogSchema.parse({
        categories,
        items: [],
        updatedAt: updatedAt(),
        source: "live",
      });

    const variants = await tx
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
    const links = await tx
      .select({
        menuItemId: menuItemModifierGroups.menuItemId,
        updatedAt: menuItemModifierGroups.updatedAt,
        group: modifierGroups,
      })
      .from(menuItemModifierGroups)
      .innerJoin(
        modifierGroups,
        and(
          eq(modifierGroups.tenantId, menuItemModifierGroups.tenantId),
          eq(modifierGroups.id, menuItemModifierGroups.groupId),
          isNull(modifierGroups.deletedAt),
        ),
      )
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
    const groupIds = [...new Set(links.map((link) => link.group.id))];
    const options = groupIds.length
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
    const availability = await readAvailabilityDecisions(tx, {
      tenantId,
      outletId,
      itemIds,
      at: now,
      timeZone: outlet.timezone,
      businessDate,
    });
    const paused = await readPausedMenuLines(
      tx,
      context,
      outletId,
      channel,
      now,
    );
    const mediaUrls = await loadMediaUrls(
      tx,
      context,
      rows.flatMap((row) => (row.mediaId === null ? [] : [row.mediaId])),
      resolveMediaUrls,
    );
    stamps.push(
      ...variants.map((row) => row.updatedAt),
      ...links.flatMap((row) => [row.updatedAt, row.group.updatedAt]),
      ...options.map((row) => row.updatedAt),
      ...[...availability.values()].map((row) => row.updatedAt),
    );
    const plainPrices = new Map<string, number>();
    const variantPrices = new Map<string, number>();
    for (const entry of grid.entries) {
      if (entry.variantId === null)
        plainPrices.set(entry.itemId, entry.priceIdr);
      else variantPrices.set(entry.variantId, entry.priceIdr);
    }
    const variantsByItem = new Map<string, typeof variants>();
    for (const variant of variants) {
      const group = variantsByItem.get(variant.menuItemId) ?? [];
      group.push(variant);
      variantsByItem.set(variant.menuItemId, group);
    }
    const linksByItem = new Map<string, typeof links>();
    for (const link of links) {
      const group = linksByItem.get(link.menuItemId) ?? [];
      group.push(link);
      linksByItem.set(link.menuItemId, group);
    }
    const optionsByGroup = new Map<string, typeof options>();
    for (const option of options) {
      const group = optionsByGroup.get(option.groupId) ?? [];
      group.push(option);
      optionsByGroup.set(option.groupId, group);
    }
    const items = rows.flatMap((row) => {
      const pricedVariants = (variantsByItem.get(row.id) ?? []).flatMap(
        (variant) => {
          const priceIdr = variantPrices.get(variant.id);
          return priceIdr !== undefined && priceIdr > 0
            ? [{ id: variant.id, name: variant.name, priceIdr }]
            : [];
        },
      );
      const plain = plainPrices.get(row.id);
      const plainPriceIdr = plain !== undefined && plain > 0 ? plain : null;
      const basePriceIdr = pricedVariants.length
        ? Math.min(...pricedVariants.map((variant) => variant.priceIdr))
        : plainPriceIdr;
      if (basePriceIdr === null) return [];
      const pausedItem = pricedVariants.length
        ? pricedVariants.every((variant) =>
            isLinePaused(paused, row.id, variant.id),
          )
        : isLinePaused(paused, row.id, null);
      return [
        {
          id: row.id,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          name: row.name,
          basePriceIdr,
          plainPriceIdr,
          variants: pricedVariants,
          imageUrl:
            row.mediaId === null ? null : (mediaUrls.get(row.mediaId) ?? null),
          course: row.course,
          code: null,
          soldOut: !(availability.get(row.id)?.sellable ?? true) || pausedItem,
          modifierGroups: (linksByItem.get(row.id) ?? []).map(({ group }) => ({
            id: group.id,
            name: group.name,
            required: group.minSelect > 0,
            min: group.minSelect,
            max: group.maxSelect,
            options: (optionsByGroup.get(group.id) ?? []).map((option) => ({
              id: option.id,
              label: option.name,
              priceDeltaIdr: option.priceIdr,
            })),
          })),
        },
      ];
    });
    return posCatalogSchema.parse({
      categories,
      items,
      updatedAt: updatedAt(),
      source: "live",
    });
  });
}
