// `wa_login_reply_policies` (legend-dn4, PRD §3 F6, AUTH-03): one row per
// tenant that decides whether the platform answers a WhatsApp login message
// with a reply. No row means disabled: replies are off by default and a
// tenant opts in. Each reply uses one message of the provider's free monthly
// quota (1.000 per month); a tenant may only lower its own cap.
//
// Database guarantees (hand SQL in migration 0222):
// - Tenant RLS (ENABLE + FORCE) through `app.enforce_tenant_rls`.
// - legend_app has SELECT, INSERT and UPDATE only (no DELETE or TRUNCATE).

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./platform-org";

export const waLoginReplyPolicies = pgTable(
  "wa_login_reply_policies",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    enabled: boolean("enabled").notNull().default(false),
    /** Provider free quota is 1.000 per month; the tenant may only lower it. */
    freeMonthlyQuota: integer("free_monthly_quota").notNull().default(1000),
    /** `YYYY-MM` in Asia/Jakarta; a different month resets the count. */
    repliesMonth: char("replies_month", { length: 7 }),
    repliesThisMonth: integer("replies_this_month").notNull().default(0),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "wa_login_reply_policies_quota_check",
      sql`${t.freeMonthlyQuota} >= 0 AND ${t.freeMonthlyQuota} <= 1000`,
    ),
    check(
      "wa_login_reply_policies_count_check",
      sql`${t.repliesThisMonth} >= 0`,
    ),
  ],
);

export type WaLoginReplyPolicy = typeof waLoginReplyPolicies.$inferSelect;
