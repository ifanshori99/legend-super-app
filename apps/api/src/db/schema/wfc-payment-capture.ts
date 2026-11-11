// WFC payment capture ledger (bead legend-bz9h round 3, C2/H2). Tenant RLS and
// outlet RLS are installed in wfc-payment-capture.custom.sql.
//
// - `wfc_payment_captures` (T, E): one row per WFC sale (seat reservation, day
//   pass or bundle purchase), written in the SAME transaction as the sale by
//   `requireCapturedPayment` (services/wfc-payment.ts). `capture_key` is the
//   lowercase text of coalesce(tender.payment_intent_id, tender.id), so every
//   alias of one payment (upper/lower case, tender id vs reference, several
//   tenders of one gateway intent) maps to one key, and the unique
//   (tenant_id, capture_key) makes "one capture = one sale" a database rule
//   across all three sale tables. `sale_id` is polymorphic (no foreign key);
//   `order_id` + `menu_item_id` let the service count how many sales one order
//   line has funded (H1).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export const wfcPaymentCaptures = pgTable(
  "wfc_payment_captures",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    captureKey: varchar("capture_key", { length: 64 }).notNull(),
    saleKind: varchar("sale_kind", { length: 20 })
      .$type<"seat_reservation" | "day_pass" | "bundle">()
      .notNull(),
    saleId: uuid("sale_id").notNull(),
    /** POS order, uuid form of its ULID. */
    orderId: uuid("order_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "wfc_payment_captures_pkey",
      columns: [table.tenantId, table.captureKey],
    }),
    index("wfc_payment_captures_line_idx").on(
      table.tenantId,
      table.orderId,
      table.menuItemId,
    ),
    index("wfc_payment_captures_sale_idx").on(table.tenantId, table.saleId),
    check(
      "wfc_payment_captures_kind_check",
      sql`${table.saleKind} IN ('seat_reservation', 'day_pass', 'bundle')`,
    ),
  ],
);
