// Collective leave ("cuti bersama", founder decision Q7; PRD v1.7 §3 Kelompok
// D 29 "Cuti, Izin & Lembur", F27). Routes: routes/hris-leave.routes.ts
// (settings); the deduction runs from the daily job (hris-leave-jobs.ts).
//
// - Tenant setting `hris_leave_settings`: no row = the defaults (collective
//   leave deducts the annual balance; the annual type is the active type coded
//   `ANNUAL`, none = nothing to deduct). Reading and writing need tenant-wide
//   `hr.employee.manage` in a tenant-wide context; writes are idempotent.
// - Deduction: every collective holiday dated before the Asia/Jakarta local
//   today and on/after the setting `collective_leave_effective_from` (no
//   retroactive flood), in the current and previous local year, takes 1 day as
//   `used` from
//   the annual balance of that holiday's year for each active employee in
//   scope (tenant-wide holiday: everyone; outlet holiday: home outlet = that
//   outlet) who was employed on that date (join/end date). The
//   `leave_accruals` ledger row (kind `collective_leave`, period = the date) is
//   unique per employee and date whatever the leave type (partial unique
//   index), so re-runs, racing workers and a type switch deduct once. The balance may go below
//   zero (mandated deduction); each such balance is audited.
// - An employee who worked on the collective day is not deducted (overtime
//   pays that day as a workday, hris-overtime.service.ts): an `in`
//   attendance log on that business date that is valid (not rejected on
//   review) or flagged and accepted. A flagged log still pending or
//   unreviewed does NOT protect the day (doubt restricts payment): it is
//   deducted. A rejected log (validity or review) deducts.
// - Such a log can appear AFTER the deduction (flagged review accepted,
//   approved manual correction, offline/edge sync). The daily run then
//   reconciles the pair: a compensating +1 ledger row (kind
//   `collective_leave_reversal`, same period, never a delete) and `used` gets
//   the day back, once (unique partial index). Never below 0 used; a year
//   whose carry-over ran is not touched.
// - An accepted log that is LATER rejected (flagging it back to pending writes nothing)
//   takes the day back (CTO decision, doubt restricts payment): a new ledger
//   row, kind `collective_leave_rededuction`, days -1, once (unique partial
//   index), `used` + 1 (redeductCollectiveLeaveForRejectedDay, from the
//   review). Per employee and date: deduction, reversal, rededuction, then
//   terminal: the day stays deducted even if a log qualifies again (the
//   reversal row is unique and is never given twice).
// - National and company holidays never deduct. A leave request counts its
//   days once, at filing (countLeaveDays excludes the holidays that exist
//   then, stored in `excluded_holiday_dates`). A collective day inside a
//   pending/approved request and not excluded by it is therefore already in
//   that request's day count: the job skips that employee and date (no
//   ledger row, so a rejected or cancelled request is deducted on a later
//   run). A collective date that
//   also has a national/company holiday in the employee's scope (tenant-wide
//   or their home outlet) is already a paid day off and is not deducted (same
//   precedence as overtime).
// - Carry-over closes a year: once a `carry_over` ledger row moved the
//   leftover of year Y into Y+1, a deduction in Y would inflate that carry.
//   The job skips a previous-year date for an employee whose carry-over ran,
//   and holiday writes refuse a collective day in such a year (422
//   `LEAVE_YEAR_CARRIED_OVER`, assertCollectiveYearOpen).
// - Deleting, moving or retyping a deducted collective day reverses its
//   deduction in the same transaction (reverseCollectiveLeaveDeductions):
//   the ledger row is deleted and the day returned to `used`, once. When a
//   worked-day reversal row already gave that day back, both rows are deleted
//   and `used` is left alone (never given back twice).

import { and, asc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  DEFAULT_TIME_ZONE,
  createUlid,
  formatDecimal4,
  localDateOf,
  parseDecimal4,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  leavePolicySchema,
  leaveRedeductedAfterSettlement,
  leaveSettingsSchema,
  type LeaveAccrualRunResult,
  type LeaveSettings,
  type LeaveSettingsInput,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import {
  holidays,
  hrisLeaveSettings,
  leaveAccruals,
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from "../db/schema/hris-leave.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-holiday.service.ts";
import { lockEmployeeLeaveAttendance } from "./hris-leave-attendance-lock.ts";
import {
  expireBalanceCarryOver,
  lockBalanceForUpdate,
  usableCarriedOverDays,
  type LeaveJobActor,
} from "./hris-leave.service.ts";

type SettingsRow = typeof hrisLeaveSettings.$inferSelect;
type LeaveTypeRow = typeof leaveTypes.$inferSelect;

const ANNUAL_CODE = "ANNUAL";
// Founder decision pending: retroactive vs next leave year. Until decided,
// collective days before the cutover are never deducted.
export const DEFAULT_COLLECTIVE_LEAVE_EFFECTIVE_FROM = "2027-01-01";
const ONE_DAY = 10_000n;
const DEDUCTION_KIND = "collective_leave";
const REVERSAL_KIND = "collective_leave_reversal";
const REDEDUCTION_KIND = "collective_leave_rededuction";
const COLLECTIVE_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "date",
  "periodYear",
  "granted",
  "skipped",
  "negative",
  "collectiveLeaveDeductsAnnual",
  "annualLeaveTypeId",
  "effectiveAnnualLeaveTypeId",
  "collectiveLeaveEffectiveFrom",
  "forfeitedDays",
  "carriedOverDays",
  "reversed",
  "rededucted",
  "carryReduced",
  "offboardingId",
  "days",
] as const;

// ----------------------------------------------------------------- access

async function authorize(
  tx: Tx,
  context: ScopedTenantContext,
  actor: LeaveJobActor,
  now: Date,
): Promise<LeaveJobActor> {
  if (context.outletScope.kind !== "tenant") throw forbidden();
  if (actor.type === "system") return actor;
  const access = await loadHrisAccess(tx, context, actor.id, now);
  if (!access.snapshot.allows(HRIS_MANAGE_CODE, { type: "tenant" }))
    throw forbidden();
  return { type: "user", id: access.actorUserId };
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: LeaveJobActor,
  now: Date,
  entry: {
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown>;
  },
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: actor.type,
      actorId: actor.type === "user" ? actor.id : null,
      deviceId: null,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      reason: null,
      maskedChanges: { before: null, after: entry.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    COLLECTIVE_AUDIT_SAFE_FIELDS,
  );
}

// --------------------------------------------------------------- settings

const tracksBalance = (row: LeaveTypeRow) =>
  leavePolicySchema.safeParse(row.policy).data?.tracksBalance === true;

async function settingsRow(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<SettingsRow | null> {
  const [row] = await tx
    .select()
    .from(hrisLeaveSettings)
    .where(eq(hrisLeaveSettings.tenantId, context.tenant.tenantId))
    .limit(1);
  return row ?? null;
}

/** The type the deduction uses: configured, else active `ANNUAL`; null = none. */
async function effectiveAnnualType(
  tx: Tx,
  context: ScopedTenantContext,
  configured: string | null,
): Promise<LeaveTypeRow | null> {
  const [row] = await tx
    .select()
    .from(leaveTypes)
    .where(
      and(
        eq(leaveTypes.tenantId, context.tenant.tenantId),
        configured === null
          ? eq(leaveTypes.code, ANNUAL_CODE)
          : eq(leaveTypes.id, configured),
        eq(leaveTypes.isActive, true),
      ),
    )
    .limit(1);
  return row && tracksBalance(row) ? row : null;
}

async function readSettings(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<LeaveSettings> {
  const row = await settingsRow(tx, context);
  const configured = row?.annualLeaveTypeId ?? null;
  const effective = await effectiveAnnualType(tx, context, configured);
  return leaveSettingsSchema.parse({
    tenantId: context.tenant.tenantId,
    collectiveLeaveDeductsAnnual: row?.collectiveLeaveDeductsAnnual ?? true,
    annualLeaveTypeId: configured,
    effectiveAnnualLeaveTypeId: effective?.id ?? null,
    collectiveLeaveEffectiveFrom:
      row?.collectiveLeaveEffectiveFrom ??
      DEFAULT_COLLECTIVE_LEAVE_EFFECTIVE_FROM,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  });
}

/** GET /api/hris/leave/settings */
export async function getLeaveSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<LeaveSettings> {
  return withTenant(db, context, async (tx) => {
    await authorize(tx, context, { type: "user", id: actorUserId }, now);
    return readSettings(tx, context);
  });
}

/** PUT /api/hris/leave/settings — replaces the setting; idempotent per key. */
export async function updateLeaveSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  body: LeaveSettingsInput & { idempotencyKey: string },
  now = new Date(),
): Promise<LeaveSettings> {
  const { idempotencyKey, ...input } = body;
  return withTenant(db, context, async (tx) => {
    const actor = await authorize(
      tx,
      context,
      { type: "user", id: actorUserId },
      now,
    );
    if (actor.type !== "user") throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "leave_settings.update",
      { actor: actor.id, input },
      async () => {
        if (input.annualLeaveTypeId !== null) {
          const type = await effectiveAnnualType(
            tx,
            context,
            input.annualLeaveTypeId,
          );
          if (!type)
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "Jenis cuti tahunan harus ada, aktif, dan memakai saldo.",
            );
        }
        await tx
          .insert(hrisLeaveSettings)
          .values({
            tenantId: context.tenant.tenantId,
            collectiveLeaveDeductsAnnual: input.collectiveLeaveDeductsAnnual,
            annualLeaveTypeId: input.annualLeaveTypeId,
            collectiveLeaveEffectiveFrom:
              input.collectiveLeaveEffectiveFrom ?? null,
            updatedBy: actor.id as SettingsRow["updatedBy"],
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: hrisLeaveSettings.tenantId,
            set: {
              collectiveLeaveDeductsAnnual: input.collectiveLeaveDeductsAnnual,
              annualLeaveTypeId: input.annualLeaveTypeId,
              collectiveLeaveEffectiveFrom:
                input.collectiveLeaveEffectiveFrom ?? null,
              updatedBy: actor.id as SettingsRow["updatedBy"],
              updatedAt: now,
            },
          });
        const settings = await readSettings(tx, context);
        await audit(tx, context, actor, now, {
          action: "hris.leave_settings.updated",
          objectType: "leave_settings",
          objectId: context.tenant.tenantId,
          after: {
            collectiveLeaveDeductsAnnual: settings.collectiveLeaveDeductsAnnual,
            annualLeaveTypeId: settings.annualLeaveTypeId,
            effectiveAnnualLeaveTypeId: settings.effectiveAnnualLeaveTypeId,
            collectiveLeaveEffectiveFrom: settings.collectiveLeaveEffectiveFrom,
          },
        });
        return settings;
      },
    );
  });
}

// -------------------------------------------------------------- deduction

/**
 * `employeeId|date` pairs whose collective day a pending or approved request
 * (of ANY leave type) already counts as a leave day: the day is already
 * charged to that request, so the deduction is skipped (brief 85 item 1). The
 * date is inside the request's range and not among the holiday dates it
 * excluded at filing (`excluded_holiday_dates`), whatever happened to the
 * calendar since.
 */
async function datesCountedByRequests(
  tx: Tx,
  tenantId: SettingsRow["tenantId"],
  collective: readonly { date: string }[],
  range: { from: string; today: string },
): Promise<Set<string>> {
  const counted = new Set<string>();
  const requests = await tx
    .select({
      employeeId: leaveRequests.employeeId,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      excludedHolidayDates: leaveRequests.excludedHolidayDates,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        inArray(leaveRequests.status, ["pending", "approved"]),
        gte(leaveRequests.endDate, range.from),
        lt(leaveRequests.startDate, range.today),
      ),
    );
  for (const request of requests) {
    const excluded = new Set(request.excludedHolidayDates);
    for (const { date } of collective)
      if (
        date >= request.startDate &&
        date <= request.endDate &&
        !excluded.has(date)
      )
        counted.add(`${request.employeeId}|${date}`);
  }
  return counted;
}

/**
 * An `in` log that counts as worked: valid and not rejected on review, or
 * flagged and accepted on review. A flagged log still pending/unreviewed, and
 * any rejected log, does not count.
 */
const workedLogCondition = () =>
  or(
    and(
      eq(attendanceLogs.validity, "valid"),
      ne(attendanceLogs.reviewStatus, "rejected"),
    ),
    and(
      eq(attendanceLogs.validity, "flagged"),
      eq(attendanceLogs.reviewStatus, "accepted"),
    ),
  );

/**
 * `employeeId|date` pairs whose collective day the employee worked: an `in`
 * log on that business date that is valid (not rejected on review) or flagged
 * and accepted. Flagged and still pending/unreviewed does not count: the day
 * is deducted and reversed once the log is accepted (reconcile below).
 * `employeeId` narrows the read to one employee (the fresh re-read under that
 * employee's lock).
 */
async function datesWorkedOrUnderReview(
  tx: Tx,
  tenantId: SettingsRow["tenantId"],
  range: { from: string; today: string },
  employeeId?: string,
): Promise<Set<string>> {
  const logs = await tx
    .selectDistinct({
      employeeId: attendanceLogs.employeeId,
      businessDate: attendanceLogs.businessDate,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        employeeId === undefined
          ? undefined
          : eq(attendanceLogs.employeeId, employeeId),
        eq(attendanceLogs.type, "in"),
        gte(attendanceLogs.businessDate, range.from),
        lt(attendanceLogs.businessDate, range.today),
        workedLogCondition(),
      ),
    );
  return new Set(logs.map((row) => `${row.employeeId}|${row.businessDate}`));
}

/**
 * Gives one deducted collective day back: a compensating `+1` ledger row (the
 * deduction row stays), then `used` - 1 (never below 0) under the balance
 * lock. The unique partial index makes it once per employee and date, so a
 * replay or a racing worker reverses nothing more; a log rejected
 * later takes the day back through a rededuction row
 * (redeductCollectiveLeaveForRejectedDay), never by touching this one.
 * Past the carry-over expiry date the returned day must not bring forfeited
 * carry back: the carry is clamped to the days still used or pending.
 * Returns whether a reversal was made.
 */
async function reverseDeductedDay(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
  today: string,
  row: { employeeId: string; leaveTypeId: string; period: string },
  forfeited: (
    after: Record<string, unknown>,
    balanceId: string,
  ) => Promise<void>,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  // Lock order: employee lock (callers), log/leave row, balance, ledger. The
  // balance is locked BEFORE the reversal row is inserted: the insert can wait
  // on a racing worker's uncommitted reversal row, and that worker must not
  // be waiting on this balance in turn.
  const year = Number(row.period.slice(0, 4));
  const locked = await lockBalanceForUpdate(
    tx,
    tenantId,
    row.employeeId,
    row.leaveTypeId,
    year,
  );
  if (!locked) throw new Error("Leave balance row missing for reversal");
  const claimed = await tx
    .insert(leaveAccruals)
    .values({
      tenantId,
      employeeId: row.employeeId,
      leaveTypeId: row.leaveTypeId,
      kind: REVERSAL_KIND,
      period: row.period,
      days: formatDecimal4(ONE_DAY),
      createdAt: now,
      createdBy: null,
    })
    .onConflictDoNothing({
      target: [
        leaveAccruals.tenantId,
        leaveAccruals.employeeId,
        leaveAccruals.period,
      ],
      // The partial unique index predicate.
      where: sql`${leaveAccruals.kind} = 'collective_leave_reversal'`,
    })
    .returning({ id: leaveAccruals.id });
  if (claimed.length === 0) return false;
  const [balance] = await tx
    .update(leaveBalances)
    .set({
      usedDays: sql`GREATEST(${leaveBalances.usedDays} - ${formatDecimal4(ONE_DAY)}::numeric, 0)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(leaveBalances.tenantId, tenantId),
        eq(leaveBalances.id, locked.id),
      ),
    )
    .returning();
  if (!balance) throw new Error("Leave balance update returned no row");
  const carried = parseDecimal4(balance.carriedOverDays);
  if (balance.carryOverExpiresOn === null || balance.carryOverExpiresOn > today)
    return true;
  const keep = usableCarriedOverDays(balance, today);
  if (carried <= keep) return true;
  await tx
    .update(leaveBalances)
    .set({ carriedOverDays: formatDecimal4(keep), updatedAt: now })
    .where(
      and(
        eq(leaveBalances.tenantId, tenantId),
        eq(leaveBalances.id, balance.id),
      ),
    );
  await forfeited(
    {
      periodYear: balance.periodYear,
      forfeitedDays: formatDecimal4(carried - keep),
      carriedOverDays: formatDecimal4(keep),
    },
    balance.id,
  );
  return true;
}

/**
 * Takes a collective day back when its accepted `in` log stopped qualifying
 * (rejected, or flagged back to pending). Call it in the review's transaction
 * after the log update. Acts only when the deduction row AND its reversal row
 * exist, no rededuction row exists yet, and no other qualifying `in` log
 * remains on that employee and date (workedLogCondition, read after the
 * update): then a new `-1` ledger row (kind `collective_leave_rededuction`,
 * once through the unique partial index, never a delete) and `used` + 1 under
 * the balance lock. Terminal: after it the day stays deducted. `used` is not
 * capped at the pool: like the original deduction the day may take the balance
 * below zero (every payout clamps remaining at 0, so a negative balance only
 * restricts payment, and `used` keeps matching the ledger); that case is
 * audited. When the carry-over of the day's year
 * already ran, the next year's carried-over days lose the day too, only when
 * the day was inside the carried days (not when the cap kept it out), and the
 * cut follows into later years whose carry ran (clamped at 0, audited) so it
 * is not paid through the carry. Same locks as the reversal:
 * the caller's employee lock, the collective holiday rows FOR SHARE, the
 * balance FOR UPDATE, then the ledger. Returns the days taken back (0 or 1).
 */
export async function redeductCollectiveLeaveForRejectedDay(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  date: string,
  now: Date,
  logOutletId?: string,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const holidayRows = await tx
    .select({ id: holidays.id })
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, tenantId),
        eq(holidays.type, "collective"),
        eq(holidays.date, date),
      ),
    )
    .orderBy(asc(holidays.id))
    .for("share");
  if (holidayRows.length === 0) return 0;
  const ledgerOf = async (kind: string) => {
    const [row] = await tx
      .select({ leaveTypeId: leaveAccruals.leaveTypeId })
      .from(leaveAccruals)
      .where(
        and(
          eq(leaveAccruals.tenantId, tenantId),
          eq(leaveAccruals.employeeId, employeeId),
          eq(leaveAccruals.kind, kind as typeof DEDUCTION_KIND),
          eq(leaveAccruals.period, date),
        ),
      )
      .limit(1);
    return row;
  };
  const deducted = await ledgerOf(DEDUCTION_KIND);
  if (!deducted) return 0;
  if (!(await ledgerOf(REVERSAL_KIND))) return 0;
  if (await ledgerOf(REDEDUCTION_KIND)) return 0;
  const [stillWorked] = await tx
    .select({ id: attendanceLogs.id })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        eq(attendanceLogs.employeeId, employeeId),
        eq(attendanceLogs.type, "in"),
        eq(attendanceLogs.businessDate, date),
        workedLogCondition(),
      ),
    )
    .limit(1);
  if (stillWorked) return 0;
  const year = Number(date.slice(0, 4));
  const locked = await lockBalanceForUpdate(
    tx,
    tenantId,
    employeeId,
    deducted.leaveTypeId,
    year,
  );
  if (!locked) throw new Error("Leave balance row missing for rededuction");
  const claimed = await tx
    .insert(leaveAccruals)
    .values({
      tenantId,
      employeeId,
      leaveTypeId: deducted.leaveTypeId,
      kind: REDEDUCTION_KIND,
      period: date,
      days: formatDecimal4(-ONE_DAY),
      createdAt: now,
      createdBy: null,
    })
    .onConflictDoNothing({
      target: [
        leaveAccruals.tenantId,
        leaveAccruals.employeeId,
        leaveAccruals.period,
      ],
      // The partial unique index predicate.
      where: sql`${leaveAccruals.kind} = 'collective_leave_rededuction'`,
    })
    .returning({ id: leaveAccruals.id });
  if (claimed.length === 0) return 0;
  const actor: LeaveJobActor = { type: "user", id: actorUserId };
  const [balance] = await tx
    .update(leaveBalances)
    .set({
      usedDays: sql`${leaveBalances.usedDays} + ${formatDecimal4(ONE_DAY)}::numeric`,
      updatedAt: now,
    })
    .where(
      and(
        eq(leaveBalances.tenantId, tenantId),
        eq(leaveBalances.id, locked.id),
      ),
    )
    .returning();
  if (!balance) throw new Error("Leave balance update returned no row");
  const negative =
    parseDecimal4(balance.entitledDays) +
      parseDecimal4(balance.carriedOverDays) -
      parseDecimal4(balance.usedDays) -
      parseDecimal4(balance.pendingDays) <
    0n;
  // The day's year is closed (carry-over into the next year ran): the day was
  // given back before that and may sit in the next years' carried days. Carry
  // of a year is min(remaining of the year before, the cap at that time) (see
  // carryOverLeave). The cap at that time is the carry ledger row of the year
  // (C), not the policy now: the policy may have changed since. A carry is cut
  // only by the part of the day that was really inside it: nothing when C kept
  // the day out. A year whose carry was cut passes the cut on to the following
  // year's carry the same way.
  const carriedFrom = (
    from: typeof locked,
    toYear: number,
    ledgerCarry: bigint,
  ) => {
    const available =
      parseDecimal4(from.entitledDays) +
      usableCarriedOverDays(from, `${toYear}-01-01`) -
      parseDecimal4(from.usedDays) -
      parseDecimal4(from.pendingDays);
    return available <= 0n
      ? 0n
      : available < ledgerCarry
        ? available
        : ledgerCarry;
  };
  let carryReduced = false;
  const carryToday = localDateOf(now, DEFAULT_TIME_ZONE);
  let before = locked; // balance of the year before the carry, pre-cut
  let after: typeof locked = balance; // the same balance, post-cut
  // Balance rows this deduction changed, per year: before and after, for the
  // exit-year remaining leave (legend-jitc3).
  const changedYears = new Map<
    number,
    { before: typeof locked; after: typeof locked }
  >([[year, { before: locked, after: balance }]]);
  for (let toYear = year + 1; ; toYear += 1) {
    const [carryRow] = await tx
      .select({ days: leaveAccruals.days })
      .from(leaveAccruals)
      .where(
        and(
          eq(leaveAccruals.tenantId, tenantId),
          eq(leaveAccruals.employeeId, employeeId),
          eq(leaveAccruals.leaveTypeId, deducted.leaveTypeId),
          eq(leaveAccruals.kind, "carry_over"),
          eq(leaveAccruals.period, String(toYear)),
        ),
      )
      .limit(1);
    if (!carryRow || parseDecimal4(carryRow.days) <= 0n) break;
    const ledgerCarry = parseDecimal4(carryRow.days);
    const cut =
      carriedFrom(before, toYear, ledgerCarry) -
      carriedFrom(after, toYear, ledgerCarry);
    if (cut <= 0n) break;
    const next = await lockBalanceForUpdate(
      tx,
      tenantId,
      employeeId,
      deducted.leaveTypeId,
      toYear,
    );
    if (!next || parseDecimal4(next.carriedOverDays) <= 0n) break;
    // legend-gxg9j: past its expiry date the expiry job forfeited F days of
    // this carry (F = |days| of the year's `carry_over_expiry` ledger row; 0
    // when the job has not run or forfeited nothing). Those days were taken out
    // of the carry already and must not absorb the cut a second time: only the
    // part of the cut above F is left to take. Nothing is left, here or in
    // later years, when F covers it.
    let effectiveCut = cut;
    if (
      next.carryOverExpiresOn !== null &&
      next.carryOverExpiresOn <= carryToday
    ) {
      const [expiryRow] = await tx
        .select({ days: leaveAccruals.days })
        .from(leaveAccruals)
        .where(
          and(
            eq(leaveAccruals.tenantId, tenantId),
            eq(leaveAccruals.employeeId, employeeId),
            eq(leaveAccruals.leaveTypeId, deducted.leaveTypeId),
            eq(leaveAccruals.kind, "carry_over_expiry"),
            eq(leaveAccruals.period, String(toYear)),
          ),
        )
        .limit(1);
      const forfeitedDays = expiryRow ? parseDecimal4(expiryRow.days) : 0n;
      effectiveCut =
        cut - (forfeitedDays < 0n ? -forfeitedDays : forfeitedDays);
      if (effectiveCut <= 0n) break;
    }
    const taken = parseDecimal4(next.carriedOverDays);
    const [cutRow] = await tx
      .update(leaveBalances)
      .set({
        carriedOverDays: sql`GREATEST(${leaveBalances.carriedOverDays} - ${formatDecimal4(effectiveCut < taken ? effectiveCut : taken)}::numeric, 0)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(leaveBalances.tenantId, tenantId),
          eq(leaveBalances.id, next.id),
        ),
      )
      .returning();
    if (!cutRow) throw new Error("Leave balance update returned no row");
    carryReduced = true;
    before = next;
    after = cutRow;
    changedYears.set(toYear, { before, after });
  }
  await audit(tx, context, actor, now, {
    action: "hris.leave_collective.rededucted",
    objectType: "leave_collective",
    objectId: createUlid(now.getTime()),
    after: {
      date,
      periodYear: year,
      rededucted: 1,
      ...(negative ? { negative: 1 } : {}),
      ...(carryReduced ? { carryReduced: 1 } : {}),
    },
  });
  // legend-jitc3: the employee's offboarding is already completed, so the
  // frozen settlement snapshot cannot take this day. It is NOT changed and no
  // receivable is created: the extra day is audited and HR is told through one
  // notification (billed by hand). The ledger claim above makes it once per day.
  const [settled] = await tx
    .select({
      id: hrisOffboardings.id,
      lastWorkingDate: hrisOffboardings.lastWorkingDate,
    })
    .from(hrisOffboardings)
    .where(
      and(
        eq(hrisOffboardings.tenantId, tenantId),
        eq(hrisOffboardings.employeeId, employeeId),
        eq(hrisOffboardings.status, "completed"),
      ),
    )
    .limit(1)
    .for("share");
  if (settled) {
    // The settlement snapshot only counts the remaining leave of the exit year
    // (min 0): the days owed are what this deduction took off that remainder.
    const exitRows = changedYears.get(
      Number(settled.lastWorkingDate.slice(0, 4)),
    );
    const remainingOf = (row: typeof locked) => {
      const left =
        parseDecimal4(row.entitledDays) +
        usableCarriedOverDays(row, carryToday) -
        parseDecimal4(row.usedDays) -
        parseDecimal4(row.pendingDays);
      return left > 0n ? left : 0n;
    };
    const settledDays = exitRows
      ? remainingOf(exitRows.before) - remainingOf(exitRows.after)
      : 0n;
    await audit(tx, context, actor, now, {
      action: "hris.leave_collective.rededucted_after_settlement",
      objectType: "leave_collective",
      objectId: createUlid(now.getTime()),
      after: {
        offboardingId: settled.id,
        date,
        periodYear: year,
        days: Number(formatDecimal4(settledDays)),
      },
    });
    if (settledDays <= 0n) return 1;
    let outletId = logOutletId;
    if (!outletId) {
      const [employee] = await tx
        .select({ homeOutletId: employees.homeOutletId })
        .from(employees)
        .where(
          and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)),
        )
        .limit(1);
      outletId = employee?.homeOutletId;
    }
    if (!outletId) throw new Error("Employee missing for rededuction event");
    const ledgerId = claimed[0]!.id;
    const event = leaveRedeductedAfterSettlement.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId,
      name: leaveRedeductedAfterSettlement.name,
      version: leaveRedeductedAfterSettlement.version,
      aggregateType: leaveRedeductedAfterSettlement.entry.aggregateType,
      aggregateId: ledgerId,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: userIdSchema.parse(actorUserId) },
      deviceId: null,
      idempotencyKey: `${leaveRedeductedAfterSettlement.name}:${ledgerId}`,
      payloadSchemaRef: leaveRedeductedAfterSettlement.payloadSchemaRef,
      payload: {
        offboardingId: settled.id,
        employeeId,
        outletId,
        date,
        periodYear: year,
        days: formatDecimal4(settledDays),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: "notification",
      direction: null,
      peerId: null,
    });
  }
  return 1;
}

/**
 * Reconciles one employee and collective date: when a deduction row exists and
 * an accepted `in` log (see workedLogCondition) now exists for that business
 * date, reverses the deduction once. Call it in the transaction that accepted
 * the log (flagged review accepted); the daily run reconciles the other
 * routes (manual correction, edge sync). Takes the same locks as the job:
 * the collective holiday rows FOR SHARE, then the balance FOR UPDATE. A past
 * year whose carry-over ran for the employee is not touched. Returns the days
 * reversed (0 or 1).
 */
export async function reverseCollectiveLeaveForWorkedDay(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  date: string,
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const today = localDateOf(now, DEFAULT_TIME_ZONE);
  if (date >= today) return 0;
  // Same window as the daily run: current and previous local year only.
  if (date < `${Number(today.slice(0, 4)) - 1}-01-01`) return 0;
  const holidayRows = await tx
    .select({ id: holidays.id })
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, tenantId),
        eq(holidays.type, "collective"),
        eq(holidays.date, date),
      ),
    )
    .orderBy(asc(holidays.id))
    .for("share");
  if (holidayRows.length === 0) return 0;
  const [deducted] = await tx
    .select({ leaveTypeId: leaveAccruals.leaveTypeId })
    .from(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        eq(leaveAccruals.employeeId, employeeId),
        eq(leaveAccruals.kind, DEDUCTION_KIND),
        eq(leaveAccruals.period, date),
      ),
    )
    .limit(1);
  if (!deducted) return 0;
  const [worked] = await tx
    .select({ id: attendanceLogs.id })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        eq(attendanceLogs.employeeId, employeeId),
        eq(attendanceLogs.type, "in"),
        eq(attendanceLogs.businessDate, date),
        workedLogCondition(),
      ),
    )
    .limit(1);
  if (!worked) return 0;
  // The year of the collective day is closed once its carry-over (period =
  // the next year) ran for this employee and leave type.
  const [carried] = await tx
    .select({ id: leaveAccruals.id })
    .from(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        eq(leaveAccruals.employeeId, employeeId),
        eq(leaveAccruals.leaveTypeId, deducted.leaveTypeId),
        eq(leaveAccruals.kind, "carry_over"),
        eq(leaveAccruals.period, String(Number(date.slice(0, 4)) + 1)),
      ),
    )
    .limit(1);
  if (carried) return 0;
  const actor: LeaveJobActor = { type: "user", id: actorUserId };
  const reversed = await reverseDeductedDay(
    tx,
    context,
    now,
    today,
    { employeeId, leaveTypeId: deducted.leaveTypeId, period: date },
    (after, balanceId) =>
      audit(tx, context, actor, now, {
        action: "hris.leave_carry_over.forfeited",
        objectType: "leave_balance",
        objectId: balanceId,
        after,
      }),
  );
  if (reversed)
    await audit(tx, context, actor, now, {
      action: "hris.leave_collective.reversed",
      objectType: "leave_collective",
      objectId: createUlid(now.getTime()),
      after: { date, reversed: 1 },
    });
  return reversed ? 1 : 0;
}

/**
 * Deducts one annual-leave day per past collective holiday (current and
 * previous Asia/Jakarta year) for each employee in scope. Idempotent through
 * the `leave_accruals` ledger; `granted` = deductions made now, `skipped` =
 * in-scope employee/date pairs already deducted.
 */
export async function applyCollectiveLeaveDeductions(
  context: ScopedTenantContext,
  now: Date,
  jobActor: LeaveJobActor,
): Promise<LeaveAccrualRunResult> {
  const today = localDateOf(now, DEFAULT_TIME_ZONE);
  const yearStart = `${Number(today.slice(0, 4)) - 1}-01-01`;
  return withTenant(db, context, async (tx) => {
    const actor = await authorize(tx, context, jobActor, now);
    const tenantId = context.tenant.tenantId;
    const settings = await settingsRow(tx, context);
    if (settings && !settings.collectiveLeaveDeductsAnnual)
      return { granted: 0, skipped: 0 };
    const type = await effectiveAnnualType(
      tx,
      context,
      settings?.annualLeaveTypeId ?? null,
    );
    if (!type) return { granted: 0, skipped: 0 };
    const effectiveFrom =
      settings?.collectiveLeaveEffectiveFrom ??
      DEFAULT_COLLECTIVE_LEAVE_EFFECTIVE_FROM;
    const from = effectiveFrom > yearStart ? effectiveFrom : yearStart;

    // FOR SHARE: a concurrent delete/move/retype of one of these days (which
    // reverses its deductions) waits for this run, or this run waits for it
    // and then no longer sees the changed row.
    const collective = await tx
      .select({ date: holidays.date, outletId: holidays.outletId })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenantId, tenantId),
          eq(holidays.type, "collective"),
          gte(holidays.date, from),
          lt(holidays.date, today),
        ),
      )
      .orderBy(asc(holidays.date), asc(holidays.id))
      .for("share");
    if (collective.length === 0) return { granted: 0, skipped: 0 };

    // National/company holidays win over the collective day, per scope.
    const paidOff = await tx
      .select({ date: holidays.date, outletId: holidays.outletId })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenantId, tenantId),
          ne(holidays.type, "collective"),
          gte(holidays.date, from),
          lt(holidays.date, today),
        ),
      );
    const paidOffTenantWide = new Set<string>();
    const paidOffAtOutlet = new Set<string>();
    for (const row of paidOff) {
      if (row.outletId === null) paidOffTenantWide.add(row.date);
      else paidOffAtOutlet.add(`${row.outletId.toLowerCase()}|${row.date}`);
    }

    const staff = await tx
      .select({
        id: employees.id,
        homeOutletId: employees.homeOutletId,
        joinDate: employees.joinDate,
        endDate: employees.endDate,
      })
      .from(employees)
      .where(
        and(eq(employees.tenantId, tenantId), eq(employees.status, "active")),
      )
      .orderBy(asc(employees.id));
    // Pairs already in the ledger: skip them without an insert attempt.
    const deductedRows = await tx
      .select({
        employeeId: leaveAccruals.employeeId,
        leaveTypeId: leaveAccruals.leaveTypeId,
        period: leaveAccruals.period,
      })
      .from(leaveAccruals)
      .where(
        and(
          eq(leaveAccruals.tenantId, tenantId),
          eq(leaveAccruals.kind, DEDUCTION_KIND),
          gte(leaveAccruals.period, from),
          lt(leaveAccruals.period, today),
        ),
      )
      .orderBy(asc(leaveAccruals.period), asc(leaveAccruals.employeeId));
    const done = new Set(
      deductedRows.map((row) => `${row.employeeId}|${row.period}`),
    );

    const counted = await datesCountedByRequests(tx, tenantId, collective, {
      from,
      today,
    });
    const worked = await datesWorkedOrUnderReview(tx, tenantId, {
      from,
      today,
    });
    // Previous-year dates for employees whose carry-over into this year ran,
    // per employee AND leave type (a deduction row keeps the type it was made
    // under, whatever the annual type is now).
    const thisYear = today.slice(0, 4);
    const carried = new Set(
      (
        await tx
          .select({
            employeeId: leaveAccruals.employeeId,
            leaveTypeId: leaveAccruals.leaveTypeId,
          })
          .from(leaveAccruals)
          .where(
            and(
              eq(leaveAccruals.tenantId, tenantId),
              eq(leaveAccruals.kind, "carry_over"),
              eq(leaveAccruals.period, thisYear),
            ),
          )
      ).map((row) => `${row.employeeId}|${row.leaveTypeId}`),
    );

    // Reconcile pairs already deducted whose day now has an accepted `in` log
    // (flagged review accepted, approved correction, edge sync): give the day
    // back once. Employee then date ascending, under the same holiday FOR
    // SHARE lock; a closed (carried-over) previous year is kept. Lock order
    // everywhere: employee lock, log/leave row, balance, ledger: the employee
    // lock is taken before the first reversal of each employee.
    let reversed = 0;
    // Per employee, read right after its lock: a log rejected between the
    // unlocked read above and the lock (decideAttendanceReview holds the lock)
    // must not give its day back. A fresh statement in the same READ COMMITTED
    // transaction sees that committed rejection.
    const workedUnderLock = new Map<string, Set<string>>();
    const reconcile = [...deductedRows].sort(
      (a, b) =>
        a.employeeId.localeCompare(b.employeeId) ||
        a.period.localeCompare(b.period),
    );
    for (const row of reconcile) {
      if (!worked.has(`${row.employeeId}|${row.period}`)) continue;
      if (
        row.period.slice(0, 4) < thisYear &&
        carried.has(`${row.employeeId}|${row.leaveTypeId}`)
      )
        continue;
      let fresh = workedUnderLock.get(row.employeeId);
      if (!fresh) {
        await lockEmployeeLeaveAttendance(tx, tenantId, row.employeeId);
        fresh = await datesWorkedOrUnderReview(
          tx,
          tenantId,
          { from, today },
          row.employeeId,
        );
        workedUnderLock.set(row.employeeId, fresh);
      }
      if (!fresh.has(`${row.employeeId}|${row.period}`)) continue;
      if (
        await reverseDeductedDay(tx, context, now, today, row, (after, id) =>
          audit(tx, context, actor, now, {
            action: "hris.leave_carry_over.forfeited",
            objectType: "leave_balance",
            objectId: id,
            after,
          }),
        )
      )
        reversed += 1;
    }

    let granted = 0;
    let skipped = 0;
    let negative = 0;
    for (const holiday of collective) {
      const periodYear = Number(holiday.date.slice(0, 4));
      for (const employee of staff) {
        const inScope =
          holiday.outletId === null ||
          holiday.outletId.toLowerCase() ===
            employee.homeOutletId.toLowerCase();
        const employed =
          employee.joinDate <= holiday.date &&
          (employee.endDate === null || employee.endDate >= holiday.date);
        if (!inScope || !employed) continue;
        if (
          paidOffTenantWide.has(holiday.date) ||
          paidOffAtOutlet.has(
            `${employee.homeOutletId.toLowerCase()}|${holiday.date}`,
          )
        )
          continue;
        const pair = `${employee.id}|${holiday.date}`;
        if (counted.has(pair)) continue;
        if (worked.has(pair)) continue;
        if (
          holiday.date.slice(0, 4) < thisYear &&
          carried.has(`${employee.id}|${type.id}`)
        )
          continue;
        if (done.has(pair)) {
          skipped += 1;
          continue;
        }
        done.add(pair);
        const claimed = await tx
          .insert(leaveAccruals)
          .values({
            tenantId,
            employeeId: employee.id,
            leaveTypeId: type.id,
            kind: DEDUCTION_KIND,
            period: holiday.date,
            days: formatDecimal4(-ONE_DAY),
            createdAt: now,
            // Same as the other ledger kinds: the audit row records the actor.
            createdBy: null,
          })
          .onConflictDoNothing({
            target: [
              leaveAccruals.tenantId,
              leaveAccruals.employeeId,
              leaveAccruals.period,
            ],
            // The partial unique index predicate.
            where: sql`${leaveAccruals.kind} = 'collective_leave'`,
          })
          .returning({ id: leaveAccruals.id });
        if (claimed.length === 0) {
          skipped += 1;
          continue;
        }
        // Make sure the row exists, then lock it: a concurrent request or job
        // on this balance serializes behind this run.
        await tx
          .insert(leaveBalances)
          .values({
            tenantId,
            employeeId: employee.id,
            leaveTypeId: type.id,
            periodYear,
            updatedAt: now,
          })
          .onConflictDoNothing();
        const locked = await lockBalanceForUpdate(
          tx,
          tenantId,
          employee.id,
          type.id,
          periodYear,
        );
        if (!locked) throw new Error("Leave balance row missing after upsert");
        // A day on or after the carry-over expiry date cannot hold carried days
        // (carry is usable only before that date, usableCarriedOverDays):
        // write off the expired carry not held by the days taken so far
        // (once, through the ledger, as the expiry job would) before adding
        // it. Dates run ascending, so days before the expiry date are already
        // in `used` and keep their carried part. Accepted: a day on/before the
        // expiry date added after the expiry job ran charges entitled days
        // (the carry was already written off; the closed-year check blocks
        // adding days to a year whose carry-over ran).
        if (
          locked.carryOverExpiresOn !== null &&
          holiday.date >= locked.carryOverExpiresOn
        )
          await expireBalanceCarryOver(
            tx,
            context,
            locked,
            today,
            now,
            (after) =>
              audit(tx, context, actor, now, {
                action: "hris.leave_carry_over.forfeited",
                objectType: "leave_balance",
                objectId: locked.id,
                after,
              }),
          );
        const [balance] = await tx
          .update(leaveBalances)
          .set({
            usedDays: sql`${leaveBalances.usedDays} + ${formatDecimal4(ONE_DAY)}::numeric`,
            updatedAt: now,
          })
          .where(
            and(
              eq(leaveBalances.tenantId, tenantId),
              eq(leaveBalances.id, locked.id),
            ),
          )
          .returning();
        if (!balance) throw new Error("Leave balance update returned no row");
        granted += 1;
        const available =
          parseDecimal4(balance.entitledDays) +
          parseDecimal4(balance.carriedOverDays) -
          parseDecimal4(balance.usedDays) -
          parseDecimal4(balance.pendingDays);
        if (available < 0n) {
          negative += 1;
          await audit(tx, context, actor, now, {
            action: "hris.leave_balance.collective_negative",
            objectType: "leave_balance",
            objectId: balance.id,
            after: { date: holiday.date, periodYear },
          });
        }
      }
    }
    if (reversed > 0)
      await audit(tx, context, actor, now, {
        action: "hris.leave_collective.reversed",
        objectType: "leave_collective",
        objectId: createUlid(now.getTime()),
        after: { reversed },
      });
    if (granted > 0)
      await audit(tx, context, actor, now, {
        action: "hris.leave_collective.applied",
        objectType: "leave_collective",
        objectId: createUlid(now.getTime()),
        after: { granted, skipped, negative },
      });
    return { granted, skipped };
  });
}

// ------------------------------------------------- holiday write follow-ups

const yearCarriedOver = (year: number) =>
  new HttpError(
    422,
    "LEAVE_YEAR_CARRIED_OVER",
    `Sisa cuti tahun ${year} sudah dibawa ke tahun berikutnya; cuti bersama di tahun itu tidak bisa ditambah, dipindah, atau dihapus.`,
  );

/**
 * Refuses a collective day in a year whose carry-over already ran for anyone
 * in the tenant (a `carry_over` ledger row for the next year): deducting it
 * would inflate the carried days. Called by holiday create/update.
 */
export async function assertCollectiveYearOpen(
  tx: Tx,
  context: ScopedTenantContext,
  date: string,
): Promise<void> {
  const year = Number(date.slice(0, 4));
  const [row] = await tx
    .select({ id: leaveAccruals.id })
    .from(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, context.tenant.tenantId),
        eq(leaveAccruals.kind, "carry_over"),
        eq(leaveAccruals.period, String(year + 1)),
      ),
    )
    .limit(1);
  if (row) throw yearCarriedOver(year);
}

/**
 * Reverses the collective-leave deductions of `date` for every employee no
 * longer covered by a collective holiday on that date (tenant-wide, or their
 * home outlet). Call it in the holiday write's transaction, after the row was
 * deleted, moved or retyped (the caller holds that row's lock; the job reads
 * the rows FOR SHARE). Deleting the ledger row returns the day to `used`
 * once, so a retry reverses nothing more and a re-added day deducts again.
 * A reversal in a year whose carry-over ran for that employee is refused
 * (422 `LEAVE_YEAR_CARRIED_OVER`). Past the carry-over expiry date the carry
 * is clamped to the days still used or pending and the rest is forfeited and
 * audited, as `moveBalance` does for a released request. Returns the number
 * of days reversed.
 */
export async function reverseCollectiveLeaveDeductions(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  date: string,
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const today = localDateOf(now, DEFAULT_TIME_ZONE);
  // Two writes on different collective rows of one date (tenant-wide and an
  // outlet row) each see the other as remaining: serialize them per date.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:collective:${tenantId}:${date}`}, 0))`,
  );
  const remaining = await tx
    .select({ outletId: holidays.outletId })
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, tenantId),
        eq(holidays.type, "collective"),
        eq(holidays.date, date),
      ),
    );
  if (remaining.some((row) => row.outletId === null)) return 0;
  const coveredOutlets = new Set(
    remaining.map((row) => row.outletId!.toLowerCase()),
  );
  const ledger = await tx
    .select({
      id: leaveAccruals.id,
      employeeId: leaveAccruals.employeeId,
      homeOutletId: employees.homeOutletId,
    })
    .from(leaveAccruals)
    .innerJoin(
      employees,
      and(
        eq(employees.tenantId, leaveAccruals.tenantId),
        eq(employees.id, leaveAccruals.employeeId),
      ),
    )
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        eq(leaveAccruals.kind, "collective_leave"),
        eq(leaveAccruals.period, date),
      ),
    )
    .orderBy(
      leaveAccruals.employeeId,
      leaveAccruals.leaveTypeId,
      leaveAccruals.id,
    );
  const uncovered = ledger.filter(
    (row) => !coveredOutlets.has(row.homeOutletId.toLowerCase()),
  );
  if (uncovered.length === 0) return 0;
  const year = Number(date.slice(0, 4));
  const [carried] = await tx
    .select({ id: leaveAccruals.id })
    .from(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        eq(leaveAccruals.kind, "carry_over"),
        eq(leaveAccruals.period, String(year + 1)),
        inArray(
          leaveAccruals.employeeId,
          uncovered.map((row) => row.employeeId),
        ),
      ),
    )
    .limit(1);
  if (carried) throw yearCarriedOver(year);
  const removed = await tx
    .delete(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        inArray(
          leaveAccruals.id,
          uncovered.map((row) => row.id),
        ),
      ),
    )
    .returning({
      employeeId: leaveAccruals.employeeId,
      leaveTypeId: leaveAccruals.leaveTypeId,
      days: leaveAccruals.days,
    });
  const homeOutlet = new Map(
    uncovered.map((row) => [row.employeeId, row.homeOutletId]),
  );
  // A day already given back by a worked-day reversal (R) is not given back
  // again: R goes with the deduction row and `used` stays as it is.
  const alreadyReversed = new Set(
    (
      await tx
        .delete(leaveAccruals)
        .where(
          and(
            eq(leaveAccruals.tenantId, tenantId),
            eq(leaveAccruals.kind, REVERSAL_KIND),
            eq(leaveAccruals.period, date),
            inArray(
              leaveAccruals.employeeId,
              removed.map((row) => row.employeeId),
            ),
          ),
        )
        .returning({ employeeId: leaveAccruals.employeeId })
    ).map((row) => row.employeeId),
  );
  // A rededuction (R, then the log rejected) took the day back again: it goes
  // with the rows, and that employee's day is given back like an unreversed one.
  for (const gone of await tx
    .delete(leaveAccruals)
    .where(
      and(
        eq(leaveAccruals.tenantId, tenantId),
        eq(leaveAccruals.kind, REDEDUCTION_KIND),
        eq(leaveAccruals.period, date),
        inArray(
          leaveAccruals.employeeId,
          removed.map((row) => row.employeeId),
        ),
      ),
    )
    .returning({ employeeId: leaveAccruals.employeeId }))
    alreadyReversed.delete(gone.employeeId);
  // Lock every affected balance in one statement ordered by id, the order the
  // carry-over and expiry jobs use, so two reversals of different dates (or a
  // reversal and such a job) queue up instead of deadlocking (40P01,
  // legend-agn0i). The per-row lock below then finds the row already ours.
  if (removed.length > 0)
    await tx
      .select({ id: leaveBalances.id })
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.tenantId, tenantId),
          eq(leaveBalances.periodYear, year),
          inArray(
            leaveBalances.employeeId,
            removed.map((row) => row.employeeId),
          ),
        ),
      )
      .orderBy(asc(leaveBalances.id))
      .for("update");
  for (const row of removed) {
    if (alreadyReversed.has(row.employeeId)) continue;
    // Lock the balance first: a concurrent request or job serializes behind us.
    const locked = await lockBalanceForUpdate(
      tx,
      tenantId,
      row.employeeId,
      row.leaveTypeId,
      year,
    );
    if (!locked) continue;
    // `days` is the signed ledger amount (-1): adding it gives the day back.
    const [balance] = await tx
      .update(leaveBalances)
      .set({
        usedDays: sql`GREATEST(${leaveBalances.usedDays} + ${row.days}::numeric, 0)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(leaveBalances.tenantId, tenantId),
          eq(leaveBalances.id, locked.id),
        ),
      )
      .returning();
    if (!balance) continue;
    // Past the expiry date the returned day must not bring forfeited carry
    // back: clamp the carry to what is still used or pending.
    const carried = parseDecimal4(balance.carriedOverDays);
    if (
      balance.carryOverExpiresOn === null ||
      balance.carryOverExpiresOn > today
    )
      continue;
    const keep = usableCarriedOverDays(balance, today);
    if (carried <= keep) continue;
    await tx
      .update(leaveBalances)
      .set({ carriedOverDays: formatDecimal4(keep), updatedAt: now })
      .where(
        and(
          eq(leaveBalances.tenantId, tenantId),
          eq(leaveBalances.id, balance.id),
        ),
      );
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actor, now, {
        outletId: homeOutlet.get(row.employeeId)!,
        action: "hris.leave_carry_over.forfeited",
        objectType: "leave_balance",
        objectId: balance.id,
        after: {
          periodYear: balance.periodYear,
          forfeitedDays: formatDecimal4(carried - keep),
          carriedOverDays: formatDecimal4(keep),
        },
      }),
      COLLECTIVE_AUDIT_SAFE_FIELDS,
    );
  }
  return removed.length;
}
