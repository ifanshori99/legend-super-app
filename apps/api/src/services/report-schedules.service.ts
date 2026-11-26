// Report delivery schedules (WS-11 F12, bead legend-ay6e6; contract
// `reportScheduleSchema`, `reportScheduleGate` in `@starter/shared/dashboard`).
//
// v1 (CTO 27 Nov, legend-hyq not done): a due schedule produces, per
// recipient, one export job (`report_exports` with `schedule_id`) generated
// under THAT recipient's own access, a downloadable file, and an in-app
// notification `report_delivery` that also goes out by email when the email
// channel is configured. No WhatsApp. The notification names the report and
// the period only; figures stay behind the download, which re-checks the
// reader's permission.
//
// Rules:
// - A schedule belongs to its owner (404 for anyone else) and points at the
//   owner's saved report. A personal-data query is never scheduled
//   (DASH-04, `reportScheduleGate`): refused on save, skipped on run.
// - Every recipient must be a tenant user who may export the query now; a
//   recipient who lost that right by run time is skipped (no job, no file).
// - Period: the saved period's length, ending on the business date before
//   the run date in the schedule's time zone (a daily schedule of a 1-day
//   query sends yesterday; a 7-day query sends the last 7 days).
// - `time_zone` is the first requested outlet's, else the tenant's first open
//   outlet's, else Asia/Jakarta; `next_run_at` is the next HH:MM there that
//   matches the frequency. A slot runs once: (schedule, slot, recipient) is
//   unique, so an overlapping tick inserts nothing twice.
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  type CursorPageQuery,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  reportBuilderQuerySchema,
  reportScheduleGate,
  reportSchedulePageSchema,
  reportScheduleSchema,
  type CreateReportScheduleInput,
  type ReportBuilderQuery,
  type ReportExportQuery,
  type ReportSchedule,
  type ReportSchedulePage,
  type UpdateReportScheduleInput,
} from "@starter/shared/dashboard";
import { db } from "../db";
import {
  outlets,
  reportExports,
  reportSchedules,
  savedReports,
  user,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { userViewerAccess } from "../routes/report-viewer";
import { recordAudit } from "./audit-writer";
import { zonedInstant } from "./facility-rules";
import { gateExport, type ExportSource } from "./report-exports.service";
import { reportHttpError } from "./report-run.service";
import { ownSavedReportRow } from "./report-saved.service";

type Row = typeof reportSchedules.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const DEFAULT_SCHEDULE_TIME_ZONE = "Asia/Jakarta";
/** Due schedules one tick runs per tenant. */
export const REPORT_SCHEDULE_BATCH = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const tenantWide = (tenant: TenantContext) =>
  establishScopedTenantContext(tenant, { kind: "tenant" });

// ---- Clock --------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

type Cadence = {
  readonly frequency: "daily" | "weekly" | "monthly";
  readonly timeOfDay: string;
  readonly dayOfWeek: number | null;
  readonly dayOfMonth: number | null;
};

/** The first slot strictly after `after` in `timeZone`. */
export function nextRunAfter(
  cadence: Cadence,
  timeZone: string,
  after: Date,
): Date {
  const [hh, mm] = cadence.timeOfDay.split(":").map(Number);
  const minutes = hh * 60 + mm;
  const start = addDays(localDate(after, timeZone), -1);
  for (let offset = 0; offset <= 62; offset += 1) {
    const date = addDays(start, offset);
    const matches =
      cadence.frequency === "daily" ||
      (cadence.frequency === "weekly" &&
        isoWeekday(date) === cadence.dayOfWeek) ||
      (cadence.frequency === "monthly" &&
        Number(date.slice(8, 10)) === cadence.dayOfMonth);
    if (!matches) continue;
    const at = zonedInstant(date, minutes, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("No schedule slot within 62 days");
}

/** The saved period's length, ending the day before the run's local date. */
export function rolledPeriod(
  period: { startDate: string; endDate: string },
  slot: Date,
  timeZone: string,
): { startDate: string; endDate: string } {
  const length = Math.round(
    (Date.parse(`${period.endDate}T00:00:00Z`) -
      Date.parse(`${period.startDate}T00:00:00Z`)) /
      DAY_MS,
  );
  const endDate = addDays(localDate(slot, timeZone), -1);
  return { startDate: addDays(endDate, -length), endDate };
}

/** Export selection of one scheduled run of `query`. */
export function scheduledExportQuery(
  query: ReportBuilderQuery,
  slot: Date,
  timeZone: string,
): ReportExportQuery {
  return {
    period: rolledPeriod(query.period, slot, timeZone),
    ...(query.outletIds === undefined ? {} : { outletIds: query.outletIds }),
    groupBy: query.groupBy,
    filters: query.filters,
    bucket: query.bucket,
  };
}

async function timeZoneFor(
  tx: Tx,
  context: ScopedTenantContext,
  query: ReportBuilderQuery,
): Promise<string> {
  const first = query.outletIds?.[0];
  const [row] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        first === undefined
          ? sql`${outlets.status} <> 'closed'`
          : eq(outlets.id, first),
      ),
    )
    .orderBy(asc(outlets.id))
    .limit(1);
  return row?.timezone ?? DEFAULT_SCHEDULE_TIME_ZONE;
}

// ---- Mapping ------------------------------------------------------------------

export function toReportSchedule(row: Row): ReportSchedule {
  return reportScheduleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    savedReportId: row.savedReportId,
    frequency: row.frequency,
    timeOfDay: row.timeOfDay,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    format: row.format,
    recipientUserIds: row.recipientUserIds,
    isEnabled: row.isEnabled,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function savedSource(row: typeof savedReports.$inferSelect): ExportSource {
  return {
    kind: "saved",
    savedReportId: row.id,
    name: row.name,
    query: reportBuilderQuerySchema.parse(row.query),
  };
}

/**
 * True when `userId` may receive the export now: an active tenant user whose
 * own access passes the export gate without an approval.
 */
async function mayReceive(
  tenant: TenantContext,
  userId: string,
  source: ExportSource,
  format: "csv" | "xlsx" | "pdf",
  query: ReportExportQuery,
): Promise<boolean> {
  try {
    const access = await userViewerAccess(tenant, userId);
    const { gate } = await gateExport(access, source, format, query, "none");
    return gate.action === "queue" && !gate.containsPersonalData;
  } catch {
    return false;
  }
}

// ---- Create / update ----------------------------------------------------------

type Settings = Omit<CreateReportScheduleInput, "savedReportId">;

/**
 * Checks the settings for the owner: the saved report is theirs and not
 * personal data, the owner may export it, every recipient may receive it.
 */
async function checkSettings(
  tenant: TenantContext,
  ownerUserId: string,
  savedReportId: string,
  settings: Settings,
): Promise<{ source: ExportSource; timeZone: string }> {
  const context = tenantWide(tenant);
  const { saved, timeZone } = await withTenant(db, context, async (tx) => {
    const saved = await ownSavedReportRow(
      tx,
      context,
      ownerUserId,
      savedReportId,
    );
    const query = reportBuilderQuerySchema.parse(saved.query);
    return { saved, timeZone: await timeZoneFor(tx, context, query) };
  });
  const source = savedSource(saved);
  if (source.kind !== "saved") throw new Error("unreachable");
  const gate = reportScheduleGate(source.query);
  if (gate.action === "reject") throw reportHttpError(gate.code);
  const query = scheduledExportQuery(source.query, new Date(), timeZone);
  await gateExport(
    await userViewerAccess(tenant, ownerUserId),
    source,
    settings.format,
    query,
    "none",
  );
  for (const userId of settings.recipientUserIds)
    if (!(await mayReceive(tenant, userId, source, settings.format, query)))
      throw new HttpError(
        400,
        "REPORT_SCHEDULE_INVALID",
        "Ada penerima yang tidak berhak menerima laporan ini.",
      );
  return { source, timeZone };
}

async function auditSchedule(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  action: string,
  actorId: string,
): Promise<void> {
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId,
      deviceId: null,
      action,
      objectType: "report_schedule",
      objectId: row.id,
      reason: null,
      before: null,
      after: {
        savedReportId: row.savedReportId,
        frequency: row.frequency,
        format: row.format,
        recipientCount: (row.recipientUserIds as unknown[]).length,
        isEnabled: row.isEnabled,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
}

export async function createReportSchedule(
  tenant: TenantContext,
  ownerUserId: string,
  input: CreateReportScheduleInput,
  now = new Date(),
): Promise<ReportSchedule> {
  const { timeZone } = await checkSettings(
    tenant,
    ownerUserId,
    input.savedReportId,
    input,
  );
  const context = tenantWide(tenant);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(reportSchedules)
      .values({
        tenantId: tenant.tenantId,
        savedReportId: input.savedReportId,
        ownerUserId,
        frequency: input.frequency,
        timeOfDay: input.timeOfDay,
        dayOfWeek: input.dayOfWeek,
        dayOfMonth: input.dayOfMonth,
        format: input.format,
        recipientUserIds: input.recipientUserIds,
        timeZone,
        isEnabled: true,
        nextRunAt: nextRunAfter(input, timeZone, now),
      })
      .returning();
    if (row === undefined) throw new Error("Schedule insert returned no row");
    await auditSchedule(
      tx,
      context,
      row,
      "report_schedule.created",
      ownerUserId,
    );
    return toReportSchedule(row);
  });
}

async function ownScheduleRow(
  tx: Tx,
  context: ScopedTenantContext,
  ownerUserId: string,
  id: string,
): Promise<Row> {
  const [row] = await tx
    .select()
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.tenantId, context.tenant.tenantId),
        eq(reportSchedules.ownerUserId, ownerUserId),
        eq(reportSchedules.id, id),
      ),
    )
    .for("update");
  if (row === undefined)
    throw new HttpError(404, "NOT_FOUND", "Jadwal laporan tidak ditemukan.");
  return row;
}

export async function updateReportSchedule(
  tenant: TenantContext,
  ownerUserId: string,
  id: string,
  input: UpdateReportScheduleInput,
  now = new Date(),
): Promise<ReportSchedule> {
  const context = tenantWide(tenant);
  const current = await withTenant(db, context, (tx) =>
    ownScheduleRow(tx, context, ownerUserId, id),
  );
  const { timeZone } = input.isEnabled
    ? await checkSettings(tenant, ownerUserId, current.savedReportId, input)
    : { timeZone: current.timeZone };
  return withTenant(db, context, async (tx) => {
    await ownScheduleRow(tx, context, ownerUserId, id);
    const [row] = await tx
      .update(reportSchedules)
      .set({
        frequency: input.frequency,
        timeOfDay: input.timeOfDay,
        dayOfWeek: input.dayOfWeek,
        dayOfMonth: input.dayOfMonth,
        format: input.format,
        recipientUserIds: input.recipientUserIds,
        timeZone,
        isEnabled: input.isEnabled,
        nextRunAt: input.isEnabled ? nextRunAfter(input, timeZone, now) : null,
        updatedAt: sql`greatest(now(), ${reportSchedules.createdAt})`,
      })
      .where(
        and(
          eq(reportSchedules.tenantId, tenant.tenantId),
          eq(reportSchedules.id, id),
        ),
      )
      .returning();
    if (row === undefined)
      throw new HttpError(404, "NOT_FOUND", "Jadwal laporan tidak ditemukan.");
    await auditSchedule(
      tx,
      context,
      row,
      "report_schedule.updated",
      ownerUserId,
    );
    return toReportSchedule(row);
  });
}

export async function listReportSchedules(
  tenant: TenantContext,
  ownerUserId: string,
  query: CursorPageQuery,
): Promise<ReportSchedulePage> {
  let after: { at: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    }
    const [at, id] = keys;
    if (typeof at !== "string" || typeof id !== "string")
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    after = { at, id };
  }
  const context = tenantWide(tenant);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        ...getTableColumns(reportSchedules),
        cursorAt: sql<string>`${reportSchedules.createdAt}::text`,
      })
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.tenantId, tenant.tenantId),
          eq(reportSchedules.ownerUserId, ownerUserId),
          after === undefined
            ? sql`TRUE`
            : sql`(${reportSchedules.createdAt}, ${reportSchedules.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(reportSchedules.createdAt), desc(reportSchedules.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return reportSchedulePageSchema.parse({
    data: page.map(toReportSchedule),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCursor([last.cursorAt, last.id])
          : null,
    },
  });
}

// ---- Run ----------------------------------------------------------------------

export type ScheduleRunResult = {
  schedules: number;
  jobs: number;
  skippedRecipients: number;
};

/**
 * Turns due schedules into per-recipient export jobs and moves each schedule
 * to its next slot. The jobs are generated by `sweepReportExports` (same
 * tick, right after); a ready scheduled job notifies its recipient.
 */
export async function runDueReportSchedules(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<ScheduleRunResult> {
  const tenant = context.tenant;
  const wide = tenantWide(tenant);
  const result: ScheduleRunResult = {
    schedules: 0,
    jobs: 0,
    skippedRecipients: 0,
  };
  const due = await withTenant(db, wide, (tx) =>
    tx
      .select({ id: reportSchedules.id })
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.tenantId, tenant.tenantId),
          eq(reportSchedules.isEnabled, true),
          isNotNull(reportSchedules.nextRunAt),
          lte(reportSchedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(REPORT_SCHEDULE_BATCH),
  );
  for (const { id } of due) {
    try {
      const made = await runOneSchedule(tenant, id, now);
      if (made === null) continue;
      result.schedules += 1;
      result.jobs += made.jobs;
      result.skippedRecipients += made.skipped;
    } catch (error) {
      logger.error(
        { errName: (error as Error)?.name, scheduleId: id },
        "Report schedule run failed",
      );
    }
  }
  return result;
}

async function runOneSchedule(
  tenant: TenantContext,
  id: string,
  now: Date,
): Promise<{ jobs: number; skipped: number } | null> {
  const wide = tenantWide(tenant);
  const claimed = await withTenant(db, wide, async (tx) => {
    const [schedule] = await tx
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.tenantId, tenant.tenantId),
          eq(reportSchedules.id, id),
          eq(reportSchedules.isEnabled, true),
          lte(reportSchedules.nextRunAt, now),
        ),
      )
      .for("update", { skipLocked: true });
    if (schedule === undefined || schedule.nextRunAt === null) return null;
    const [saved] = await tx
      .select()
      .from(savedReports)
      .where(
        and(
          eq(savedReports.tenantId, tenant.tenantId),
          eq(savedReports.id, schedule.savedReportId),
          eq(savedReports.ownerUserId, schedule.ownerUserId),
        ),
      );
    const slot = schedule.nextRunAt;
    // Advance first: a failing slot is skipped, never retried every tick.
    await tx
      .update(reportSchedules)
      .set({
        lastRunAt: slot,
        nextRunAt: nextRunAfter(
          {
            frequency: schedule.frequency as Cadence["frequency"],
            timeOfDay: schedule.timeOfDay,
            dayOfWeek: schedule.dayOfWeek,
            dayOfMonth: schedule.dayOfMonth,
          },
          schedule.timeZone,
          new Date(Math.max(slot.getTime(), now.getTime())),
        ),
      })
      .where(
        and(
          eq(reportSchedules.tenantId, tenant.tenantId),
          eq(reportSchedules.id, id),
        ),
      );
    return { schedule, saved, slot };
  });
  if (claimed === null) return null;
  const { schedule, saved, slot } = claimed;
  if (saved === undefined || saved.status !== "active")
    return { jobs: 0, skipped: 0 };
  const source = savedSource(saved);
  if (source.kind !== "saved") return null;
  // DASH-04: a saved query edited into a person split is never delivered.
  if (reportScheduleGate(source.query).action === "reject")
    return { jobs: 0, skipped: 0 };
  const format = schedule.format as "csv" | "xlsx" | "pdf";
  const query = scheduledExportQuery(source.query, slot, schedule.timeZone);
  const recipients = schedule.recipientUserIds as string[];
  const active = new Set(
    (
      await withTenant(db, wide, (tx) =>
        tx
          .select({ id: user.id })
          .from(user)
          .where(
            and(
              inArray(user.id, recipients),
              sql`coalesce(${user.banned}, false) = false`,
            ),
          ),
      )
    ).map((row) => row.id),
  );
  let jobs = 0;
  let skipped = 0;
  for (const userId of recipients) {
    if (
      !active.has(userId) ||
      !(await mayReceive(tenant, userId, source, format, query))
    ) {
      skipped += 1;
      continue;
    }
    const inserted = await withTenant(db, wide, async (tx) => {
      const [row] = await tx
        .insert(reportExports)
        .values({
          tenantId: tenant.tenantId,
          requestedBy: userId,
          savedReportId: saved.id,
          scheduleId: schedule.id,
          scheduledFor: slot,
          format,
          query,
          containsPersonalData: false,
          status: "queued",
          requestedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (row === undefined) return false;
      await recordAudit(
        {
          tenantId: tenant.tenantId,
          outletId: null,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "report_export.requested",
          objectType: "report_export",
          objectId: row.id,
          reason: null,
          before: null,
          after: {
            savedReportId: saved.id,
            scheduleId: schedule.id,
            format,
            containsPersonalData: false,
            status: "queued",
          },
          sensitiveAccess: false,
        },
        { tx, context: wide },
      );
      return true;
    });
    if (inserted) jobs += 1;
  }
  return { jobs, skipped };
}
