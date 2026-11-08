// HRIS announcements (PRD v1.7 §3 F32; bead legend-7df1). Contract:
// `@starter/shared/hris` (performance.ts `announcementSchema`,
// `announcementAudienceSchema`, `announcementReceiptSchema`).
//
// - `announcements` is tenant master data. The outlet audience lives in
//   `hris_announcement_outlets`, the only table of this module with a NOT NULL
//   `outlet_id`, so it also gets outlet RLS (hris-sop.custom.sql).
// - A receipt row appears on first read; `read_at` is set once and
//   `acknowledged_at` is set once and never cleared (service).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { employees } from "./hris.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** PRD F32 `announcements` (T). */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    audienceKind: varchar("audience_kind", { length: 10 }).notNull(),
    requiresReceipt: boolean("requires_receipt").notNull(),
    publishedBy: text("published_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    unique("announcements_tenant_id_id_key").on(table.tenantId, table.id),
    index("announcements_tenant_published_idx").on(
      table.tenantId,
      table.publishedAt,
    ),
    check(
      "announcements_audience_kind_check",
      sql`${table.audienceKind} IN ('all', 'outlets')`,
    ),
  ],
);

/** Outlet audience of an `outlets` announcement (T, O). */
export const announcementOutlets = pgTable(
  "hris_announcement_outlets",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    announcementId: uuid("announcement_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hris_announcement_outlets_pkey",
      columns: [table.tenantId, table.announcementId, table.outletId],
    }),
    foreignKey({
      name: "hris_announcement_outlets_announcement_fk",
      columns: [table.tenantId, table.announcementId],
      foreignColumns: [announcements.tenantId, announcements.id],
    }),
    foreignKey({
      name: "hris_announcement_outlets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("hris_announcement_outlets_tenant_outlet_idx").on(
      table.tenantId,
      table.outletId,
    ),
  ],
);

/** PRD F32 read / acknowledge receipt (T). */
export const announcementReceipts = pgTable(
  "announcement_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    announcementId: uuid("announcement_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
  },
  (table) => [
    unique("announcement_receipts_tenant_announcement_employee_key").on(
      table.tenantId,
      table.announcementId,
      table.employeeId,
    ),
    foreignKey({
      name: "announcement_receipts_announcement_fk",
      columns: [table.tenantId, table.announcementId],
      foreignColumns: [announcements.tenantId, announcements.id],
    }),
    foreignKey({
      name: "announcement_receipts_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    index("announcement_receipts_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
  ],
);
