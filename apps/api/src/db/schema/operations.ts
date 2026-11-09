// Daily-operations storage (PRD v1.7 §3 F41/F45 "Operasional Harian", §6 L;
// WS-14; bead legend-ptd8 contract). Tables for checklist templates and runs,
// food-safety temperature logs, prep labels and prep lists, the equipment
// registry with service schedules and breakdown tickets, and shift handovers.
//
// - Every table is tenant owned and outlet owned; `operations.custom.sql`
//   installs tenant + outlet RLS (`app.enforce_tenant_rls` +
//   `app.enforce_outlet_rls`) on all of them (TEN-01..03).
// - Child rows repeat (tenant_id, outlet_id, parent_id) in a composite FK so a
//   child can never sit in another outlet than its parent.
// - Checklist runs snapshot their template items (`items`) and answers
//   (`results`) as JSONB: the contract makes a run immutable against later
//   template edits (owner decision, `snapshotChecklistTemplate`).
// - OPS-02 is enforced twice: the service gate (`assertTemperatureLogAllowed`)
//   and the `temperature_logs_corrective_action_check` CHECK, so an
//   out-of-range reading can never be stored without its corrective action.
// - `operations_idempotency` binds a client key to a request fingerprint and
//   the document it created (contract `idempotencyKey`; D-CORE-5).
//
// Shift templates, fixed assets and purchasing suppliers have no table on this
// branch yet (WS-10/WS-07/WS-06 beads own them), so ids for those stay plain
// UUIDs without a foreign key, exactly like the contract types.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import type {
  ChecklistItem,
  ChecklistItemResult,
  ChecklistRunStatus,
  ChecklistSchedule,
  ChecklistTemplateType,
  EquipmentCategory,
  EquipmentStatus,
  MaintenanceTicketStatus,
  MaintenanceUrgency,
  PrepListStatus,
  ShiftHandoverNotes,
  ShiftHandoverStatus,
  TemperatureThreshold,
} from "@starter/shared/operations";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems, stockBatches } from "./inventory.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// ---------------------------------------------------------- equipment

/** §6 L `equipment`: the asset registry with the OPS-04 menu mapping. */
export const equipment = pgTable(
  "equipment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    category: varchar("category", { length: 30 })
      .$type<EquipmentCategory>()
      .notNull(),
    /** Fixed-asset ledger row when the equipment is capitalized (WS-07). */
    assetId: uuid("asset_id"),
    /** OPS-04: a broken machine marks these menu items sold out. */
    linkedMenuItemIds: uuid("linked_menu_item_ids")
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: varchar("status", { length: 20 })
      .$type<EquipmentStatus>()
      .notNull()
      .default("operational"),
    temperatureThreshold: jsonb(
      "temperature_threshold",
    ).$type<TemperatureThreshold>(),
    /**
     * OPS-04 bookkeeping: the linked items THIS equipment disabled when it went
     * broken. A repair restores exactly these, so a manual 86 is never lifted
     * by a maintenance transition.
     */
    disabledItemIds: uuid("disabled_item_ids")
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("equipment_tenant_id_id_key").on(table.tenantId, table.id),
    unique("equipment_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "equipment_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("equipment_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.id,
    ),
    index("equipment_tenant_outlet_category_idx").on(
      table.tenantId,
      table.outletId,
      table.category,
      table.id,
    ),
    check(
      "equipment_category_check",
      sql`${table.category} IN ('espresso_machine', 'grinder', 'blender', 'oven', 'water_filter', 'air_conditioner', 'water_heater', 'chiller', 'freezer', 'other')`,
    ),
    check(
      "equipment_status_check",
      sql`${table.status} IN ('operational', 'under_maintenance', 'broken', 'retired')`,
    ),
    check(
      "equipment_linked_items_check",
      sql`array_length(${table.linkedMenuItemIds}, 1) IS NULL OR array_length(${table.linkedMenuItemIds}, 1) <= 100`,
    ),
  ],
);

// ------------------------------------------------------------ checklists

/** §6 L `checklist_templates`: the reusable checklist definition. */
export const opsChecklistTemplates = pgTable(
  "ops_checklist_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 })
      .$type<ChecklistTemplateType>()
      .notNull(),
    /** Snapshot of the template items; a run copies them (owner decision). */
    items: jsonb("items").$type<ChecklistItem[]>().notNull(),
    /** Per shift/station/zone schedule; `dueTime` is outlet-local HH:mm. */
    schedule: jsonb("schedule").$type<ChecklistSchedule>().notNull(),
    /** Role the runs are assigned to; a run names the employee. */
    roleId: uuid("role_id"),
    /** Bumped whenever `items` change. */
    version: integer("version").notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("ops_checklist_templates_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("ops_checklist_templates_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "ops_checklist_templates_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("ops_checklist_templates_tenant_outlet_type_idx").on(
      table.tenantId,
      table.outletId,
      table.type,
      table.id,
    ),
    check(
      "ops_checklist_templates_type_check",
      sql`${table.type} IN ('opening', 'closing', 'cleaning', 'shift')`,
    ),
    check("ops_checklist_templates_version_check", sql`${table.version} > 0`),
    check(
      "ops_checklist_templates_items_check",
      sql`jsonb_typeof(${table.items}) = 'array' AND jsonb_array_length(${table.items}) BETWEEN 1 AND 100`,
    ),
  ],
);

/** §6 L `checklist_runs`: one template snapshot for one business date. */
export const opsChecklistRuns = pgTable(
  "ops_checklist_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    templateId: uuid("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    /** Run-local snapshot of the template items (never the live template). */
    items: jsonb("items").$type<ChecklistItem[]>().notNull(),
    shiftDate: businessDate("shift_date").notNull(),
    shiftTemplateId: uuid("shift_template_id"),
    assignedTo: text("assigned_to")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: varchar("status", { length: 20 })
      .$type<ChecklistRunStatus>()
      .notNull()
      .default("pending"),
    results: jsonb("results")
      .$type<ChecklistItemResult[]>()
      .notNull()
      .default([]),
    /** OPS-01 server flag: set when the run is missed (sweep or manual). */
    missedAt: timestamp("missed_at", { withTimezone: true }),
    /** OPS-01 delivery evidence: when the supervisor alert was queued. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    /**
     * F45 (legend-5v69): true when the worker created the run from the
     * template schedule (per shift/role), false for a run created by hand.
     * Server-internal; not part of the contract run shape.
     */
    scheduled: boolean("scheduled").notNull().default(false),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("ops_checklist_runs_tenant_id_id_key").on(table.tenantId, table.id),
    // F45 (legend-5v69): the scheduler creates at most one run per template
    // and shift date, so a repeated or overlapping worker tick inserts
    // nothing twice. Manual runs stay unrestricted.
    uniqueIndex("ops_checklist_runs_scheduled_key")
      .on(table.tenantId, table.templateId, table.shiftDate)
      .where(sql`${table.scheduled}`),
    unique("ops_checklist_runs_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "ops_checklist_runs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "ops_checklist_runs_template_fk",
      columns: [table.tenantId, table.outletId, table.templateId],
      foreignColumns: [
        opsChecklistTemplates.tenantId,
        opsChecklistTemplates.outletId,
        opsChecklistTemplates.id,
      ],
    }),
    index("ops_checklist_runs_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.dueAt,
      table.id,
    ),
    index("ops_checklist_runs_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.shiftDate,
      table.id,
    ),
    index("ops_checklist_runs_tenant_assignee_idx").on(
      table.tenantId,
      table.assignedTo,
      table.status,
    ),
    check(
      "ops_checklist_runs_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'completed', 'missed', 'failed')`,
    ),
    check(
      "ops_checklist_runs_completed_check",
      sql`(${table.status} IN ('completed', 'failed')) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "ops_checklist_runs_missed_check",
      sql`(${table.status} = 'missed') = (${table.missedAt} IS NOT NULL)`,
    ),
    check(
      "ops_checklist_runs_items_check",
      sql`jsonb_typeof(${table.items}) = 'array' AND jsonb_array_length(${table.items}) BETWEEN 1 AND 100`,
    ),
    check(
      "ops_checklist_runs_results_check",
      sql`jsonb_typeof(${table.results}) = 'array'`,
    ),
  ],
);

// --------------------------------------------------------- food safety

/** §6 L `temperature_logs`: chiller/freezer readings with the OPS-02 gate. */
export const temperatureLogs = pgTable(
  "temperature_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    equipmentId: uuid("equipment_id").notNull(),
    readingCelsius: decimal4Column("reading_celsius").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    recordedBy: text("recorded_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    /** Derived once from the equipment threshold and stored (history keeps
     * the verdict even if the threshold changes later). */
    inRange: boolean("in_range").notNull(),
    /** OPS-02: mandatory exactly when `inRange` is false. */
    correctiveAction: varchar("corrective_action", { length: 1000 }),
    createdAt,
  },
  (table) => [
    unique("temperature_logs_tenant_id_id_key").on(table.tenantId, table.id),
    unique("temperature_logs_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "temperature_logs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "temperature_logs_equipment_fk",
      columns: [table.tenantId, table.outletId, table.equipmentId],
      foreignColumns: [equipment.tenantId, equipment.outletId, equipment.id],
    }),
    index("temperature_logs_tenant_outlet_recorded_idx").on(
      table.tenantId,
      table.outletId,
      table.recordedAt,
      table.id,
    ),
    index("temperature_logs_tenant_equipment_idx").on(
      table.tenantId,
      table.equipmentId,
      table.recordedAt,
    ),
    check(
      "temperature_logs_corrective_action_check",
      sql`(${table.inRange} AND ${table.correctiveAction} IS NULL) OR (NOT ${table.inRange} AND ${table.correctiveAction} IS NOT NULL)`,
    ),
  ],
);

// -------------------------------------------------------------- prep

/** §6 L `prep_labels`: production label linked to its inventory batch. */
export const prepLabels = pgTable(
  "prep_labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    producedAt: timestamp("produced_at", { withTimezone: true }).notNull(),
    useBy: timestamp("use_by", { withTimezone: true }).notNull(),
    producedBy: text("produced_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    /** OPS-03 expiry-alert bookkeeping: set once when the sweep raised it. */
    expiryAlertedAt: timestamp("expiry_alerted_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    unique("prep_labels_tenant_id_id_key").on(table.tenantId, table.id),
    unique("prep_labels_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "prep_labels_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "prep_labels_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "prep_labels_batch_fk",
      columns: [table.tenantId, table.outletId, table.batchId],
      foreignColumns: [
        stockBatches.tenantId,
        stockBatches.outletId,
        stockBatches.id,
      ],
    }),
    index("prep_labels_tenant_outlet_use_by_idx").on(
      table.tenantId,
      table.outletId,
      table.useBy,
      table.id,
    ),
    index("prep_labels_tenant_item_idx").on(
      table.tenantId,
      table.inventoryItemId,
      table.useBy,
    ),
    check(
      "prep_labels_use_by_check",
      sql`${table.useBy} > ${table.producedAt}`,
    ),
  ],
);

/** §6 L `prep_lists`: one prep plan per business date. */
export const prepLists = pgTable(
  "prep_lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    prepDate: businessDate("prep_date").notNull(),
    status: varchar("status", { length: 20 })
      .$type<PrepListStatus>()
      .notNull()
      .default("pending"),
    /** AI-07 forecast job the quantities came from (WS-12). */
    generatedFromForecastId: uuid("generated_from_forecast_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("prep_lists_tenant_id_id_key").on(table.tenantId, table.id),
    unique("prep_lists_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("prep_lists_tenant_outlet_date_key").on(
      table.tenantId,
      table.outletId,
      table.prepDate,
    ),
    foreignKey({
      name: "prep_lists_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("prep_lists_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.id,
    ),
    check(
      "prep_lists_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'completed')`,
    ),
  ],
);

/** One line of a prep list; `productionOrderId` links the produced batch
 * (WS-06 `production_orders`, wired by legend-sdet when it lands). */
export const prepListItems = pgTable(
  "prep_list_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    prepListId: uuid("prep_list_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    plannedQuantity: decimal4Column("planned_quantity").notNull(),
    productionOrderId: uuid("production_order_id"),
    createdAt,
  },
  (table) => [
    unique("prep_list_items_tenant_id_id_key").on(table.tenantId, table.id),
    unique("prep_list_items_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("prep_list_items_tenant_list_item_key").on(
      table.tenantId,
      table.prepListId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "prep_list_items_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "prep_list_items_list_fk",
      columns: [table.tenantId, table.outletId, table.prepListId],
      foreignColumns: [prepLists.tenantId, prepLists.outletId, prepLists.id],
    }),
    foreignKey({
      name: "prep_list_items_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("prep_list_items_tenant_list_idx").on(
      table.tenantId,
      table.prepListId,
      table.id,
    ),
    check("prep_list_items_quantity_check", sql`${table.plannedQuantity} > 0`),
  ],
);

/** §6 L `maintenance_schedules`: recurring service per equipment. */
export const maintenanceSchedules = pgTable(
  "maintenance_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    equipmentId: uuid("equipment_id").notNull(),
    intervalDays: integer("interval_days").notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    /** Service vendor; a purchasing supplier (legend-uy1e). */
    vendorId: uuid("vendor_id"),
    /** The `next_due_at` the last service reminder was queued for. The sweep
     * reminds once per due date: completing a service moves `next_due_at`,
     * which re-arms the reminder (OPS-04). */
    remindedForDueAt: timestamp("reminded_for_due_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("maintenance_schedules_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("maintenance_schedules_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "maintenance_schedules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "maintenance_schedules_equipment_fk",
      columns: [table.tenantId, table.outletId, table.equipmentId],
      foreignColumns: [equipment.tenantId, equipment.outletId, equipment.id],
    }),
    index("maintenance_schedules_tenant_outlet_due_idx").on(
      table.tenantId,
      table.outletId,
      table.nextDueAt,
      table.id,
    ),
    check(
      "maintenance_schedules_interval_check",
      sql`${table.intervalDays} BETWEEN 1 AND 3650`,
    ),
  ],
);

/** §6 L `maintenance_tickets`: breakdown reports (photo required). */
export const maintenanceTickets = pgTable(
  "maintenance_tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    equipmentId: uuid("equipment_id").notNull(),
    reportedBy: text("reported_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    urgency: varchar("urgency", { length: 20 })
      .$type<MaintenanceUrgency>()
      .notNull(),
    description: varchar("description", { length: 1000 }).notNull(),
    mediaIds: uuid("media_ids").array().$type<string[]>().notNull(),
    vendorId: uuid("vendor_id"),
    costIdr: idrColumn("cost_idr"),
    status: varchar("status", { length: 20 })
      .$type<MaintenanceTicketStatus>()
      .notNull()
      .default("reported"),
    /** OPS-04: true when this ticket marks the equipment broken. */
    marksEquipmentBroken: boolean("marks_equipment_broken")
      .notNull()
      .default(false),
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("maintenance_tickets_tenant_id_id_key").on(table.tenantId, table.id),
    unique("maintenance_tickets_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "maintenance_tickets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "maintenance_tickets_equipment_fk",
      columns: [table.tenantId, table.outletId, table.equipmentId],
      foreignColumns: [equipment.tenantId, equipment.outletId, equipment.id],
    }),
    index("maintenance_tickets_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.reportedAt,
      table.id,
    ),
    index("maintenance_tickets_tenant_equipment_idx").on(
      table.tenantId,
      table.equipmentId,
      table.status,
    ),
    check(
      "maintenance_tickets_urgency_check",
      sql`${table.urgency} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      "maintenance_tickets_status_check",
      sql`${table.status} IN ('reported', 'in_progress', 'resolved', 'cancelled')`,
    ),
    check(
      "maintenance_tickets_resolved_check",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "maintenance_tickets_media_check",
      sql`array_length(${table.mediaIds}, 1) BETWEEN 1 AND 10`,
    ),
    check(
      "maintenance_tickets_cost_check",
      sql`${table.costIdr} IS NULL OR ${table.costIdr} >= 0`,
    ),
  ],
);

// ------------------------------------------------------------ handover

/** §6 L `shift_handovers`: submitted by one shift, acknowledged by the next. */
export const shiftHandovers = pgTable(
  "shift_handovers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    fromShiftTemplateId: uuid("from_shift_template_id").notNull(),
    toShiftTemplateId: uuid("to_shift_template_id").notNull(),
    notes: jsonb("notes").$type<ShiftHandoverNotes>().notNull(),
    submittedBy: text("submitted_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedBy: text("acknowledged_by")
      .$type<UserId>()
      .references(() => user.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    status: varchar("status", { length: 20 })
      .$type<ShiftHandoverStatus>()
      .notNull()
      .default("submitted"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("shift_handovers_tenant_id_id_key").on(table.tenantId, table.id),
    unique("shift_handovers_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "shift_handovers_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("shift_handovers_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.submittedAt,
      table.id,
    ),
    check(
      "shift_handovers_status_check",
      sql`${table.status} IN ('submitted', 'acknowledged')`,
    ),
    check(
      "shift_handovers_acknowledged_check",
      sql`(${table.status} = 'acknowledged') = (${table.acknowledgedBy} IS NOT NULL AND ${table.acknowledgedAt} IS NOT NULL)`,
    ),
    check(
      "shift_handovers_self_acknowledgement_check",
      sql`${table.acknowledgedBy} IS NULL OR ${table.acknowledgedBy} <> ${table.submittedBy}`,
    ),
  ],
);

// --------------------------------------------------------- idempotency

/**
 * `operations_idempotency` (T, E): a client key bound to a request
 * fingerprint and the document it created. A replay with the same fingerprint
 * returns the recorded document; a reused key with a different payload is
 * `IDEMPOTENCY_KEY_REUSED` (docs/plan/contracts.md D-CORE-5).
 */
export const operationsIdempotency = pgTable(
  "operations_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    resultTable: varchar("result_table", { length: 40 }).notNull(),
    resultId: uuid("result_id").notNull(),
    createdAt,
  },
  (table) => [
    unique("operations_idempotency_tenant_key_key").on(
      table.tenantId,
      table.key,
    ),
    foreignKey({
      name: "operations_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "operations_idempotency_key_check",
      sql`length(${table.key}) BETWEEN 1 AND 100`,
    ),
  ],
);
