// Auto-journal parking (F19, design docs/design/auto-journals.md section 6).
//
// `auto_journal_parked` holds an event that the auto-journal consumer could not
// post yet (missing or unusable account mapping, closed-period race) or never
// can (deterministic accounting error). The consumer parks it instead of
// failing the outbox consumption; the sweep rebuilds the journal from the
// stored payload and deletes the row once it posts. Tenant-owned and
// outlet-owned (RLS in the custom migration after this table). Two foreign
// keys: tenant, and the composite (tenant_id, outlet_id) to outlets, so a row
// can never point at another tenant's outlet. Journal rows are referenced by
// key, not by foreign key. The payload holds ids and amounts only, never
// personal data.

import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

/**
 * `auto_journal_parked` (T, outlet-owned): one row per business-fact
 * idempotency key (`aj:...`) that is waiting. `next_retry_at` is null for a
 * non-retryable error, which finance sees and fixes by hand.
 */
export const autoJournalParked = pgTable(
  "auto_journal_parked",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    eventId: text("event_id").notNull(),
    eventName: varchar("event_name", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    errorCode: varchar("error_code", { length: 60 }).notNull(),
    retryable: boolean("retryable").notNull(),
    attempts: integer("attempts").notNull().default(1),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "auto_journal_parked_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    unique("auto_journal_parked_tenant_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("auto_journal_parked_retry_idx").on(
      table.tenantId,
      table.nextRetryAt,
    ),
  ],
);

export type AutoJournalParkedRow = typeof autoJournalParked.$inferSelect;
