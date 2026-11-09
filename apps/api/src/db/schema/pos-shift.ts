// Cashier shift, cash movements and end-of-day close (bead legend-6c0; PRD
// v1.7 §3 F8 "Shift Kasir" + "Tutup Hari", §4 E, §6 C `pos_shifts` /
// `cash_movements`; acceptance POS-03, POS-05). Contract:
// @starter/shared/pos posShiftSchema, posCashMovementSchema,
// endOfDayRecapSchema.
//
// Rules carried by the tables (the service checks them first; the
// pos-shift.custom.sql triggers are the database backstop):
// - tenant_id NOT NULL everywhere, outlet_id NOT NULL (operational), unique
//   constraints include tenant_id, children reference parents through
//   composite (tenant_id, id) foreign keys. Money is BIGINT whole rupiah.
// - One open shift per terminal and one per cashier in an outlet (partial
//   unique indexes), so the order service's shift lookup is deterministic.
// - POS-03: a closed shift is frozen (no UPDATE, no DELETE); the close writes
//   count, expectation, variance and the supervisor approval in one UPDATE
//   and the row checks force them to agree. An approval is used once
//   (unique approval_override_id per tenant).
// - cash_movements and pos_daily_closes are append-only history.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { user } from "./user";

/** `pos_shifts` (T, O): one cashier shift on one terminal (§6 C). */
export const posShifts = pgTable(
  "pos_shifts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    cashierId: text("cashier_id")
      .notNull()
      .references(() => user.id),
    businessDate: businessDate("business_date").notNull(),
    status: varchar("status", { length: 10 })
      .$type<"open" | "closed">()
      .notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openingFloatIdr: idrColumn("opening_float_idr").notNull(),
    /** Server aggregates frozen at close (0 while open; live values are computed). */
    cashSalesIdr: idrColumn("cash_sales_idr")
      .notNull()
      .default(sql`0`),
    cashRefundsIdr: idrColumn("cash_refunds_idr")
      .notNull()
      .default(sql`0`),
    cashInIdr: idrColumn("cash_in_idr")
      .notNull()
      .default(sql`0`),
    cashOutIdr: idrColumn("cash_out_idr")
      .notNull()
      .default(sql`0`),
    cashDropIdr: idrColumn("cash_drop_idr")
      .notNull()
      .default(sql`0`),
    expectedIdr: idrColumn("expected_idr"),
    countedIdr: idrColumn("counted_idr"),
    varianceIdr: idrColumn("variance_idr"),
    varianceNote: varchar("variance_note", { length: 500 }),
    /** The blind count sheet as submitted: [{denominationIdr, quantity}]. */
    counts:
      jsonb("counts").$type<
        Array<{ denominationIdr: number; quantity: number }>
      >(),
    /** The pos_shift_counts submission the close used (set in the close UPDATE). */
    countId: uuid("count_id"),
    approvedBy: text("approved_by").references(() => user.id),
    approvalRequestId: uuid("approval_request_id"),
    /** pos_overrides.id of the supervisor decision; single use per tenant. */
    approvalOverrideId: uuid("approval_override_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by").references(() => user.id),
    /** Idempotency of open and close: key + request fingerprint (sha256 hex). */
    openKey: varchar("open_key", { length: 100 }).notNull(),
    openFingerprint: varchar("open_fingerprint", { length: 64 }).notNull(),
    closeKey: varchar("close_key", { length: 100 }),
    closeFingerprint: varchar("close_fingerprint", { length: 64 }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("pos_shifts_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pos_shifts_open_key").on(
      table.tenantId,
      table.outletId,
      table.openKey,
    ),
    foreignKey({
      name: "pos_shifts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // The close count belongs to this shift (the guard trigger also checks
    // shift_id and counted_idr). posShiftCounts is declared below and already
    // points back here, so its columns are read only when drizzle builds the
    // constraint, never while this table is being declared.
    foreignKey({
      name: "pos_shifts_count_fk",
      columns: [table.tenantId, table.countId],
      foreignColumns: [posShiftCounts.tenantId, posShiftCounts.id],
    }),
    uniqueIndex("pos_shifts_open_device_key")
      .on(table.tenantId, table.outletId, table.deviceId)
      .where(sql`${table.status} = 'open'`),
    uniqueIndex("pos_shifts_open_cashier_key")
      .on(table.tenantId, table.outletId, table.cashierId)
      .where(sql`${table.status} = 'open'`),
    uniqueIndex("pos_shifts_approval_override_key")
      .on(table.tenantId, table.approvalOverrideId)
      .where(sql`${table.approvalOverrideId} IS NOT NULL`),
    index("pos_shifts_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
      table.openedAt,
    ),
    check(
      "pos_shifts_status_check",
      sql`${table.status} IN ('open', 'closed')`,
    ),
    check(
      "pos_shifts_amounts_check",
      sql`${table.openingFloatIdr} >= 0 AND ${table.cashSalesIdr} >= 0
        AND ${table.cashRefundsIdr} >= 0 AND ${table.cashInIdr} >= 0
        AND ${table.cashOutIdr} >= 0 AND ${table.cashDropIdr} >= 0
        AND (${table.expectedIdr} IS NULL OR ${table.expectedIdr} >= 0)
        AND (${table.countedIdr} IS NULL OR ${table.countedIdr} >= 0)`,
    ),
    // Open: no close figure at all. Closed: every close figure, and they agree
    // with the drawer formula (contract shiftExpectedCashIdr) and U9.
    check(
      "pos_shifts_open_check",
      sql`${table.status} <> 'open' OR (${table.expectedIdr} IS NULL
        AND ${table.countedIdr} IS NULL AND ${table.varianceIdr} IS NULL
        AND ${table.varianceNote} IS NULL AND ${table.counts} IS NULL
        AND ${table.approvedBy} IS NULL AND ${table.approvalRequestId} IS NULL
        AND ${table.approvalOverrideId} IS NULL AND ${table.approvedAt} IS NULL
        AND ${table.closedAt} IS NULL AND ${table.closedBy} IS NULL
        AND ${table.closeKey} IS NULL AND ${table.closeFingerprint} IS NULL
        AND ${table.countId} IS NULL)`,
    ),
    check(
      "pos_shifts_closed_check",
      sql`${table.status} <> 'closed' OR (${table.expectedIdr} IS NOT NULL
        AND ${table.countedIdr} IS NOT NULL AND ${table.varianceIdr} IS NOT NULL
        AND ${table.counts} IS NOT NULL
        AND ${table.approvedBy} IS NOT NULL AND ${table.approvalRequestId} IS NOT NULL
        AND ${table.approvalOverrideId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL
        AND ${table.closedAt} IS NOT NULL AND ${table.closedBy} IS NOT NULL
        AND ${table.closeKey} IS NOT NULL AND ${table.closeFingerprint} IS NOT NULL
        AND ${table.expectedIdr} = ${table.openingFloatIdr} + ${table.cashSalesIdr}
          - ${table.cashRefundsIdr} + ${table.cashInIdr} - ${table.cashOutIdr}
          - ${table.cashDropIdr}
        AND ${table.varianceIdr} = ${table.countedIdr} - ${table.expectedIdr}
        AND (${table.varianceIdr} = 0 OR ${table.varianceNote} IS NOT NULL))`,
    ),
    check(
      "pos_shifts_closed_count_check",
      sql`${table.status} <> 'closed' OR ${table.countId} IS NOT NULL`,
    ),
    check(
      "pos_shifts_approver_check",
      sql`${table.approvedBy} IS NULL OR lower(${table.approvedBy}) <> lower(${table.cashierId})`,
    ),
  ],
);

/**
 * `pos_shift_counts` (T, O): append-only blind count submissions of a shift.
 * The close references one submission (`pos_shifts.count_id`); the server
 * derives the variance from it, so the cashier cannot change the numbers
 * after the supervisor approved.
 */
export const posShiftCounts = pgTable(
  "pos_shift_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    shiftId: uuid("shift_id").notNull(),
    /** 1, 2, 3 ... per shift. */
    sequence: integer("sequence").notNull(),
    counts: jsonb("counts")
      .$type<Array<{ denominationIdr: number; quantity: number }>>()
      .notNull(),
    countsFingerprint: varchar("counts_fingerprint", { length: 64 }).notNull(),
    countedIdr: idrColumn("counted_idr").notNull(),
    expectedIdr: idrColumn("expected_idr").notNull(),
    /** Signed: counted - expected. */
    varianceIdr: idrColumn("variance_idr").notNull(),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => user.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    /** Supervisor force close (U9): submitted by someone other than the cashier. */
    forced: boolean("forced").notNull().default(false),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("pos_shift_counts_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pos_shift_counts_sequence_key").on(
      table.tenantId,
      table.shiftId,
      table.sequence,
    ),
    unique("pos_shift_counts_idempotency_key").on(
      table.tenantId,
      table.shiftId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "pos_shift_counts_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "pos_shift_counts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("pos_shift_counts_shift_idx").on(
      table.tenantId,
      table.shiftId,
      table.sequence,
    ),
    check("pos_shift_counts_sequence_check", sql`${table.sequence} >= 1`),
    check("pos_shift_counts_counted_check", sql`${table.countedIdr} >= 0`),
    check(
      "pos_shift_counts_variance_check",
      sql`${table.varianceIdr} = ${table.countedIdr} - ${table.expectedIdr}`,
    ),
    check(
      "pos_shift_counts_counts_check",
      sql`jsonb_typeof(${table.counts}) = 'array'`,
    ),
  ],
);

/** `cash_movements` (T, E): cash in / out / drop on an open shift (§6 C). */
export const cashMovements = pgTable(
  "cash_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    shiftId: uuid("shift_id").notNull(),
    type: varchar("type", { length: 10 })
      .$type<"cash_in" | "cash_out" | "drop">()
      .notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    reasonNote: varchar("reason_note", { length: 500 }).notNull(),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => user.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    approvedBy: text("approved_by").references(() => user.id),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("cash_movements_tenant_id_id_key").on(table.tenantId, table.id),
    unique("cash_movements_idempotency_key").on(
      table.tenantId,
      table.shiftId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "cash_movements_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "cash_movements_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("cash_movements_shift_idx").on(
      table.tenantId,
      table.shiftId,
      table.recordedAt,
    ),
    check(
      "cash_movements_type_check",
      sql`${table.type} IN ('cash_in', 'cash_out', 'drop')`,
    ),
    check("cash_movements_amount_check", sql`${table.amountIdr} > 0`),
    // The service trims the note first; btrim keeps spaces alone out even for
    // a writer that skips it (legend-vor4). Migration 0099 adds it NOT VALID
    // so rows written before it are not re-checked.
    check(
      "cash_movements_reason_check",
      sql`char_length(btrim(${table.reasonNote})) >= 4`,
    ),
  ],
);

/**
 * `cash_movement_refusals` (T, E): the idempotency record of a refused cash
 * out (legend-uw47). A retry with the same key and fingerprint gets the same
 * refusal without a new audit row, so retries do not use up the shift's
 * refusal allowance; one row per unique refused attempt.
 */
export const cashMovementRefusals = pgTable(
  "cash_movement_refusals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    shiftId: uuid("shift_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("cash_movement_refusals_idempotency_key").on(
      table.tenantId,
      table.shiftId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "cash_movement_refusals_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "cash_movement_refusals_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
  ],
);

/**
 * `pos_daily_closes` (T, O): F8 "Tutup Hari" — one closed business day per
 * outlet with the frozen recap (contract endOfDayRecapSchema) that `day.closed`
 * carries to WS-07 / WS-06 (POS-05: one set of figures for every reader).
 */
export const posDailyCloses = pgTable(
  "pos_daily_closes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    businessDate: businessDate("business_date").notNull(),
    orderCount: integer("order_count").notNull(),
    totalSalesIdr: idrColumn("total_sales_idr").notNull(),
    totalRefundsIdr: idrColumn("total_refunds_idr").notNull(),
    totalVoidsIdr: idrColumn("total_voids_idr").notNull(),
    totalVarianceIdr: idrColumn("total_variance_idr").notNull(),
    inventoryDeductionApplied: boolean("inventory_deduction_applied").notNull(),
    /** The whole recap as returned (devices, tenders, channels). */
    recap: jsonb("recap").$type<Record<string, unknown>>().notNull(),
    closedBy: text("closed_by")
      .notNull()
      .references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("pos_daily_closes_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pos_daily_closes_day_key").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    unique("pos_daily_closes_idempotency_key").on(
      table.tenantId,
      table.outletId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "pos_daily_closes_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pos_daily_closes_amounts_check",
      sql`${table.orderCount} >= 0 AND ${table.totalSalesIdr} >= 0
        AND ${table.totalRefundsIdr} >= 0 AND ${table.totalVoidsIdr} >= 0`,
    ),
  ],
);
