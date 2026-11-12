import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { paymentIntents } from "./payment";
import { outlets, tenants } from "./platform-org";
import { posOrderRefunds } from "./pos-order";
import { orders } from "./qr-order";

/** Q81: immutable release of paid DP to its original payment refund route. */
export const posDepositRefunds = pgTable(
  "pos_deposit_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    posRefundId: uuid("pos_refund_id").notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("pos_deposit_refunds_refund_intent_key").on(
      table.tenantId,
      table.posRefundId,
      table.paymentIntentId,
    ),
    foreignKey({
      name: "pos_deposit_refunds_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_deposit_refunds_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "pos_deposit_refunds_pos_refund_fk",
      columns: [table.tenantId, table.posRefundId],
      foreignColumns: [posOrderRefunds.tenantId, posOrderRefunds.id],
    }),
    foreignKey({
      name: "pos_deposit_refunds_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    index("pos_deposit_refunds_order_idx").on(table.tenantId, table.orderId),
    check("pos_deposit_refunds_amount_check", sql`${table.amountIdr} > 0`),
  ],
);
