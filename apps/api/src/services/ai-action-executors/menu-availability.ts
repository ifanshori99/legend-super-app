// TL-18 executor: sell out / restore menu items at one outlet through the 86
// toggle (`setAvailabilityStatus`, idempotent by key, permission re-checked by
// the service for the requester). An item already in the wanted state is left
// alone.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { draftMenuAvailabilityInputSchema } from "@starter/shared/ai";
import { db } from "../../db/index.ts";
import { itemAvailability } from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { setAvailabilityStatus } from "../menu-pricing.service.ts";
import { ActionExecutionError, type ActionExecutor } from "./types.ts";

export const executeMenuAvailability: ActionExecutor = async ({
  access,
  row,
  now,
}) => {
  const payload = draftMenuAvailabilityInputSchema.parse(row.payload);
  const context = access.contextFor("menu.availability.toggle", {
    type: "outlet",
    id: payload.outletId,
  });
  if (!context)
    throw new ActionExecutionError(
      "Pengaju tidak lagi punya akses ke outlet ini.",
    );
  const found = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: itemAvailability.id,
        menuItemId: itemAvailability.menuItemId,
        status: itemAvailability.status,
      })
      .from(itemAvailability)
      .where(
        and(
          eq(itemAvailability.tenantId, row.tenantId),
          eq(itemAvailability.outletId, payload.outletId),
          inArray(
            itemAvailability.menuItemId,
            payload.items.map((item) => item.menuItemId),
          ),
          isNull(itemAvailability.deletedAt),
        ),
      ),
  );
  const byItem = new Map(found.map((entry) => [entry.menuItemId, entry]));
  let changed = 0;
  for (const item of payload.items) {
    const entry = byItem.get(item.menuItemId);
    if (!entry)
      throw new ActionExecutionError(
        "Item menu tidak ditemukan di outlet ini.",
      );
    const soldOut = entry.status === "sold_out";
    if (item.available !== soldOut) continue;
    await setAvailabilityStatus(
      context,
      row.requestedByUserId,
      entry.id,
      {
        action: item.available ? "restore" : "sell_out",
        soldOutUntil: item.available ? null : (payload.until ?? null),
        idempotencyKey: `ai-action:${row.id}:${item.menuItemId}`,
      },
      now,
    );
    changed += 1;
  }
  return { resultRef: `menu_availability:${payload.outletId}:${changed}` };
};
