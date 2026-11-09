// HRIS employee lifecycle and KPI (PRD v1.7 F24 onboarding/offboarding, F29
// KPI; §6 H `onboarding_tasks` / `offboarding_tasks`, `kpi_definitions` /
// `kpi_reviews`; bead legend-ovxw). Decisions: docs/DECISIONS.md
// "2026-11-10: WS-10 lifecycle".
//
// - One task table for both checklists (`kind`), so the contract's single
//   `checklistTaskSchema` maps 1:1. Offboarding tasks belong to one
//   offboarding (`offboarding_id`), so a rehire gets a fresh checklist.
// - `hris_checklist_task_actions` is the append-only trail of every
//   complete/block/unblock/waive (UPDATE/DELETE revoked in the custom SQL).
// - `hris_offboardings` carries the exit-clearance result and the frozen
//   settlement summary; one live (non-cancelled) row per employee.
// - KPI scores snapshot their definition, so editing a definition never
//   rewrites a submitted review.
// - No table has a NOT NULL outlet_id: tenant RLS only, outlet reach is
//   checked in the services through the employee's home outlet.
// - Composite (tenant_id, id) foreign keys keep every reference in one tenant.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";
import { employeeDocuments, employees, positions } from "./hris.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

type ChecklistKind = "onboarding" | "offboarding";
type ChecklistTaskStatus = "open" | "done" | "blocked" | "waived";
type ChecklistAction = "complete" | "block" | "unblock" | "waive";

/** Template item as stored; validated by `checklistTemplateItemSchema`. */
export type StoredChecklistTemplateItem = {
  code: string;
  title: string;
  category: string;
  requiresDocument: boolean;
  sortOrder: number;
};

// ------------------------------------------------------ checklist templates

export const hrisChecklistTemplates = pgTable(
  "hris_checklist_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 12 }).$type<ChecklistKind>().notNull(),
    positionId: uuid("position_id"),
    title: varchar("title", { length: 150 }).notNull(),
    items: jsonb("items").$type<StoredChecklistTemplateItem[]>().notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("hris_checklist_templates_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("hris_checklist_templates_active_position_key")
      .on(table.tenantId, table.kind, table.positionId)
      .where(sql`${table.isActive} AND ${table.positionId} IS NOT NULL`),
    uniqueIndex("hris_checklist_templates_active_default_key")
      .on(table.tenantId, table.kind)
      .where(sql`${table.isActive} AND ${table.positionId} IS NULL`),
    foreignKey({
      name: "hris_checklist_templates_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }),
    check(
      "hris_checklist_templates_kind_check",
      sql`${table.kind} IN ('onboarding', 'offboarding')`,
    ),
    check(
      "hris_checklist_templates_items_array_check",
      sql`jsonb_typeof(${table.items}) = 'array' AND jsonb_array_length(${table.items}) > 0`,
    ),
  ],
);

// ------------------------------------------------------------ offboardings

export type OffboardingExitType =
  "resignation" | "termination" | "contract_end";
export type OffboardingStatus = "open" | "revoked" | "completed" | "cancelled";

export const hrisOffboardings = pgTable(
  "hris_offboardings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    exitType: varchar("exit_type", { length: 20 })
      .$type<OffboardingExitType>()
      .notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    noticeDate: businessDate("notice_date"),
    lastWorkingDate: businessDate("last_working_date").notNull(),
    status: varchar("status", { length: 12 })
      .$type<OffboardingStatus>()
      .notNull()
      .default("open"),
    accessRevokedAt: timestamp("access_revoked_at", { withTimezone: true }),
    accessRevokedBy: text("access_revoked_by").$type<UserId>(),
    revocationResult:
      jsonb("revocation_result").$type<Record<string, unknown>>(),
    settlementSnapshot: jsonb("settlement_snapshot").$type<
      Record<string, unknown>
    >(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: text("completed_by").$type<UserId>(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").$type<UserId>(),
    cancelReason: varchar("cancel_reason", { length: 500 }),
    certificateNo: varchar("certificate_no", { length: 40 }),
    certificateIssuedAt: timestamp("certificate_issued_at", {
      withTimezone: true,
    }),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("hris_offboardings_tenant_id_key").on(table.tenantId, table.id),
    uniqueIndex("hris_offboardings_live_employee_key")
      .on(table.tenantId, table.employeeId)
      .where(sql`${table.status} <> 'cancelled'`),
    uniqueIndex("hris_offboardings_certificate_no_key")
      .on(table.tenantId, table.certificateNo)
      .where(sql`${table.certificateNo} IS NOT NULL`),
    foreignKey({
      name: "hris_offboardings_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "hris_offboardings_exit_type_check",
      sql`${table.exitType} IN ('resignation', 'termination', 'contract_end')`,
    ),
    check(
      "hris_offboardings_status_check",
      sql`${table.status} IN ('open', 'revoked', 'completed', 'cancelled')`,
    ),
    check(
      "hris_offboardings_revoked_check",
      sql`${table.status} NOT IN ('revoked', 'completed') OR (${table.accessRevokedAt} IS NOT NULL AND ${table.accessRevokedBy} IS NOT NULL AND ${table.revocationResult} IS NOT NULL)`,
    ),
    check(
      "hris_offboardings_completed_check",
      sql`${table.status} <> 'completed' OR (${table.completedAt} IS NOT NULL AND ${table.completedBy} IS NOT NULL AND ${table.settlementSnapshot} IS NOT NULL)`,
    ),
    check(
      "hris_offboardings_cancelled_check",
      sql`${table.status} <> 'cancelled' OR (${table.accessRevokedAt} IS NULL AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelReason} IS NOT NULL)`,
    ),
    check(
      "hris_offboardings_notice_check",
      sql`${table.noticeDate} IS NULL OR ${table.noticeDate} <= ${table.lastWorkingDate}`,
    ),
  ],
);

// ---------------------------------------------------------- checklist tasks

export const hrisChecklistTasks = pgTable(
  "hris_checklist_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    offboardingId: uuid("offboarding_id"),
    templateId: uuid("template_id"),
    kind: varchar("kind", { length: 12 }).$type<ChecklistKind>().notNull(),
    code: varchar("code", { length: 40 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    category: varchar("category", { length: 20 }).notNull(),
    requiresDocument: boolean("requires_document").notNull().default(false),
    documentId: uuid("document_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: varchar("status", { length: 10 })
      .$type<ChecklistTaskStatus>()
      .notNull()
      .default("open"),
    systemManaged: boolean("system_managed").notNull().default(false),
    dueAt: timestamp("due_at", { withTimezone: true }),
    doneBy: text("done_by").$type<UserId>(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    blockReason: varchar("block_reason", { length: 500 }),
    waiveReason: varchar("waive_reason", { length: 500 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("hris_checklist_tasks_tenant_id_key").on(table.tenantId, table.id),
    uniqueIndex("hris_checklist_tasks_onboarding_code_key")
      .on(table.tenantId, table.employeeId, table.code)
      .where(sql`${table.kind} = 'onboarding'`),
    uniqueIndex("hris_checklist_tasks_offboarding_code_key")
      .on(table.tenantId, table.offboardingId, table.code)
      .where(sql`${table.offboardingId} IS NOT NULL`),
    index("hris_checklist_tasks_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.kind,
    ),
    foreignKey({
      name: "hris_checklist_tasks_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "hris_checklist_tasks_offboarding_fk",
      columns: [table.tenantId, table.offboardingId],
      foreignColumns: [hrisOffboardings.tenantId, hrisOffboardings.id],
    }),
    foreignKey({
      name: "hris_checklist_tasks_template_fk",
      columns: [table.tenantId, table.templateId],
      foreignColumns: [
        hrisChecklistTemplates.tenantId,
        hrisChecklistTemplates.id,
      ],
    }),
    foreignKey({
      name: "hris_checklist_tasks_document_fk",
      columns: [table.tenantId, table.documentId],
      foreignColumns: [employeeDocuments.tenantId, employeeDocuments.id],
    }),
    check(
      "hris_checklist_tasks_kind_check",
      sql`${table.kind} IN ('onboarding', 'offboarding')`,
    ),
    check(
      "hris_checklist_tasks_category_check",
      sql`${table.category} IN ('documents', 'uniform', 'account', 'training', 'asset', 'access_revocation', 'final_settlement', 'work_certificate', 'other')`,
    ),
    check(
      "hris_checklist_tasks_status_check",
      sql`${table.status} IN ('open', 'done', 'blocked', 'waived')`,
    ),
    check(
      "hris_checklist_tasks_done_pair_check",
      sql`(${table.doneBy} IS NULL) = (${table.doneAt} IS NULL)`,
    ),
    check(
      "hris_checklist_tasks_done_check",
      sql`(${table.status} = 'done') = (${table.doneAt} IS NOT NULL)`,
    ),
    check(
      "hris_checklist_tasks_blocked_check",
      sql`${table.status} <> 'blocked' OR ${table.blockReason} IS NOT NULL`,
    ),
    check(
      "hris_checklist_tasks_waived_check",
      sql`${table.status} <> 'waived' OR ${table.waiveReason} IS NOT NULL`,
    ),
    check(
      "hris_checklist_tasks_offboarding_link_check",
      sql`(${table.kind} = 'offboarding') = (${table.offboardingId} IS NOT NULL)`,
    ),
  ],
);

/** Append-only trail of every task action (who, when, why). */
export const hrisChecklistTaskActions = pgTable(
  "hris_checklist_task_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    taskId: uuid("task_id").notNull(),
    action: varchar("action", { length: 10 })
      .$type<ChecklistAction>()
      .notNull(),
    fromStatus: varchar("from_status", { length: 10 })
      .$type<ChecklistTaskStatus>()
      .notNull(),
    toStatus: varchar("to_status", { length: 10 })
      .$type<ChecklistTaskStatus>()
      .notNull(),
    reason: varchar("reason", { length: 500 }),
    documentId: uuid("document_id"),
    actorUserId: text("actor_user_id").$type<UserId>().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }),
    createdAt,
  },
  (table) => [
    unique("hris_checklist_task_actions_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("hris_checklist_task_actions_idempotency_key").on(
      table.tenantId,
      table.taskId,
      table.idempotencyKey,
    ),
    index("hris_checklist_task_actions_task_idx").on(
      table.tenantId,
      table.taskId,
      table.createdAt,
    ),
    foreignKey({
      name: "hris_checklist_task_actions_task_fk",
      columns: [table.tenantId, table.taskId],
      foreignColumns: [hrisChecklistTasks.tenantId, hrisChecklistTasks.id],
    }),
    foreignKey({
      name: "hris_checklist_task_actions_document_fk",
      columns: [table.tenantId, table.documentId],
      foreignColumns: [employeeDocuments.tenantId, employeeDocuments.id],
    }),
    check(
      "hris_checklist_task_actions_action_check",
      sql`${table.action} IN ('complete', 'block', 'unblock', 'waive')`,
    ),
    check(
      "hris_checklist_task_actions_reason_check",
      sql`${table.action} NOT IN ('block', 'waive') OR ${table.reason} IS NOT NULL`,
    ),
  ],
);

// --------------------------------------------------------------------- KPI

type KpiSource = "system" | "manager";
type KpiDirection = "higher_is_better" | "lower_is_better";

export const hrisKpiDefinitions = pgTable(
  "hris_kpi_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    positionId: uuid("position_id"),
    name: varchar("name", { length: 150 }).notNull(),
    source: varchar("source", { length: 10 }).$type<KpiSource>().notNull(),
    metricCode: varchar("metric_code", { length: 60 }),
    target: numeric("target", { precision: 18, scale: 4 }),
    unit: varchar("unit", { length: 20 }).notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<KpiDirection>()
      .notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("hris_kpi_definitions_tenant_id_key").on(table.tenantId, table.id),
    uniqueIndex("hris_kpi_definitions_active_position_name_key")
      .on(table.tenantId, table.positionId, table.name)
      .where(sql`${table.isActive} AND ${table.positionId} IS NOT NULL`),
    uniqueIndex("hris_kpi_definitions_active_default_name_key")
      .on(table.tenantId, table.name)
      .where(sql`${table.isActive} AND ${table.positionId} IS NULL`),
    foreignKey({
      name: "hris_kpi_definitions_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }),
    check(
      "hris_kpi_definitions_source_check",
      sql`${table.source} IN ('system', 'manager')`,
    ),
    check(
      "hris_kpi_definitions_metric_code_check",
      sql`(${table.source} = 'system') = (${table.metricCode} IS NOT NULL)`,
    ),
    check(
      "hris_kpi_definitions_target_check",
      sql`${table.target} IS NULL OR ${table.target} >= 0`,
    ),
    check(
      "hris_kpi_definitions_direction_check",
      sql`${table.direction} IN ('higher_is_better', 'lower_is_better')`,
    ),
  ],
);

export const hrisKpiReviews = pgTable(
  "hris_kpi_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    cycle: varchar("cycle", { length: 10 })
      .$type<"monthly" | "quarterly">()
      .notNull(),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    status: varchar("status", { length: 10 })
      .$type<"draft" | "submitted">()
      .notNull()
      .default("draft"),
    reviewerUserId: text("reviewer_user_id").$type<UserId>(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    overallScore: numeric("overall_score", { precision: 5, scale: 2 }),
    note: varchar("note", { length: 2000 }),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("hris_kpi_reviews_tenant_id_key").on(table.tenantId, table.id),
    unique("hris_kpi_reviews_employee_period_key").on(
      table.tenantId,
      table.employeeId,
      table.cycle,
      table.periodStart,
    ),
    foreignKey({
      name: "hris_kpi_reviews_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "hris_kpi_reviews_cycle_check",
      sql`${table.cycle} IN ('monthly', 'quarterly')`,
    ),
    check(
      "hris_kpi_reviews_status_check",
      sql`${table.status} IN ('draft', 'submitted')`,
    ),
    check(
      "hris_kpi_reviews_period_check",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
    check(
      "hris_kpi_reviews_submitted_check",
      sql`(${table.status} = 'submitted') = (${table.submittedAt} IS NOT NULL AND ${table.reviewerUserId} IS NOT NULL)`,
    ),
  ],
);

export const hrisKpiScores = pgTable(
  "hris_kpi_scores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    reviewId: uuid("review_id").notNull(),
    kpiDefinitionId: uuid("kpi_definition_id").notNull(),
    definitionSnapshot: jsonb("definition_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    systemActual: numeric("system_actual", { precision: 18, scale: 4 }),
    systemAvailability: varchar("system_availability", { length: 30 }),
    systemComputedAt: timestamp("system_computed_at", { withTimezone: true }),
    actual: numeric("actual", { precision: 18, scale: 4 }),
    actualSource: varchar("actual_source", { length: 10 }).$type<
      "system" | "manual"
    >(),
    score: smallint("score"),
    comment: varchar("comment", { length: 1000 }),
  },
  (table) => [
    unique("hris_kpi_scores_tenant_id_key").on(table.tenantId, table.id),
    unique("hris_kpi_scores_review_definition_key").on(
      table.tenantId,
      table.reviewId,
      table.kpiDefinitionId,
    ),
    foreignKey({
      name: "hris_kpi_scores_review_fk",
      columns: [table.tenantId, table.reviewId],
      foreignColumns: [hrisKpiReviews.tenantId, hrisKpiReviews.id],
    }),
    foreignKey({
      name: "hris_kpi_scores_definition_fk",
      columns: [table.tenantId, table.kpiDefinitionId],
      foreignColumns: [hrisKpiDefinitions.tenantId, hrisKpiDefinitions.id],
    }),
    check(
      "hris_kpi_scores_score_check",
      sql`${table.score} IS NULL OR ${table.score} BETWEEN 0 AND 100`,
    ),
    check(
      "hris_kpi_scores_actual_source_check",
      sql`${table.actualSource} IS NULL OR ${table.actualSource} IN ('system', 'manual')`,
    ),
  ],
);
