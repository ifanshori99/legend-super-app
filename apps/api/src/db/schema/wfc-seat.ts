// WFC seats, seat reservations and day-pass purchases (PRD v1.7 §3 F25/F39,
// FAC-14; bead legend-bz9h). Tenant RLS, outlet RLS and the no-double-booking
// exclusion constraint are installed in wfc-seat.custom.sql.
//
// - `wfc_seats` (T, E): one bookable seat of a floor zone, code unique per zone.
// - `wfc_seat_reservations` (T, E): the slot is the `tstzrange` column `slot`
//   (half-open `[)`; `starts_at` / `ends_at` are generated from it for
//   reads); the partial EXCLUDE constraint `wfc_seat_reservations_no_overlap`
//   makes a second active hold of one seat impossible even if a service forgot
//   its check (M5). `price_idr` is a snapshot of the product price; money
//   columns obey `paid <= price` and `refunded <= paid`, so the database alone
//   refuses to pay out more than was paid (M2).
// - `wfc_day_pass_purchases` (T, E): one paid day pass, `payment_ref` unique per
//   tenant so a replayed payment never sells two passes.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import type {
  WfcDayPassStatus,
  WfcReservationStatus,
  WfcSeatStatus,
} from "@starter/shared/wfc";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { customerProfiles } from "./crm-member.ts";
import { facilityProducts } from "./facility.ts";
import { floorZones } from "./floor.ts";
import { outlets, tenants } from "./platform-org.ts";

/** PostgreSQL `tstzrange`, written as the text literal `[start,end)`. */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => "tstzrange",
});

/** Range literal of a half-open slot `[startsAt, endsAt)`. */
export const slotLiteral = (startsAt: Date, endsAt: Date): string =>
  `[${startsAt.toISOString()},${endsAt.toISOString()})`;

/** One bookable seat of a zone (e.g. a desk of the co-working area). */
export const wfcSeats = pgTable(
  "wfc_seats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    zoneId: uuid("zone_id").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<WfcSeatStatus>()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_seats_tenant_id_id_key").on(table.tenantId, table.id),
    unique("wfc_seats_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("wfc_seats_zone_code_key").on(
      table.tenantId,
      table.outletId,
      table.zoneId,
      table.code,
    ),
    foreignKey({
      name: "wfc_seats_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // The zone must sit in this outlet: composite FK on floor_zones'
    // unique (tenant_id, outlet_id, id); `createWfcSeat` checks the outlet only
    // to answer with a friendly error.
    foreignKey({
      name: "wfc_seats_zone_fk",
      columns: [table.tenantId, table.outletId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.outletId, floorZones.id],
    }),
    index("wfc_seats_zone_idx").on(table.tenantId, table.zoneId),
    check(
      "wfc_seats_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
  ],
);

/** One seat booking over a time slot; see the header for the money rules. */
export const wfcSeatReservations = pgTable(
  "wfc_seat_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    seatId: uuid("seat_id").notNull(),
    productId: uuid("product_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    slot: tstzrange("slot").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true })
      .notNull()
      .generatedAlwaysAs(sql`lower(slot)`),
    endsAt: timestamp("ends_at", { withTimezone: true })
      .notNull()
      .generatedAlwaysAs(sql`upper(slot)`),
    status: varchar("status", { length: 20 })
      .$type<WfcReservationStatus>()
      .notNull(),
    /** Snapshot of the product price at booking time (M1). */
    priceIdr: idrColumn("price_idr").notNull(),
    paidIdr: idrColumn("paid_idr").notNull().default(idr(0)),
    refundedIdr: idrColumn("refunded_idr").notNull().default(idr(0)),
    /** The captured payment that funded this reservation; one capture, one sale. */
    paymentRef: varchar("payment_ref", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_seat_reservations_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("wfc_seat_reservations_payment_ref_key")
      .on(table.tenantId, table.paymentRef)
      .where(sql`${table.paymentRef} IS NOT NULL`),
    foreignKey({
      name: "wfc_seat_reservations_seat_fk",
      columns: [table.tenantId, table.outletId, table.seatId],
      foreignColumns: [wfcSeats.tenantId, wfcSeats.outletId, wfcSeats.id],
    }),
    foreignKey({
      name: "wfc_seat_reservations_product_fk",
      columns: [table.tenantId, table.outletId, table.productId],
      foreignColumns: [
        facilityProducts.tenantId,
        facilityProducts.outletId,
        facilityProducts.id,
      ],
    }),
    foreignKey({
      name: "wfc_seat_reservations_customer_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("wfc_seat_reservations_seat_idx").on(
      table.tenantId,
      table.seatId,
      table.startsAt,
    ),
    index("wfc_seat_reservations_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.startsAt,
    ),
    check(
      "wfc_seat_reservations_status_check",
      sql`${table.status} IN ('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'refunded')`,
    ),
    check(
      "wfc_seat_reservations_slot_check",
      sql`NOT isempty(${table.slot}) AND NOT lower_inf(${table.slot}) AND NOT upper_inf(${table.slot})`,
    ),
    check(
      "wfc_seat_reservations_amount_check",
      sql`${table.priceIdr} >= 0 AND ${table.paidIdr} >= 0 AND ${table.paidIdr} <= ${table.priceIdr} AND ${table.refundedIdr} >= 0 AND ${table.refundedIdr} <= ${table.paidIdr}`,
    ),
  ],
);

/** One paid day pass; the entitlement it grants lives in entitlement_ledger. */
export const wfcDayPassPurchases = pgTable(
  "wfc_day_pass_purchases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    productId: uuid("product_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Payment reference; also the entitlement `source_ref` (<= 40 chars). */
    paymentRef: varchar("payment_ref", { length: 40 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<WfcDayPassStatus>()
      .notNull()
      .default("paid"),
    priceIdr: idrColumn("price_idr").notNull(),
    paidIdr: idrColumn("paid_idr").notNull(),
    refundedIdr: idrColumn("refunded_idr").notNull().default(idr(0)),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_day_pass_purchases_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("wfc_day_pass_purchases_payment_ref_key").on(
      table.tenantId,
      table.paymentRef,
    ),
    foreignKey({
      name: "wfc_day_pass_purchases_product_fk",
      columns: [table.tenantId, table.outletId, table.productId],
      foreignColumns: [
        facilityProducts.tenantId,
        facilityProducts.outletId,
        facilityProducts.id,
      ],
    }),
    foreignKey({
      name: "wfc_day_pass_purchases_customer_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("wfc_day_pass_purchases_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    check(
      "wfc_day_pass_purchases_status_check",
      sql`${table.status} IN ('paid', 'refunded')`,
    ),
    check(
      "wfc_day_pass_purchases_amount_check",
      sql`${table.priceIdr} >= 0 AND ${table.paidIdr} = ${table.priceIdr} AND ${table.refundedIdr} >= 0 AND ${table.refundedIdr} <= ${table.paidIdr}`,
    ),
  ],
);
