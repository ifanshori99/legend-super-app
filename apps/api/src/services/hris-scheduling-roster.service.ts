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
//   (transactional outbox, destination `cloud-sync`). Compliance (F26) is a
//   warning on publish; HR-05 only blocks swaps.
// - `shift_assignments` and the copy have no idempotency column. A replayed
//   create returns the matching active assignment; a replayed copy meets the
//   non-empty target week and answers 409. Publish has its own ledger
//   (`roster_publications`), so a replayed key returns the first result and
//   emits nothing twice.
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
  createUlid,
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
  shiftPublished,
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
  rosterPublications,
  shiftAssignments,
  shiftSwapRequests,
  shiftTemplates,
} from "../db/schema/hris-scheduling.ts";
import { stations } from "../db/schema/menu.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import {
  loadWeekAssignments,
  resolveCompliancePolicy,
  segmentsFromTemplate,
  toShiftAssignment,
  toShiftTemplate,
} from "./hris-scheduling-common.ts";

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

/**
 * `shift.published` goes to cloud sync and to the notification consumer; the
 * notification rule for it lives in worker/notification-adapters.ts `ruleFor`.
 */
export const SHIFT_EVENT_DESTINATIONS = ["cloud-sync", "notification"] as const;

/** Days of other weeks loaded around a week so rest and run limits see them. */
const COMPLIANCE_CONTEXT_DAYS = 7;
const DAY_MS = 86_400_000;

function validation(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
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
  actor: string,
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

// ----------------------------------------------------------------- events

async function nextShiftEventSequence(
  tx: Tx,
  tenantId: string,
  destination: string,
  assignmentId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, destination),
        eq(domainEventOutbox.aggregateType, shiftPublished.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, assignmentId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * Appends `shift.published` in the caller's transaction, once per destination.
 * The aggregate is the assignment, so a later change (swap) re-emits with the
 * next sequence and a sequence-bound idempotency key. The assignment row lock
 * (or the outlet-week lock on publish) serialises the sequence. Segments and
 * ids only: no employee name or pay in the payload.
 */
export async function appendShiftPublished(
  tx: Tx,
  context: ScopedTenantContext,
  row: ShiftRow,
  now: Date,
): Promise<void> {
  if (!row.publishedBy || !row.publishedAt)
    throw new Error("shift.published needs a published assignment");
  const publishedBy = userIdSchema.parse(row.publishedBy);
  for (const destination of SHIFT_EVENT_DESTINATIONS) {
    const sequence = await nextShiftEventSequence(
      tx,
      row.tenantId,
      destination,
      row.id,
    );
    const event = shiftPublished.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: shiftPublished.name,
      version: shiftPublished.version,
      aggregateType: shiftPublished.entry.aggregateType,
      aggregateId: row.id,
      sequence,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: publishedBy },
      deviceId: null,
      idempotencyKey: `${shiftPublished.name}:${row.id}:${sequence}`,
      payloadSchemaRef: shiftPublished.payloadSchemaRef,
      payload: {
        shiftAssignmentId: row.id,
        employeeId: row.employeeId,
        outletId: row.outletId,
        shiftTemplateId: row.shiftTemplateId,
        stationId: row.stationId,
        businessDate: row.businessDate,
        segments: row.segments,
        publishedBy,
        publishedAt: row.publishedAt.toISOString(),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
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
 * POST /api/hris/shifts — a draft assignment. A replay (same employee, day and
 * template still active) returns the stored assignment.
 */
export async function createShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateBody,
  now = new Date(),
): Promise<ShiftAssignment> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertManage(access, input.outletId);
    const tenantId = context.tenant.tenantId;
    const zone = await loadOutletZone(tx, tenantId, input.outletId);
    await lockKey(tx, `hris:shift:${tenantId}:${input.employeeId}`);

    const [replayed] = await tx
      .select()
      .from(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.tenantId, tenantId),
          eq(shiftAssignments.outletId, input.outletId),
          eq(shiftAssignments.employeeId, input.employeeId),
          eq(shiftAssignments.businessDate, input.businessDate),
          eq(shiftAssignments.shiftTemplateId, input.shiftTemplateId),
          ne(shiftAssignments.status, "cancelled"),
        ),
      )
      .limit(1);
    if (replayed) return toShiftAssignment(replayed);

    await assertSchedulable(tx, tenantId, input.employeeId, input.outletId);
    const snapshot = await materialise(
      tx,
      tenantId,
      input.outletId,
      zone,
      input,
    );
    const [inserted] = await tx
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
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await auditShift(
      tx,
      context,
      actorUserId,
      now,
      inserted,
      "hris.shift_assignment.created",
    );
    return toShiftAssignment(inserted);
  });
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

    const [updated] = await tx
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
 * cancelled row. A pending swap on the shift is withdrawn with it. No
 * `shift.published` is emitted for a cancel (the event has no cancel shape).
 */
export async function cancelShiftAssignment(
  context: ScopedTenantContext,
  actorUserId: string,
  assignmentId: string,
  now = new Date(),
): Promise<ShiftAssignment> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const found = await findAssignment(tx, tenantId, assignmentId);
    if (!found) throw scheduleNotFound();
    assertManage(access, found.outletId);

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
    await auditShift(
      tx,
      context,
      actorUserId,
      now,
      updated,
      "hris.shift_assignment.cancelled",
    );
    return toShiftAssignment(updated);
  });
}

function shiftInstant(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

/**
 * POST /api/hris/rosters/copy — non-cancelled shifts of the source week become
 * drafts in the target week (dates shifted, segments re-derived from the
 * template in the outlet zone). Employees who are no longer active at the
 * outlet, or on approved leave that day, are skipped. A non-empty target week is a
 * 409 unless it already holds every assignment this copy would create, in which
 * case it is a replay and returns the current roster without writing.
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
    const source = await loadWeek(
      tx,
      tenantId,
      input.outletId,
      input.fromWeekStart,
    );
    if (source.length === 0) {
      if (existing.length > 0) throw notEmpty();
      throw validation("Minggu asal tidak punya jadwal untuk disalin.");
    }

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
    if (existing.length > 0) {
      // Replay: every assignment this copy would create is already there, so
      // return the current roster without writing rows or events.
      const key = (
        employeeId: string,
        shiftTemplateId: string | null,
        businessDate: string,
      ) => `${lower(employeeId)}|${shiftTemplateId ?? ""}|${businessDate}`;
      const present = new Set(
        existing.map((row) =>
          key(row.employeeId, row.shiftTemplateId, row.businessDate),
        ),
      );
      const replay =
        values.length > 0 &&
        values.every((value) =>
          present.has(
            key(
              value.employeeId,
              value.shiftTemplateId ?? null,
              value.businessDate,
            ),
          ),
        );
      if (!replay) throw notEmpty();
      return buildRoster(tx, tenantId, input.outletId, input.toWeekStart);
    }
    if (values.length === 0)
      throw validation(
        "Tidak ada jadwal yang bisa disalin: karyawan tidak aktif atau sedang cuti.",
      );

    const inserted = await tx
      .insert(shiftAssignments)
      .values(values)
      .returning();
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

async function presentPublication(
  tx: Tx,
  publication: typeof rosterPublications.$inferSelect,
): Promise<RosterPublication> {
  // The batch is the rows stamped with this publication's instant; later
  // cancellations stay visible (status) instead of silently shrinking it.
  const rows = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, publication.tenantId),
        eq(shiftAssignments.outletId, publication.outletId),
        eq(shiftAssignments.publishedAt, publication.publishedAt),
      ),
    )
    .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id));
  return {
    outletId: publication.outletId,
    weekStart: publication.weekStart,
    assignments: rows.map(toShiftAssignment),
    complianceIssues: publication.complianceIssues,
    publishedBy: userIdSchema.parse(publication.publishedBy),
    publishedAt: publication.publishedAt.toISOString(),
  } as RosterPublication;
}

/**
 * POST /api/hris/rosters/publish — every draft of the outlet-week becomes
 * published, with compliance warnings frozen on the publication and one
 * `shift.published` event per assignment, all in one transaction. The same
 * idempotency key returns the first result and emits nothing again.
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
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return presentPublication(tx, replayed);
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
    const [publication] = await tx
      .insert(rosterPublications)
      .values({
        tenantId,
        outletId: input.outletId,
        weekStart: input.weekStart,
        idempotencyKey: input.idempotencyKey,
        complianceIssues,
        assignmentCount: published.length,
        publishedBy: access.actorUserId,
        publishedAt: now,
      })
      .returning();

    for (const row of published)
      await appendShiftPublished(tx, context, row, now);
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
    return presentPublication(tx, publication);
  });
}
