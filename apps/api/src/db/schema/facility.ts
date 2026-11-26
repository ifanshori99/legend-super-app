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
// - `facility_products`, `facility_addons`, `entitlement_rules`,
//   `facility_subscription_plans`, `wifi_policies` and `facility_incidents`
//   are the configuration and incident-log tables of bead legend-8dpm (PRD
//   v1.7 §3 F22/F25 "Produk & Hak Akses", "Add-on Opsional", "Langganan
//   Bulanan", "Keselamatan", §3 F39 "Wi-Fi Berbasis Belanja"). They are all
//   outlet owned and repeat (tenant_id, outlet_id, facility_id) so a config
//   row can never point at a facility of another outlet; `wifi_policies` is
//   scoped to a floor zone and only one policy may exist per zone.
//
// Entitlement ledger, credentials (QR/PIN digests) and subscription rows are
// separate beads (legend-fjk5, legend-bzih, legend-gr3j); table/aggregate
// references without a definition here (`menu_item_id`, `tax_rule_id`,
// `zone_id`, `product_id`, `entitlement_ledger_id`) carry no FK. Tenant RLS
// and outlet RLS are installed in facility.custom.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
  AccessTicketStatus,
  BreakfastDelivery,
  BreakfastOrderStatus,
  CancellationPolicy,
  EntitlementRule,
  EntitlementSource,
  EntitlementValidity,
  FacilityDayHours,
  FacilityIncidentType,
  FacilityProductType,
  FacilityQueueEntryStatus,
  FacilityType,
  FacilityUnitStatus,
  OvertimePolicy,
  PeakWindow,
  SubscriptionInterval,
  TicketAddon,
} from "@starter/shared/facility";
import type { WfcAccess, WfcProductKind } from "@starter/shared/wfc";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { inventoryItems } from "./inventory.ts";
import { outlets, tenants } from "./platform-org.ts";
import { orders } from "./qr-order.ts";
import { user } from "./user.ts";

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

/**
 * Operating hours of a facility with an effective date (legend-4us1a). The
 * hours of a business date are the version with the latest `effective_from`
 * at or before that date, so a change never rewrites a past day or a booking
 * already confirmed. `facilities.operating_hours` stays the hours valid today
 * (the latest version whose `effective_from` is not in the future); the
 * migration seeds one version per facility at 1970-01-01 so a tenant with no
 * change behaves as before.
 */
export const facilityOperatingHoursVersions = pgTable(
  "facility_operating_hours_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    /** Business date (outlet calendar) from which these hours apply. */
    effectiveFrom: date("effective_from").notNull(),
    operatingHours: jsonb("operating_hours")
      .$type<FacilityDayHours[]>()
      .notNull(),
    createdAt,
  },
  (table) => [
    unique("facility_operating_hours_versions_key").on(
      table.tenantId,
      table.facilityId,
      table.effectiveFrom,
    ),
    foreignKey({
      name: "facility_operating_hours_versions_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("facility_operating_hours_versions_lookup_idx").on(
      table.tenantId,
      table.facilityId,
      table.effectiveFrom,
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
    /**
     * Retirement (legend-etawy): set = the unit is no longer offered for new
     * slots or tickets; the row and its ticket history stay. NULL = active.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt,
    /** Configuration stamp only; a status transition does not move it. */
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

// ---- Configuration: products, add-ons, rules, plans, Wi-Fi policies --------

/**
 * One sellable access product (PRD §3 F25 "Produk & Hak Akses"; contract
 * `facilityProductSchema`). `type` is the acquisition route the product
 * belongs to and `sessions` how many sessions one purchase grants (1 for a
 * single ticket, 10/20 for a plan). `is_active` stops new sales without
 * deleting a product that issued tickets still reference.
 */
export const facilityProducts = pgTable(
  "facility_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 })
      .$type<FacilityProductType>()
      .notNull(),
    priceIdr: idrColumn("price_idr").notNull(),
    /** Tax rule applied to the sale (WS-05); no FK until that table lands. */
    taxRuleId: uuid("tax_rule_id"),
    sessions: integer("sessions").notNull(),
    /** Sessions per business day; null = unlimited. */
    maxPerDay: integer("max_per_day"),
    /** Menu package that carries this component (WS-03). */
    menuItemId: uuid("menu_item_id"),
    /**
     * Paid WFC product (brief 1270 W1): only a `single` product of a coworking
     * facility may carry a kind (the service enforces the facility type); null
     * = ordinary product. `facility_products_wfc_check` ties the columns
     * together: price = seat fee + credit, and no menu item, so no till, package
     * or ticket door can sell it.
     */
    wfcKind: varchar("wfc_kind", { length: 20 }).$type<WfcProductKind>(),
    wfcAccess: varchar("wfc_access", { length: 10 }).$type<WfcAccess>(),
    seatFeeIdr: idrColumn("seat_fee_idr"),
    creditIdr: idrColumn("credit_idr"),
    /** Slot length of a seat reservation in minutes (1..1440), else null. */
    durationMinutes: smallint("duration_minutes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_products_tenant_id_id_key").on(table.tenantId, table.id),
    unique("facility_products_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "facility_products_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("facility_products_facility_idx").on(
      table.tenantId,
      table.facilityId,
      table.type,
    ),
    check(
      "facility_products_type_check",
      sql`${table.type} IN ('single', 'package_component', 'subscription_plan')`,
    ),
    // IS NOT NULL is spelled out: a NULL comparison would pass a CHECK.
    check(
      "facility_products_wfc_check",
      sql`(${table.wfcKind} IS NULL AND ${table.wfcAccess} IS NULL AND ${table.seatFeeIdr} IS NULL AND ${table.creditIdr} IS NULL AND ${table.durationMinutes} IS NULL) OR (${table.wfcKind} IS NOT NULL AND ${table.wfcKind} IN ('day_pass', 'seat_reservation') AND ${table.wfcAccess} IS NOT NULL AND ${table.wfcAccess} IN ('off_peak', 'all_day') AND ${table.type} = 'single' AND ${table.menuItemId} IS NULL AND ${table.sessions} = 1 AND ${table.maxPerDay} IS NULL AND ${table.seatFeeIdr} IS NOT NULL AND ${table.seatFeeIdr} > 0 AND ${table.creditIdr} IS NOT NULL AND ${table.creditIdr} > 0 AND ${table.priceIdr} = ${table.seatFeeIdr} + ${table.creditIdr} AND (${table.wfcKind} = 'seat_reservation') = (${table.durationMinutes} IS NOT NULL) AND (${table.durationMinutes} IS NULL OR ${table.durationMinutes} BETWEEN 1 AND 1440))`,
    ),
    check(
      "facility_products_amount_check",
      sql`${table.priceIdr} >= 0 AND ${table.sessions} BETWEEN 1 AND 100 AND (${table.maxPerDay} IS NULL OR ${table.maxPerDay} BETWEEN 1 AND 10)`,
    ),
  ],
);

/** Optional add-on (towel, amenities kit, locker, hair dryer) per facility. */
export const facilityAddons = pgTable(
  "facility_addons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    priceIdr: idrColumn("price_idr").notNull(),
    /** Inventory item the add-on consumes (WS-06), else null. */
    inventoryItemId: uuid("inventory_item_id"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_addons_tenant_id_id_key").on(table.tenantId, table.id),
    unique("facility_addons_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "facility_addons_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    foreignKey({
      name: "facility_addons_inventory_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("facility_addons_facility_idx").on(
      table.tenantId,
      table.facilityId,
      table.sortOrder,
    ),
    check(
      "facility_addons_amount_check",
      sql`${table.priceIdr} >= 0 AND ${table.sortOrder} >= 0`,
    ),
  ],
);

/**
 * A rule under which a condition issues access rights (PRD §3 F25 "Produk &
 * Hak Akses"). The condition shape is fixed per `type`, so the jsonb column
 * is typed as the contract's discriminated condition union and a min-spend
 * rule can never lose its threshold.
 */
export const entitlementRules = pgTable(
  "entitlement_rules",
  {
    /** The client sends the id on PUT (upsert key). */
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    type: varchar("type", { length: 20 })
      .$type<EntitlementRule["type"]>()
      .notNull(),
    condition: jsonb("condition")
      .$type<EntitlementRule["condition"]>()
      .notNull(),
    sessions: integer("sessions").notNull(),
    validity: jsonb("validity").$type<EntitlementValidity>().notNull(),
    isEnabled: boolean("is_enabled").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("entitlement_rules_tenant_id_id_key").on(table.tenantId, table.id),
    unique("entitlement_rules_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "entitlement_rules_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("entitlement_rules_facility_idx").on(
      table.tenantId,
      table.facilityId,
      table.type,
    ),
    check(
      "entitlement_rules_type_check",
      sql`${table.type} IN ('min_spend', 'tier_benefit', 'package')`,
    ),
    check(
      "entitlement_rules_sessions_check",
      sql`${table.sessions} BETWEEN 1 AND 100`,
    ),
  ],
);

/** A monthly/yearly access plan (PRD §3 F25 "Langganan Bulanan"). */
export const facilitySubscriptionPlans = pgTable(
  "facility_subscription_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    priceIdr: idrColumn("price_idr").notNull(),
    /** Sessions included per billing period, e.g. 10 or 20. */
    quotaPerPeriod: integer("quota_per_period").notNull(),
    interval: varchar("interval", { length: 10 })
      .$type<SubscriptionInterval>()
      .notNull(),
    /** Optional per-day cap; null = no daily limit. */
    maxPerDay: integer("max_per_day"),
    /** Plan id in the recurring-billing provider (DOIT). */
    providerPlanId: varchar("provider_plan_id", { length: 100 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_subscription_plans_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("facility_subscription_plans_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "facility_subscription_plans_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("facility_subscription_plans_facility_idx").on(
      table.tenantId,
      table.facilityId,
      table.isActive,
    ),
    check(
      "facility_subscription_plans_interval_check",
      sql`${table.interval} IN ('month', 'year')`,
    ),
    check(
      "facility_subscription_plans_amount_check",
      sql`${table.priceIdr} >= 0 AND ${table.quotaPerPeriod} BETWEEN 1 AND 100 AND (${table.maxPerDay} IS NULL OR ${table.maxPerDay} BETWEEN 1 AND 10)`,
    ),
  ],
);

/**
 * Guest Wi-Fi quota policy of one floor zone (PRD §3 F39 "Wi-Fi Berbasis
 * Belanja", FAC-12/FAC-13/FAC-14). Every number is a row, so the admin panel
 * changes the rules without a redeploy; one policy per zone. The zone lives
 * in WS-03's `floor_zones` (no FK: another workstream owns it) and
 * `facility_id` is null for a zone policy that is not facility specific.
 */
export const wifiPolicies = pgTable(
  "wifi_policies",
  {
    /** The client sends the id on PUT (upsert key). */
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    zoneId: uuid("zone_id").notNull(),
    facilityId: uuid("facility_id"),
    freeMinutes: integer("free_minutes").notNull(),
    peakFreeMinutes: integer("peak_free_minutes").notNull(),
    spendPerExtraHourIdr: idrColumn("spend_per_extra_hour_idr").notNull(),
    extraMinutes: integer("extra_minutes").notNull(),
    maxDevices: integer("max_devices").notNull(),
    peakSchedule: jsonb("peak_schedule").$type<PeakWindow[]>().notNull(),
    baseSpeedKbps: integer("base_speed_kbps").notNull(),
    fullSpeedKbps: integer("full_speed_kbps").notNull(),
    minSpendPerHourIdr: idrColumn("min_spend_per_hour_idr"),
    tierBonusMinutes: jsonb("tier_bonus_minutes")
      .$type<Record<string, number>>()
      .notNull(),
    // legend-kmd3: how spend turns into extra hours. Null reads as the CTO
    // default `per_day_multiple` (whole-day net spend / step); `per_order`
    // floors each order on its own.
    spendMode: varchar("spend_mode", { length: 20 }).$type<
      "per_day_multiple" | "per_order"
    >(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("wifi_policies_tenant_id_id_key").on(table.tenantId, table.id),
    // One policy per zone: the PUT on a zone replaces the row, never adds one.
    unique("wifi_policies_tenant_outlet_zone_key").on(
      table.tenantId,
      table.outletId,
      table.zoneId,
    ),
    foreignKey({
      name: "wifi_policies_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    index("wifi_policies_zone_idx").on(table.tenantId, table.zoneId, table.id),
    check(
      "wifi_policies_spend_mode_check",
      sql`${table.spendMode} IS NULL OR ${table.spendMode} IN ('per_day_multiple','per_order')`,
    ),
    check(
      "wifi_policies_amount_check",
      sql`${table.freeMinutes} >= 0 AND ${table.peakFreeMinutes} >= 0 AND ${table.spendPerExtraHourIdr} >= 0 AND ${table.extraMinutes} BETWEEN 1 AND 1440 AND ${table.maxDevices} BETWEEN 1 AND 20 AND ${table.baseSpeedKbps} >= 1 AND ${table.fullSpeedKbps} >= 1 AND (${table.minSpendPerHourIdr} IS NULL OR ${table.minSpendPerHourIdr} >= 0)`,
    ),
  ],
);

/**
 * Emergency / assistance / damage report of a facility (PRD §3 F25
 * "Keselamatan", FAC-08; contract `facilityIncidentSchema`). Raised by the
 * panic button or staff, possibly offline, and answered with a resolution;
 * `responded_by` is the Better Auth account id.
 */
export const facilityIncidents = pgTable(
  "facility_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    unitId: uuid("unit_id"),
    accessTicketId: ulidInUuid("access_ticket_id"),
    type: varchar("type", { length: 20 })
      .$type<FacilityIncidentType>()
      .notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    /** Raised on the edge while the outlet had no internet (FAC-08). */
    offline: boolean("offline").notNull().default(false),
    respondedBy: text("responded_by").references(() => user.id),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    resolution: varchar("resolution", { length: 500 }),
    createdAt,
  },
  (table) => [
    unique("facility_incidents_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "facility_incidents_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    // The incident log reads newest first per facility (cursor keys).
    index("facility_incidents_log_idx").on(
      table.tenantId,
      table.outletId,
      table.facilityId,
      table.triggeredAt,
      table.id,
    ),
    check(
      "facility_incidents_type_check",
      sql`${table.type} IN ('panic', 'assist', 'damage')`,
    ),
  ],
);

/**
 * Breakfast order tied to an access ticket (bead oa0qk; owner Q43: a ticket's
 * breakfast MUST be paid before it reaches the kitchen / KDS). The order
 * itself is an `orders` row of channel `facility` (pay_first); this row holds
 * the money state machine awaiting_payment -> paid -> fired | cancelled.
 *
 * - `paid` / `fired` require a verified payment: paid_at, paid_intent_id and
 *   paid_idr = total_idr (CHECK below). The same fact is enforced for the
 *   kitchen by the `kitchen_tickets` BEFORE INSERT trigger
 *   (kds.custom.sql, constraint `kitchen_tickets_breakfast_paid`), so no
 *   path (retry, edge sync, captain, resend, worker) can queue an unpaid one.
 * - `refunded_idr` never exceeds `paid_idr` (cancel after pay refunds at most
 *   what was paid).
 * - One live (not cancelled) breakfast order per ticket; a cancelled one may
 *   be replaced. Create is idempotent per (ticket, idempotency_key).
 */
export const facilityLinkedOrders = pgTable(
  "facility_linked_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    accessTicketId: ulidInUuid("access_ticket_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<BreakfastOrderStatus>()
      .notNull(),
    delivery: jsonb("delivery").$type<BreakfastDelivery>().notNull(),
    subtotalIdr: idrColumn("subtotal_idr").notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    paidIdr: idrColumn("paid_idr")
      .notNull()
      .default(sql`0`),
    /** The verified WS-05 payment intent that settled this order. */
    paidIntentId: uuid("paid_intent_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Minutes before the ticket's ends_at the kitchen is fed (default 15). */
    fireOffsetMinutes: integer("fire_offset_minutes").notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    refundedIdr: idrColumn("refunded_idr")
      .notNull()
      .default(sql`0`),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_linked_orders_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "facility_linked_orders_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    foreignKey({
      name: "facility_linked_orders_ticket_fk",
      columns: [table.tenantId, table.accessTicketId],
      foreignColumns: [accessTickets.tenantId, accessTickets.id],
    }),
    foreignKey({
      name: "facility_linked_orders_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    unique("facility_linked_orders_order_key").on(
      table.tenantId,
      table.orderId,
    ),
    // One live breakfast order per ticket; a cancelled one is replaceable.
    uniqueIndex("facility_linked_orders_ticket_live_key")
      .on(table.tenantId, table.accessTicketId)
      .where(sql`${table.status} <> 'cancelled'`),
    unique("facility_linked_orders_idempotency_key").on(
      table.tenantId,
      table.accessTicketId,
      table.idempotencyKey,
    ),
    // The fire sweep reads paid orders that are due.
    index("facility_linked_orders_fire_due_idx")
      .on(table.tenantId, table.fireAt)
      .where(sql`${table.status} = 'paid'`),
    check(
      "facility_linked_orders_status_check",
      sql`${table.status} IN ('awaiting_payment', 'paid', 'fired', 'cancelled')`,
    ),
    check(
      "facility_linked_orders_amounts_check",
      sql`${table.subtotalIdr} >= 0 AND ${table.totalIdr} >= 0 AND ${table.paidIdr} >= 0 AND ${table.refundedIdr} >= 0`,
    ),
    check(
      "facility_linked_orders_fire_offset_check",
      sql`${table.fireOffsetMinutes} BETWEEN 0 AND 240`,
    ),
    // Paid / fired means a verified payment for exactly the total.
    check(
      "facility_linked_orders_paid_check",
      sql`${table.status} NOT IN ('paid', 'fired') OR (${table.paidAt} IS NOT NULL AND ${table.paidIntentId} IS NOT NULL AND ${table.paidIdr} = ${table.totalIdr})`,
    ),
    check(
      "facility_linked_orders_fired_check",
      sql`${table.status} <> 'fired' OR ${table.firedAt} IS NOT NULL`,
    ),
    check(
      "facility_linked_orders_cancelled_check",
      sql`${table.status} <> 'cancelled' OR ${table.cancelledAt} IS NOT NULL`,
    ),
    check(
      "facility_linked_orders_refund_check",
      sql`${table.refundedIdr} <= ${table.paidIdr}`,
    ),
  ],
);
