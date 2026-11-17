// DP remainder subledger: funds stay in customer_deposit, never new income.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { tenants, outlets } from "./platform-org.ts";
import { reservations } from "./reservation.ts";
import { tableSessions } from "./floor.ts";
import { paymentIntents } from "./payment.ts";
import { customerProfiles } from "./crm-member.ts";

export const reservationDepositRemainders = pgTable(
  "reservation_deposit_remainders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    reservationId: uuid("reservation_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    customerProfileId: uuid("customer_profile_id"),
    amountIdr: idrColumn("amount_idr").notNull(),
    /** Spendable credit for customer_credit; original snapshot for manual_refund.
     * Manual refunds are shown through WS-05's live cap, never this snapshot. */
    remainingIdr: idrColumn("remaining_idr").notNull(),
    kind: varchar("kind", { length: 24 })
      .$type<"customer_credit" | "manual_refund">()
      .notNull(),
    /** legend-svwdz (1020): what the provider had already refunded on its own
     * for the source intent when this remainder was made. Amount is already
     * net of it; only a later refund shrinks credit moved to other sessions.
     * 0 for rows older than the column (restrictive: the whole refund counts). */
    providerRefundedSnapshotIdr: idrColumn("provider_refunded_snapshot_idr")
      .notNull()
      .default(idr(0)),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("reservation_dp_remainder_tenant_id_key").on(t.tenantId, t.id),
    unique("reservation_dp_remainder_source_key").on(
      t.tenantId,
      t.reservationId,
      t.tableSessionId,
    ),
    foreignKey({
      name: "reservation_dp_remainder_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_dp_remainder_reservation_fk",
      columns: [t.tenantId, t.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    foreignKey({
      name: "reservation_dp_remainder_session_fk",
      columns: [t.tenantId, t.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "reservation_dp_remainder_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "reservation_dp_remainder_profile_fk",
      columns: [t.tenantId, t.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    check(
      "reservation_dp_remainder_amount_check",
      sql`${t.amountIdr} > 0 AND ${t.remainingIdr} >= 0 AND ${t.remainingIdr} <= ${t.amountIdr}`,
    ),
    check(
      "reservation_dp_remainder_kind_check",
      sql`${t.kind} IN ('customer_credit','manual_refund') AND (${t.kind} <> 'customer_credit' OR ${t.customerProfileId} IS NOT NULL)`,
    ),
    index("reservation_dp_remainder_profile_idx").on(
      t.tenantId,
      t.customerProfileId,
    ),
  ],
);

export const reservationCustomerCreditUses = pgTable(
  "reservation_customer_credit_uses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    remainderId: uuid("remainder_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    returnedIdr: idrColumn("returned_idr").notNull().default(idr(0)),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("reservation_credit_use_tenant_id_key").on(t.tenantId, t.id),
    unique("reservation_credit_use_key").on(
      t.tenantId,
      t.idempotencyKey,
      t.remainderId,
    ),
    foreignKey({
      name: "reservation_credit_use_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_credit_use_remainder_fk",
      columns: [t.tenantId, t.remainderId],
      foreignColumns: [
        reservationDepositRemainders.tenantId,
        reservationDepositRemainders.id,
      ],
    }),
    foreignKey({
      name: "reservation_credit_use_session_fk",
      columns: [t.tenantId, t.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    check(
      "reservation_credit_use_amount_check",
      sql`${t.amountIdr} > 0 AND ${t.returnedIdr} >= 0 AND ${t.returnedIdr} <= ${t.amountIdr}`,
    ),
    index("reservation_credit_use_session_idx").on(
      t.tenantId,
      t.tableSessionId,
    ),
  ],
);

/**
 * legend-svwdz (1020): recon flag, insert-only. Written when credit moved to a
 * session was already used beyond what the source intent still holds net (a
 * provider refund landed after the use). The used value is never cut; finance
 * looks at the flag. One row per credit use (unique), so a re-read adds none.
 */
export const reservationCreditReconFlags = pgTable(
  "reservation_credit_recon_flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    creditUseId: uuid("credit_use_id").notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    usedIdr: idrColumn("used_idr").notNull(),
    effectiveIdr: idrColumn("effective_idr").notNull(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("reservation_credit_recon_flag_use_key").on(
      t.tenantId,
      t.creditUseId,
    ),
    foreignKey({
      name: "reservation_credit_recon_flag_use_fk",
      columns: [t.tenantId, t.creditUseId],
      foreignColumns: [
        reservationCustomerCreditUses.tenantId,
        reservationCustomerCreditUses.id,
      ],
    }),
    foreignKey({
      name: "reservation_credit_recon_flag_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "reservation_credit_recon_flag_session_fk",
      columns: [t.tenantId, t.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    check(
      "reservation_credit_recon_flag_amount_check",
      sql`${t.usedIdr} > 0 AND ${t.effectiveIdr} >= 0 AND ${t.effectiveIdr} < ${t.usedIdr}`,
    ),
    index("reservation_credit_recon_flag_intent_idx").on(
      t.tenantId,
      t.paymentIntentId,
    ),
  ],
);
