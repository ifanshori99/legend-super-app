// Table link groups (WS-03, bead legend-1nmh): 2+ tables grouped for SERVICE
// only. Bills stay separate and are paid separately; sessions are untouched.
//
// A member is (table, its active session). A table and a session each sit in
// at most one live membership (partial unique indexes on left_at IS NULL). A
// member leaves when its session closes, staff unlink it, or the group
// dissolves; a group with fewer than 2 live members is dissolved by the API.
//
// (T, O) rules: tenant_id and outlet_id NOT NULL (enforced tenant + outlet RLS
// in the migration), unique constraints include tenant_id, and parents are
// referenced through (tenant_id, id) composite keys.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { tableSessions, tables } from "./floor";
import { outlets, tenants } from "./platform-org";

/** `table_link_groups` (T, O): one set of tables served together. */
export const tableLinkGroups = pgTable(
  "table_link_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dissolvedAt: timestamp("dissolved_at", { withTimezone: true }),
    dissolvedReason: varchar("dissolved_reason", { length: 30 }),
  },
  (table) => [
    unique("table_link_groups_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "table_link_groups_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
  ],
);

/** `table_link_members` (T, O): one (table, session) inside a group. */
export const tableLinkMembers = pgTable(
  "table_link_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    groupId: uuid("group_id").notNull(),
    tableId: uuid("table_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    leftReason: varchar("left_reason", { length: 30 }),
  },
  (table) => [
    foreignKey({
      name: "table_link_members_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "table_link_members_group_fk",
      columns: [table.tenantId, table.groupId],
      foreignColumns: [tableLinkGroups.tenantId, tableLinkGroups.id],
    }),
    foreignKey({
      name: "table_link_members_table_fk",
      columns: [table.tenantId, table.tableId],
      foreignColumns: [tables.tenantId, tables.id],
    }),
    foreignKey({
      name: "table_link_members_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    // A table and a session are in at most one live group.
    uniqueIndex("table_link_members_live_table_key")
      .on(table.tenantId, table.tableId)
      .where(sql`${table.leftAt} IS NULL`),
    uniqueIndex("table_link_members_live_session_key")
      .on(table.tenantId, table.tableSessionId)
      .where(sql`${table.leftAt} IS NULL`),
    index("table_link_members_group_idx").on(table.tenantId, table.groupId),
    check(
      "table_link_members_left_reason_check",
      sql`${table.leftReason} IS NULL OR ${table.leftReason} IN ('staff', 'session_closed', 'group_dissolved', 'session_merged')`,
    ),
    check(
      "table_link_members_left_pair_check",
      sql`(${table.leftAt} IS NULL) = (${table.leftReason} IS NULL)`,
    ),
  ],
);
