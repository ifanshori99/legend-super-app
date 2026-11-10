// HRIS training and certification (PRD v1.7 §3 F32; bead legend-7df1).
// Contract: `@starter/shared/hris` (performance.ts `trainingSchema`,
// `trainingCompletionSchema`, `gradeTrainingAttempt`).
//
// - The answer key (`training_questions.correct_option_index`) never leaves
//   the API: responses are built from the prompt/options/points columns only.
// - `training_completions` has one immutable row per quiz attempt (UPDATE and
//   DELETE revoked from `legend_app`, hris-sop.custom.sql). A certificate row
//   is issued only for a passing attempt.
// - Tenant master data (no `outlet_id`): outlet reach is enforced by the
//   service through the station outlet / employee home outlet.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { employees, positions } from "./hris.ts";
import { stations } from "./menu.ts";
import { tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** PRD F32 `trainings` (T). */
export const trainings = pgTable(
  "trainings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull(),
    stationId: uuid("station_id"),
    positionId: uuid("position_id"),
    passingScore: smallint("passing_score").notNull(),
    /** Certificate validity in months; 0 = never expires. */
    validityMonths: smallint("validity_months").notNull(),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    createdBy: text("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("trainings_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "trainings_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "trainings_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }).onDelete("restrict"),
    index("trainings_tenant_station_idx").on(table.tenantId, table.stationId),
    check(
      "trainings_passing_score_check",
      sql`${table.passingScore} BETWEEN 0 AND 100`,
    ),
    check(
      "trainings_validity_months_check",
      sql`${table.validityMonths} BETWEEN 0 AND 120`,
    ),
    check(
      "trainings_schedule_check",
      sql`${table.scheduledStart} IS NULL OR ${table.scheduledEnd} IS NULL OR ${table.scheduledEnd} > ${table.scheduledStart}`,
    ),
  ],
);

/** PRD F32 quiz question (T); holds the server-side answer key. */
export const trainingQuestions = pgTable(
  "training_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    trainingId: uuid("training_id").notNull(),
    sortOrder: smallint("sort_order").notNull(),
    prompt: varchar("prompt", { length: 500 }).notNull(),
    /** JSON array of 2..6 option strings. */
    options: jsonb("options").$type<string[]>().notNull(),
    points: smallint("points").notNull(),
    correctOptionIndex: smallint("correct_option_index").notNull(),
  },
  (table) => [
    unique("training_questions_tenant_id_id_key").on(table.tenantId, table.id),
    unique("training_questions_tenant_training_sort_key").on(
      table.tenantId,
      table.trainingId,
      table.sortOrder,
    ),
    foreignKey({
      name: "training_questions_training_fk",
      columns: [table.tenantId, table.trainingId],
      foreignColumns: [trainings.tenantId, trainings.id],
    }),
    check(
      "training_questions_options_check",
      sql`jsonb_typeof(${table.options}) = 'array' AND jsonb_array_length(${table.options}) BETWEEN 2 AND 6`,
    ),
    check(
      "training_questions_points_check",
      sql`${table.points} BETWEEN 1 AND 100`,
    ),
    check(
      "training_questions_correct_option_check",
      sql`${table.correctOptionIndex} >= 0 AND ${table.correctOptionIndex} < jsonb_array_length(${table.options})`,
    ),
    check("training_questions_sort_order_check", sql`${table.sortOrder} >= 0`),
  ],
);

/** PRD F32 enrollment (T): an employee assigned to a training. */
export const trainingEnrollments = pgTable(
  "training_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    trainingId: uuid("training_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    enrolledBy: text("enrolled_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dueOn: businessDate("due_on"),
  },
  (table) => [
    unique("training_enrollments_tenant_training_employee_key").on(
      table.tenantId,
      table.trainingId,
      table.employeeId,
    ),
    foreignKey({
      name: "training_enrollments_training_fk",
      columns: [table.tenantId, table.trainingId],
      foreignColumns: [trainings.tenantId, trainings.id],
    }),
    foreignKey({
      name: "training_enrollments_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    index("training_enrollments_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
  ],
);

/** PRD F32 quiz attempt (T): one immutable row per attempt. */
export const trainingCompletions = pgTable(
  "training_completions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    trainingId: uuid("training_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    score: smallint("score").notNull(),
    passed: boolean("passed").notNull(),
    answers: jsonb("answers").$type<unknown>().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    expiresOn: businessDate("expires_on"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
  },
  (table) => [
    unique("training_completions_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("training_completions_tenant_attempt_key").on(
      table.tenantId,
      table.trainingId,
      table.employeeId,
      table.attemptNumber,
    ),
    unique("training_completions_tenant_employee_idempotency_key").on(
      table.tenantId,
      table.employeeId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "training_completions_training_fk",
      columns: [table.tenantId, table.trainingId],
      foreignColumns: [trainings.tenantId, trainings.id],
    }),
    foreignKey({
      name: "training_completions_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    index("training_completions_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.trainingId,
    ),
    check(
      "training_completions_attempt_check",
      sql`${table.attemptNumber} BETWEEN 1 AND 100`,
    ),
    check(
      "training_completions_score_check",
      sql`${table.score} BETWEEN 0 AND 100`,
    ),
  ],
);

/** PRD F32 certificate (T): issued for a passing attempt only. */
export const trainingCertificates = pgTable(
  "training_certificates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    trainingId: uuid("training_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    completionId: uuid("completion_id").notNull(),
    certificateNumber: varchar("certificate_number", { length: 40 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresOn: businessDate("expires_on"),
  },
  (table) => [
    unique("training_certificates_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("training_certificates_tenant_completion_key").on(
      table.tenantId,
      table.completionId,
    ),
    unique("training_certificates_tenant_number_key").on(
      table.tenantId,
      table.certificateNumber,
    ),
    foreignKey({
      name: "training_certificates_training_fk",
      columns: [table.tenantId, table.trainingId],
      foreignColumns: [trainings.tenantId, trainings.id],
    }),
    foreignKey({
      name: "training_certificates_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "training_certificates_completion_fk",
      columns: [table.tenantId, table.completionId],
      foreignColumns: [trainingCompletions.tenantId, trainingCompletions.id],
    }),
    index("training_certificates_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.trainingId,
    ),
  ],
);
