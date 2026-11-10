// Inventory domain events (bead legend-p38). Registered in the WS-00 event
// catalog (packages/shared/src/events/catalog.ts, WS-06) and emitted through
// the transactional outbox contract (`eventEnvelopeSchema`, D-CORE event
// rules: ULID event ids, payload schema ref `<name>.v1`).
//
// - stock.moved: one row appended to the stock ledger (PRD §16, INV-01).
// - stock.critical: a balance fell below its par minimum (PRD §16 "Par Level &
//   Saran Pembelian").
// - recipe.cost_changed: theoretical HPP refreshed after an ingredient cost or
//   recipe change, within the INV-04 five-minute window.

import {
  decimal4Schema,
  isoDateTimeSchema,
  parseDecimal4,
  ulidSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import {
  inventoryItemIdSchema,
  recipeIdSchema,
  stockBatchIdSchema,
  stockLedgerIdSchema,
  stockLocationIdSchema,
  stockMovementTypeSchema,
  stockSourceTypeSchema,
} from "./schemas.ts";

export const inventoryEventNames = [
  "stock.moved",
  "stock.critical",
  "recipe.cost_changed",
] as const;
export type InventoryEventName = (typeof inventoryEventNames)[number];

/** The ledger row that caused the event; quantity is signed (D-CORE ledger). */
export const stockMovedEventPayloadSchema = z.strictObject({
  ledgerEntryId: stockLedgerIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  locationId: stockLocationIdSchema,
  movementType: stockMovementTypeSchema,
  quantity: decimal4Schema,
  unitCostIdr: decimal4Schema,
  batchId: stockBatchIdSchema.nullable(),
  sourceType: stockSourceTypeSchema,
  sourceId: z.union([uuidSchema, ulidSchema]),
  occurredAt: isoDateTimeSchema,
});
export type StockMovedEventPayload = z.infer<
  typeof stockMovedEventPayloadSchema
>;

/**
 * Raised when `quantity` is below `parMin`; `parMin` is the effective par.
 * `quantity` is null while an open blind stock count covers the pair: the
 * balance would leak the system quantity to the counter (legend-r2zv).
 */
export const stockCriticalEventPayloadSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  locationId: stockLocationIdSchema,
  quantity: decimal4Schema.nullable(),
  parMin: decimal4Schema,
  detectedAt: isoDateTimeSchema,
});
export type StockCriticalEventPayload = z.infer<
  typeof stockCriticalEventPayloadSchema
>;

/**
 * INV-04: the new theoretical HPP per yield unit, with the previous value so
 * consumers can show the delta. `previousTheoreticalCostIdr` is null the first
 * time a recipe is costed.
 */
export const recipeCostChangedEventPayloadSchema = z
  .strictObject({
    recipeId: recipeIdSchema,
    version: z.number().int().positive(),
    previousTheoreticalCostIdr: decimal4Schema.nullable(),
    theoreticalCostIdr: decimal4Schema,
    updatedAt: isoDateTimeSchema,
  })
  .refine((payload) => parseDecimal4(payload.theoreticalCostIdr) >= 0n, {
    path: ["theoreticalCostIdr"],
    message: "Cost must not be negative",
  });
export type RecipeCostChangedEventPayload = z.infer<
  typeof recipeCostChangedEventPayloadSchema
>;

/** Payload schema per event name, for the outbox writer and consumers. */
export const inventoryEventPayloadSchemas = {
  "stock.moved": stockMovedEventPayloadSchema,
  "stock.critical": stockCriticalEventPayloadSchema,
  "recipe.cost_changed": recipeCostChangedEventPayloadSchema,
} as const;

/**
 * Catalog-bound definitions (contracts.md "One catalog, typed payloads"):
 * defineDomainEvent throws at module load for an uncatalogued name, and each
 * `envelopeSchema` validates name, version, schema ref and payload together.
 */
export const inventoryEvents = Object.fromEntries(
  inventoryEventNames.map((name) => [
    name,
    defineDomainEvent({
      name,
      payload: inventoryEventPayloadSchemas[name] as z.ZodType<
        Record<string, unknown>
      >,
    }),
  ]),
) as Record<InventoryEventName, ReturnType<typeof defineDomainEvent>>;

export const inventoryEventCatalogEntries: readonly EventCatalogEntry[] =
  inventoryEventNames.map((name) => inventoryEvents[name].entry);

/** Envelope whose name and payload belong to this domain. */
export const inventoryEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (inventoryEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not an inventory event" },
  )
  .refine(
    (event) =>
      inventoryEvents[
        event.name as InventoryEventName
      ]?.envelopeSchema.safeParse(event).success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );
export type InventoryEvent = EventEnvelope;
