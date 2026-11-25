// WFC seats and seat claims (PRD v1.7 §3 F25/F39, FAC-14; brief 1270 card W1,
// from bead legend-bz9h). Tenant RLS, outlet RLS and the no-double-booking
// exclusion constraint are installed in wfc-seat.custom.sql.
//
// - `wfc_seats` (T, E): one sellable seat of a WFC floor zone, code unique per
//   zone.
// - `wfc_seat_reservations` (T, E): the one seat claim of every WFC product
//   (reservation, day pass; the monthly visit joins with W4). The slot is the
//   `tstzrange` column `slot` (half-open `[)`; `starts_at` / `ends_at` are
//   generated from it); the partial EXCLUDE constraint
//   `wfc_seat_reservations_no_overlap` makes a second active claim of one seat
//   impossible even if a service forgot its check. Seat fee, credit, price,
//   price floor and settings version are a snapshot of the sale. Money columns
//   obey price = seat fee + credit, `paid` is 0 or the price and `refunded <= paid`, and
//   a claim past `pending_payment` is fully paid through its own payment link.
//   The trigger `app.wfc_claim_guard` proves it against the link, copies the
//   live product, freezes the snapshot and allows only legal status steps. It
//   locks the link: lock a claim with `lockWfcClaim` (link first, then claim).
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
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
  WfcAccess,
  WfcProductKind,
  WfcReservationStatus,
  WfcSeatStatus,
} from "@starter/shared/wfc";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { customerProfiles } from "./crm-member.ts";
import { facilityProducts } from "./facility.ts";
import { floorZones } from "./floor.ts";
import { paymentLinks } from "./payment.ts";
import { outlets, tenants } from "./platform-org.ts";
import { wfcBusinessSettings } from "./wfc-settings.ts";

/** PostgreSQL `tstzrange`, written as the text literal `[start,end)`. */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => "tstzrange",
});

/** One sellable seat of a zone (e.g. a desk of the co-working area). */
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
    foreignKey({
      name: "wfc_seats_zone_fk",
      columns: [table.tenantId, table.outletId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.outletId, floorZones.id],
    }),
    check(
      "wfc_seats_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
  ],
);

/** One seat claim over a time slot; see the header for the money rules. */
export const wfcSeatReservations = pgTable(
  "wfc_seat_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    seatId: uuid("seat_id").notNull(),
    productId: uuid("product_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    kind: varchar("kind", { length: 20 }).$type<WfcProductKind>().notNull(),
    access: varchar("access", { length: 10 }).$type<WfcAccess>().notNull(),
    /** Business date of the slot: the day the credit is valid. */
    businessDate: date("business_date").notNull(),
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
    seatFeeIdr: idrColumn("seat_fee_idr").notNull(),
    creditIdr: idrColumn("credit_idr").notNull(),
    priceIdr: idrColumn("price_idr").notNull(),
    settingsVersionId: uuid("settings_version_id").notNull(),
    floorPerHourIdr: idrColumn("floor_per_hour_idr").notNull(),
    paidIdr: idrColumn("paid_idr").notNull().default(idr(0)),
    refundedIdr: idrColumn("refunded_idr").notNull().default(idr(0)),
    /** The payment link that funds this claim; one link, one claim. */
    paymentLinkId: uuid("payment_link_id"),
    /** The link's expiry when attached, set by the trigger: a later value means cancelled. */
    paymentLinkExpiresAt: timestamp("payment_link_expires_at", {
      withTimezone: true,
    }),
    /** Set while `pending_payment`: the sweep releases the seat after it. */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_seat_reservations_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    uniqueIndex("wfc_seat_reservations_payment_link_key")
      .on(table.tenantId, table.paymentLinkId)
      .where(sql`${table.paymentLinkId} IS NOT NULL`),
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
    foreignKey({
      name: "wfc_seat_reservations_settings_fk",
      columns: [table.tenantId, table.outletId, table.settingsVersionId],
      foreignColumns: [
        wfcBusinessSettings.tenantId,
        wfcBusinessSettings.outletId,
        wfcBusinessSettings.id,
      ],
    }),
    foreignKey({
      name: "wfc_seat_reservations_link_fk",
      columns: [table.tenantId, table.outletId, table.paymentLinkId],
      foreignColumns: [
        paymentLinks.tenantId,
        paymentLinks.outletId,
        paymentLinks.id,
      ],
    }),
    index("wfc_seat_reservations_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.startsAt,
    ),
    index("wfc_seat_reservations_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.startsAt,
    ),
    index("wfc_seat_reservations_hold_idx")
      .on(table.tenantId, table.holdExpiresAt)
      .where(sql`${table.status} = 'pending_payment'`),
    check(
      "wfc_seat_reservations_kind_check",
      sql`${table.kind} IN ('day_pass', 'seat_reservation') AND ${table.access} IN ('off_peak', 'all_day')`,
    ),
    check(
      "wfc_seat_reservations_status_check",
      sql`${table.status} IN ('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'refunded')`,
    ),
    check(
      "wfc_seat_reservations_slot_check",
      sql`NOT isempty(${table.slot}) AND NOT lower_inf(${table.slot}) AND NOT upper_inf(${table.slot}) AND lower_inc(${table.slot}) AND NOT upper_inc(${table.slot})`,
    ),
    check(
      "wfc_seat_reservations_amount_check",
      sql`${table.seatFeeIdr} > 0 AND ${table.creditIdr} > 0 AND ${table.priceIdr} = ${table.seatFeeIdr} + ${table.creditIdr} AND ${table.floorPerHourIdr} > 0 AND ${table.paidIdr} IN (0, ${table.priceIdr}) AND ${table.refundedIdr} >= 0 AND ${table.refundedIdr} <= ${table.paidIdr}`,
    ),
    check(
      "wfc_seat_reservations_link_check",
      sql`(${table.paymentLinkId} IS NULL) = (${table.paymentLinkExpiresAt} IS NULL) AND (${table.paidIdr} = 0 OR ${table.paymentLinkId} IS NOT NULL)`,
    ),
    // The seat is issued only after full payment through a link.
    check(
      "wfc_seat_reservations_paid_check",
      sql`${table.status} NOT IN ('confirmed', 'checked_in', 'completed', 'no_show', 'refunded') OR (${table.paidIdr} = ${table.priceIdr} AND ${table.paymentLinkId} IS NOT NULL)`,
    ),
    // Only a fully refunded claim is `refunded`; a claim that holds or used the
    // seat is never refunded at the same time.
    check(
      "wfc_seat_reservations_refund_check",
      sql`(${table.status} <> 'refunded' OR ${table.refundedIdr} = ${table.paidIdr}) AND (${table.status} NOT IN ('pending_payment', 'confirmed', 'checked_in') OR ${table.refundedIdr} = 0)`,
    ),
    check(
      "wfc_seat_reservations_hold_check",
      sql`(${table.status} = 'pending_payment') = (${table.holdExpiresAt} IS NOT NULL)`,
    ),
  ],
);
