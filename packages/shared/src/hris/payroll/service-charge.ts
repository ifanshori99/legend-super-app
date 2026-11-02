// Service-charge pool distribution (PRD v1.7 §3 D.30 "Distribusi Service
// Charge: pool service charge per periode dibagikan berdasarkan poin jabatan,
// kehadiran, dan aturan yang diatur admin, lalu masuk sebagai komponen
// payroll"; §6 H `service_charge_pools` / `service_charge_allocations`:
// outlet_id, period, amount_idr, rule; pool_id, employee_id, points,
// amount_idr). Position points come from `positions.service_charge_points`
// (HRIS contract, Decimal4).
//
// Lifecycle:
//   draft -> calculated (repeatable) -> approved -> distributed
//   draft | calculated -> cancelled
// `distributed` is set when the payroll run carrying the allocations is
// locked; a reversed run returns the pool to `approved`.
//
// The split always sums to the pool exactly (ORD-06, D-CORE-2 allocateIdr,
// largest remainder, deterministic tie-break by participant order).

import {
  z,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idrSchema,
  businessDateSchema,
  isoDateTimeSchema,
  decimal4Schema,
  clientInputSchema,
  idempotencyKeySchema,
  allocateIdr,
  parseDecimal4,
} from "../../core/index.ts";
import type { Decimal4, Idr } from "../../core/index.ts";
import { employeeIdSchema } from "../ids.ts";
import type { EmployeeId } from "../ids.ts";
import { employmentTypeSchema } from "../organization.ts";
import { PayrollError } from "./errors.ts";
import {
  payrollRunIdSchema,
  serviceChargeAllocationIdSchema,
  serviceChargePoolIdSchema,
} from "./ids.ts";

/**
 * points: weight = position points; points_x_attendance: points x days
 * present; equal: one share per eligible employee.
 */
export const serviceChargeMethodSchema = z.enum([
  "points",
  "points_x_attendance",
  "equal",
]);
export type ServiceChargeMethod = z.infer<typeof serviceChargeMethodSchema>;

export const serviceChargeRuleSchema = z.strictObject({
  method: serviceChargeMethodSchema,
  /** Employees with fewer days present in the period get no share. */
  minAttendanceDays: z.number().int().min(0).max(31),
  eligibleEmploymentTypes: z.array(employmentTypeSchema).min(1).max(4),
});
export type ServiceChargeRule = z.infer<typeof serviceChargeRuleSchema>;

export const SERVICE_CHARGE_POOL_STATUSES = [
  "draft",
  "calculated",
  "approved",
  "distributed",
  "cancelled",
] as const;
export const serviceChargePoolStatusSchema = z.enum(
  SERVICE_CHARGE_POOL_STATUSES,
);
export type ServiceChargePoolStatus = z.infer<
  typeof serviceChargePoolStatusSchema
>;

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Must not be negative");

const poolFields = {
  outletId: outletIdSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  /** Service charge collected in the period (from POS settlements). */
  amountIdr: nonNegativeIdr,
  rule: serviceChargeRuleSchema,
};

export const serviceChargePoolSchema = z
  .strictObject({
    id: serviceChargePoolIdSchema,
    tenantId: tenantIdSchema,
    ...poolFields,
    status: serviceChargePoolStatusSchema,
    payrollRunId: payrollRunIdSchema.nullable(),
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((pool, ctx) => {
    if (pool.periodEnd < pool.periodStart)
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "periodEnd cannot precede periodStart",
      });
    const approved =
      pool.status === "approved" || pool.status === "distributed";
    if (
      (pool.approvedBy !== null) !== approved ||
      (pool.approvedAt !== null) !== approved
    )
      ctx.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "approvedBy/approvedAt are set exactly for approved pools",
      });
    if ((pool.status === "distributed") !== (pool.payrollRunId !== null))
      ctx.addIssue({
        code: "custom",
        path: ["payrollRunId"],
        message: "A distributed pool names the payroll run that paid it",
      });
  });
export type ServiceChargePool = z.infer<typeof serviceChargePoolSchema>;

export const createServiceChargePoolInputSchema = clientInputSchema({
  ...poolFields,
  idempotencyKey: idempotencyKeySchema,
});
export type CreateServiceChargePoolInput = z.infer<
  typeof createServiceChargePoolInputSchema
>;

export const serviceChargeAllocationSchema = z.strictObject({
  id: serviceChargeAllocationIdSchema,
  tenantId: tenantIdSchema,
  poolId: serviceChargePoolIdSchema,
  employeeId: employeeIdSchema,
  points: decimal4Schema,
  attendanceDays: z.number().int().min(0).max(31),
  /** Integer weight the split used (points scaled by 10^4 x days, ...). */
  weight: z.number().int().min(0).safe(),
  amountIdr: nonNegativeIdr,
});
export type ServiceChargeAllocation = z.infer<
  typeof serviceChargeAllocationSchema
>;

export type ServiceChargePoolAction =
  "calculate" | "approve" | "distribute" | "cancel" | "restore";

const poolTransitions: Partial<
  Record<
    ServiceChargePoolStatus,
    Partial<Record<ServiceChargePoolAction, ServiceChargePoolStatus>>
  >
> = {
  draft: { calculate: "calculated", cancel: "cancelled" },
  calculated: {
    calculate: "calculated",
    approve: "approved",
    cancel: "cancelled",
  },
  approved: { distribute: "distributed" },
  /** Run reversal (PAYR-05) gives the pool back to be paid again. */
  distributed: { restore: "approved" },
};

export function transitionServiceChargePool(
  status: ServiceChargePoolStatus,
  action: ServiceChargePoolAction,
): ServiceChargePoolStatus {
  const next = poolTransitions[status]?.[action];
  if (!next) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  return next;
}

export type ServiceChargeParticipant = {
  employeeId: EmployeeId;
  employmentType: z.infer<typeof employmentTypeSchema>;
  points: Decimal4;
  attendanceDays: number;
};

export type ServiceChargeShare = {
  employeeId: EmployeeId;
  points: Decimal4;
  attendanceDays: number;
  weight: number;
  amountIdr: Idr;
};

/** Integer weight of one participant under the rule (0 = not eligible). */
export function serviceChargeWeight(
  rule: ServiceChargeRule,
  participant: ServiceChargeParticipant,
): number {
  if (!rule.eligibleEmploymentTypes.includes(participant.employmentType))
    return 0;
  if (participant.attendanceDays < rule.minAttendanceDays) return 0;
  const points = parseDecimal4(participant.points);
  if (points < 0n) throw new RangeError("Points cannot be negative");
  switch (rule.method) {
    case "equal":
      return 1;
    case "points":
      return Number(points);
    case "points_x_attendance":
      return Number(points * BigInt(participant.attendanceDays));
  }
}

/**
 * Splits the pool across participants. Sum of shares === pool amount. A
 * non-empty pool without any eligible participant is refused (the money must
 * not silently vanish): PAYROLL_INVALID_TRANSITION.
 */
export function distributeServiceChargePool(
  amountIdr: Idr,
  rule: ServiceChargeRule,
  participants: readonly ServiceChargeParticipant[],
): ServiceChargeShare[] {
  const weights = participants.map((p) => serviceChargeWeight(rule, p));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    if (amountIdr === 0)
      return participants.map((p) => ({
        employeeId: p.employeeId,
        points: p.points,
        attendanceDays: p.attendanceDays,
        weight: 0,
        amountIdr: 0 as Idr,
      }));
    throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  }
  const amounts = allocateIdr(amountIdr, weights);
  return participants.map((p, index) => ({
    employeeId: p.employeeId,
    points: p.points,
    attendanceDays: p.attendanceDays,
    weight: weights[index] ?? 0,
    amountIdr: amounts[index] ?? (0 as Idr),
  }));
}
