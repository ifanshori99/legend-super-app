// Menu domain events (PRD v1.7 §3 F8 "Master Menu & Harga", §5 Sinkronisasi).
// One event per change class: a structural menu change (`menu.updated`), an
// item change (`menu_item.updated`), a price version change
// (`price_list.updated`) and the 86 toggle (`item.sold_out` / `item.restored`).
//
// Consumers: the edge down-sync (WS-02 legend-97p) refreshes its menu copy,
// the QR/POS menu read models invalidate prices, and the delivery-channel sync
// (WS-08) pushes 86 status. Payloads carry ids and enums only (JSON-safe).
// Names are registered in `events/catalog.ts`; defineDomainEvent throws at
// module load for a name that is not catalogued.

import {
  z,
  uuidSchema,
  businessDateSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";

const entity = z.enum([
  "category",
  "station",
  "variant",
  "modifier_group",
  "modifier",
  "combo",
  "item_group_link",
  "availability",
]);
const operation = z.enum(["created", "updated", "deleted"]);

/** Structural menu change outside the item/price rows. */
export const menuUpdatedEvent = defineDomainEvent({
  name: "menu.updated",
  payload: z.strictObject({ entity, entityId: uuidSchema, operation }),
});

/** Item content/routing change (PRD §8 "Struktur Menu", "Routing Stasiun"). */
export const menuItemUpdatedEvent = defineDomainEvent({
  name: "menu_item.updated",
  payload: z.strictObject({
    itemId: uuidSchema,
    categoryId: uuidSchema,
    isActive: z.boolean(),
    operation,
  }),
});

/** A price version or its grid changed (PRD §8 "Harga per Kanal"). */
export const priceListUpdatedEvent = defineDomainEvent({
  name: "price_list.updated",
  payload: z.strictObject({
    priceListId: uuidSchema,
    outletId: uuidSchema,
    channel: z.enum([
      "dine_in",
      "takeaway",
      "gofood",
      "grabfood",
      "shopeefood",
      "reservation",
    ]),
    effectiveFrom: businessDateSchema,
    operation: z.enum(["created", "updated", "deleted", "items_replaced"]),
  }),
});

/** 86: the item stops selling on every channel of the outlet. */
export const itemSoldOutEvent = defineDomainEvent({
  name: "item.sold_out",
  payload: z.strictObject({
    itemId: uuidSchema,
    availabilityId: uuidSchema,
    outletId: uuidSchema,
    soldOutUntil: isoDateTimeSchema.nullable(),
  }),
});

/** 86 lifted; `soldOutUntil` passing does the same through the daily sweep. */
export const itemRestoredEvent = defineDomainEvent({
  name: "item.restored",
  payload: z.strictObject({
    itemId: uuidSchema,
    availabilityId: uuidSchema,
    outletId: uuidSchema,
  }),
});

export const menuEvents = [
  menuUpdatedEvent,
  menuItemUpdatedEvent,
  priceListUpdatedEvent,
  itemSoldOutEvent,
  itemRestoredEvent,
] as const;
