// Kitchen domain events (bead legend-acz, PRD v1.7 §3 F12). Names registered on
// the WS-04 line of the WS-00 event catalog (`events/catalog.ts`); every event
// travels inside the standard envelope (bead legend-m59) with a ULID id.
//
//   kitchen_ticket.created   ticket fired to a station
//   kitchen_ticket.started   staff started working on it
//   kitchen_ticket.bumped    station finished it (done)
//   kitchen_ticket.recalled  expo sent it back to the station
//   kitchen_ticket.voided    ticket cancelled after firing (KDS-03)
//   pacing.updated           station queue vs capacity changed (KDS-05)

import {
  z,
  outletIdSchema,
  ulidIdSchema,
  uuidIdSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import {
  eventCatalogEntrySchema,
  eventEnvelopeSchema,
} from "../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import { stationPacingSchema } from "./schemas.ts";

const ticketIdSchema = ulidIdSchema<"KitchenTicketId">();
const orderIdSchema = ulidIdSchema<"OrderId">();
const stationIdSchema = uuidIdSchema<"StationId">();
const prioritySchema = z.number().int().min(0).max(9);
const reason = z.string().min(1).max(200);

const ticketEventBase = {
  outletId: outletIdSchema,
  ticketId: ticketIdSchema,
  orderId: orderIdSchema,
  stationId: stationIdSchema,
};

export const kitchenTicketCreatedPayloadSchema = z.strictObject({
  ...ticketEventBase,
  status: z.literal("new"),
  priority: prioritySchema,
  itemCount: z.number().int().positive().max(999),
});

export const kitchenTicketStartedPayloadSchema = z.strictObject({
  ...ticketEventBase,
  status: z.literal("in_progress"),
  startedAt: isoDateTimeSchema,
});

export const kitchenTicketBumpedPayloadSchema = z.strictObject({
  ...ticketEventBase,
  status: z.literal("done"),
  startedAt: isoDateTimeSchema,
  doneAt: isoDateTimeSchema,
});

export const kitchenTicketRecalledPayloadSchema = z.strictObject({
  ...ticketEventBase,
  status: z.literal("recalled"),
  reason,
});

export const kitchenTicketVoidedPayloadSchema = z.strictObject({
  ...ticketEventBase,
  status: z.literal("cancelled"),
  reason,
});

/** F12 order pacing: one snapshot per outlet whenever capacity changes (KDS-05). */
export const pacingUpdatedPayloadSchema = z.strictObject({
  outletId: outletIdSchema,
  generatedAt: isoDateTimeSchema,
  stations: z.array(stationPacingSchema).min(1),
});

export const kitchenEventNames = [
  "kitchen_ticket.created",
  "kitchen_ticket.started",
  "kitchen_ticket.bumped",
  "kitchen_ticket.recalled",
  "kitchen_ticket.voided",
  "pacing.updated",
] as const;
export type KitchenEventName = (typeof kitchenEventNames)[number];

export const kitchenEventPayloads: Record<KitchenEventName, z.ZodType> = {
  "kitchen_ticket.created": kitchenTicketCreatedPayloadSchema,
  "kitchen_ticket.started": kitchenTicketStartedPayloadSchema,
  "kitchen_ticket.bumped": kitchenTicketBumpedPayloadSchema,
  "kitchen_ticket.recalled": kitchenTicketRecalledPayloadSchema,
  "kitchen_ticket.voided": kitchenTicketVoidedPayloadSchema,
  "pacing.updated": pacingUpdatedPayloadSchema,
};

export const kitchenEventCatalog: readonly EventCatalogEntry[] =
  kitchenEventNames.map((name) =>
    eventCatalogEntrySchema.parse({
      name,
      aggregateType: name.split(".")[0],
      version: 1,
      payloadSchemaRef: `${name}.v1`,
      workstream: "WS-04",
    }),
  );

/** Envelope whose name and payload belong to this domain. */
export const kitchenEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (kitchenEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a kitchen event" },
  )
  .refine(
    (event) =>
      kitchenEventPayloads[event.name as KitchenEventName]?.safeParse(
        event.payload,
      ).success === true,
    { path: ["payload"], message: "Event payload does not match its schema" },
  );

export type KitchenEvent = EventEnvelope;
