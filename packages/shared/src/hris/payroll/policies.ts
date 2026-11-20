// Payroll policies, cycles and THR schedules (PRD v1.7 §3 D.30 "Kebijakan
// Payroll": tanggal gajian, periode cut-off absensi, dan siklus bulanan, dua
// mingguan, atau harian dapat dikonfigurasi per tenant dan per kelompok
// karyawan; "THR ... tanggal pembayaran yang dapat diatur"; §6 H
// `payroll_policies`: legal_entity_id, frequency, cutoff_day, pay_day,
// employee_group; Alur K step 1).
//
// Period arithmetic is on business dates (YYYY-MM-DD, outlet/legal-entity time
// zone, D-CORE-6) and never reads the clock.

import {
  z,
  tenantIdSchema,
  businessDateSchema,
  isoDateTimeSchema,
  clientInputSchema,
  idempotencyKeySchema,
} from "../../core/index.ts";
import type { BusinessDate } from "../../core/index.ts";
import { legalEntityIdSchema } from "../../accounting/ids.ts";
import { employeeIdSchema } from "../ids.ts";
import { employmentTypeSchema } from "../organization.ts";
import { payrollPolicyIdSchema, thrScheduleIdSchema } from "./ids.ts";
import { BPJS_TABLE_TYPES, jkkRiskClassSchema } from "./statutory.ts";

// ---- Cycles ---------------------------------------------------------------

export const payrollFrequencySchema = z.enum(["monthly", "biweekly", "daily"]);
export type PayrollFrequency = z.infer<typeof payrollFrequencySchema>;

const dayOfMonth = z.number().int().min(1).max(28);

/**
 * monthly: attendance cut-off day (null = calendar month) and pay day (null =
 * last day of the month), paid in the month the period ends or the next.
 * Days are capped at 28 so every month has them.
 * biweekly: 14-day periods counted from `anchorDate` (a period start).
 * daily: one-day periods for daily workers (pekerja harian).
 */
export const payrollCycleSchema = z
  .discriminatedUnion("frequency", [
    z.strictObject({
      frequency: z.literal("monthly"),
      cutoffDay: dayOfMonth.nullable(),
      payDay: dayOfMonth.nullable(),
      payMonthOffset: z.union([z.literal(0), z.literal(1)]),
    }),
    z.strictObject({
      frequency: z.literal("biweekly"),
      anchorDate: businessDateSchema,
      payDaysAfterPeriodEnd: z.number().int().min(0).max(14),
    }),
    z.strictObject({
      frequency: z.literal("daily"),
      payDaysAfterPeriodEnd: z.number().int().min(0).max(7),
    }),
  ])
  .superRefine((cycle, ctx) => {
    // A monthly period with a cut-off ends on cutoffDay; paying in the same
    // month on or before that day would pay before the period has closed
    // (attendance and overtime not final). Pay later that month or next month.
    if (
      cycle.frequency === "monthly" &&
      cycle.payMonthOffset === 0 &&
      cycle.cutoffDay !== null &&
      cycle.payDay !== null &&
      cycle.payDay <= cycle.cutoffDay
    )
      ctx.addIssue({
        code: "custom",
        path: ["payDay"],
        message:
          "With payMonthOffset 0 the pay day must fall after the cut-off day",
      });
  });
export type PayrollCycle = z.infer<typeof payrollCycleSchema>;

/**
 * PRD silent on a pay date that falls on a weekend or holiday. Default is
 * `previous_working_day` (safest: salary is never paid late, U10).
 */
export const payDateAdjustmentSchema = z.enum([
  "previous_working_day",
  "next_working_day",
  "none",
]);
export type PayDateAdjustment = z.infer<typeof payDateAdjustmentSchema>;

/** Which employees a policy covers (§6 H `employee_group`). */
export const employeeGroupSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Group codes are 2-30 chars: A-Z, 0-9, _"),
  name: z.string().trim().min(1).max(100),
  employmentTypes: z.array(employmentTypeSchema).min(1).max(4),
});
export type EmployeeGroup = z.infer<typeof employeeGroupSchema>;

const policyFields = {
  legalEntityId: legalEntityIdSchema,
  name: z.string().trim().min(1).max(100),
  employeeGroup: employeeGroupSchema,
  cycle: payrollCycleSchema,
  payDateAdjustment: payDateAdjustmentSchema,
  /** JKK risk group of the employer for the JKK table. */
  jkkRiskClass: jkkRiskClassSchema,
  /** BPJS programmes this group is enrolled in (PRD silent: per group). */
  bpjsProgrammes: z
    .array(z.enum(BPJS_TABLE_TYPES))
    .max(BPJS_TABLE_TYPES.length)
    .refine(
      (list) => new Set(list).size === list.length,
      "Duplicate programme",
    ),
};

export const payrollPolicySchema = z.strictObject({
  id: payrollPolicyIdSchema,
  tenantId: tenantIdSchema,
  ...policyFields,
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PayrollPolicy = z.infer<typeof payrollPolicySchema>;

export const createPayrollPolicyInputSchema = clientInputSchema({
  ...policyFields,
  idempotencyKey: idempotencyKeySchema,
});
export type CreatePayrollPolicyInput = z.infer<
  typeof createPayrollPolicyInputSchema
>;

/** Changes apply to runs created afterwards; a run keeps its snapshot. */
export const updatePayrollPolicyInputSchema = clientInputSchema({
  name: policyFields.name.optional(),
  cycle: payrollCycleSchema.optional(),
  payDateAdjustment: payDateAdjustmentSchema.optional(),
  jkkRiskClass: jkkRiskClassSchema.optional(),
  bpjsProgrammes: policyFields.bpjsProgrammes.optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePayrollPolicyInput = z.infer<
  typeof updatePayrollPolicyInputSchema
>;

// ---- Overlap guards (bead legend-1213, SO 1208) ----------------------------

/**
 * Employment types two policies of one legal entity both cover. A run takes
 * every employee of its policy's types, so a shared type means the employee is
 * in two runs of the same period and is paid twice.
 */
export function sharedEmploymentTypes(
  a: readonly EmployeeGroup["employmentTypes"][number][],
  b: readonly EmployeeGroup["employmentTypes"][number][],
): EmployeeGroup["employmentTypes"] {
  const other = new Set(b);
  return [...new Set(a)].filter((type) => other.has(type));
}

/**
 * The first of `activePolicies` (the ACTIVE policies of the same legal entity,
 * without `candidate` itself) that shares an employment type with `candidate`,
 * or null. Pure: the service loads the rows and decides the status code.
 */
export function findEmploymentTypeOverlap(
  candidate: EmployeeGroup["employmentTypes"],
  activePolicies: readonly {
    name: string;
    employeeGroup: Pick<EmployeeGroup, "employmentTypes">;
  }[],
): { name: string; types: EmployeeGroup["employmentTypes"] } | null {
  for (const policy of activePolicies) {
    const types = sharedEmploymentTypes(
      candidate,
      policy.employeeGroup.employmentTypes,
    );
    if (types.length > 0) return { name: policy.name, types };
  }
  return null;
}

/**
 * True when `cycle` would open a period that starts on or before
 * `latestRunPeriodEnd` (the end of the latest live regular run of the policy):
 * the days up to that date are already paid, so the next period must start
 * after it. The period that follows the run is the one containing the next day.
 */
export function cycleReopensPaidDays(
  cycle: PayrollCycle,
  latestRunPeriodEnd: BusinessDate,
): boolean {
  const next = payrollPeriodFor(cycle, addDays(latestRunPeriodEnd, 1));
  return next.periodStart <= latestRunPeriodEnd;
}

// ---- Date helpers (UTC calendar arithmetic on YYYY-MM-DD) ----------------

const DAY_MS = 86_400_000;

function toUtc(date: BusinessDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): BusinessDate {
  return new Date(ms).toISOString().slice(0, 10) as BusinessDate;
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

function ymd(year: number, month: number, day: number): BusinessDate {
  // month is 1-based and may overflow (13 -> next year); Date.UTC normalizes.
  return fromUtc(Date.UTC(year, month - 1, day));
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type PayrollPeriod = {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** Pay date before the working-day adjustment. */
  payDate: BusinessDate;
};

/** The period of `cycle` that contains `referenceDate`. */
export function payrollPeriodFor(
  cycle: PayrollCycle,
  referenceDate: BusinessDate,
): PayrollPeriod {
  const [y, m, d] = referenceDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  switch (cycle.frequency) {
    case "monthly": {
      let start: BusinessDate;
      let end: BusinessDate;
      if (cycle.cutoffDay === null) {
        start = ymd(y, m, 1);
        end = ymd(y, m, lastDayOfMonth(y, m));
      } else if (d <= cycle.cutoffDay) {
        start = ymd(y, m - 1, cycle.cutoffDay + 1);
        end = ymd(y, m, cycle.cutoffDay);
      } else {
        start = ymd(y, m, cycle.cutoffDay + 1);
        end = ymd(y, m + 1, cycle.cutoffDay);
      }
      const [ey, em] = end.split("-").map(Number) as [number, number];
      const payMonth = em + cycle.payMonthOffset;
      const payYear = ey + Math.floor((payMonth - 1) / 12);
      const normalizedMonth = ((payMonth - 1) % 12) + 1;
      const payDay = cycle.payDay ?? lastDayOfMonth(payYear, normalizedMonth);
      return {
        periodStart: start,
        periodEnd: end,
        payDate: ymd(payYear, normalizedMonth, payDay),
      };
    }
    case "biweekly": {
      const diff = Math.floor(
        (toUtc(referenceDate) - toUtc(cycle.anchorDate)) / DAY_MS,
      );
      const index = Math.floor(diff / 14);
      const start = addDays(cycle.anchorDate, index * 14);
      const end = addDays(start, 13);
      return {
        periodStart: start,
        periodEnd: end,
        payDate: addDays(end, cycle.payDaysAfterPeriodEnd),
      };
    }
    case "daily":
      return {
        periodStart: referenceDate,
        periodEnd: referenceDate,
        payDate: addDays(referenceDate, cycle.payDaysAfterPeriodEnd),
      };
  }
}

/**
 * Moves a pay date off weekends/holidays. `isNonWorkingDay` comes from the
 * holiday calendar (§3 D.29 Hari Libur) plus the legal entity's weekly rest
 * days; at most 31 steps, so a misconfigured calendar cannot loop forever.
 */
export function adjustPayDate(
  payDate: BusinessDate,
  rule: PayDateAdjustment,
  isNonWorkingDay: (date: BusinessDate) => boolean,
): BusinessDate {
  if (rule === "none") return payDate;
  const step = rule === "previous_working_day" ? -1 : 1;
  let date = payDate;
  for (let i = 0; i < 31 && isNonWorkingDay(date); i += 1)
    date = addDays(date, step);
  if (isNonWorkingDay(date))
    throw new RangeError("No working day within 31 days of the pay date");
  return date;
}

// ---- THR schedules --------------------------------------------------------

export const thrScheduleStatusSchema = z.enum([
  "scheduled",
  "paid",
  "cancelled",
]);
export type ThrScheduleStatus = z.infer<typeof thrScheduleStatusSchema>;

const thrScheduleFields = {
  legalEntityId: legalEntityIdSchema,
  /** e.g. "THR Idul Fitri 2027". */
  name: z.string().trim().min(1).max(100),
  holidayName: z.string().trim().min(1).max(100),
  holidayDate: businessDateSchema,
  /** Masa kerja is counted up to this date (PRD: "sesuai masa kerja"). */
  tenureAsOfDate: businessDateSchema,
  payDate: businessDateSchema,
  /** null = every eligible employee of the legal entity. */
  employeeIds: z.array(employeeIdSchema).min(1).max(1000).nullable(),
};

function checkThrDates(
  value: { holidayDate: string; payDate: string; tenureAsOfDate: string },
  ctx: z.RefinementCtx,
) {
  // PRD silent on the deadline; safest: THR is never paid after the holiday.
  if (value.payDate > value.holidayDate)
    ctx.addIssue({
      code: "custom",
      path: ["payDate"],
      message: "THR must be paid on or before the holiday",
    });
  if (value.tenureAsOfDate > value.holidayDate)
    ctx.addIssue({
      code: "custom",
      path: ["tenureAsOfDate"],
      message: "Tenure reference date cannot be after the holiday",
    });
}

export const thrScheduleSchema = z
  .strictObject({
    id: thrScheduleIdSchema,
    tenantId: tenantIdSchema,
    ...thrScheduleFields,
    status: thrScheduleStatusSchema,
    createdAt: isoDateTimeSchema,
  })
  .superRefine(checkThrDates);
export type ThrSchedule = z.infer<typeof thrScheduleSchema>;

export const createThrScheduleInputSchema = clientInputSchema({
  ...thrScheduleFields,
  idempotencyKey: idempotencyKeySchema,
}).superRefine(checkThrDates);
export type CreateThrScheduleInput = z.infer<
  typeof createThrScheduleInputSchema
>;
