// WS-08 feedback and complaints (legend-ts50, docs/briefs/290d, shipped as
// migration 0209).
//
// Database guarantees (hand SQL in crm-feedback.custom.sql):
// - Tenant + outlet RLS (`outlet_id` is NOT NULL); member RLS (`member_self`)
//   on `customer_profile_id`, so a member never sees a row of another profile
//   or a QR-guest row (profile NULL). Staff and worker paths leave
//   `app.customer_profile_id` unset, so the policy is inert for them.
// - No DELETE or TRUNCATE for legend_app: status moves through the service.
// - One feedback per (order, member, kind) via `feedback_order_profile_kind_key`.
// - One order-less feedback per (table session, member, kind) via the partial
//   unique index `feedback_session_profile_kind_key` (the key above skips NULL
//   orders, so parallel session-only posts would otherwise both land).

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { FeedbackKind, FeedbackStatus } from "@starter/shared/crm";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { customerProfiles } from "./crm-member";
import { tableSessions } from "./floor";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

export const FEEDBACK_KINDS = ["rating", "complaint"] as const;
export const FEEDBACK_STATUSES = [
  "open",
  "in_review",
  "resolved",
  "closed",
] as const;

/** `feedback` (T, E, member RLS): a rating or complaint about an order. */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").defaultRandom().notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** WS-03 table session the feedback came from, when it did. */
    tableSessionId: uuid("table_session_id"),
    /** NULL for a QR guest; such a row is visible to staff only. */
    customerProfileId: uuid("customer_profile_id"),
    orderId: ulidInUuid("order_id"),
    kind: varchar("kind", { length: 12 }).$type<FeedbackKind>().notNull(),
    rating: integer("rating"),
    comment: varchar("comment", { length: 2000 }),
    status: varchar("status", { length: 12 })
      .$type<FeedbackStatus>()
      .notNull()
      .default("open"),
    /** Staff user who took the item; set once it leaves `open`. */
    handledBy: text("handled_by"),
    /** Staff note written while handling (resolve, close, dismiss). */
    handledNote: varchar("handled_note", { length: 2000 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ name: "feedback_pkey", columns: [table.tenantId, table.id] }),
    unique("feedback_order_profile_kind_key").on(
      table.tenantId,
      table.orderId,
      table.customerProfileId,
      table.kind,
    ),
    uniqueIndex("feedback_session_profile_kind_key")
      .on(
        table.tenantId,
        table.tableSessionId,
        table.customerProfileId,
        table.kind,
      )
      .where(
        sql`${table.orderId} IS NULL AND ${table.tableSessionId} IS NOT NULL`,
      ),
    foreignKey({
      name: "feedback_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "feedback_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "feedback_table_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    index("feedback_queue_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.createdAt,
    ),
    index("feedback_profile_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.createdAt,
    ),
    check("feedback_kind_check", sql`${table.kind} IN ('rating', 'complaint')`),
    check(
      "feedback_status_check",
      sql`${table.status} IN ('open', 'in_review', 'resolved', 'closed')`,
    ),
    check(
      "feedback_rating_check",
      sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`,
    ),
    check(
      "feedback_kind_shape_check",
      sql`CASE WHEN ${table.kind} = 'rating'
               THEN ${table.rating} IS NOT NULL
               ELSE ${table.comment} IS NOT NULL END`,
    ),
  ],
);
