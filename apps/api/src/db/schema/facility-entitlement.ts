// Entitlement ledger (PRD v1.7 §3 F25 "Produk & Hak Akses", §6 K
// `entitlement_ledger`; bead legend-fjk5; FAC-04, FAC-05).
//
// One append-only row per movement of access rights (grant / redeem / cancel /
// expire). Rows are never updated or deleted (triggers + REVOKE in the
// migration, same pattern as `point_ledger` 0203). The customer's balance and
// the remaining sessions of one grant are derived by summing rows.
//
// - A `grant` row carries `sessions` (1..100), `expires_at` and, for the
//   rule-driven sources, the `rule_id` that issued it.
// - `redeem` / `cancel` / `expire` rows point at the grant they draw down
//   (`grant_entry_id`), so "sessions left in this grant" is exact and a refund
//   revokes only what nobody used yet.
// - Idempotency: one grant per (source, source_ref, rule) and one terminal
//   (`cancel` or `expire`) row per grant; one `redeem` row per ticket. The
//   unique indexes live here, the append-only guards, the per-grant overdraw
//   trigger (advisory lock + remaining check) and the RLS policies are in
//   facility-entitlement.custom.sql (appended to the migration).
// - `facility_id` references the facility with the (tenant, outlet, facility)
//   composite FK, so a row can never sit in another outlet than its facility.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  EntitlementLedgerType,
  EntitlementSource,
} from "@starter/shared/facility";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { facilities } from "./facility.ts";
import { outlets, tenants } from "./platform-org.ts";

export const entitlementLedger = pgTable(
  "entitlement_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    /** Customer profile (WS-08); no FK, same as `access_tickets`. */
    customerProfileId: uuid("customer_profile_id").notNull(),
    type: varchar("type", { length: 10 })
      .$type<EntitlementLedgerType>()
      .notNull(),
    sessions: integer("sessions").notNull(),
    /** How the grant was obtained; copied onto the rows that draw it down. */
    sourceType: varchar("source_type", { length: 20 })
      .$type<EntitlementSource>()
      .notNull(),
    /** Source transaction: order ULID, or a subscription/rule/staff UUID. */
    sourceRef: varchar("source_ref", { length: 40 }).notNull(),
    /** The rule that issued a package/min_spend/tier_benefit grant. */
    ruleId: uuid("rule_id"),
    /** The grant a redeem/cancel/expire row draws down; null on a grant. */
    grantEntryId: uuid("grant_entry_id"),
    /** Set on a redeem row only: the ticket that consumed it (1:1, FAC-05). */
    accessTicketId: ulidInUuid("access_ticket_id"),
    /** Grant only: FAC-04 validity end; null = never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Staff or system actor; null for an automatic consumer or job. */
    actorUserId: uuid("actor_user_id"),
    reason: varchar("reason", { length: 500 }),
    postingSeq: bigint("posting_seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("entitlement_ledger_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "entitlement_ledger_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    foreignKey({
      name: "entitlement_ledger_grant_fk",
      columns: [table.tenantId, table.grantEntryId],
      foreignColumns: [table.tenantId, table.id],
    }),
    // One grant per (source, reference, rule): replaying an event is a no-op.
    uniqueIndex("entitlement_ledger_grant_dedupe")
      .on(
        table.tenantId,
        table.facilityId,
        table.customerProfileId,
        table.sourceType,
        table.sourceRef,
        sql`COALESCE(${table.ruleId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${table.type} = 'grant'`),
    // A grant ends once: one cancel OR expire row per grant.
    uniqueIndex("entitlement_ledger_terminal_key")
      .on(table.tenantId, table.grantEntryId)
      .where(sql`${table.type} IN ('cancel', 'expire')`),
    // One redemption row per ticket and one ticket per redemption (FAC-05).
    uniqueIndex("entitlement_ledger_ticket_key")
      .on(table.tenantId, table.accessTicketId)
      .where(sql`${table.accessTicketId} IS NOT NULL`),
    index("entitlement_ledger_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.facilityId,
      table.postingSeq,
    ),
    index("entitlement_ledger_grant_entry_idx")
      .on(table.tenantId, table.grantEntryId)
      .where(sql`${table.grantEntryId} IS NOT NULL`),
    index("entitlement_ledger_source_idx").on(
      table.tenantId,
      table.sourceType,
      table.sourceRef,
    ),
    index("entitlement_ledger_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
    ),
    check(
      "entitlement_ledger_type_check",
      sql`${table.type} IN ('grant', 'redeem', 'cancel', 'expire')`,
    ),
    check(
      "entitlement_ledger_source_check",
      sql`${table.sourceType} IN ('purchase', 'package', 'min_spend', 'tier_benefit', 'subscription', 'staff_issue')`,
    ),
    check(
      "entitlement_ledger_sessions_check",
      sql`${table.sessions} BETWEEN 1 AND 100`,
    ),
    check(
      "entitlement_ledger_shape_check",
      sql`(${table.type} = 'grant' AND ${table.grantEntryId} IS NULL AND ${table.accessTicketId} IS NULL)
        OR (${table.type} = 'redeem' AND ${table.grantEntryId} IS NOT NULL AND ${table.accessTicketId} IS NOT NULL AND ${table.sessions} = 1 AND ${table.expiresAt} IS NULL)
        OR (${table.type} IN ('cancel', 'expire') AND ${table.grantEntryId} IS NOT NULL AND ${table.accessTicketId} IS NULL AND ${table.expiresAt} IS NULL)`,
    ),
  ],
);
