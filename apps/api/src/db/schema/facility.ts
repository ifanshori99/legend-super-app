// Facility access storage (PRD v1.7 §3 F22 "Model Generik" / "Pemesanan", §6 K
// `facilities` / `facility_areas` / `facility_units` / `access_tickets`; bead
// legend-nm4f; FAC-02, FAC-06).
//
// - `facilities` -> `facility_areas` -> `facility_units` is the generic model
//   (showers first; lockers, rooms, co-working later). Every table is outlet
//   owned, and each child repeats (tenant_id, outlet_id, facility_id) in a
//   composite FK so a child can never sit in another outlet than its parent.
// - `access_tickets` carries the slot as three instants. The occupied range
//   is `tstzrange(starts_at, cleaning_ends_at, '[)')`: the session plus the
//   cleaning buffer. The partial EXCLUDE constraint
//   `access_tickets_no_overlap` (facility.custom.sql, needs btree_gist) makes
//   an overlapping hold impossible even if a service forgot its lock, and a
//   cancelled / refunded / no_show ticket drops out of it (FAC-02).
// - `facility_queue_entries` is the "masuk sekarang" wait queue.
//
// Entitlement ledger, credentials (QR/PIN digests), products and add-ons are
// separate beads (legend-fjk5, legend-bzih, legend-er32); `product_id` and
// `entitlement_ledger_id` carry no FK until those tables land. Tenant RLS and
// outlet RLS are installed in facility.custom.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  AccessTicketStatus,
  CancellationPolicy,
  EntitlementSource,
  FacilityDayHours,
  FacilityQueueEntryStatus,
  FacilityType,
  FacilityUnitStatus,
  OvertimePolicy,
  TicketAddon,
} from "@starter/shared/facility";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** One facility of an outlet, e.g. "Shower Room" (§6 K `facilities`). */
export const facilities = pgTable(
  "facilities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).$type<FacilityType>().notNull(),
    sessionMinutes: integer("session_minutes").notNull(),
    cleaningMinutes: integer("cleaning_minutes").notNull(),
    arrivalGraceMinutes: integer("arrival_grace_minutes").notNull(),
    operatingHours: jsonb("operating_hours")
      .$type<FacilityDayHours[]>()
      .notNull(),
    overtimePolicy: jsonb("overtime_policy").$type<OvertimePolicy>().notNull(),
    cancellationPolicy: jsonb("cancellation_policy")
      .$type<CancellationPolicy>()
      .notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facilities_tenant_id_id_key").on(table.tenantId, table.id),
    unique("facilities_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "facilities_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("facilities_tenant_outlet_idx").on(table.tenantId, table.outletId),
    check(
      "facilities_type_check",
      sql`${table.type} IN ('shower', 'locker', 'meeting_room', 'coworking')`,
    ),
    check(
      "facilities_minutes_check",
      sql`${table.sessionMinutes} BETWEEN 1 AND 480 AND ${table.cleaningMinutes} BETWEEN 0 AND 240 AND ${table.arrivalGraceMinutes} BETWEEN 0 AND 1440 AND ${table.sessionMinutes} + ${table.cleaningMinutes} <= 720`,
    ),
  ],
);

/** An area inside a facility, e.g. Area Pria / Area Wanita (§6 K). */
export const facilityAreas = pgTable(
  "facility_areas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    entranceLockDeviceId: uuid("entrance_lock_device_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_areas_tenant_id_id_key").on(table.tenantId, table.id),
    unique("facility_areas_tenant_facility_id_key").on(
      table.tenantId,
      table.facilityId,
      table.id,
    ),
    unique("facility_areas_tenant_facility_name_key").on(
      table.tenantId,
      table.facilityId,
      table.name,
    ),
    foreignKey({
      name: "facility_areas_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    check("facility_areas_sort_check", sql`${table.sortOrder} >= 0`),
  ],
);

/** One bookable unit (booth) with its door lock and panic button (§6 K). */
export const facilityUnits = pgTable(
  "facility_units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    areaId: uuid("area_id").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    lockDeviceId: uuid("lock_device_id"),
    panicDeviceId: uuid("panic_device_id"),
    status: varchar("status", { length: 20 })
      .$type<FacilityUnitStatus>()
      .notNull()
      .default("available"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_units_tenant_id_id_key").on(table.tenantId, table.id),
    unique("facility_units_tenant_facility_id_key").on(
      table.tenantId,
      table.facilityId,
      table.id,
    ),
    unique("facility_units_tenant_facility_code_key").on(
      table.tenantId,
      table.facilityId,
      table.code,
    ),
    foreignKey({
      name: "facility_units_area_fk",
      columns: [table.tenantId, table.facilityId, table.areaId],
      foreignColumns: [
        facilityAreas.tenantId,
        facilityAreas.facilityId,
        facilityAreas.id,
      ],
    }),
    foreignKey({
      name: "facility_units_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("facility_units_tenant_area_idx").on(
      table.tenantId,
      table.areaId,
      table.sortOrder,
    ),
    check(
      "facility_units_status_check",
      sql`${table.status} IN ('available', 'in_use', 'needs_cleaning', 'cleaning', 'maintenance')`,
    ),
    check("facility_units_sort_check", sql`${table.sortOrder} >= 0`),
  ],
);

/**
 * A booking/session ticket (§6 K `access_tickets`). This bead owns the slot
 * columns, the hold lifecycle and the exclusion constraint; QR/PIN digests
 * and lock credentials are added by legend-bzih.
 */
export const accessTickets = pgTable(
  "access_tickets",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    /** FAC-09: the picked area lives on the ticket, never on the profile. */
    areaId: uuid("area_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Facility product (legend-er32 / legend-fjk5); no FK until that table lands. */
    productId: uuid("product_id").notNull(),
    source: varchar("source", { length: 20 })
      .$type<EntitlementSource>()
      .notNull(),
    /** The `redeem` ledger row this ticket consumed (legend-fjk5); no FK yet. */
    entitlementLedgerId: uuid("entitlement_ledger_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** End of the cleaning buffer: the unit is free again from here. */
    cleaningEndsAt: timestamp("cleaning_ends_at", {
      withTimezone: true,
    }).notNull(),
    graceMinutes: integer("grace_minutes").notNull(),
    addons: jsonb("addons").$type<TicketAddon[]>().notNull().default([]),
    status: varchar("status", { length: 20 })
      .$type<AccessTicketStatus>()
      .notNull(),
    issuedOffline: boolean("issued_offline").notNull().default(false),
    /** A pending_payment hold that is not paid by then is released (sweeper). */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    overtimeFeeIdr: idrColumn("overtime_fee_idr")
      .notNull()
      .default(sql`0`),
    /** Client key + fingerprint of the request that created the hold. */
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }),
    createdBy: uuid("created_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("access_tickets_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "access_tickets_unit_fk",
      columns: [table.tenantId, table.facilityId, table.unitId],
      foreignColumns: [
        facilityUnits.tenantId,
        facilityUnits.facilityId,
        facilityUnits.id,
      ],
    }),
    foreignKey({
      name: "access_tickets_area_fk",
      columns: [table.tenantId, table.facilityId, table.areaId],
      foreignColumns: [
        facilityAreas.tenantId,
        facilityAreas.facilityId,
        facilityAreas.id,
      ],
    }),
    foreignKey({
      name: "access_tickets_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    uniqueIndex("access_tickets_idempotency_key")
      .on(table.tenantId, table.customerProfileId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    // One redeemed grant backs at most one ticket (FAC-05).
    uniqueIndex("access_tickets_ledger_key")
      .on(table.tenantId, table.entitlementLedgerId)
      .where(sql`${table.entitlementLedgerId} IS NOT NULL`),
    index("access_tickets_unit_slot_idx").on(
      table.tenantId,
      table.unitId,
      table.startsAt,
    ),
    index("access_tickets_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.startsAt,
    ),
    index("access_tickets_hold_expiry_idx")
      .on(table.tenantId, table.holdExpiresAt)
      .where(sql`${table.status} = 'pending_payment'`),
    check(
      "access_tickets_status_check",
      sql`${table.status} IN ('pending_payment', 'issued', 'in_use', 'completed', 'no_show', 'cancelled', 'refunded')`,
    ),
    check(
      "access_tickets_source_check",
      sql`${table.source} IN ('purchase', 'package', 'min_spend', 'tier_benefit', 'subscription', 'staff_issue')`,
    ),
    check(
      "access_tickets_slot_check",
      sql`${table.endsAt} > ${table.startsAt} AND ${table.cleaningEndsAt} >= ${table.endsAt}`,
    ),
    check(
      "access_tickets_overtime_check",
      sql`${table.overtimeMinutes} >= 0 AND ${table.overtimeFeeIdr} >= 0 AND ${table.graceMinutes} >= 0`,
    ),
    check(
      "access_tickets_fingerprint_check",
      sql`(${table.idempotencyKey} IS NULL) = (${table.requestFingerprint} IS NULL)`,
    ),
  ],
);

/** The "masuk sekarang" wait queue (contract `facilityQueueEntrySchema`). */
export const facilityQueueEntries = pgTable(
  "facility_queue_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    areaId: uuid("area_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<FacilityQueueEntryStatus>()
      .notNull()
      .default("waiting"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    updatedAt,
  },
  (table) => [
    unique("facility_queue_entries_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "facility_queue_entries_area_fk",
      columns: [table.tenantId, table.facilityId, table.areaId],
      foreignColumns: [
        facilityAreas.tenantId,
        facilityAreas.facilityId,
        facilityAreas.id,
      ],
    }),
    foreignKey({
      name: "facility_queue_entries_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    // A guest holds one place per facility (ALREADY_QUEUED), race-safe.
    uniqueIndex("facility_queue_entries_active_key")
      .on(table.tenantId, table.facilityId, table.customerProfileId)
      .where(sql`${table.status} IN ('waiting', 'notified')`),
    index("facility_queue_entries_order_idx").on(
      table.tenantId,
      table.facilityId,
      table.areaId,
      table.status,
      table.joinedAt,
    ),
    check(
      "facility_queue_entries_status_check",
      sql`${table.status} IN ('waiting', 'notified', 'converted', 'expired')`,
    ),
    check(
      "facility_queue_entries_notified_check",
      sql`(${table.status} <> 'notified') OR ${table.notifiedAt} IS NOT NULL`,
    ),
  ],
);
