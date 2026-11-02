// Reservation storage (PRD v1.7 §3 F22 / §3.22 "Reservasi & Event", §6 G
// `reservations`; Alur H; acceptance RSV-01..03; bead legend-t8bz).
//
// - `reservation_policies`: the outlet's CURRENT DP / cancellation rules. A
//   reservation never reads this table after booking: it freezes a copy in
//   `reservations.policy_snapshot` (RSV-03).
// - `reservations`: the booking. The PRD's `table_ids UUID[]` has no foreign-key
//   integrity (BREAKDOWN W30), so the tables live in the join table below.
// - `reservation_tables`: one row per (reservation, table) with the half-open
//   `hold_range` (`[starts_at, ends_at)`, the contract's RESERVATION_RANGE_BOUNDS).
//   `reservation_tables_no_overlap` (EXCLUDE USING gist, in
//   reservation.custom.sql) makes two live holds on one table at overlapping
//   times impossible even if two requests race (RSV-01). A hold stops blocking
//   when `released_at` is set (cancelled, no-show, completed).
// - `reservation_deposit_allocations`: the paid DP handed to the table's bill
//   when the guest is seated (RSV-02). The bill module reads it as prepaid credit.
// - `reservation_idempotency`: binds each client idempotency key to a request
//   fingerprint (same key + same request replays the stored result, same key +
//   another request is a conflict).
//
// The DP itself is a WS-05 payment intent (`payment_intents`, composite FK).
// Customer profiles (legend-111j) do not exist yet, so `customer_profile_id`
// carries no foreign key.
//
// Needs the `btree_gist` extension (tenant_id / table_id equality inside the
// gist exclusion); the lead's migration creates it. Tenant RLS and outlet RLS
// are installed in reservation.custom.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  DepositRequirement,
  ReservationPolicySnapshot,
  ReservationSource,
  ReservationStatus,
} from "@starter/shared/reservation";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { floorZones, tables, tableSessions } from "./floor.ts";
import { paymentIntents } from "./payment.ts";
import { outlets, tenants } from "./platform-org.ts";

/** PostgreSQL `tstzrange`, read and written as text (never rebuilt by hand). */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => "tstzrange",
});

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** Statuses whose table holds block other bookings (machines.ts: not terminal). */
export const RESERVATION_HOLDING_STATUSES = [
  "pending_deposit",
  "confirmed",
  "seated",
] as const satisfies readonly ReservationStatus[];

export type RefundStatus = "not_required" | "pending" | "requested";

/** `reservation_policies` (T, E): current rules, one active row per outlet. */
export const reservationPolicies = pgTable(
  "reservation_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Label copied into the snapshot (`policy.version`). */
    version: varchar("version", { length: 40 }).notNull(),
    depositRequirement: varchar("deposit_requirement", { length: 20 })
      .$type<DepositRequirement>()
      .notNull(),
    depositAmountIdr: idrColumn("deposit_amount_idr").notNull(),
    paymentWindowMinutes: integer("payment_window_minutes").notNull(),
    freeCancellationHours: integer("free_cancellation_hours").notNull(),
    lateCancellationRefundBp: integer("late_cancellation_refund_bp").notNull(),
    noShowRefundBp: integer("no_show_refund_bp").notNull(),
    minimumSpendIdr: idrColumn("minimum_spend_idr").notNull(),
    /** Slot length when the guest does not choose one (minutes). */
    defaultDurationMinutes: integer("default_duration_minutes")
      .notNull()
      .default(90),
    /** Spacing of the start times offered by the availability search. */
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(30),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("reservation_policies_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("reservation_policies_tenant_outlet_version_key").on(
      table.tenantId,
      table.outletId,
      table.version,
    ),
    uniqueIndex("reservation_policies_active_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.isActive}`),
    foreignKey({
      name: "reservation_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "reservation_policies_requirement_check",
      sql`${table.depositRequirement} IN ('none', 'required', 'optional')`,
    ),
    check(
      "reservation_policies_amounts_check",
      sql`${table.depositAmountIdr} >= 0 AND ${table.minimumSpendIdr} >= 0
        AND (${table.depositRequirement} <> 'none' OR ${table.depositAmountIdr} = 0)
        AND (${table.depositRequirement} <> 'required' OR ${table.depositAmountIdr} > 0)`,
    ),
    check(
      "reservation_policies_rules_check",
      sql`${table.paymentWindowMinutes} BETWEEN 5 AND 1440
        AND ${table.freeCancellationHours} BETWEEN 0 AND 720
        AND ${table.lateCancellationRefundBp} BETWEEN 0 AND 10000
        AND ${table.noShowRefundBp} BETWEEN 0 AND 10000
        AND ${table.defaultDurationMinutes} BETWEEN 15 AND 720
        AND ${table.slotIntervalMinutes} BETWEEN 5 AND 240`,
    ),
  ],
);

/** `reservations` (T, E): a booking (PRD §6 G), without the table list. */
export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    customerProfileId: uuid("customer_profile_id"),
    guestName: varchar("guest_name", { length: 150 }).notNull(),
    /** `hashGuestContact` digest; the phone number itself is never stored. */
    contactHash: varchar("contact_hash", { length: 64 }),
    reservedFor: timestamp("reserved_for", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    pax: smallint("pax").notNull(),
    zoneId: uuid("zone_id"),
    depositIdr: idrColumn("deposit_idr").notNull(),
    /** `payment_intents.id` of the DP; null until the link is opened. */
    depositPaymentId: uuid("deposit_payment_id"),
    /** Sealed DP payment URL so an idempotent replay can return it again. */
    depositLinkSealed: text("deposit_link_sealed"),
    depositLinkExpiresAt: timestamp("deposit_link_expires_at", {
      withTimezone: true,
    }),
    /** Frozen copy of the policy at booking time (RSV-03). Never rewritten. */
    policySnapshot: jsonb("policy_snapshot")
      .$type<ReservationPolicySnapshot>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<ReservationStatus>()
      .notNull(),
    note: varchar("note", { length: 300 }),
    source: varchar("source", { length: 20 })
      .$type<ReservationSource>()
      .notNull(),
    seatedAt: timestamp("seated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: varchar("close_reason", { length: 300 }),
    /** DP split decided from the snapshot at cancel / no-show (RSV-03). */
    depositRefundIdr: idrColumn("deposit_refund_idr"),
    depositForfeitedIdr: idrColumn("deposit_forfeited_idr"),
    refundStatus: varchar("refund_status", { length: 20 })
      .$type<RefundStatus>()
      .notNull()
      .default("not_required"),
    tableSessionId: uuid("table_session_id"),
    createdBy: uuid("created_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("reservations_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "reservations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservations_zone_fk",
      columns: [table.tenantId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.id],
    }),
    foreignKey({
      name: "reservations_deposit_payment_fk",
      columns: [table.tenantId, table.depositPaymentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "reservations_table_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    index("reservations_outlet_time_idx").on(
      table.tenantId,
      table.outletId,
      table.reservedFor,
      table.id,
    ),
    index("reservations_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    check(
      "reservations_status_check",
      sql`${table.status} IN ('pending_deposit', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')`,
    ),
    check(
      "reservations_source_check",
      sql`${table.source} IN ('website', 'staff', 'whatsapp')`,
    ),
    check(
      "reservations_size_check",
      sql`${table.pax} BETWEEN 1 AND 60 AND ${table.durationMinutes} BETWEEN 15 AND 720`,
    ),
    check("reservations_deposit_check", sql`${table.depositIdr} >= 0`),
    check(
      "reservations_contact_hash_check",
      sql`${table.contactHash} IS NULL OR ${table.contactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    // A closed reservation records when; an open one never does (the contract).
    check(
      "reservations_closed_check",
      sql`(${table.status} IN ('cancelled', 'no_show')) = (${table.closedAt} IS NOT NULL)`,
    ),
    check(
      "reservations_seated_check",
      sql`${table.status} NOT IN ('seated', 'completed') OR (${table.seatedAt} IS NOT NULL AND ${table.tableSessionId} IS NOT NULL)`,
    ),
    check(
      "reservations_completed_check",
      sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
    // RSV-03: refund + forfeit is the DP that was paid, both set together.
    check(
      "reservations_outcome_check",
      sql`(${table.depositRefundIdr} IS NULL) = (${table.depositForfeitedIdr} IS NULL)
        AND (${table.depositRefundIdr} IS NULL OR (${table.depositRefundIdr} >= 0 AND ${table.depositForfeitedIdr} >= 0))`,
    ),
    check(
      "reservations_refund_status_check",
      sql`${table.refundStatus} IN ('not_required', 'pending', 'requested')`,
    ),
  ],
);

/**
 * `reservation_tables` (T, E): the join table that fixes the `table_ids UUID[]`
 * gap. `hold_range` is generated from `starts_at` / `ends_at` so the range and
 * the contract's slot bounds can never disagree.
 */
export const reservationTables = pgTable(
  "reservation_tables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    reservationId: uuid("reservation_id").notNull(),
    tableId: uuid("table_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Half-open upper bound: a slot ending exactly when the next starts is free. */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    holdRange: tstzrange("hold_range").generatedAlwaysAs(
      sql`tstzrange(starts_at, ends_at, '[)')`,
    ),
    /** Set when the hold stops blocking (cancelled, no-show, completed, replaced). */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    unique("reservation_tables_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "reservation_tables_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_tables_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    foreignKey({
      name: "reservation_tables_table_fk",
      columns: [table.tenantId, table.tableId],
      foreignColumns: [tables.tenantId, tables.id],
    }),
    // One live row per (reservation, table); released rows stay as history.
    uniqueIndex("reservation_tables_live_key")
      .on(table.tenantId, table.reservationId, table.tableId)
      .where(sql`${table.releasedAt} IS NULL`),
    index("reservation_tables_reservation_idx").on(
      table.tenantId,
      table.reservationId,
    ),
    index("reservation_tables_table_idx").on(
      table.tenantId,
      table.outletId,
      table.tableId,
      table.startsAt,
    ),
    check(
      "reservation_tables_range_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

/** `reservation_deposit_allocations` (T, E): the paid DP credited to a bill (RSV-02). */
export const reservationDepositAllocations = pgTable(
  "reservation_deposit_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    reservationId: uuid("reservation_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A reservation's DP is allocated once.
    unique("reservation_deposit_allocations_reservation_key").on(
      table.tenantId,
      table.reservationId,
    ),
    foreignKey({
      name: "reservation_deposit_allocations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_deposit_allocations_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    foreignKey({
      name: "reservation_deposit_allocations_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "reservation_deposit_allocations_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    index("reservation_deposit_allocations_session_idx").on(
      table.tenantId,
      table.tableSessionId,
    ),
    check(
      "reservation_deposit_allocations_amount_check",
      sql`${table.amountIdr} > 0`,
    ),
  ],
);

/** `reservation_idempotency` (T, E): idempotency key -> request fingerprint + result. */
export const reservationIdempotency = pgTable(
  "reservation_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 30 }).notNull(),
    /** SHA-256 of operation + outlet + target + canonical payload. */
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    reservationId: uuid("reservation_id"),
    /** Stored result; null while the first request is still completing. */
    response: jsonb("response").$type<Record<string, unknown>>(),
    createdAt,
  },
  (table) => [
    unique("reservation_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "reservation_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_idempotency_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    check(
      "reservation_idempotency_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
