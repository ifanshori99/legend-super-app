// Supplier invoice payments through the approval matrix (bead legend-xxqz3;
// brief docs/briefs/991-akuntansi-kas-supplier.md, part A; PRD v1.7 §3.18
// "pembayaran supplier disetujui dan dijurnal otomatis").
//
// One row per payment REQUEST against one supplier invoice (its payable open
// item shares the invoice id). A request above the approval matrix limit is
// `pending_approval` with its `approval_chain_id`; it becomes `paid` when the
// chain is approved by someone other than the requester (the settlement and
// the Dr AP / Cr bank journal are written in the same transaction), or
// `rejected` / `cancelled`. A request below the limit is `paid` at once with no
// chain. Open requests (`pending_approval`, `approved`) count against the
// invoice's outstanding balance, so two requests can never pay more than is
// owed. UNIQUE (tenant, idempotency_key) makes a re-sent request a replay.
//
// Tenant and outlet RLS; only the decision columns can change and a final row
// is frozen (supplier-payments trigger in the migration).

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { SupplierPaymentStatus } from "@starter/shared/inventory";
import { businessDate, idrColumn, tenantIdColumn } from "../columns.ts";
import { journalEntries } from "./accounting.ts";
import { purchaseInvoices } from "./purchasing.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    supplierInvoiceId: uuid("supplier_invoice_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    paidOn: businessDate("paid_on").notNull(),
    status: varchar("status", { length: 20 })
      .$type<SupplierPaymentStatus>()
      .notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    /** NULL when the matrix asked for no approval at this amount. */
    approvalChainId: uuid("approval_chain_id"),
    approvedBy: text("approved_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: varchar("decision_note", { length: 500 }),
    /** The open item settlement and its journal, set once when paid. */
    settlementId: uuid("settlement_id"),
    journalEntryId: uuid("journal_entry_id"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("supplier_payments_tenant_id_id_key").on(table.tenantId, table.id),
    unique("supplier_payments_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique("supplier_payments_approval_chain_key").on(
      table.tenantId,
      table.approvalChainId,
    ),
    unique("supplier_payments_journal_key").on(
      table.tenantId,
      table.journalEntryId,
    ),
    foreignKey({
      name: "supplier_payments_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "supplier_payments_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    // The invoice belongs to the same outlet as its payments.
    foreignKey({
      name: "supplier_payments_invoice_fk",
      columns: [table.tenantId, table.outletId, table.supplierInvoiceId],
      foreignColumns: [
        purchaseInvoices.tenantId,
        purchaseInvoices.outletId,
        purchaseInvoices.id,
      ],
    }),
    foreignKey({
      name: "supplier_payments_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    index("supplier_payments_invoice_status_idx").on(
      table.tenantId,
      table.supplierInvoiceId,
      table.status,
    ),
    check("supplier_payments_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "supplier_payments_status_check",
      sql`${table.status} IN ('pending_approval', 'approved', 'paid', 'rejected', 'cancelled')`,
    ),
    check(
      "supplier_payments_key_check",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    // Nobody approves their own payment request (second line of defence
    // behind the service).
    check(
      "supplier_payments_approver_check",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`,
    ),
    // A pending request has its chain; a paid one has its settlement and
    // journal; a paid one that went through a chain has its approver.
    check(
      "supplier_payments_pending_chain_check",
      sql`${table.status} <> 'pending_approval' OR ${table.approvalChainId} IS NOT NULL`,
    ),
    check(
      "supplier_payments_paid_check",
      sql`(${table.status} = 'paid') = (${table.journalEntryId} IS NOT NULL AND ${table.settlementId} IS NOT NULL)`,
    ),
    check(
      "supplier_payments_paid_approver_check",
      sql`${table.status} <> 'paid' OR ${table.approvalChainId} IS NULL OR ${table.approvedBy} IS NOT NULL`,
    ),
  ],
);
