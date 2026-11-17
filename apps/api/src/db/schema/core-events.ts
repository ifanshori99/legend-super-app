import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EventActor, EventEnvelope } from "@starter/shared/events";

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
    dispatchState: varchar("dispatch_state", { length: 20 })
      .notNull()
      .default("ready"),
    dispatchGeneration: integer("dispatch_generation").notNull().default(0),
    dispatchLeaseToken: uuid("dispatch_lease_token"),
    dispatchLeaseUntil: timestamp("dispatch_lease_until", {
      withTimezone: true,
    }),
    dispatchJobId: uuid("dispatch_job_id"),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
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
    // legend-9e21l: the refund lookups of a paid swap charge (payment-admin
    // chargeInUseOfIntent, accounting-auto-journal-guards charge refund guard)
    // find `order_issue.charge_refunded` events by their payload refundId. The
    // queries repeat this WHERE text exactly so the planner uses the index.
    index("domain_event_outbox_charge_refunded_idx")
      .on(table.tenantId, sql`(${table.event}->'payload'->>'refundId')`)
      .where(sql`${table.event}->>'name' = 'order_issue.charge_refunded'`),
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

/** A destination must receive the full contiguous sequence for an aggregate. */
export const domainEventOffsets = pgTable(
  "domain_event_offsets",
  {
    tenantId: uuid("tenant_id").notNull(),
    outletId: uuid("outlet_id"),
    consumer: varchar("consumer", { length: 255 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.consumer,
        table.aggregateType,
        table.aggregateId,
      ],
    }),
  ],
);

/** Append alongside a replay transition; never mutate or remove audit records. */
export const domainEventReplays = pgTable(
  "domain_event_replays",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    outletId: uuid("outlet_id"),
    outboxId: uuid("outbox_id").notNull(),
    generation: integer("generation").notNull(),
    actor: jsonb("actor").$type<EventActor>().notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("domain_event_replays_generation_key").on(
      table.tenantId,
      table.outboxId,
      table.generation,
    ),
    foreignKey({
      columns: [table.tenantId, table.outboxId],
      foreignColumns: [domainEventOutbox.tenantId, domainEventOutbox.id],
    }),
  ],
);

/**
 * A durable, idempotent record that a destination is missing an outbox
 * sequence. Sequences are allocated in the producer's transaction, so a gap is
 * a producer bug: the relay never skips it on its own, the record feeds a
 * throttled alert. It is resolved when the consumer offset passes the gap,
 * either because the event arrives or because a platform operator skips it
 * through the audited action (legend-jcil, core-outbox-gap-actions.ts).
 */
export const domainEventGapRequests = pgTable(
  "domain_event_gap_requests",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    outletId: uuid("outlet_id"),
    destination: varchar("destination", { length: 255 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    missingSequence: bigint("missing_sequence", { mode: "number" }).notNull(),
    firstRequestedAt: timestamp("first_requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestCount: integer("request_count").notNull().default(1),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("domain_event_gap_requests_gap_key").on(
      table.tenantId,
      table.destination,
      table.aggregateType,
      table.aggregateId,
      table.missingSequence,
    ),
    index("domain_event_gap_requests_open_idx").on(
      table.tenantId,
      table.resolvedAt,
    ),
    check(
      "domain_event_gap_requests_sequence_check",
      sql`${table.missingSequence} >= 1`,
    ),
    check(
      "domain_event_gap_requests_count_check",
      sql`${table.requestCount} >= 1`,
    ),
  ],
);
