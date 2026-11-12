// Shared helpers of the shift scheduling services (PRD v1.7 §3 Kelompok D 28
// "Penjadwalan Shift", F26, HR-05; bead legend-jstx). Used by
// hris-scheduling-{setup,roster,swap}.service.ts.
//
// - Row → DTO mappers parse through the contract schemas, so a bad row fails
//   loudly instead of leaking an off-contract shape. Only employee ids appear
//   in a schedule DTO (no name, NIK or pay).
// - Compliance limits resolve outlet row → tenant row → built-in default.
// - Template segments are wall-clock times of the outlet; an assignment
//   snapshots concrete instants computed with the outlet time zone.

import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { toIsoDateTime, type TenantId } from "@starter/shared/core";
import {
  addBusinessDays,
  shiftAssignmentSchema,
  shiftSwapRequestSchema,
  shiftTemplateSchema,
  type ShiftAssignment,
  type ShiftAssignmentSegment,
  type ShiftCompliancePolicy,
  type ShiftSwapRequest,
  type ShiftTemplate,
} from "@starter/shared/hris";
import { outlets } from "../db/schema/platform-org.ts";
import {
  shiftAssignments,
  shiftCompliancePolicies,
  shiftSwapRequests,
  shiftTemplates,
} from "../db/schema/hris-scheduling.ts";
import { HRIS_AUDIT_SAFE_FIELDS, type Tx } from "./hris-access.ts";

export type ShiftComplianceLimits = Pick<
  ShiftCompliancePolicy,
  | "maxShiftMinutes"
  | "maxDailyMinutes"
  | "maxWeeklyMinutes"
  | "minRestMinutesBetweenShifts"
  | "maxConsecutiveWorkDays"
>;
export type ShiftCompliancePolicySource = "outlet" | "tenant" | "default";

/** Built-in limits when neither the outlet nor the tenant set a policy row. */
export const DEFAULT_SHIFT_COMPLIANCE_LIMITS: ShiftComplianceLimits =
  Object.freeze({
    maxShiftMinutes: 600,
    maxDailyMinutes: 720,
    maxWeeklyMinutes: 2_700,
    minRestMinutesBetweenShifts: 660,
    maxConsecutiveWorkDays: 6,
  });

/** Audit fields of the scheduling services (values are not personal data). */
export const HRIS_SCHEDULING_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "name",
  "isActive",
  "source",
  "businessDate",
  "weekStart",
  "assignmentCount",
  "maxShiftMinutes",
  "maxDailyMinutes",
  "maxWeeklyMinutes",
  "minRestMinutesBetweenShifts",
  "maxConsecutiveWorkDays",
] as const;

type ShiftAssignmentRow = typeof shiftAssignments.$inferSelect;
type ShiftTemplateRow = typeof shiftTemplates.$inferSelect;
type ShiftSwapRequestRow = typeof shiftSwapRequests.$inferSelect;

export function toShiftAssignment(row: ShiftAssignmentRow): ShiftAssignment {
  return shiftAssignmentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    employeeId: row.employeeId,
    shiftTemplateId: row.shiftTemplateId,
    stationId: row.stationId,
    businessDate: row.businessDate,
    segments: row.segments,
    breakMinutes: row.breakMinutes,
    status: row.status,
    source: row.source,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  });
}

export function toShiftTemplate(row: ShiftTemplateRow): ShiftTemplate {
  return shiftTemplateSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    segments: row.segments,
    breakMinutes: row.breakMinutes,
    stationId: row.stationId,
    positionId: row.positionId,
    isActive: row.isActive,
  });
}

export function toShiftSwapRequest(row: ShiftSwapRequestRow): ShiftSwapRequest {
  return shiftSwapRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    fromAssignmentId: row.fromAssignmentId,
    toAssignmentId: row.toAssignmentId,
    requestedBy: row.requestedBy,
    toEmployeeId: row.toEmployeeId,
    status: row.status,
    complianceIssues: row.complianceIssues,
    overrideReason: row.overrideReason,
    rejectionReason: row.rejectionReason,
    peerAcceptedAt: row.peerAcceptedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    requestedAt: row.requestedAt.toISOString(),
    // A cancelled/expired request carries a time but no approver (DB check);
    // the contract wants both or neither.
    decidedAt: row.approvedBy ? (row.decidedAt?.toISOString() ?? null) : null,
  });
}

/**
 * The limits in force: the outlet's own row, else the tenant default row, else
 * the built-in defaults. `outletId` null asks for the tenant level only.
 */
export async function resolveCompliancePolicy(
  tx: Tx,
  tenantId: TenantId,
  outletId: string | null,
): Promise<{
  limits: ShiftComplianceLimits;
  source: ShiftCompliancePolicySource;
}> {
  const rows = await tx
    .select()
    .from(shiftCompliancePolicies)
    .where(
      and(
        eq(shiftCompliancePolicies.tenantId, tenantId),
        outletId === null
          ? isNull(shiftCompliancePolicies.outletId)
          : or(
              eq(shiftCompliancePolicies.outletId, outletId),
              isNull(shiftCompliancePolicies.outletId),
            ),
      ),
    );
  const row =
    rows.find((candidate) => candidate.outletId !== null) ??
    rows.find((candidate) => candidate.outletId === null);
  if (!row)
    return { limits: DEFAULT_SHIFT_COMPLIANCE_LIMITS, source: "default" };
  return {
    limits: {
      maxShiftMinutes: row.maxShiftMinutes,
      maxDailyMinutes: row.maxDailyMinutes,
      maxWeeklyMinutes: row.maxWeeklyMinutes,
      minRestMinutesBetweenShifts: row.minRestMinutesBetweenShifts,
      maxConsecutiveWorkDays: row.maxConsecutiveWorkDays,
    },
    source: row.outletId === null ? "tenant" : "outlet",
  };
}

/** `employeeIds` also counts shifts at other outlets (rest between outlets). */
export type WeekAssignmentScope =
  | { readonly outletIds: readonly string[] }
  | { readonly employeeIds: readonly string[] };

/**
 * Live (draft, published, swapped) assignments with a business date in
 * `[from, to]`, by outlet or by employee; cancelled rows are left out. Callers
 * widen the range by a day on each side when rest across the week edge counts.
 */
export async function loadWeekAssignments(
  tx: Tx,
  tenantId: TenantId,
  scope: WeekAssignmentScope,
  from: string,
  to: string,
): Promise<ShiftAssignment[]> {
  const ids = "outletIds" in scope ? scope.outletIds : scope.employeeIds;
  if (ids.length === 0) return [];
  const column =
    "outletIds" in scope
      ? shiftAssignments.outletId
      : shiftAssignments.employeeId;
  const rows = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        inArray(column, [...ids]),
        inArray(shiftAssignments.status, ["draft", "published", "swapped"]),
        gte(shiftAssignments.businessDate, from),
        lte(shiftAssignments.businessDate, to),
      ),
    )
    .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id));
  return rows.map(toShiftAssignment);
}

/** IANA zone of an outlet, or null when the outlet does not exist. */
export async function loadOutletTimeZone(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  return row?.timezone ?? null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instantMs));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return local - Math.floor(instantMs / 1000) * 1000;
}

/** The instant a local wall time (date + minutes after midnight) happens. */
function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const wall = Date.parse(`${date}T00:00:00.000Z`) + minutes * 60_000;
  // Two passes settle the offset even across a DST change.
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Concrete instants of a template on a business date in the outlet zone. A
 * segment whose end is not after its start crosses midnight and ends on the
 * next calendar day (malam shift); the business date stays the start day.
 */
export function segmentsFromTemplate(
  template: Pick<ShiftTemplate, "segments">,
  businessDate: string,
  timeZone: string,
): ShiftAssignmentSegment[] {
  return template.segments.map((segment) => {
    const start = minutesOfDay(segment.startTime);
    const end = minutesOfDay(segment.endTime);
    const endDate =
      end <= start ? addBusinessDays(businessDate, 1) : businessDate;
    return {
      startsAt: toIsoDateTime(zonedInstant(businessDate, start, timeZone)),
      endsAt: toIsoDateTime(zonedInstant(endDate, end, timeZone)),
    };
  });
}

/** Total scheduled minutes of a template (before the break). */
export function templateSpanMinutes(
  template: Pick<ShiftTemplate, "segments">,
): number {
  return template.segments.reduce((sum, segment) => {
    const start = minutesOfDay(segment.startTime);
    const end = minutesOfDay(segment.endTime);
    return sum + (end <= start ? end + 1_440 - start : end - start);
  }, 0);
}
