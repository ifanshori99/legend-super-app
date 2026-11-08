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
// - National and company holidays never deduct; leave requests keep excluding
//   every holiday from their day count (countLeaveDays), so nothing is
//   deducted twice. A collective date that also has a national/company holiday
//   in the employee's scope (tenant-wide or their home outlet) is already a
//   paid day off and is not deducted (same precedence as overtime).

import { and, asc, eq, gte, lt, ne, sql } from "drizzle-orm";
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
import type { LeaveJobActor } from "./hris-leave.service.ts";

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
      .orderBy(asc(holidays.date), asc(holidays.id));
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
        // The upsert takes the balance row lock (same as FOR UPDATE), so a
        // concurrent request or job on this balance serializes behind it.
        const [balance] = await tx
          .insert(leaveBalances)
          .values({
            tenantId,
            employeeId: employee.id,
            leaveTypeId: type.id,
            periodYear,
            usedDays: formatDecimal4(ONE_DAY),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              leaveBalances.tenantId,
              leaveBalances.employeeId,
              leaveBalances.leaveTypeId,
              leaveBalances.periodYear,
            ],
            set: {
              usedDays: sql`${leaveBalances.usedDays} + ${formatDecimal4(ONE_DAY)}::numeric`,
              updatedAt: now,
            },
          })
          .returning();
        if (!balance) throw new Error("Leave balance upsert returned no row");
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
