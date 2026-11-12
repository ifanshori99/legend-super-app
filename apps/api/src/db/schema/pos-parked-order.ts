// Raw POS cart snapshots. No order, tender, stock, DP or pickup-call link is
// created. A consumed row remains as the original create-intent replay record.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PosParkedOrderSnapshot } from "@starter/shared/pos";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

export const posParkedOrders = pgTable(
  "pos_parked_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => user.id),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    snapshot: jsonb("snapshot").$type<PosParkedOrderSnapshot>().notNull(),
    label: varchar("label", { length: 150 }).notNull(),
    parkedAt: timestamp("parked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("pos_parked_orders_create_intent_key").on(
      table.tenantId,
      table.outletId,
      table.creatorUserId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "pos_parked_orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("pos_parked_orders_active_creator_idx")
      .on(
        table.tenantId,
        table.outletId,
        table.creatorUserId,
        table.parkedAt,
        table.id,
      )
      .where(sql`${table.consumedAt} IS NULL`),
    check(
      "pos_parked_orders_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object' AND jsonb_typeof(${table.snapshot}->'items') = 'array'`,
    ),
  ],
);
