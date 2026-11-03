// `consents` (T, PRD v1.7 §6 B, §2 privacy "persetujuan terpisah dan
// berversi", LOY-04). Append-only event log: a grant and a withdrawal are both
// new rows. The current consent per (subject, purpose) is the row with the
// highest `seq`; withdrawing never deletes or updates anything. The table is
// granted INSERT/SELECT only to legend_app (migration), so the application
// role cannot rewrite history even by mistake.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./platform-org.ts";

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Customer profile (data subject). No FK: the CRM profile table is owned
     * by the loyalty bead; the service never trusts a subject from another
     * tenant because every read and write is tenant-scoped by RLS. */
    subjectId: uuid("subject_id").notNull(),
    purpose: varchar("purpose", { length: 20 }).notNull(),
    policyVersion: varchar("policy_version", { length: 20 }).notNull(),
    decision: varchar("decision", { length: 20 }).notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    recordedBy: text("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Monotonic order for latest-wins; wall-clock ties cannot flip it. */
    seq: bigint("seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
  },
  (table) => [
    index("consents_subject_purpose_idx").on(
      table.tenantId,
      table.subjectId,
      table.purpose,
      table.seq,
    ),
    check(
      "consents_purpose_check",
      sql`${table.purpose} IN ('loyalty', 'marketing', 'ai')`,
    ),
    check(
      "consents_decision_check",
      sql`${table.decision} IN ('granted', 'withdrawn')`,
    ),
    check(
      "consents_source_check",
      sql`${table.source} IN ('member_pwa', 'website', 'cashier', 'import')`,
    ),
  ],
);
