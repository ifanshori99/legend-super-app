import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EventEnvelope } from "@starter/shared/events";

/** ULID identifiers are stored losslessly as UUIDs; convert at the boundary. */
export const domainEventOutbox = pgTable(
  "domain_event_outbox",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    eventId: uuid("event_id").notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    event: jsonb("event").$type<EventEnvelope>().notNull(),
    destination: varchar("destination", { length: 255 }).notNull(),
    direction: varchar("direction", { length: 20 }),
    peerId: uuid("peer_id"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: varchar("lease_owner", { length: 255 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("domain_event_outbox_event_destination_key").on(
      table.tenantId,
      table.eventId,
      table.destination,
    ),
    unique("domain_event_outbox_aggregate_sequence_key").on(
      table.tenantId,
      table.destination,
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    index("domain_event_outbox_due_idx").on(
      table.tenantId,
      table.status,
      table.availableAt,
    ),
  ],
);

/** Insert in the same transaction as the consumer's database effects. */
export const domainEventConsumptions = pgTable(
  "domain_event_consumptions",
  {
    tenantId: uuid("tenant_id").notNull(),
    outletId: uuid("outlet_id"),
    consumer: varchar("consumer", { length: 255 }).notNull(),
    eventId: uuid("event_id").notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.consumer, table.eventId] }),
    unique("domain_event_consumptions_aggregate_sequence_key").on(
      table.tenantId,
      table.consumer,
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
  ],
);
