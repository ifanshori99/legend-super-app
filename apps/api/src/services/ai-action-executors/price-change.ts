// TL-17 executor: change menu prices through the price list services
// (`createPriceList` / `setPriceListItems`, menu.price.manage re-checked by the
// services for the requester). Price lists are versioned per outlet and
// channel by `effectiveFrom` (a business date): for each outlet and channel the
// list in force on the effective date is copied into a new list dated that day
// (or edited in place when it already starts that day), with the new prices on
// the items it already sells. An item sold in no channel of an outlet fails the
// request (a price change never starts selling an item).
//
// Two phases. Phase 1 reads and validates every outlet and channel (access,
// item sold there) and writes nothing. Phase 2 writes; the price services
// commit on their own, so on an error the lists created in this run are deleted
// and in-place edits are restored before the error is rethrown. A dated list
// is never left empty.
//
// Idempotency: setting prices is idempotent by value, and a re-run after a
// crash finds the list already dated that day. If that list is still empty
// (created, grid not yet copied) its items come from the previous version.
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { localDateOf } from "@starter/shared/core";
import { draftPriceChangeInputSchema } from "@starter/shared/ai";
import { db } from "../../db/index.ts";
import { outlets, priceListItems, priceLists } from "../../db/schema/index.ts";
import type { ScopedTenantContext } from "@starter/shared/core";
import { withTenant } from "../../db/tenant.ts";
import {
  createPriceList,
  deletePriceList,
  setPriceListItems,
} from "../menu-pricing.service.ts";
import { ActionExecutionError, type ActionExecutor } from "./types.ts";

export const executePriceChange: ActionExecutor = async ({
  access,
  row,
  now,
}) => {
  const payload = draftPriceChangeInputSchema.parse(row.payload);
  const target = access.contextFor("menu.price.manage", { type: "tenant" });
  const reach = target ?? null;
  // Absent outletIds = every outlet the requester may manage.
  const outletIds =
    payload.outletIds ??
    (reach
      ? (
          await withTenant(db, reach, (tx) =>
            tx
              .select({ id: outlets.id })
              .from(outlets)
              .where(eq(outlets.tenantId, row.tenantId)),
          )
        ).map((entry) => entry.id)
      : []);
  if (outletIds.length === 0)
    throw new ActionExecutionError(
      "Tidak ada outlet yang boleh diubah harganya.",
    );
  const effectiveDate = localDateOf(payload.effectiveAt);
  const today = localDateOf(now);
  const date = effectiveDate < today ? today : effectiveDate;
  const newPrice = new Map(
    payload.changes.map((change) => [change.menuItemId, change.newPriceIdr]),
  );
  type Entry = { itemId: string; variantId: string | null; priceIdr: number };
  type Step = {
    context: ScopedTenantContext;
    outletId: string;
    channel: (typeof priceLists.$inferSelect)["channel"];
    listId: string;
    create: boolean;
    entries: Entry[];
    original: Entry[];
  };
  // Phase 1: validate everything, write nothing.
  const steps: Step[] = [];
  for (const outletId of outletIds) {
    const context = access.contextFor("menu.price.manage", {
      type: "outlet",
      id: outletId,
    });
    if (!context)
      throw new ActionExecutionError(
        "Pengaju tidak lagi punya akses ke outlet ini.",
      );
    const channels = await withTenant(db, context, async (tx) => {
      const lists = await tx
        .select()
        .from(priceLists)
        .where(
          and(
            eq(priceLists.tenantId, row.tenantId),
            eq(priceLists.outletId, outletId),
            lte(priceLists.effectiveFrom, date),
            isNull(priceLists.deletedAt),
          ),
        )
        .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id));
      // Latest list in force per channel, with its items.
      const latest = new Map<string, (typeof lists)[number]>();
      for (const list of lists)
        if (!latest.has(list.channel)) latest.set(list.channel, list);
      const result = [];
      for (const list of latest.values()) {
        let items = await tx
          .select()
          .from(priceListItems)
          .where(
            and(
              eq(priceListItems.tenantId, row.tenantId),
              eq(priceListItems.priceListId, list.id),
              isNull(priceListItems.deletedAt),
            ),
          );
        if (items.length === 0 && list.effectiveFrom === date) {
          // Crashed re-run: the new list exists but was never filled.
          const previous = lists.find(
            (candidate) =>
              candidate.channel === list.channel &&
              candidate.effectiveFrom < date,
          );
          if (previous) {
            items = await tx
              .select()
              .from(priceListItems)
              .where(
                and(
                  eq(priceListItems.tenantId, row.tenantId),
                  eq(priceListItems.priceListId, previous.id),
                  isNull(priceListItems.deletedAt),
                ),
              );
          }
        }
        result.push({ list, items });
      }
      return result;
    });
    const touched = new Set<string>();
    for (const { list, items } of channels) {
      const hit = items.filter((item) => newPrice.has(item.itemId));
      if (hit.length === 0) continue;
      for (const item of hit) touched.add(item.itemId);
      const original = items.map((item) => ({
        itemId: item.itemId,
        variantId: item.variantId ?? null,
        priceIdr: Number(item.priceIdr),
      }));
      steps.push({
        context,
        outletId,
        channel: list.channel,
        listId: list.id,
        create: list.effectiveFrom !== date,
        entries: original.map((entry) => ({
          ...entry,
          priceIdr: newPrice.get(entry.itemId) ?? entry.priceIdr,
        })),
        original,
      });
    }
    for (const menuItemId of newPrice.keys())
      if (!touched.has(menuItemId))
        throw new ActionExecutionError(
          "Salah satu item menu tidak dijual di outlet tujuan.",
        );
  }
  // Phase 2: write, compensating on error.
  const created: { context: ScopedTenantContext; id: string }[] = [];
  const edited: Step[] = [];
  try {
    for (const step of steps) {
      let listId = step.listId;
      if (step.create) {
        const list = await createPriceList(
          step.context,
          row.requestedByUserId,
          {
            outletId: step.outletId,
            channel: step.channel,
            effectiveFrom: date,
          },
          now,
        );
        listId = list.id;
        created.push({ context: step.context, id: list.id });
      } else edited.push(step);
      await setPriceListItems(
        step.context,
        row.requestedByUserId,
        listId,
        step.entries,
        now,
      );
    }
  } catch (error) {
    for (const step of edited)
      await setPriceListItems(
        step.context,
        row.requestedByUserId,
        step.listId,
        step.original,
        now,
      ).catch(() => undefined);
    for (const list of created)
      await deletePriceList(
        list.context,
        row.requestedByUserId,
        list.id,
        now,
      ).catch(() => undefined);
    throw error;
  }
  return { resultRef: `price_change:${steps.length}_lists` };
};
