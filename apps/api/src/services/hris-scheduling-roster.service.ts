// Weekly roster: shift assignments, the manager's week view, copy week and
// publish (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", F26, HR-05; bead
// legend-jstx). Routes: routes/hris-scheduling.routes.ts.
//
// - Managing the roster is `hr.schedule.manage` at the assignment's outlet; an
//   outlet outside the caller's reach answers 404 like a missing row. An
//   employee reads only their own `published`/`swapped` shifts
//   (`self.schedule.view`); a manager also sees drafts.
// - Only an active employee whose home outlet is the assignment's outlet can be
//   scheduled (default rule: no cross-outlet loans yet).
// - A new assignment is a draft that snapshots segments and break minutes from
//   the template in the outlet time zone; `businessDate` is the outlet-local
//   day the shift starts, so a night shift keeps the day it begins.
// - Publishing a week turns every draft of the outlet-week into `published`
//   and appends one `shift.published` per assignment in the same transaction
//   (transactional outbox, destinations `cloud-sync` and `notification`).
//   Cancelling a published or swapped shift appends `shift.cancelled` for its
//   owner; a draft was never announced, so it emits nothing. Compliance (F26)
//   is a warning on publish; HR-05 only blocks swaps.
// - Idempotency is by the body's `idempotencyKey`, never by matching the data:
//   a create stores it in `shift_assignments.create_idempotency_key`, a copy
//   in the `roster_copies` ledger and a publish in `roster_publications`. A
//   replayed key returns the first result (the ledger rows keep the assignment
//   ids, a publication also its snapshot) and writes or emits nothing twice. A
//   new key with the same data is a 409: the partial unique index on
//   (employee, day, template) for live rows answers `SHIFT_DUPLICATE`, a copy
//   onto a week with live shifts `ROSTER_NOT_EMPTY`. The key is tenant-wide, so
//   a replay for another outlet is `IDEMPOTENCY_KEY_REUSED`.
// - Responses carry employee ids only, never names, ID numbers or pay.

import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lte,
  ne,
  or,
  gt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  addBusinessDays,
  copyRosterWeek as copyRosterWeekEndpoint,
  createShiftAssignment as createShiftAssignmentEndpoint,
  evaluateShiftCompliance,
  isRosterPublished,
  listShiftAssignments as listShiftAssignmentsEndpoint,
  publishRoster as publishRosterEndpoint,
  transitionShiftAssignment,
  updateShiftAssignment as updateShiftAssignmentEndpoint,
  weekStartOf,
  type RosterPublication,
  type RosterView,
  type ShiftAssignment,
  type ShiftAssignmentSegment,
  type ShiftTemplate,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { leaveRequests } from "../db/schema/hris-leave.ts";
import {
  rosterCopies,
  rosterPublications,
  shiftAssignments,
  shiftSwapRequests,
  shiftTemplates,
} from "../db/schema/hris-scheduling.ts";
import { stations } from "../db/schema/menu.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type HrisActor,
  type Tx,
} from "./hris-access.ts";
import {
  loadWeekAssignments,
  resolveCompliancePolicy,
  segmentsFromTemplate,
  toShiftAssignment,
  toShiftTemplate,
} from "./hris-scheduling-common.ts";
import {
  appendShiftCancelled,
  appendShiftPublished,
} from "./hris-scheduling-events.ts";

export const HRIS_SCHEDULE_MANAGE_CODE = "hr.schedule.manage";
export const HRIS_SHIFT_OBJECT_TYPE = "shift_assignment";
export const HRIS_ROSTER_OBJECT_TYPE = "roster_publication";
const HRIS_SWAP_OBJECT_TYPE = "shift_swap_request";

type ShiftRow = typeof shiftAssignments.$inferSelect;
type CreateBody = z.output<typeof createShiftAssignmentEndpoint.body>;
type UpdateBody = z.output<typeof updateShiftAssignmentEndpoint.body>;
type ListQuery = z.output<typeof listShiftAssignmentsEndpoint.query>;
type CopyBody = z.output<typeof copyRosterWeekEndpoint.body>;
type PublishBody = z.output<typeof publishRosterEndpoint.body>;
type GetRosterQuery = { outletId: string; weekStart: string };
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const lower = (value: string) => value.toLowerCase();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const SHIFT_KEY_CONSTRAINT = "shift_assignments_tenant_idempotency_key";
const SHIFT_ACTIVE_CONSTRAINT =
  "shift_assignments_active_employee_day_template_key";
const COPY_KEY_CONSTRAINT = "roster_copies_tenant_idempotency_key";
const PUBLICATION_KEY_CONSTRAINT = "roster_publications_tenant_idempotency_key";

/** Days of other weeks loaded around a week so rest and run limits see them. */
const COMPLIANCE_CONTEXT_DAYS = 7;
const DAY_MS = 86_400_000;

function validation(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

/**
 * Constraint name of a PostgreSQL unique violation (23505), directly or
 * wrapped by drizzle's cause chain; null for any other error.
 */
function uniqueViolation(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolation(candidate.cause, depth + 1);
}

function keyReused(): CoreError {
  return new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "Idempotency key already used for a different request.",
  );
}

function shiftDuplicate(): HttpError {
  return conflict(
    "SHIFT_DUPLICATE",
    "Karyawan sudah punya jadwal dengan template yang sama pada hari ini.",
  );
}

function scheduleNotFound(): HttpError {
  return notFound("Jadwal shift");
}

/** The caller manages the roster at this outlet, else 404 (outside reach). */
function assertManage(access: HrisAccess, outletId: string): void {
  if (
    !access.snapshot.allows(HRIS_SCHEDULE_MANAGE_CODE, {
      type: "outlet",
      id: outletId,
    })
  )
    throw scheduleNotFound();
}

function assertMonday(date: string): void {
  if (weekStartOf(date) !== date)
    throw validation("Tanggal awal minggu harus hari Senin.");
}

async function loadOutletZone(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
): Promise<string> {
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw scheduleNotFound();
  return outlet.timezone;
}

async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function assertSchedulable(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  outletId: string,
): Promise<void> {
  const [employee] = await tx
    .select({ status: employees.status, homeOutletId: employees.homeOutletId })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  if (
    !employee ||
    employee.status !== "active" ||
    lower(employee.homeOutletId) !== lower(outletId)
  )
    throw validation(
      "Karyawan tidak aktif atau bukan karyawan outlet ini; tidak bisa dijadwalkan.",
    );
}

async function loadTemplate(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  templateId: string,
): Promise<ShiftTemplate> {
  const [row] = await tx
    .select()
    .from(shiftTemplates)
    .where(
      and(
        eq(shiftTemplates.tenantId, tenantId),
        eq(shiftTemplates.id, templateId),
      ),
    )
    .limit(1);
  if (!row || lower(row.outletId) !== lower(outletId) || !row.isActive)
    throw validation("Template shift tidak ditemukan atau tidak aktif.");
  return toShiftTemplate(row);
}

async function assertStation(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  stationId: string,
): Promise<void> {
  const [station] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.id, stationId),
        eq(stations.outletId, outletId),
      ),
    )
    .limit(1);
  if (!station) throw validation("Stasiun tidak ditemukan di outlet ini.");
}

async function findAssignment(
  tx: Tx,
  tenantId: TenantId,
  assignmentId: string,
  lock = false,
): Promise<ShiftRow | null> {
  const query = tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        eq(shiftAssignments.id, assignmentId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

async function auditShift(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string | HrisActor,
  now: Date,
  row: Pick<ShiftRow, "id" | "outletId" | "status">,
  action: string,
  objectType: string = HRIS_SHIFT_OBJECT_TYPE,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action,
      objectType,
      objectId: row.id,
      after: { status: row.status },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ compliance

/**
 * Warnings for the outlet-week. The employees' shifts at other outlets and in
 * the neighbouring days are part of the evaluation (rest, consecutive days);
 * only issues anchored on this week's assignments are reported.
 */
async function weekCompliance(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  weekStart: string,
  week: readonly ShiftAssignment[],
) {
  const { limits } = await resolveCompliancePolicy(tx, tenantId, outletId);
  const context = await loadWeekAssignments(
    tx,
    tenantId,
    {
      employeeIds: [
        ...new Set(week.map((assignment) => assignment.employeeId)),
      ],
    },
    addBusinessDays(weekStart, -COMPLIANCE_CONTEXT_DAYS),
    addBusinessDays(weekStart, 6 + COMPLIANCE_CONTEXT_DAYS),
  );
  const weekIds = new Set(week.map((assignment) => assignment.id));
  return evaluateShiftCompliance(context, limits).filter((issue) =>
    weekIds.has(issue.assignmentId),
  );
}

function loadWeek(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  weekStart: string,
): Promise<ShiftAssignment[]> {
  return loadWeekAssignments(
    tx,
    tenantId,
    { outletIds: [outletId] },
    weekStart,
    addBusinessDays(weekStart, 6),
  );
}

async function buildRoster(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  weekStart: string,
): Promise<RosterView> {
  const week = await loadWeek(tx, tenantId, outletId, weekStart);
  return {
    outletId,
    weekStart,
    published: isRosterPublished(week),
    assignments: week,
    complianceIssues: await weekCompliance(
      tx,
      tenantId,
      outletId,
      weekStart,
      week,
    ),
  } as RosterView;
}

// ----------------------------------------------------------------- reads

/**
 * GET /api/hris/shifts — managers by outlet reach (drafts included), plus the
 * caller's own published/swapped shifts. Cancelled rows are never listed.
 */
export async function listShiftAssignments(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
  now = new Date(),
): Promise<Page<ShiftAssignment>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const manage = access.reach([HRIS_SCHEDULE_MANAGE_CODE]);
    const mine =
      access.own && access.snapshot.permissions.includes("self.schedule.view")
        ? access.own
        : null;
    if (!manage && !mine) throw forbidden();

    const visible: SQL[] = [];
    if (manage?.kind === "tenant") visible.push(sql`true`);
    else if (manage)
      visible.push(inArray(shiftAssignments.outletId, [...manage.outletIds]));
    if (mine)
      visible.push(
        and(
          eq(shiftAssignments.employeeId, mine.id),
          inArray(shiftAssignments.status, ["published", "swapped"]),
        )!,
      );

    const filters: SQL[] = [
      eq(shiftAssignments.tenantId, context.tenant.tenantId),
      ne(shiftAssignments.status, "cancelled"),
      or(...visible)!,
    ];
    if (query.outletId)
      filters.push(eq(shiftAssignments.outletId, query.outletId));
    if (query.employeeId)
      filters.push(eq(shiftAssignments.employeeId, query.employeeId));
    if (query.from)
      filters.push(gte(shiftAssignments.businessDate, query.from));
    if (query.to) filters.push(lte(shiftAssignments.businessDate, query.to));
    if (query.cursor) {
      const [businessDate, id] = cursorPair(query.cursor);
      if (!isCalendarDate(businessDate) || !UUID_PATTERN.test(id))
        throw validation("Check the cursor.");
      filters.push(
        or(
          gt(shiftAssignments.businessDate, businessDate),
          and(
            eq(shiftAssignments.businessDate, businessDate),
            gt(shiftAssignments.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(shiftAssignments)
      .where(and(...filters))
      .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toShiftAssignment),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.businessDate, last.id])
            : null,
      },
    };
  });
}

/** GET /api/hris/rosters — the manager's week: drafts and warnings included. */
export async function getRoster(
  context: ScopedTenantContext,
  actorUserId: string,
  query: GetRosterQuery,
  now = new Date(),
): Promise<RosterView> {
  assertMonday(query.weekStart);
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertManage(access, query.outletId);
    await loadOutletZone(tx, context.tenant.tenantId, query.outletId);
    return buildRoster(
      tx,
      context.tenant.tenantId,
      query.outletId,
      query.weekStart,
    );
  });
}

// ----------------------------------------------------------------- writes

type Materialised = {
  segments: ShiftAssignmentSegment[];
  breakMinutes: number;
  shiftTemplateId: string;
  stationId: string | null;
};

/** Validates station and template and snapshots the concrete segments. */
async function materialise(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  zone: string,
  input: {
    shiftTemplateId: string;
    stationId: string | null;
    businessDate: string;
  },
): Promise<Materialised> {
  const template = await loadTemplate(
    tx,
    tenantId,
    outletId,
    input.shiftTemplateId,
  );
  // Null keeps the template's own station; an explicit station overrides it.
  const stationId = input.stationId ?? template.stationId;
  if (stationId) await assertStation(tx, tenantId, outletId, stationId);
  return {
    segments: segmentsFromTemplate(template, input.businessDate, zone),
    breakMinutes: template.breakMinutes,
    shiftTemplateId: template.id,
    stationId,
  };
}

/**
 * POST /api/hris/shifts — a draft assignment. The body's idempotency key is
 * stored on the row: a replay returns the stored assignment. The same data
 * under a new key hits the live-row unique index and is a 409.
 */
export async function createShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateBody,
  now = new Date(),
  onOutcome?: (outcome: { created: boolean }) => void,
): Promise<ShiftAssignment> {
  const result = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertManage(access, input.outletId);
    const tenantId = context.tenant.tenantId;

    const storedByKey = async (): Promise<ShiftAssignment | null> => {
      const [row] = await tx
        .select()
        .from(shiftAssignments)
        .where(
          and(
            eq(shiftAssignments.tenantId, tenantId),
            eq(shiftAssignments.createIdempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!row) return null;
      // The key is tenant-wide: another outlet's row is never handed back, and
      // neither is a row made from other data under the same key.
      if (
        lower(row.outletId) !== lower(input.outletId) ||
        lower(row.employeeId) !== lower(input.employeeId) ||
        row.businessDate !== input.businessDate ||
        lower(row.shiftTemplateId ?? "") !== lower(input.shiftTemplateId)
      )
        throw keyReused();
      return toShiftAssignment(row);
    };
    const early = await storedByKey();
    if (early) return { assignment: early, created: false };

    const zone = await loadOutletZone(tx, tenantId, input.outletId);
    await lockKey(tx, `hris:shift:${tenantId}:${input.employeeId}`);
    const locked = await storedByKey();
    if (locked) return { assignment: locked, created: false };

    await assertSchedulable(tx, tenantId, input.employeeId, input.outletId);
    const snapshot = await materialise(
      tx,
      tenantId,
      input.outletId,
      zone,
      input,
    );
    let inserted: ShiftRow;
    try {
      // A savepoint keeps the transaction usable after a unique violation.
      [inserted] = await tx.transaction((savepoint) =>
        savepoint
          .insert(shiftAssignments)
          .values({
            tenantId,
            outletId: input.outletId,
            employeeId: input.employeeId,
            shiftTemplateId: snapshot.shiftTemplateId,
            stationId: snapshot.stationId,
            businessDate: input.businessDate,
            segments: snapshot.segments,
            breakMinutes: snapshot.breakMinutes,
            status: "draft",
            source: "user",
            createdBy: access.actorUserId,
            createIdempotencyKey: input.idempotencyKey,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
      );
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === SHIFT_KEY_CONSTRAINT) {
        // A concurrent create with this key won: its row is the replay.
        const raced = await storedByKey();
        if (raced) return { assignment: raced, created: false };
        // RLS hides the row of an outlet outside the caller's reach: the key
        // is taken tenant-wide all the same.
        throw keyReused();
      }
      if (constraint === SHIFT_ACTIVE_CONSTRAINT) throw shiftDuplicate();
      throw error;
    }
    await auditShift(
      tx,
      context,
      actorUserId,
      now,
      inserted,
      "hris.shift_assignment.created",
    );
    return { assignment: toShiftAssignment(inserted), created: true };
  });
  onOutcome?.({ created: result.created });
  return result.assignment;
}

/** PATCH /api/hris/shifts/:assignmentId — draft only; segments are re-derived. */
export async function updateShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  assignmentId: string,
  input: UpdateBody,
  now = new Date(),
): Promise<ShiftAssignment> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const current = await findAssignment(tx, tenantId, assignmentId, true);
    if (!current) throw scheduleNotFound();
    assertManage(access, current.outletId);
    if (current.status !== "draft")
      throw conflict(
        "SHIFT_NOT_DRAFT",
        "Hanya jadwal draft yang bisa diubah; batalkan lalu buat ulang.",
      );

    const employeeId = input.employeeId ?? current.employeeId;
    const businessDate = input.businessDate ?? current.businessDate;
    const shiftTemplateId = input.shiftTemplateId ?? current.shiftTemplateId;
    if (!shiftTemplateId)
      throw validation("Pilih template shift untuk jadwal ini.");
    if (lower(employeeId) !== lower(current.employeeId))
      await assertSchedulable(tx, tenantId, employeeId, current.outletId);

    const zone = await loadOutletZone(tx, tenantId, current.outletId);
    const templateChanged =
      lower(shiftTemplateId) !== lower(current.shiftTemplateId ?? "");
    const resnapshot = templateChanged || businessDate !== current.businessDate;
    // An explicit station wins; a template switch drops the old station so the
    // new template's own station applies; otherwise keep what is stored.
    const stationInput =
      input.stationId !== undefined
        ? input.stationId
        : templateChanged
          ? null
          : current.stationId;
    const snapshot = resnapshot
      ? await materialise(tx, tenantId, current.outletId, zone, {
          shiftTemplateId,
          stationId: stationInput,
          businessDate,
        })
      : {
          segments: current.segments,
          breakMinutes: current.breakMinutes,
          shiftTemplateId,
          stationId: stationInput,
        };
    if (!resnapshot && snapshot.stationId)
      await assertStation(tx, tenantId, current.outletId, snapshot.stationId);

    let updated: ShiftRow;
    try {
      [updated] = await tx
        .update(shiftAssignments)
        .set({
          employeeId,
          businessDate,
          shiftTemplateId: snapshot.shiftTemplateId,
          stationId: snapshot.stationId,
          segments: snapshot.segments,
          breakMinutes: snapshot.breakMinutes,
          updatedAt: now,
        })
        .where(
          and(
            eq(shiftAssignments.tenantId, tenantId),
            eq(shiftAssignments.id, current.id),
          ),
        )
        .returning();
    } catch (error) {
      // The request fails whole, so no savepoint: the transaction rolls back.
      if (uniqueViolation(error) !== null) throw shiftDuplicate();
      throw error;
    }
    await auditShift(
      tx,
      context,
      actorUserId,
      now,
      updated,
      "hris.shift_assignment.updated",
    );
    return toShiftAssignment(updated);
  });
}

/**
 * POST /api/hris/shifts/:assignmentId/cancel — repeating it returns the
 * cancelled row. A pending swap on the shift is withdrawn with it. A published
 * or swapped shift emits `shift.cancelled` for its owner (the employee was
 * told about it); a draft was never announced, so nothing is emitted.
 */
export async function cancelShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  assignmentId: string,
  now = new Date(),
): Promise<ShiftAssignment> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const found = await findAssignment(
      tx,
      context.tenant.tenantId,
      assignmentId,
    );
    if (!found) throw scheduleNotFound();
    assertManage(access, found.outletId);
    return cancelShiftAssignmentInTx(
      tx,
      context,
      access.actorUserId,
      assignmentId,
      now,
    );
  });
}

/**
 * Cancels the shift only if it is still a draft, checked on the locked row in
 * the same transaction as the cancel (no read-then-cancel gap): a shift a
 * manager published meanwhile is returned untouched. For the Tanya AI
 * rollback of the drafts it inserted. Same access check and effects as
 * `cancelShiftAssignment`.
 */
export async function cancelDraftShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  assignmentId: string,
  now = new Date(),
): Promise<ShiftAssignment> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const found = await findAssignment(
      tx,
      context.tenant.tenantId,
      assignmentId,
    );
    if (!found) throw scheduleNotFound();
    assertManage(access, found.outletId);
    return cancelShiftAssignmentInTx(
      tx,
      context,
      access.actorUserId,
      assignmentId,
      now,
      true,
    );
  });
}

/**
 * The cancel itself, inside the caller's tenant transaction, for a caller
 * that has already authorised it: `cancelShiftAssignment` above (schedule
 * manager of the outlet) and exit clearance (`hris-offboarding.service.ts`,
 * HR manager of the employee; legend-ovxw), which cancels every shift after
 * the last working day in the same transaction as the access revocation.
 * Same effects either way: pending swaps withdrawn, `shift.cancelled` for a
 * published or swapped shift, audit rows. A cancelled row is returned as is.
 * `onlyDraft` returns a non-draft row as is, judged on the locked row.
 */
export async function cancelShiftAssignmentInTx(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string | HrisActor,
  assignmentId: string,
  now: Date,
  onlyDraft = false,
): Promise<ShiftAssignment> {
  const tenantId = context.tenant.tenantId;
  const found = await findAssignment(tx, tenantId, assignmentId);
  if (!found) throw scheduleNotFound();

  // Lock order is swap -> assignment, the same as decideShiftSwapRequest.
  const pendingSwaps = await tx
    .select({
      id: shiftSwapRequests.id,
      outletId: shiftSwapRequests.outletId,
    })
    .from(shiftSwapRequests)
    .where(
      and(
        eq(shiftSwapRequests.tenantId, tenantId),
        eq(shiftSwapRequests.status, "pending"),
        or(
          eq(shiftSwapRequests.fromAssignmentId, found.id),
          eq(shiftSwapRequests.toAssignmentId, found.id),
        ),
      ),
    )
    .orderBy(asc(shiftSwapRequests.id))
    .for("update");
  const current = await findAssignment(tx, tenantId, assignmentId, true);
  if (!current) throw scheduleNotFound();
  if (current.status === "cancelled") return toShiftAssignment(current);
  if (onlyDraft && current.status !== "draft")
    return toShiftAssignment(current);

  const status = transitionShiftAssignment(current.status, "cancel");
  const [updated] = await tx
    .update(shiftAssignments)
    .set({ status, updatedAt: now })
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        eq(shiftAssignments.id, current.id),
      ),
    )
    .returning();
  if (pendingSwaps.length > 0) {
    await tx
      .update(shiftSwapRequests)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(shiftSwapRequests.tenantId, tenantId),
          inArray(
            shiftSwapRequests.id,
            pendingSwaps.map((swap) => swap.id),
          ),
        ),
      );
    for (const swap of pendingSwaps)
      await auditShift(
        tx,
        context,
        actorUserId,
        now,
        { ...swap, status: "cancelled" },
        "hris.shift_swap.cancelled",
        HRIS_SWAP_OBJECT_TYPE,
      );
  }
  if (current.status === "published" || current.status === "swapped")
    await appendShiftCancelled(
      tx,
      context,
      updated,
      current.employeeId,
      "cancelled",
      actorUserId,
      now,
    );
  await auditShift(
    tx,
    context,
    actorUserId,
    now,
    updated,
    "hris.shift_assignment.cancelled",
  );
  return toShiftAssignment(updated);
}

/** The roster as the first copy left it: the ledger's ids, whatever their status now. */
async function presentCopy(
  tx: Tx,
  copy: typeof rosterCopies.$inferSelect,
): Promise<RosterView> {
  const rows = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, copy.tenantId),
        inArray(shiftAssignments.id, copy.assignmentIds),
      ),
    )
    .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id));
  const assignments = rows.map(toShiftAssignment);
  const live = assignments.filter((row) => row.status !== "cancelled");
  return {
    outletId: copy.outletId,
    weekStart: copy.toWeekStart,
    published: isRosterPublished(live),
    assignments,
    complianceIssues: await weekCompliance(
      tx,
      copy.tenantId as TenantId,
      copy.outletId,
      copy.toWeekStart,
      live,
    ),
  } as RosterView;
}

function shiftInstant(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

/**
 * POST /api/hris/rosters/copy — non-cancelled shifts of the source week become
 * drafts in the target week (dates shifted, segments re-derived from the
 * template in the outlet zone). Employees who are no longer active at the
 * outlet, or on approved leave that day, are skipped. The key is kept in
 * `roster_copies` with the created ids, in the same transaction as the drafts:
 * a replay returns the roster of those ids and writes nothing. A target week
 * that already holds live shifts (and no copy under this key) is a 409.
 */
export async function copyRosterWeek(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CopyBody,
  now = new Date(),
): Promise<RosterView> {
  assertMonday(input.fromWeekStart);
  assertMonday(input.toWeekStart);
  if (input.fromWeekStart === input.toWeekStart)
    throw validation("Minggu tujuan harus berbeda dari minggu asal.");
  const dayOffset = Math.round(
    (Date.parse(`${input.toWeekStart}T00:00:00.000Z`) -
      Date.parse(`${input.fromWeekStart}T00:00:00.000Z`)) /
      DAY_MS,
  );

  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertManage(access, input.outletId);
    const tenantId = context.tenant.tenantId;
    const zone = await loadOutletZone(tx, tenantId, input.outletId);
    await lockKey(
      tx,
      `hris:roster:${tenantId}:${input.outletId}:${input.toWeekStart}`,
    );
    // The key is tenant-wide, so a replay on another week must serialise too.
    await lockKey(
      tx,
      `hris:roster-copy-key:${tenantId}:${input.idempotencyKey}`,
    );

    const [replayed] = await tx
      .select()
      .from(rosterCopies)
      .where(
        and(
          eq(rosterCopies.tenantId, tenantId),
          eq(rosterCopies.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (replayed) {
      if (
        lower(replayed.outletId) !== lower(input.outletId) ||
        replayed.fromWeekStart !== input.fromWeekStart ||
        replayed.toWeekStart !== input.toWeekStart
      )
        throw keyReused();
      return presentCopy(tx, replayed);
    }

    const existing = await loadWeek(
      tx,
      tenantId,
      input.outletId,
      input.toWeekStart,
    );
    const notEmpty = () =>
      conflict(
        "ROSTER_NOT_EMPTY",
        "Minggu tujuan sudah berisi jadwal; kosongkan atau batalkan dulu.",
      );
    if (existing.length > 0) throw notEmpty();
    const source = await loadWeek(
      tx,
      tenantId,
      input.outletId,
      input.fromWeekStart,
    );
    if (source.length === 0)
      throw validation("Minggu asal tidak punya jadwal untuk disalin.");

    const employeeIds = [...new Set(source.map((row) => row.employeeId))];
    const eligible = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(employees.id, employeeIds),
          eq(employees.status, "active"),
          eq(employees.homeOutletId, input.outletId),
        ),
      );
    const eligibleIds = new Set(eligible.map((row) => lower(row.id)));
    const targetEnd = addBusinessDays(input.toWeekStart, 6);
    const leaves = await tx
      .select({
        employeeId: leaveRequests.employeeId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.status, "approved"),
          inArray(leaveRequests.employeeId, employeeIds),
          lte(leaveRequests.startDate, targetEnd),
          gte(leaveRequests.endDate, input.toWeekStart),
        ),
      );
    const onLeave = (employeeId: string, date: string) =>
      leaves.some(
        (leave) =>
          lower(leave.employeeId) === lower(employeeId) &&
          leave.startDate <= date &&
          leave.endDate >= date,
      );

    const templates = new Map<string, ShiftTemplate>();
    const values: (typeof shiftAssignments.$inferInsert)[] = [];
    for (const row of source) {
      if (!eligibleIds.has(lower(row.employeeId))) continue;
      const businessDate = addBusinessDays(row.businessDate, dayOffset);
      if (onLeave(row.employeeId, businessDate)) continue;
      let template: ShiftTemplate | null = null;
      if (row.shiftTemplateId) {
        template = templates.get(row.shiftTemplateId) ?? null;
        if (!template) {
          const [templateRow] = await tx
            .select()
            .from(shiftTemplates)
            .where(
              and(
                eq(shiftTemplates.tenantId, tenantId),
                eq(shiftTemplates.id, row.shiftTemplateId),
              ),
            )
            .limit(1);
          if (templateRow) {
            template = toShiftTemplate(templateRow);
            templates.set(row.shiftTemplateId, template);
          }
        }
      }
      values.push({
        tenantId,
        outletId: input.outletId,
        employeeId: row.employeeId,
        shiftTemplateId: row.shiftTemplateId,
        stationId: row.stationId,
        businessDate,
        // Template gone: keep the stored interval, moved by whole days.
        segments: template
          ? segmentsFromTemplate(template, businessDate, zone)
          : row.segments.map((segment) => ({
              startsAt: shiftInstant(segment.startsAt, dayOffset),
              endsAt: shiftInstant(segment.endsAt, dayOffset),
            })),
        breakMinutes: template ? template.breakMinutes : row.breakMinutes,
        status: "draft",
        source: "user",
        createdBy: access.actorUserId,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (values.length === 0)
      throw validation(
        "Tidak ada jadwal yang bisa disalin: karyawan tidak aktif atau sedang cuti.",
      );

    let inserted: ShiftRow[];
    try {
      inserted = await tx.insert(shiftAssignments).values(values).returning();
    } catch (error) {
      // A create racing this copy took one of the slots: the week is not empty.
      if (uniqueViolation(error) === SHIFT_ACTIVE_CONSTRAINT) throw notEmpty();
      throw error;
    }
    try {
      await tx.transaction((savepoint) =>
        savepoint.insert(rosterCopies).values({
          tenantId,
          outletId: input.outletId,
          fromWeekStart: input.fromWeekStart,
          toWeekStart: input.toWeekStart,
          idempotencyKey: input.idempotencyKey,
          assignmentIds: inserted.map((row) => row.id),
          createdBy: access.actorUserId,
          createdAt: now,
        }),
      );
    } catch (error) {
      // RLS hid the ledger row of an outlet outside the caller's reach.
      if (uniqueViolation(error) === COPY_KEY_CONSTRAINT) throw keyReused();
      throw error;
    }
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actorUserId, now, {
        outletId: input.outletId,
        action: "hris.roster.copied",
        objectType: HRIS_ROSTER_OBJECT_TYPE,
        objectId: inserted[0].id,
        after: { status: "draft" },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return buildRoster(tx, tenantId, input.outletId, input.toWeekStart);
  });
}

// ---------------------------------------------------------------- publish

/** The publication as first answered: the stored snapshot, not today's rows. */
function presentPublication(
  publication: typeof rosterPublications.$inferSelect,
): RosterPublication {
  return {
    outletId: publication.outletId,
    weekStart: publication.weekStart,
    assignments: publication.snapshot,
    complianceIssues: publication.complianceIssues,
    publishedBy: userIdSchema.parse(publication.publishedBy),
    publishedAt: publication.publishedAt.toISOString(),
  } as RosterPublication;
}

/**
 * POST /api/hris/rosters/publish — every draft of the outlet-week becomes
 * published, with compliance warnings frozen on the publication and one
 * `shift.published` event per assignment, all in one transaction. The
 * publication keeps the ids and a snapshot of what was published; the same
 * idempotency key returns that snapshot and emits nothing again, even after a
 * later cancel.
 */
export async function publishRoster(
  context: ScopedTenantContext,
  actorUserId: string,
  input: PublishBody,
  now = new Date(),
): Promise<RosterPublication> {
  assertMonday(input.weekStart);
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertManage(access, input.outletId);
    const tenantId = context.tenant.tenantId;
    await loadOutletZone(tx, tenantId, input.outletId);
    await lockKey(
      tx,
      `hris:roster:${tenantId}:${input.outletId}:${input.weekStart}`,
    );
    // The key is tenant-wide, so a replay on another week must serialise too.
    await lockKey(tx, `hris:roster-key:${tenantId}:${input.idempotencyKey}`);

    const [replayed] = await tx
      .select()
      .from(rosterPublications)
      .where(
        and(
          eq(rosterPublications.tenantId, tenantId),
          eq(rosterPublications.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (replayed) {
      if (
        lower(replayed.outletId) !== lower(input.outletId) ||
        replayed.weekStart !== input.weekStart
      )
        throw keyReused();
      return presentPublication(replayed);
    }

    const drafts = await tx
      .select()
      .from(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.tenantId, tenantId),
          eq(shiftAssignments.outletId, input.outletId),
          eq(shiftAssignments.status, "draft"),
          gte(shiftAssignments.businessDate, input.weekStart),
          lte(
            shiftAssignments.businessDate,
            addBusinessDays(input.weekStart, 6),
          ),
        ),
      )
      .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id))
      .for("update");
    if (drafts.length === 0)
      throw conflict(
        "ROSTER_NOTHING_TO_PUBLISH",
        "Tidak ada jadwal draft pada minggu ini untuk dipublikasikan.",
      );

    const published: ShiftRow[] = [];
    for (const draft of drafts) {
      const status = transitionShiftAssignment(draft.status, "publish");
      const [row] = await tx
        .update(shiftAssignments)
        .set({
          status,
          publishedBy: access.actorUserId,
          publishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(shiftAssignments.tenantId, tenantId),
            eq(shiftAssignments.id, draft.id),
          ),
        )
        .returning();
      published.push(row);
    }

    const week = await loadWeek(tx, tenantId, input.outletId, input.weekStart);
    const complianceIssues = await weekCompliance(
      tx,
      tenantId,
      input.outletId,
      input.weekStart,
      week,
    );
    let publication: typeof rosterPublications.$inferSelect;
    try {
      [publication] = await tx.transaction((savepoint) =>
        savepoint
          .insert(rosterPublications)
          .values({
            tenantId,
            outletId: input.outletId,
            weekStart: input.weekStart,
            idempotencyKey: input.idempotencyKey,
            complianceIssues,
            assignmentCount: published.length,
            assignmentIds: published.map((row) => row.id),
            snapshot: published.map(toShiftAssignment),
            publishedBy: access.actorUserId,
            publishedAt: now,
          })
          .returning(),
      );
    } catch (error) {
      // RLS hid the publication of an outlet outside the caller's reach.
      if (uniqueViolation(error) === PUBLICATION_KEY_CONSTRAINT)
        throw keyReused();
      throw error;
    }

    for (const row of published)
      await appendShiftPublished(
        tx,
        context,
        row,
        access.actorUserId,
        now,
        now,
      );
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actorUserId, now, {
        outletId: input.outletId,
        action: "hris.roster.published",
        objectType: HRIS_ROSTER_OBJECT_TYPE,
        objectId: publication.id,
        after: { status: "published" },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return presentPublication(publication);
  });
}
