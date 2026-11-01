import { z } from "../core/index.ts";
import { eventCatalogByName } from "./catalog.ts";
import type { EventCatalogEntry } from "./catalog.ts";
import { checkEnvelopeRules, eventEnvelopeBaseSchema } from "./schemas.ts";

/**
 * Binds a workstream's payload schema to a catalogued event name, so the
 * envelope for that event is validated end to end (name, version, schema ref
 * and payload). Call it from `<domain>/events.ts`:
 *
 *   export const orderPaid = defineDomainEvent({
 *     name: "order.paid",
 *     payload: z.strictObject({ totalIdr: idrSchema, receiptNumber: z.string() }),
 *   });
 *
 * Throws at module load for a name that is not in the catalog (typos), or a
 * version that differs from the catalog's. Adding an event means adding its name
 * to `catalog.ts` first, so the whole system has one list of events.
 */
export function defineDomainEvent<
  const Name extends string,
  Payload extends z.ZodType<Record<string, unknown>>,
>(definition: { name: Name; version?: number; payload: Payload }) {
  const entry: EventCatalogEntry | undefined = eventCatalogByName.get(
    definition.name,
  );
  if (!entry)
    throw new TypeError(
      `Event "${definition.name}" is not in the event catalog; add it to events/catalog.ts first`,
    );
  if (definition.version !== undefined && definition.version !== entry.version)
    throw new TypeError(
      `Event "${definition.name}" is version ${entry.version} in the catalog, not ${definition.version}`,
    );
  const envelopeSchema = eventEnvelopeBaseSchema
    .extend({
      name: z.literal(definition.name),
      version: z.literal(entry.version),
      aggregateType: z.literal(entry.aggregateType),
      payloadSchemaRef: z.literal(entry.payloadSchemaRef),
      payload: definition.payload,
    })
    .superRefine(checkEnvelopeRules);
  return {
    entry,
    name: definition.name,
    version: entry.version,
    payloadSchemaRef: entry.payloadSchemaRef,
    payloadSchema: definition.payload,
    envelopeSchema,
  };
}
export type DomainEventDefinition = ReturnType<typeof defineDomainEvent>;
