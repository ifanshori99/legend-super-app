import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  timestamp,
  varchar,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantIdColumn, outletIdColumn, ulidInUuid } from "../columns";
import { tenants, outlets } from "./platform-org";
import { orders } from "./qr-order";
import { billSplits } from "./bill-splits";

/** Durable, non-resumable pause of one guest claim, without altering a sale. */
export const loyaltyClaimPauses = pgTable(
  "loyalty_claim_pauses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id"),
    splitId: uuid("split_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true }).notNull(),
    remainingMs: bigint("remaining_ms", { mode: "number" }).notNull(),
    state: varchar("state", { length: 16 }).notNull(),
    resumeDeadline: timestamp("resume_deadline", { withTimezone: true }),
  },
  (table) => [
    unique("loyalty_claim_pauses_order_key").on(table.tenantId, table.orderId),
    unique("loyalty_claim_pauses_split_key").on(table.tenantId, table.splitId),
    foreignKey({
      name: "loyalty_claim_pauses_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "loyalty_claim_pauses_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "loyalty_claim_pauses_split_fk",
      columns: [table.tenantId, table.splitId],
      foreignColumns: [billSplits.tenantId, billSplits.id],
    }),
    check(
      "loyalty_claim_pauses_unit_check",
      sql`(${table.orderId} IS NULL) <> (${table.splitId} IS NULL)`,
    ),
    check(
      "loyalty_claim_pauses_remaining_check",
      sql`${table.remainingMs} > 0`,
    ),
    check(
      "loyalty_claim_pauses_state_check",
      sql`${table.state} IN ('busy', 'ambiguous', 'active', 'invalid')`,
    ),
    check(
      "loyalty_claim_pauses_resume_check",
      sql`(${table.state} = 'active') = (${table.resumeDeadline} IS NOT NULL)`,
    ),
  ],
);
