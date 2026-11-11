// DOIT/Duitku webhook inbox (PRD v1.7 §3 F13, PAY-02/03/06). Every inbound
// webhook is stored first, then processed; the partial unique index dedupes
// retries by provider event id. Rows with an invalid signature are kept for
// audit (hash only, no payload) and never reach settlement.
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";
import { paymentIntents } from "./payment";

export const gatewayWebhookEvents = pgTable(
  "gateway_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Filled once the intent is known. */
    outletId: outletIdColumn(() => outlets.id),
    /** tenant_integrations row whose secret verified the signature. */
    integrationId: uuid("integration_id"),
    /** Recurring invoice events only: every integration of the tenant whose
     * (current or in-grace previous) secret equals the one that verified the
     * event, plus the matching one. The worker accepts the bound integration
     * from this set and never re-verifies with a later (rotated) secret. */
    verifiedIntegrationIds: uuid("verified_integration_ids").array(),
    provider: varchar("provider", { length: 20 }).notNull(),
    /** null when the signature failed (the body is not trusted). */
    eventId: varchar("event_id", { length: 200 }),
    eventType: varchar("event_type", { length: 60 }),
    signatureValid: boolean("signature_valid").notNull(),
    /** sha256 hex of the raw request bytes. */
    payloadHash: char("payload_hash", { length: 64 }).notNull(),
    /** Stored only when the signature is valid. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    providerRef: varchar("provider_ref", { length: 100 }),
    paymentIntentId: uuid("payment_intent_id"),
    status: varchar("status", { length: 20 }).notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    /** Error code only; never a message, body or secret. */
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "gateway_webhook_events_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "gateway_webhook_events_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    // Retry dedupe: one verified row per provider event id.
    uniqueIndex("gateway_webhook_events_event_key")
      .on(table.tenantId, table.provider, table.eventId)
      .where(sql`${table.signatureValid} AND ${table.eventId} IS NOT NULL`),
    // Rejected rows: one per (tenant, body hash), so a replayed bad request
    // cannot grow the table without bound.
    uniqueIndex("gateway_webhook_events_rejected_hash_uq")
      .on(table.tenantId, table.payloadHash)
      .where(sql`NOT ${table.signatureValid}`),
    index("gateway_webhook_events_status_idx").on(
      table.tenantId,
      table.status,
      table.receivedAt,
    ),
    index("gateway_webhook_events_provider_ref_idx").on(
      table.tenantId,
      table.provider,
      table.providerRef,
    ),
    check(
      "gateway_webhook_events_provider_check",
      sql`${table.provider} IN ('doit', 'duitku')`,
    ),
    check(
      "gateway_webhook_events_status_check",
      sql`${table.status} IN ('received', 'processed', 'ignored', 'failed', 'rejected')`,
    ),
  ],
);

export type GatewayWebhookEvent = typeof gatewayWebhookEvents.$inferSelect;
export type NewGatewayWebhookEvent = typeof gatewayWebhookEvents.$inferInsert;
