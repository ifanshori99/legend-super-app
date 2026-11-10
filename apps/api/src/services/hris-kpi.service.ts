// KPI definitions and review cycle (PRD v1.7 §3 F29 "KPI per jabatan"; HR-01;
// TEN-01..03; bead legend-ovxw, DECISIONS 2026-11-10 "WS-10 lifecycle" point
// 3). Routes: routes/hris-kpi.routes.ts.
//
// - A definition belongs to one position (or, with a null position, to every
//   employee). `source = system` names a metric of the report catalog that
//   declares the `employee` dimension, with the catalog unit; `source =
//   manager` is the reviewer's judgement. Definitions are tenant-wide master
//   data: writing one needs `hr.kpi.manage` with tenant-wide reach, reading
//   one needs `hr.kpi.manage` or an HRIS read code with any reach.
// - A review is one employee and one full calendar month or quarter. Creating
//   it copies the active definitions of the employee's position plus the
//   position-less ones into score rows, each with a frozen snapshot of the
//   definition, and computes the system actual of every system KPI.
// - System actuals come only from `evaluateMetrics` (the single path from
//   codes to values): split by `employee`, filtered to the employee's login
//   account, over the caller's outlet scope. An employee without a login
//   account, a metric without data and an unavailable metric store a null
//   with the reason in `system_availability`; the reviewer then enters a
//   manual actual. An available system actual always wins: it is copied to
//   `actual` (source `system`) and a manual value for it is refused.
// - A draft is edited and refreshed by a manager of the employee's home
//   outlet (`hr.kpi.manage`; another outlet answers 404). Submitting needs a
//   score on every row, a reviewer who is not the subject's own account, and
//   freezes the review: scores, refresh and a second submit answer 409
//   `KPI_REVIEW_SUBMITTED`. The overall score is the plain mean of the
//   scores, two decimals.
// - Visibility: a manager sees every status at the outlets they manage;
//   anyone else with an HRIS read code at the home outlet, and the employee
//   themself (`self.profile.view`), see submitted reviews only.

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { reportMetricByCode } from "@starter/shared/dashboard";
import {
  businessDateSchema,
  createUlid,
  encodeCursor,
  formatDecimal4,
  outletIdsForQuery,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { z } from "@starter/shared/core";
import {
  kpiDefinitionSchema,
  kpiReviewSchema,
  type createKpiDefinitionInputSchema,
  type createKpiReviewInputSchema,
  type KpiDefinition,
  type KpiReview,
  type listKpiDefinitions as listKpiDefinitionsEndpoint,
  type listKpiReviews as listKpiReviewsEndpoint,
  type updateKpiDefinitionInputSchema,
  type updateKpiScoresInputSchema,
} from "@starter/shared/hris";
import type { MetricValue } from "@starter/shared/metrics";
import { db } from "../db/index.ts";
import { employees, positions } from "../db/schema/hris.ts";
import {
  hrisKpiDefinitions,
  hrisKpiReviews,
  hrisKpiScores,
} from "../db/schema/hris-lifecycle.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_READ_CODES,
  HRIS_SELF_CODE,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";
import { evaluateMetrics } from "./metrics-query.service.ts";

export const HRIS_KPI_MANAGE_CODE = "hr.kpi.manage";
const KPI_MANAGE = [HRIS_KPI_MANAGE_CODE] as const;
const DEFINITION_OBJECT_TYPE = "kpi_definition";
const REVIEW_OBJECT_TYPE = "kpi_review";

type DefinitionRow = typeof hrisKpiDefinitions.$inferSelect;
type ReviewRow = typeof hrisKpiReviews.$inferSelect;
type ScoreRow = typeof hrisKpiScores.$inferSelect;
type CreateDefinitionBody = z.output<typeof createKpiDefinitionInputSchema>;
type UpdateDefinitionBody = z.output<typeof updateKpiDefinitionInputSchema>;
type CreateReviewBody = z.output<typeof createKpiReviewInputSchema>;
type UpdateScoresBody = z.output<typeof updateKpiScoresInputSchema>;
type ListReviewsQuery = z.output<typeof listKpiReviewsEndpoint.query>;
type ListDefinitionsQuery = z.output<typeof listKpiDefinitionsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** The definition as it was when the review was created (never edited). */
type DefinitionSnapshot = {
  id: string;
  name: string;
  source: "system" | "manager";
  metricCode: string | null;
  target: string | null;
  unit: string;
  direction: string;
  positionId: string | null;
};

/** What the metric engine says about one system KPI for one employee. */
export type SystemActual = {
  actual: Decimal4 | null;
  /** `available`, or why there is no value (`no_user_account`, `no_data`, ...). */
  availability: string;
};

const lower = (value: string) => value.toLowerCase();

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function validation(message: string, code = "VALIDATION_ERROR"): HttpError {
  return new HttpError(422, code, message);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function kpiNotFound(): HttpError {
  return notFound("KPI");
}

function submittedError(): HttpError {
  return conflict(
    "KPI_REVIEW_SUBMITTED",
    "Penilaian KPI sudah dikirim dan tidak bisa diubah.",
  );
}

// ------------------------------------------------------------------ mappers

export function toKpiDefinition(row: DefinitionRow): KpiDefinition {
  return kpiDefinitionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    positionId: row.positionId,
    name: row.name,
    source: row.source,
    metricCode: row.metricCode,
    target: row.target,
    unit: row.unit,
    direction: row.direction,
    isActive: row.isActive,
  });
}

function snapshotOf(row: DefinitionRow): DefinitionSnapshot {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    metricCode: row.metricCode,
    target: row.target,
    unit: row.unit,
    direction: row.direction,
    positionId: row.positionId,
  };
}

function snapshotOfScore(row: ScoreRow): DefinitionSnapshot {
  return row.definitionSnapshot as unknown as DefinitionSnapshot;
}

function toKpiReview(row: ReviewRow, scores: readonly ScoreRow[]): KpiReview {
  const ordered = [...scores].sort((a, b) => {
    const byName = snapshotOfScore(a).name.localeCompare(
      snapshotOfScore(b).name,
    );
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
  return kpiReviewSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    cycle: row.cycle,
    scores: ordered.map((score) => ({
      kpiDefinitionId: score.kpiDefinitionId,
      actual: score.actual,
      score: score.score,
      systemActual: score.systemActual,
      systemAvailability: score.systemAvailability,
      actualSource: score.actualSource,
      comment: score.comment,
    })),
    reviewerId: row.reviewerUserId,
    status: row.status,
    submittedAt: row.submittedAt === null ? null : iso(row.submittedAt),
    note: row.note,
    overallScore: row.overallScore === null ? null : Number(row.overallScore),
  });
}

// ------------------------------------------------------------------- audit

async function auditDefinition(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: DefinitionRow,
  action: string,
  fields: readonly string[],
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: DEFINITION_OBJECT_TYPE,
      objectId: row.id,
      reason: null,
      maskedChanges: {
        before: null,
        after: { fields: [...fields], status: row.source },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

async function auditReview(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  review: Pick<ReviewRow, "id" | "status">,
  homeOutletId: string,
  action: string,
  fields: readonly string[],
): Promise<void> {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: homeOutletId,
      action,
      objectType: REVIEW_OBJECT_TYPE,
      objectId: review.id,
      after: { fields: [...fields], status: review.status },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ catalog rules

/**
 * A system KPI names a catalog metric that is split by employee, in the
 * catalog's unit. Anything else is a 422: the engine could never fill it.
 */
function assertSystemMetric(metricCode: string, unit: string): void {
  const metric = reportMetricByCode.get(metricCode);
  if (!metric)
    throw validation(
      "Kode metrik tidak ada di katalog metrik.",
      "KPI_METRIC_UNKNOWN",
    );
  if (!metric.dimensions.includes("employee"))
    throw validation(
      "Metrik ini tidak bisa dirinci per karyawan.",
      "KPI_METRIC_NOT_PER_EMPLOYEE",
    );
  if (metric.unit !== unit)
    throw validation(
      `Satuan KPI harus sama dengan satuan metrik (${metric.unit}).`,
      "KPI_METRIC_UNIT_MISMATCH",
    );
}

function definitionConflict(error: unknown): never {
  if (uniqueViolation(error))
    throw conflict(
      "KPI_DEFINITION_DUPLICATE",
      "Sudah ada KPI aktif dengan nama yang sama untuk jabatan ini.",
    );
  throw error;
}

/** Writing a definition: `hr.kpi.manage` held tenant-wide, else 403. */
function assertDefinitionWrite(
  access: HrisAccess,
  context: ScopedTenantContext,
): void {
  if (
    access.reach(KPI_MANAGE)?.kind !== "tenant" ||
    context.outletScope.kind !== "tenant"
  )
    throw forbidden();
}

// -------------------------------------------------------------- definitions

/** GET /api/hris/kpi-definitions: KPI manager or any HRIS read code. */
export async function listKpiDefinitions(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListDefinitionsQuery,
): Promise<Page<KpiDefinition>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    if (access.reach([...KPI_MANAGE, ...HRIS_READ_CODES]) === null)
      throw forbidden();
    const filters: SQL[] = [
      eq(hrisKpiDefinitions.tenantId, context.tenant.tenantId),
    ];
    if (query.positionId)
      filters.push(eq(hrisKpiDefinitions.positionId, query.positionId));
    if (query.source) filters.push(eq(hrisKpiDefinitions.source, query.source));
    if (query.isActive !== undefined)
      filters.push(eq(hrisKpiDefinitions.isActive, query.isActive === "true"));
    if (query.cursor) {
      const [name, id] = cursorPair(query.cursor);
      filters.push(
        or(
          sql`${hrisKpiDefinitions.name} > ${name}`,
          and(
            eq(hrisKpiDefinitions.name, name),
            sql`${hrisKpiDefinitions.id} > ${id}`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(hrisKpiDefinitions)
      .where(and(...filters))
      .orderBy(asc(hrisKpiDefinitions.name), asc(hrisKpiDefinitions.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toKpiDefinition),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/kpi-definitions */
export async function createKpiDefinition(
  context: ScopedTenantContext,
  actorUserId: string,
  body: CreateDefinitionBody,
  now = new Date(),
): Promise<KpiDefinition> {
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      assertDefinitionWrite(access, context);
      if (body.source === "system") {
        if (body.metricCode === null)
          throw validation("KPI sistem butuh kode metrik.");
        assertSystemMetric(body.metricCode, body.unit);
      }
      if (body.positionId !== null) {
        const [position] = await tx
          .select({ id: positions.id })
          .from(positions)
          .where(
            and(
              eq(positions.tenantId, context.tenant.tenantId),
              eq(positions.id, body.positionId),
            ),
          )
          .limit(1);
        if (!position) throw validation("Jabatan tidak ditemukan.");
      }
      const [row] = await tx
        .insert(hrisKpiDefinitions)
        .values({
          tenantId: context.tenant.tenantId,
          positionId: body.positionId,
          name: body.name,
          source: body.source,
          metricCode: body.metricCode,
          target: body.target,
          unit: body.unit,
          direction: body.direction,
          isActive: true,
          createdBy: access.actorUserId,
        })
        .returning();
      if (!row) throw new Error("KPI definition insert returned no row");
      await auditDefinition(
        tx,
        context,
        actorUserId,
        now,
        row,
        "kpi_definition.created",
        ["name", "source", "target", "unit", "direction", "metricCode"],
      );
      return toKpiDefinition(row);
    });
  } catch (error) {
    return definitionConflict(error);
  }
}

/** PATCH /api/hris/kpi-definitions/:kpiDefinitionId */
export async function updateKpiDefinition(
  context: ScopedTenantContext,
  actorUserId: string,
  definitionId: string,
  body: UpdateDefinitionBody,
  now = new Date(),
): Promise<KpiDefinition> {
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      assertDefinitionWrite(access, context);
      const [current] = await tx
        .select()
        .from(hrisKpiDefinitions)
        .where(
          and(
            eq(hrisKpiDefinitions.tenantId, context.tenant.tenantId),
            eq(hrisKpiDefinitions.id, definitionId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) throw kpiNotFound();
      if (body.metricCode !== undefined && current.source !== "system")
        throw validation("KPI manajer tidak punya kode metrik.");
      const unit = body.unit ?? current.unit;
      const metricCode =
        current.source === "system"
          ? (body.metricCode ?? current.metricCode)
          : null;
      if (current.source === "system" && metricCode !== null)
        assertSystemMetric(metricCode, unit);
      const [row] = await tx
        .update(hrisKpiDefinitions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.target !== undefined ? { target: body.target } : {}),
          ...(body.direction !== undefined
            ? { direction: body.direction }
            : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          unit,
          metricCode,
          updatedAt: now,
        })
        .where(
          and(
            eq(hrisKpiDefinitions.tenantId, context.tenant.tenantId),
            eq(hrisKpiDefinitions.id, definitionId),
          ),
        )
        .returning();
      if (!row) throw kpiNotFound();
      await auditDefinition(
        tx,
        context,
        actorUserId,
        now,
        row,
        "kpi_definition.updated",
        Object.entries(body)
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field),
      );
      return toKpiDefinition(row);
    });
  } catch (error) {
    return definitionConflict(error);
  }
}

// ------------------------------------------------------------ system actuals

function decimalOf(value: MetricValue): Decimal4 {
  switch (value.unit) {
    case "idr":
      return formatDecimal4(BigInt(value.valueIdr) * 10_000n);
    case "count":
    case "seconds":
      return formatDecimal4(BigInt(value.value) * 10_000n);
    case "percent":
    case "decimal":
      return formatDecimal4(parseDecimal4(value.value));
  }
}

/**
 * The value of each system KPI of one employee for one period, read through
 * `evaluateMetrics` (split by employee, filtered to the login account). The
 * value spans every outlet of the tenant, whatever outlet the caller manages:
 * the caller already reached this employee, and the filter to the one login
 * account is what keeps other people's numbers out. One engine call serves
 * every code. The result has one entry per distinct code.
 */
export async function computeSystemActuals(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string | null,
  metricCodes: readonly string[],
  period: { start: string; end: string },
  now: Date,
): Promise<Map<string, SystemActual>> {
  const result = new Map<string, SystemActual>();
  const codes = [...new Set(metricCodes)];
  if (codes.length === 0) return result;
  if (userId === null) {
    for (const code of codes)
      result.set(code, { actual: null, availability: "no_user_account" });
    return result;
  }
  const queryable: string[] = [];
  for (const code of codes) {
    const metric = reportMetricByCode.get(code);
    if (!metric)
      result.set(code, { actual: null, availability: "source_not_built" });
    else if (!metric.dimensions.includes("employee"))
      result.set(code, {
        actual: null,
        availability: "dimension_not_supported",
      });
    else queryable.push(code);
  }
  if (queryable.length === 0) return result;
  // `metrics_daily` is outlet-scoped by RLS (`app.outlet_ids`, set by
  // `withTenant` from the caller's reach), so widen it for this one read and
  // put it back: later statements in this transaction keep the caller's reach.
  const tenantWide = establishScopedTenantContext(context.tenant, {
    kind: "tenant",
  });
  const callerOutlets =
    context.outletScope.kind === "tenant"
      ? "*"
      : JSON.stringify(context.outletScope.outletIds);
  await tx.execute(sql`SELECT set_config('app.outlet_ids', '*', true)`);
  const evaluated = await evaluateMetrics(
    tx,
    tenantWide,
    {
      metricCodes: queryable,
      period: {
        start: businessDateSchema.parse(period.start),
        end: businessDateSchema.parse(period.end),
      },
      bucket: "total",
      outletFilter: outletIdsForQuery(tenantWide.outletScope),
      groupBy: ["employee"],
      filters: [{ key: "employee", values: [userId] }],
      comparePrevious: false,
      viewer: "full",
    },
    now,
  );
  await tx.execute(
    sql`SELECT set_config('app.outlet_ids', ${callerOutlets}, true)`,
  );
  for (const entry of evaluated.availability) {
    if (entry.status === "unavailable") {
      result.set(entry.metricCode, {
        actual: null,
        availability: entry.reason,
      });
      continue;
    }
    const series = evaluated.series.find(
      (candidate) =>
        candidate.metricCode === entry.metricCode &&
        candidate.dimensions.some(
          (dimension) =>
            dimension.key === "employee" && dimension.value === userId,
        ),
    );
    const value = series?.points[0]?.value ?? null;
    if (value === null) {
      result.set(entry.metricCode, { actual: null, availability: "no_data" });
      continue;
    }
    try {
      result.set(entry.metricCode, {
        actual: decimalOf(value),
        availability: "available",
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      result.set(entry.metricCode, {
        actual: null,
        availability: "value_too_large",
      });
    }
  }
  return result;
}

// ------------------------------------------------------------------ periods

/** Last day of a full month or quarter, or a 422 for a partial period. */
export function reviewPeriodEnd(
  cycle: "monthly" | "quarterly",
  periodStart: string,
): string {
  const [year, month, dayOfMonth] = periodStart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const monthsLong = cycle === "monthly" ? 1 : 3;
  const startsFull =
    dayOfMonth === 1 && (cycle === "monthly" || (month - 1) % 3 === 0);
  if (!startsFull)
    throw validation(
      cycle === "monthly"
        ? "Periode bulanan harus dimulai tanggal 1."
        : "Periode kuartal harus dimulai tanggal 1 Januari, April, Juli, atau Oktober.",
      "KPI_PERIOD_INVALID",
    );
  return new Date(Date.UTC(year, month - 1 + monthsLong, 0))
    .toISOString()
    .slice(0, 10);
}

// ------------------------------------------------------------------ reviews

type SubjectRow = {
  id: string;
  userId: string | null;
  homeOutletId: string;
  positionId: string | null;
};

async function loadSubject(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
): Promise<SubjectRow | null> {
  const [row] = await tx
    .select({
      id: employees.id,
      userId: employees.userId,
      homeOutletId: employees.homeOutletId,
      positionId: employees.positionId,
    })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The caller manages KPIs at the employee's home outlet, else 404. */
function assertManages(access: HrisAccess, subject: SubjectRow): void {
  if (
    !access.snapshot.allows(HRIS_KPI_MANAGE_CODE, {
      type: "outlet",
      id: subject.homeOutletId,
    })
  )
    throw kpiNotFound();
}

async function loadScores(
  tx: Tx,
  context: ScopedTenantContext,
  reviewIds: readonly string[],
  lock = false,
): Promise<Map<string, ScoreRow[]>> {
  const byReview = new Map<string, ScoreRow[]>();
  if (reviewIds.length === 0) return byReview;
  const query = tx
    .select()
    .from(hrisKpiScores)
    .where(
      and(
        eq(hrisKpiScores.tenantId, context.tenant.tenantId),
        inArray(hrisKpiScores.reviewId, [...reviewIds]),
      ),
    );
  for (const row of await (lock ? query.for("update") : query)) {
    const list = byReview.get(row.reviewId) ?? [];
    list.push(row);
    byReview.set(row.reviewId, list);
  }
  return byReview;
}

/** A draft or submitted review the caller may change, locked; else 404. */
async function loadReviewForManage(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  reviewId: string,
): Promise<{ review: ReviewRow; subject: SubjectRow; scores: ScoreRow[] }> {
  const [review] = await tx
    .select()
    .from(hrisKpiReviews)
    .where(
      and(
        eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
        eq(hrisKpiReviews.id, reviewId),
      ),
    )
    .limit(1)
    .for("update");
  if (!review) throw kpiNotFound();
  const subject = await loadSubject(tx, context, review.employeeId);
  if (!subject) throw kpiNotFound();
  assertManages(access, subject);
  const scores = (await loadScores(tx, context, [review.id], true)).get(
    review.id,
  );
  return { review, subject, scores: scores ?? [] };
}

function reachCondition(reach: HrisReach): SQL {
  return reach.kind === "tenant"
    ? sql`true`
    : inArray(employees.homeOutletId, [...reach.outletIds]);
}

/** GET /api/hris/kpi-reviews: drafts for managers, submitted for the rest. */
export async function listKpiReviews(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListReviewsQuery,
): Promise<Page<KpiReview>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const visible: SQL[] = [];
    const manage = access.reach(KPI_MANAGE);
    if (manage) visible.push(reachCondition(manage));
    const submittedOnly: SQL[] = [];
    const read = access.reach(HRIS_READ_CODES);
    if (read) submittedOnly.push(reachCondition(read));
    const own = access.own;
    if (own !== null && access.snapshot.permissions.includes(HRIS_SELF_CODE))
      submittedOnly.push(eq(hrisKpiReviews.employeeId, own.id));
    if (submittedOnly.length > 0)
      visible.push(
        and(eq(hrisKpiReviews.status, "submitted"), or(...submittedOnly))!,
      );
    if (visible.length === 0) throw forbidden();

    const filters: SQL[] = [
      eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.employeeId)
      filters.push(eq(hrisKpiReviews.employeeId, query.employeeId));
    if (query.reviewId) filters.push(eq(hrisKpiReviews.id, query.reviewId));
    if (query.periodYear !== undefined) {
      filters.push(
        gte(hrisKpiReviews.periodStart, `${query.periodYear}-01-01`),
        lte(hrisKpiReviews.periodStart, `${query.periodYear}-12-31`),
      );
    }
    if (query.cursor) {
      const [periodStart, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(hrisKpiReviews.periodStart, periodStart),
          and(
            eq(hrisKpiReviews.periodStart, periodStart),
            sql`${hrisKpiReviews.id} > ${id}`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select({ review: hrisKpiReviews })
      .from(hrisKpiReviews)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, hrisKpiReviews.tenantId),
          eq(employees.id, hrisKpiReviews.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(hrisKpiReviews.periodStart), asc(hrisKpiReviews.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit).map((row) => row.review);
    const last = page.at(-1);
    const scores = await loadScores(
      tx,
      context,
      page.map((row) => row.id),
    );
    return {
      data: page.map((row) => toKpiReview(row, scores.get(row.id) ?? [])),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.periodStart, last.id])
            : null,
      },
    };
  });
}

/** Actual and its source from a system value, or kept manual, or empty. */
function actualFrom(
  system: SystemActual,
  current: Pick<ScoreRow, "actual" | "actualSource">,
): {
  actual: Decimal4 | string | null;
  actualSource: "system" | "manual" | null;
} {
  if (system.actual !== null)
    return { actual: system.actual, actualSource: "system" };
  if (current.actualSource === "manual")
    return { actual: current.actual, actualSource: "manual" };
  return { actual: null, actualSource: null };
}

/** POST /api/hris/kpi-reviews: opens a draft and computes system actuals. */
export async function createKpiReview(
  context: ScopedTenantContext,
  actorUserId: string,
  body: CreateReviewBody,
  now = new Date(),
): Promise<KpiReview> {
  const periodEnd = reviewPeriodEnd(body.cycle, body.periodStart);
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      const subject = await loadSubject(tx, context, body.employeeId);
      if (!subject) throw kpiNotFound();
      assertManages(access, subject);

      const [existing] = await tx
        .select({ id: hrisKpiReviews.id })
        .from(hrisKpiReviews)
        .where(
          and(
            eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
            eq(hrisKpiReviews.employeeId, subject.id),
            eq(hrisKpiReviews.cycle, body.cycle),
            eq(hrisKpiReviews.periodStart, body.periodStart),
          ),
        )
        .limit(1);
      if (existing) throw reviewExists();

      const positionFilter =
        subject.positionId === null
          ? sql`${hrisKpiDefinitions.positionId} IS NULL`
          : or(
              sql`${hrisKpiDefinitions.positionId} IS NULL`,
              eq(hrisKpiDefinitions.positionId, subject.positionId),
            )!;
      const definitions = await tx
        .select()
        .from(hrisKpiDefinitions)
        .where(
          and(
            eq(hrisKpiDefinitions.tenantId, context.tenant.tenantId),
            eq(hrisKpiDefinitions.isActive, true),
            positionFilter,
          ),
        )
        .orderBy(asc(hrisKpiDefinitions.name), asc(hrisKpiDefinitions.id));
      if (definitions.length === 0)
        throw validation(
          "Belum ada KPI aktif untuk jabatan karyawan ini.",
          "KPI_NO_DEFINITIONS",
        );

      const actuals = await computeSystemActuals(
        tx,
        context,
        subject.userId,
        definitions.flatMap((definition) =>
          definition.source === "system" && definition.metricCode !== null
            ? [definition.metricCode]
            : [],
        ),
        { start: body.periodStart, end: periodEnd },
        now,
      );

      const [review] = await tx
        .insert(hrisKpiReviews)
        .values({
          tenantId: context.tenant.tenantId,
          employeeId: subject.id,
          cycle: body.cycle,
          periodStart: body.periodStart,
          periodEnd,
          status: "draft",
          createdBy: access.actorUserId,
        })
        .returning();
      if (!review) throw new Error("KPI review insert returned no row");
      const scoreRows = await tx
        .insert(hrisKpiScores)
        .values(
          definitions.map((definition) => {
            const system: SystemActual | null =
              definition.source === "system" && definition.metricCode !== null
                ? (actuals.get(definition.metricCode) ?? null)
                : null;
            const picked = system
              ? actualFrom(system, { actual: null, actualSource: null })
              : { actual: null, actualSource: null };
            return {
              tenantId: context.tenant.tenantId,
              reviewId: review.id,
              kpiDefinitionId: definition.id,
              definitionSnapshot: snapshotOf(definition) as unknown as Record<
                string,
                unknown
              >,
              systemActual: system?.actual ?? null,
              systemAvailability: system?.availability ?? null,
              systemComputedAt: system ? now : null,
              actual: picked.actual,
              actualSource: picked.actualSource,
            };
          }),
        )
        .returning();
      await auditReview(
        tx,
        context,
        actorUserId,
        now,
        review,
        subject.homeOutletId,
        "kpi_review.created",
        ["cycle", "periodStart", "periodEnd"],
      );
      return toKpiReview(review, scoreRows);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw reviewExists();
    throw error;
  }
}

function reviewExists(): HttpError {
  return conflict(
    "KPI_REVIEW_EXISTS",
    "Penilaian KPI untuk karyawan dan periode ini sudah ada.",
  );
}

/** PATCH /api/hris/kpi-reviews/:reviewId/scores: draft only. */
export async function updateKpiScores(
  context: ScopedTenantContext,
  actorUserId: string,
  reviewId: string,
  body: UpdateScoresBody,
  now = new Date(),
): Promise<KpiReview> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { review, subject, scores } = await loadReviewForManage(
      tx,
      context,
      access,
      reviewId,
    );
    if (review.status !== "draft") throw submittedError();
    const byDefinition = new Map(
      scores.map((score) => [lower(score.kpiDefinitionId), score]),
    );
    const changed = new Set<string>();
    const updated = new Map<string, ScoreRow>();
    for (const line of body.scores) {
      const current = byDefinition.get(lower(line.kpiDefinitionId));
      if (!current)
        throw validation(
          "KPI ini bukan bagian dari penilaian.",
          "KPI_SCORE_UNKNOWN",
        );
      const patch: Partial<typeof hrisKpiScores.$inferInsert> = {};
      if (line.actual !== undefined) {
        // An available system value is the actual; nobody overrides it.
        if (current.systemActual !== null)
          throw validation(
            "KPI ini terisi dari data sistem; nilai aktual tidak bisa diubah.",
            "KPI_ACTUAL_SYSTEM",
          );
        patch.actual = line.actual;
        patch.actualSource = "manual";
        changed.add("actual");
      }
      if (line.score !== undefined) {
        patch.score = line.score;
        changed.add("score");
      }
      if (line.comment !== undefined) {
        patch.comment = line.comment === "" ? null : line.comment;
        changed.add("comment");
      }
      const [row] = await tx
        .update(hrisKpiScores)
        .set(patch)
        .where(
          and(
            eq(hrisKpiScores.tenantId, context.tenant.tenantId),
            eq(hrisKpiScores.id, current.id),
          ),
        )
        .returning();
      if (row) updated.set(row.id, row);
    }
    const [row] = await tx
      .update(hrisKpiReviews)
      .set({
        ...(body.note !== undefined
          ? { note: body.note === "" ? null : body.note }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
          eq(hrisKpiReviews.id, review.id),
        ),
      )
      .returning();
    if (!row) throw kpiNotFound();
    if (body.note !== undefined) changed.add("note");
    await auditReview(
      tx,
      context,
      actorUserId,
      now,
      row,
      subject.homeOutletId,
      "kpi_review.scores_updated",
      [...changed],
    );
    return toKpiReview(
      row,
      scores.map((score) => updated.get(score.id) ?? score),
    );
  });
}

/** POST /api/hris/kpi-reviews/:reviewId/refresh-actuals: draft only. */
export async function refreshKpiActuals(
  context: ScopedTenantContext,
  actorUserId: string,
  reviewId: string,
  now = new Date(),
): Promise<KpiReview> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { review, subject, scores } = await loadReviewForManage(
      tx,
      context,
      access,
      reviewId,
    );
    if (review.status !== "draft") throw submittedError();
    const systemRows = scores.filter(
      (score) => snapshotOfScore(score).source === "system",
    );
    const actuals = await computeSystemActuals(
      tx,
      context,
      subject.userId,
      systemRows.flatMap((score) => {
        const code = snapshotOfScore(score).metricCode;
        return code === null ? [] : [code];
      }),
      { start: review.periodStart, end: review.periodEnd },
      now,
    );
    const updated = new Map<string, ScoreRow>();
    for (const score of systemRows) {
      const code = snapshotOfScore(score).metricCode;
      const system = code === null ? undefined : actuals.get(code);
      if (!system) continue;
      const picked = actualFrom(system, score);
      const [row] = await tx
        .update(hrisKpiScores)
        .set({
          systemActual: system.actual,
          systemAvailability: system.availability,
          systemComputedAt: now,
          actual: picked.actual,
          actualSource: picked.actualSource,
        })
        .where(
          and(
            eq(hrisKpiScores.tenantId, context.tenant.tenantId),
            eq(hrisKpiScores.id, score.id),
          ),
        )
        .returning();
      if (row) updated.set(row.id, row);
    }
    const [row] = await tx
      .update(hrisKpiReviews)
      .set({ updatedAt: now })
      .where(
        and(
          eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
          eq(hrisKpiReviews.id, review.id),
        ),
      )
      .returning();
    if (!row) throw kpiNotFound();
    await auditReview(
      tx,
      context,
      actorUserId,
      now,
      row,
      subject.homeOutletId,
      "kpi_review.actuals_refreshed",
      ["systemActual"],
    );
    return toKpiReview(
      row,
      scores.map((score) => updated.get(score.id) ?? score),
    );
  });
}

/** Plain mean of integer scores, two decimals ("87.50"). */
export function overallScoreOf(scores: readonly number[]): string {
  const total = scores.reduce((sum, score) => sum + score, 0);
  return (Math.round((total / scores.length) * 100) / 100).toFixed(2);
}

/** POST /api/hris/kpi-reviews/:reviewId/submit: freezes the review. */
export async function submitKpiReview(
  context: ScopedTenantContext,
  actorUserId: string,
  reviewId: string,
  now = new Date(),
): Promise<KpiReview> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { review, subject, scores } = await loadReviewForManage(
      tx,
      context,
      access,
      reviewId,
    );
    if (review.status !== "draft") throw submittedError();
    if (subject.userId !== null && lower(subject.userId) === lower(actorUserId))
      throw new HttpError(
        403,
        "KPI_SELF_REVIEW",
        "Penilai tidak boleh menilai dirinya sendiri.",
      );
    if (scores.length === 0)
      throw validation("Penilaian tidak punya KPI.", "KPI_SCORES_INCOMPLETE");
    const values = scores.map((score) => score.score);
    if (values.some((value) => value === null))
      throw validation(
        "Setiap KPI harus punya skor sebelum dikirim.",
        "KPI_SCORES_INCOMPLETE",
      );
    const [row] = await tx
      .update(hrisKpiReviews)
      .set({
        status: "submitted",
        reviewerUserId: access.actorUserId,
        submittedAt: now,
        overallScore: overallScoreOf(values as number[]),
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisKpiReviews.tenantId, context.tenant.tenantId),
          eq(hrisKpiReviews.id, review.id),
        ),
      )
      .returning();
    if (!row) throw kpiNotFound();
    await auditReview(
      tx,
      context,
      actorUserId,
      now,
      row,
      subject.homeOutletId,
      "kpi_review.submitted",
      ["status", "overallScore"],
    );
    return toKpiReview(row, scores);
  });
}
