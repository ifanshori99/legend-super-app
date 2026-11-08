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
// - There is no attendance table yet, so an employee who worked on the
//   collective day is still deducted (overtime pays that day as a workday,
//   hris-overtime.service.ts).
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
//   the ledger row is deleted and the day returned to `used`, once.

import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import {
  DEFAULT_TIME_ZONE,
  createUlid,
  formatDecimal4,
  localDateOf,
  parseDecimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  leavePolicySchema,
  leaveSettingsSchema,
  type LeaveAccrualRunResult,
  type LeaveSettings,
  type LeaveSettingsInput,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
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
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  forbidden,
  loadHrisAccess,
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-holiday.service.ts";
import {
  expireBalanceCarryOver,
  lockBalanceForUpdate,
  type LeaveJobActor,
} from "./hris-leave.service.ts";

type SettingsRow = typeof hrisLeaveSettings.$inferSelect;
type LeaveTypeRow = typeof leaveTypes.$inferSelect;

const ANNUAL_CODE = "ANNUAL";
// Founder decision pending: retroactive vs next leave year. Until decided,
// collective days before the cutover are never deducted.
export const DEFAULT_COLLECTIVE_LEAVE_EFFECTIVE_FROM = "2027-01-01";
const ONE_DAY = 10_000n;
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
 * already counts as a leave day: the date is inside the request's range and
 * not among the holiday dates it excluded at filing
 * (`excluded_holiday_dates`), whatever happened to the calendar since.
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
    const done = new Set(
      (
        await tx
          .select({
            employeeId: leaveAccruals.employeeId,
            period: leaveAccruals.period,
          })
          .from(leaveAccruals)
          .where(
            and(
              eq(leaveAccruals.tenantId, tenantId),
              eq(leaveAccruals.kind, "collective_leave"),
              gte(leaveAccruals.period, from),
              lt(leaveAccruals.period, today),
            ),
          )
      ).map((row) => `${row.employeeId}|${row.period}`),
    );

    const counted = await datesCountedByRequests(tx, tenantId, collective, {
      from,
      today,
    });
    // Previous-year dates for employees whose carry-over into this year ran.
    const thisYear = today.slice(0, 4);
    const carried = new Set(
      (
        await tx
          .select({ employeeId: leaveAccruals.employeeId })
          .from(leaveAccruals)
          .where(
            and(
              eq(leaveAccruals.tenantId, tenantId),
              eq(leaveAccruals.leaveTypeId, type.id),
              eq(leaveAccruals.kind, "carry_over"),
              eq(leaveAccruals.period, thisYear),
            ),
          )
      ).map((row) => row.employeeId),
    );

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
        if (holiday.date.slice(0, 4) < thisYear && carried.has(employee.id))
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
            kind: "collective_leave",
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
        // A day after the carry-over expiry date cannot hold carried days:
        // write off the expired carry not held by the days taken so far
        // (once, through the ledger, as the expiry job would) before adding
        // it. Dates run ascending, so days on or before the expiry date are
        // already in `used` and keep their carried part.
        if (
          locked.carryOverExpiresOn !== null &&
          holiday.date > locked.carryOverExpiresOn
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
 * (422 `LEAVE_YEAR_CARRIED_OVER`). Returns the number of days reversed.
 */
export async function reverseCollectiveLeaveDeductions(
  tx: Tx,
  context: ScopedTenantContext,
  date: string,
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
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
  for (const row of removed)
    // `days` is the signed ledger amount (-1): adding it gives the day back.
    await tx
      .update(leaveBalances)
      .set({
        usedDays: sql`${leaveBalances.usedDays} + ${row.days}::numeric`,
        updatedAt: now,
      })
      .where(
        and(
          eq(leaveBalances.tenantId, tenantId),
          eq(leaveBalances.employeeId, row.employeeId),
          eq(leaveBalances.leaveTypeId, row.leaveTypeId),
          eq(leaveBalances.periodYear, year),
        ),
      );
  return removed.length;
}
