// Full-state event down-sync (legend-3x9l). A single record is a complete
// document, including all children for recipes / price lists. A page is never
// an aggregate: skipping an older page could lose unrelated records.
import { z } from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  catalogSyncRecordSchemas,
  type CatalogSyncStream,
} from "./catalog-sync.ts";

function recordOf<S extends CatalogSyncStream>(stream: S) {
  return z.strictObject({
    stream: z.literal(stream),
    record: catalogSyncRecordSchemas[stream],
  });
}

export const catalogRecordUpdatedPayloadSchema = z.discriminatedUnion(
  "stream",
  [
    recordOf("stations"),
    recordOf("printers"),
    recordOf("inventory_items"),
    recordOf("menu_categories"),
    recordOf("modifier_groups"),
    recordOf("modifiers"),
    recordOf("menu_items"),
    recordOf("item_variants"),
    recordOf("menu_item_modifier_groups"),
    recordOf("price_lists"),
    recordOf("recipes"),
    recordOf("promotions"),
    recordOf("vouchers"),
  ],
);

export type CatalogRecordUpdatedPayload = z.infer<
  typeof catalogRecordUpdatedPayloadSchema
>;

export const catalogRecordUpdatedEvent = defineDomainEvent({
  name: "catalog_record.updated",
  payload: catalogRecordUpdatedPayloadSchema,
});
