// Apology vouchers of the failed-item recovery flow (legend-4qu, ORD-08,
// ORD-09; contract @starter/shared/qr-order `apologyVoucherSchema`, shipped as
// migration 0212).
//
// One row = one apology voucher issued by the system (the guest chose a
// voucher for a failed paid item) or by staff (`order.apology_voucher.issue`),
// linked to the CRM `vouchers` row that carries value, validity and status.
// The plain voucher code is never stored: `code_sealed` holds it sealed with
// lib/secrets.ts (AAD = tenant id + voucher id) so the guest list and the
// staff lookup can show it again, while `vouchers` keeps only the code hash.
//
// (T) rules: tenant_id and outlet_id NOT NULL (enforced tenant + outlet RLS in
// apology-vouchers.custom.sql), unique constraints include tenant_id, and
// parents are referenced through composite (tenant_id, id) keys. The table is
// append-only for the application role (REVOKE in the hand SQL); a voucher is
// voided on `vouchers`, never here.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { customerProfiles } from "./crm-member";
import { vouchers } from "./crm-promo";
import { orderIssues } from "./kds-issues";
import { outlets, tenants } from "./platform-org";
import { user } from "./user";

/** `apology_vouchers` (T, O): one apology voucher with its sealed code. */
export const apologyVouchers = pgTable(
  "apology_vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    voucherId: uuid("voucher_id").notNull(),
    /** The failed-item issue this voucher resolves; null for a staff gift. */
    orderIssueId: uuid("order_issue_id"),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** Approval request that allowed a value above the matrix limit. */
    approvalRequestId: uuid("approval_request_id"),
    /** Voucher code sealed with lib/secrets.ts; never stored in plain text. */
    codeSealed: text("code_sealed").notNull(),
    customerProfileId: uuid("customer_profile_id"),
    issuedBy: text("issued_by")
      .notNull()
      .references(() => user.id),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("apology_vouchers_tenant_id_id_key").on(table.tenantId, table.id),
    unique("apology_vouchers_tenant_voucher_key").on(
      table.tenantId,
      table.voucherId,
    ),
    // One apology voucher per failed-item issue, even under concurrent calls.
    uniqueIndex("apology_vouchers_issue_once_idx")
      .on(table.tenantId, table.orderIssueId)
      .where(sql`${table.orderIssueId} IS NOT NULL`),
    // One approval request backs at most one apology voucher.
    uniqueIndex("apology_vouchers_approval_once_idx")
      .on(table.tenantId, table.approvalRequestId)
      .where(sql`${table.approvalRequestId} IS NOT NULL`),
    foreignKey({
      name: "apology_vouchers_voucher_fk",
      columns: [table.tenantId, table.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }),
    foreignKey({
      name: "apology_vouchers_order_issue_fk",
      columns: [table.tenantId, table.orderIssueId],
      foreignColumns: [orderIssues.tenantId, orderIssues.id],
    }),
    foreignKey({
      name: "apology_vouchers_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "apology_vouchers_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("apology_vouchers_outlet_issued_idx").on(
      table.tenantId,
      table.outletId,
      table.issuedAt,
      table.id,
    ),
    check(
      "apology_vouchers_reason_check",
      sql`length(btrim(${table.reason})) >= 10`,
    ),
  ],
);
