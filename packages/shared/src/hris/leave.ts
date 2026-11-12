// Leave, holidays and overtime (PRD v1.7 §3 Kelompok D 29 "Cuti, Izin &
// Lembur", §6 H `leave_types`, `leave_balances`, `leave_requests`, `holidays`,
// `overtime_requests`; F27, HR-05 adjacent).
//
// Day counts are `Decimal4` quantities (half days are allowed and this is not
// money). Overtime pay formulas belong to the payroll contract (bead
// legend-zjwa); this contract only records the approved minutes.

import {
  z,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  decimal4Schema,
  parseDecimal4,
  formatDecimal4,
  divideRounded,
  CoreError,
} from "../core/index.ts";
import type { Decimal4 } from "../core/index.ts";
import {
  employeeIdSchema,
  leaveTypeIdSchema,
  leaveBalanceIdSchema,
  leaveRequestIdSchema,
  holidayIdSchema,
  overtimeRequestIdSchema,
  overtimeFormulaIdSchema,
} from "./ids.ts";
import {
  overtimeDayTypeSchema,
  overtimeParametersSchema,
} from "./payroll/statutory.ts";

const nonnegativeDecimal = decimal4Schema.refine(
  (value) => parseDecimal4(value) >= 0n,
  "Must not be negative",
);
const positiveDecimal = decimal4Schema.refine(
  (value) => parseDecimal4(value) > 0n,
  "Must be greater than zero",
);
const reason = z.string().min(1).max(500);

// ---- Holidays ------------------------------------------------------------

/** PRD §6 H `holidays.type` (`national` / `collective` / `company`). */
export const holidayTypeSchema = z.enum(["national", "collective", "company"]);
export type HolidayType = z.infer<typeof holidayTypeSchema>;

export const holidaySchema = z.strictObject({
  id: holidayIdSchema,
  tenantId: tenantIdSchema,
  date: businessDateSchema,
  name: z.string().min(1).max(150),
  type: holidayTypeSchema,
  /** Company holiday for one outlet; null = the whole tenant. */
  outletId: outletIdSchema.nullable(),
});
export type Holiday = z.infer<typeof holidaySchema>;

/** A year's calendar; duplicate date + outlet pairs are rejected. */
export const holidayCalendarSchema = z
  .array(holidaySchema)
  .superRefine((holidays, ctx) => {
    const keys = new Set<string>();
    for (const holiday of holidays) {
      const key = `${holiday.date}|${holiday.outletId ?? "all"}`;
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate holiday on ${holiday.date}`,
        });
      keys.add(key);
    }
  });
export type HolidayCalendar = z.infer<typeof holidayCalendarSchema>;

/** True when `date` is a holiday for the outlet (tenant-wide rows count too). */
export function isHoliday(
  date: string,
  holidays: readonly Holiday[],
  outletId?: string,
): boolean {
  return holidays.some(
    (holiday) =>
      holiday.date === date &&
      (holiday.outletId === null ||
        outletId === undefined ||
        holiday.outletId.toLowerCase() === outletId.toLowerCase()),
  );
}

// ---- Leave ---------------------------------------------------------------

/** Configurable balance policy (PRD F27 "kebijakan saldo, akrual, carry-over"). */
export const leavePolicySchema = z.strictObject({
  annualDays: nonnegativeDecimal,
  carryOverMaxDays: nonnegativeDecimal,
  /** 0 = carry-over never expires; otherwise months after the period year ends. */
  carryOverExpiryMonths: z.number().int().min(0).max(24),
  /** false = unlimited leave with no balance row (e.g. sick leave). */
  tracksBalance: z.boolean().default(true),
  /** `upfront` grants the annual days once a year; `monthly` accrues 1/12 a month. */
  accrual: z.enum(["upfront", "monthly"]).default("upfront"),
  /** How far below zero a balance may go when a request is made. */
  negativeAllowanceDays: nonnegativeDecimal.default(() => formatDecimal4(0n)),
});
export type LeavePolicy = z.infer<typeof leavePolicySchema>;

export const leaveTypeSchema = z.strictObject({
  id: leaveTypeIdSchema,
  tenantId: tenantIdSchema,
  code: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Leave type codes are uppercase"),
  name: z.string().min(1).max(100),
  paid: z.boolean(),
  /** Attachment required with the request (e.g. medical certificate). */
  requiresAttachment: z.boolean(),
  policy: leavePolicySchema,
  isActive: z.boolean(),
});
export type LeaveType = z.infer<typeof leaveTypeSchema>;

/** Create/update payload for a leave type (the server owns id and tenant). */
export const leaveTypeInputSchema = z.strictObject({
  code: leaveTypeSchema.shape.code,
  name: leaveTypeSchema.shape.name,
  paid: z.boolean(),
  requiresAttachment: z.boolean(),
  policy: leavePolicySchema,
  isActive: z.boolean().optional(),
});
export type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

/** Result of an accrual run: balances granted vs skipped (already granted). */
export const leaveAccrualRunResultSchema = z.strictObject({
  granted: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type LeaveAccrualRunResult = z.infer<typeof leaveAccrualRunResultSchema>;

/**
 * Tenant leave settings (founder decision Q7 "cuti bersama"). Collective leave
 * (`holidays.type = 'collective'`) deducts one day of the annual balance per
 * collective date by default; national and company holidays never deduct.
 * `annualLeaveTypeId` null = the active leave type coded `ANNUAL`;
 * `effectiveAnnualLeaveTypeId` is the type the deduction actually uses (null =
 * none, nothing is deducted). `collectiveLeaveEffectiveFrom` is the business
 * date from which collective days are deducted (no retroactive deduction; the
 * server default applies until one is saved). `updatedBy`/`updatedAt` are null
 * until saved.
 */
const collectiveLeaveEffectiveFromSchema = businessDateSchema.refine(
  (date) => date >= "2000-01-01",
  "Tanggal berlaku cuti bersama tidak boleh sebelum tahun 2000.",
);
export const leaveSettingsSchema = z.strictObject({
  tenantId: tenantIdSchema,
  collectiveLeaveDeductsAnnual: z.boolean(),
  annualLeaveTypeId: leaveTypeIdSchema.nullable(),
  effectiveAnnualLeaveTypeId: leaveTypeIdSchema.nullable(),
  collectiveLeaveEffectiveFrom: collectiveLeaveEffectiveFromSchema,
  updatedBy: userIdSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type LeaveSettings = z.infer<typeof leaveSettingsSchema>;

/** PUT payload: the whole setting (the server owns tenant and audit fields). */
export const leaveSettingsInputSchema = z.strictObject({
  collectiveLeaveDeductsAnnual: z.boolean(),
  annualLeaveTypeId: leaveTypeIdSchema.nullable(),
  /** Omitted or null = the server default. */
  collectiveLeaveEffectiveFrom: collectiveLeaveEffectiveFromSchema
    .nullable()
    .default(null),
});
export type LeaveSettingsInput = z.input<typeof leaveSettingsInputSchema>;

/** PRD §6 H `leave_balances` row for one employee, type and period year. */
export const leaveBalanceSchema = z.strictObject({
  id: leaveBalanceIdSchema,
  tenantId: tenantIdSchema,
  employeeId: employeeIdSchema,
  leaveTypeId: leaveTypeIdSchema,
  periodYear: z.number().int().min(2000).max(2100),
  entitledDays: nonnegativeDecimal,
  carriedOverDays: nonnegativeDecimal,
  usedDays: nonnegativeDecimal,
  pendingDays: nonnegativeDecimal,
});
// Used + pending may exceed entitled + carried over by the leave type's
// `policy.negativeAllowanceDays`; the server enforces that limit under a row
// lock when a request is created, so the DTO itself does not refuse it.
export type LeaveBalance = z.infer<typeof leaveBalanceSchema>;

/** Remaining days (entitled + carried over − used − pending). */
export function leaveDaysRemaining(
  balance: Pick<
    LeaveBalance,
    "entitledDays" | "carriedOverDays" | "usedDays" | "pendingDays"
  >,
): Decimal4 {
  return formatDecimal4(
    parseDecimal4(balance.entitledDays) +
      parseDecimal4(balance.carriedOverDays) -
      parseDecimal4(balance.usedDays) -
      parseDecimal4(balance.pendingDays),
  );
}

/** True when the balance can still absorb `days` (approval guard, F27). */
export function canApproveLeave(
  balance: Pick<
    LeaveBalance,
    "entitledDays" | "carriedOverDays" | "usedDays" | "pendingDays"
  >,
  days: Decimal4,
): boolean {
  const remaining =
    parseDecimal4(balance.entitledDays) +
    parseDecimal4(balance.carriedOverDays) -
    parseDecimal4(balance.usedDays) -
    parseDecimal4(balance.pendingDays);
  return parseDecimal4(days) <= remaining;
}

export const leaveRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);
export type LeaveRequestStatus = z.infer<typeof leaveRequestStatusSchema>;

/**
 * PRD §6 H `leave_requests` row. `days` is the day count the server computed
 * from the tenant policy and holiday calendar, so the request never disagrees
 * with the balance. `reason` and the attachment are personal data and are never
 * copied into an event payload.
 */
export const leaveRequestSchema = z
  .strictObject({
    id: leaveRequestIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    leaveTypeId: leaveTypeIdSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    days: positiveDecimal,
    reason: reason.nullable(),
    rejectionReason: z.string().min(1).max(500).nullable().default(null),
    /** Signed, short-lived URL of the private attachment (medical certificate). */
    attachmentUrl: z.string().min(1).max(2048).nullable(),
    status: leaveRequestStatusSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    if (request.endDate < request.startDate)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot precede the start date",
      });
    // A system ending (matrix expiry / cancel) has a time but no deciding user.
    if (request.decidedBy !== null && request.decidedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A leave decision by a user needs a decision time",
      });
    if (request.status === "pending" && request.decidedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A pending request has no decision",
      });
    if (
      (request.status === "approved" || request.status === "rejected") &&
      request.decidedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A decided request needs a decision time",
      });
    if (request.status === "approved" && request.decidedBy === null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "An approved request needs a deciding user",
      });
  });
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

const leaveTransitions: Partial<
  Record<
    LeaveRequestStatus,
    Partial<Record<"approve" | "reject" | "cancel", LeaveRequestStatus>>
  >
> = {
  pending: { approve: "approved", reject: "rejected", cancel: "cancelled" },
  approved: { cancel: "cancelled" },
};
export type LeaveRequestAction = "approve" | "reject" | "cancel";

/** Pending → approved/rejected/cancelled; an approved leave can be cancelled. */
export function transitionLeaveRequest(
  status: LeaveRequestStatus,
  action: LeaveRequestAction,
): LeaveRequestStatus {
  const next = leaveTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi cuti tidak valid: ${status} → ${action}.`,
    );
  return next;
}

// ---- Overtime ------------------------------------------------------------

export const overtimeRequestStatusSchema = leaveRequestStatusSchema;
export type OvertimeRequestStatus = z.infer<typeof overtimeRequestStatusSchema>;

/** PRD §6 H `overtime_requests`: date, minutes, reason, status, approved_by. */
export const overtimeRequestSchema = z
  .strictObject({
    id: overtimeRequestIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    date: businessDateSchema,
    minutes: z.number().int().min(1).max(720),
    reason,
    rejectionReason: z.string().min(1).max(500).nullable().default(null),
    /** Day kind the pay tiers apply to; a holiday resolves to a rest-day type. */
    dayType: overtimeDayTypeSchema,
    /** Formula version pinned at request time; null when none was resolved. */
    formulaId: overtimeFormulaIdSchema.nullable(),
    status: overtimeRequestStatusSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    // A system ending (matrix expiry / cancel) has a time but no deciding user.
    if (request.decidedBy !== null && request.decidedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "An overtime decision by a user needs a decision time",
      });
    if (request.status === "pending" && request.decidedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A pending request has no decision",
      });
    if (
      (request.status === "approved" || request.status === "rejected") &&
      request.decidedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A decided request needs a decision time",
      });
    if (request.status === "approved" && request.decidedBy === null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "An approved request needs a deciding user",
      });
  });
export type OvertimeRequest = z.infer<typeof overtimeRequestSchema>;

const overtimeTransitions: Partial<
  Record<
    OvertimeRequestStatus,
    Partial<Record<"approve" | "reject" | "cancel", OvertimeRequestStatus>>
  >
> = {
  pending: { approve: "approved", reject: "rejected", cancel: "cancelled" },
  approved: { cancel: "cancelled" },
};
export type OvertimeRequestAction = "approve" | "reject" | "cancel";

/** Same lifecycle as leave: pending → approved/rejected/cancelled. */
export function transitionOvertimeRequest(
  status: OvertimeRequestStatus,
  action: OvertimeRequestAction,
): OvertimeRequestStatus {
  const next = overtimeTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi lembur tidak valid: ${status} → ${action}.`,
    );
  return next;
}

export const overtimeRestDayTypeSchema = z.enum([
  "rest_day_6_day_week",
  "rest_day_5_day_week",
]);
export type OvertimeRestDayType = z.infer<typeof overtimeRestDayTypeSchema>;

export const overtimeFormulaStatusSchema = z.enum([
  "draft",
  "published",
  "archived",
]);
export type OvertimeFormulaStatus = z.infer<typeof overtimeFormulaStatusSchema>;

/** Versioned "rumus lembur": a published version never changes. */
export const overtimeFormulaSchema = z.strictObject({
  id: overtimeFormulaIdSchema,
  tenantId: tenantIdSchema,
  version: z.number().int().min(1),
  effectiveFrom: businessDateSchema,
  status: overtimeFormulaStatusSchema,
  parameters: overtimeParametersSchema,
  /** Day type applied to holidays (the tenant's working-week regime). */
  restDayType: overtimeRestDayTypeSchema,
  legalBasis: z.string().min(1).max(200),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: userIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type OvertimeFormula = z.infer<typeof overtimeFormulaSchema>;

/** Overtime hours as a Decimal4 quantity, for display and payroll input. */
export function overtimeHours(minutes: number): Decimal4 {
  if (!Number.isInteger(minutes) || minutes <= 0)
    throw new RangeError("Overtime minutes must be a positive integer");
  return formatDecimal4(
    divideRounded(BigInt(minutes) * 10_000n, 60n, "half_up"),
  );
}
