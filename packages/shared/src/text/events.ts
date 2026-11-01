// Text-domain events: every term override change is a catalogued domain event
// (WS-00 event contract, bead legend-m59), so config changes reach the audit
// log and, later, config templates (TEN-09). Naming follows
// `<aggregate>.<past_verb>`; ids are ULIDs in the shared envelope.

import { z } from "../core/index.ts";
import { eventCatalogEntrySchema } from "../events/catalog.ts";
import { catalogKeySchema, textLocaleSchema } from "./schemas.ts";

export const textOverrideUpdatedPayloadSchema = z.strictObject({
  key: catalogKeySchema,
  locale: textLocaleSchema,
  /** Null when the key had no tenant override before this change. */
  previousValue: z.string().nullable(),
  /** Null resets the key to the catalog value (the row is deleted). */
  value: z.string().nullable(),
});
export type TextOverrideUpdatedPayload = z.infer<
  typeof textOverrideUpdatedPayloadSchema
>;

export const TEXT_EVENT_PAYLOADS = {
  "text_override.updated": textOverrideUpdatedPayloadSchema,
} as const;

export const textEventCatalog = ["text_override.updated"].map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-00",
  }),
);
