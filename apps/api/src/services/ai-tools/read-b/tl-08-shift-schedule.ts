// TL-08 get_shift_schedule (bead legend-ktqc). Staff read only their own
// schedule (`self.schedule.view`); a manager with `hr.schedule.manage` reads
// the schedule of the outlets they reach. Rows come from the HRIS roster
// service (the same list as the schedule screen); this handler only maps them.
import { and, eq, inArray } from "drizzle-orm";
import {
  getShiftScheduleInputSchema,
  type GetShiftScheduleOutput,
} from "@starter/shared/ai";
import { DEFAULT_TIME_ZONE, userIdSchema } from "@starter/shared/core";
import type { ShiftAssignment } from "@starter/shared/hris";
import { db } from "../../../db/index.ts";
import { employees } from "../../../db/schema/hris.ts";
import { stations } from "../../../db/schema/menu.ts";
import { outlets } from "../../../db/schema/platform-org.ts";
import { withTenant } from "../../../db/tenant.ts";
import { HttpError } from "../../../lib/http-error.ts";
import { listShiftAssignments } from "../../hris-scheduling-roster.service.ts";
import type { AiToolContext, AiToolHandler } from "../types.ts";
import {
  assertKnownOutlets,
  forbidden,
  resolveReach,
  scopeOutlets,
  TOOL_MAX_ROWS,
  tryResolveReach,
  type ToolReach,
} from "./support.ts";

const PAGE_LIMIT = 100;
/** Bounds the service paging; more pages than this are reported as truncated. */
const MAX_PAGES = 10;

type ListQuery = Parameters<typeof listShiftAssignments>[2];

/** Outlet-local "HH:mm" of an instant. */
function timeOfDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/**
 * Published/swapped shifts of the service list, paged up to the row cap. The
 * service computes its own (wider) manage reach, so every page is narrowed to
 * the tool's outlets (`outletIds`, lower-case; null = every outlet) before its
 * rows count towards the cap.
 */
async function collect(
  ctx: AiToolContext,
  reach: ToolReach,
  query: Omit<ListQuery, "limit" | "cursor">,
  outletIds: readonly string[] | null,
): Promise<{ rows: ShiftAssignment[]; truncated: boolean }> {
  const allowed = outletIds === null ? null : new Set(outletIds);
  const rows: ShiftAssignment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listShiftAssignments(
      reach.context,
      ctx.access.userId,
      { ...query, limit: PAGE_LIMIT, cursor },
      ctx.now,
    ).catch((error: unknown) => {
      // The roster service reads access from the database: a refusal is an
      // access denial, not a tool failure. Other errors stay errors.
      if (error instanceof HttpError && error.status === 403) throw forbidden();
      throw error;
    });
    // A draft is not yet a schedule the staff can rely on: leave it out.
    for (const row of result.data)
      if (
        row.status !== "draft" &&
        (allowed === null || allowed.has(row.outletId.toLowerCase()))
      )
        rows.push(row);
    if (result.meta.nextCursor === null)
      return { rows, truncated: rows.length > TOOL_MAX_ROWS };
    if (rows.length > TOOL_MAX_ROWS) return { rows, truncated: true };
    cursor = result.meta.nextCursor;
  }
  return { rows, truncated: true };
}

async function toOutput(
  ctx: AiToolContext,
  reach: ToolReach,
  found: { rows: ShiftAssignment[]; truncated: boolean },
): Promise<GetShiftScheduleOutput> {
  const kept = found.rows.slice(0, TOOL_MAX_ROWS);
  if (kept.length === 0) return { shifts: [], truncated: found.truncated };
  const tenantId = ctx.access.tenant.tenantId;
  const stationIds = [
    ...new Set(
      kept.flatMap((row) => (row.stationId === null ? [] : [row.stationId])),
    ),
  ];
  const [employeeRows, outletRows, stationRows] = await withTenant(
    db,
    reach.context,
    (tx) =>
      Promise.all([
        tx
          .select({ id: employees.id, name: employees.fullName })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, tenantId),
              inArray(employees.id, [
                ...new Set(kept.map((row) => row.employeeId)),
              ]),
            ),
          ),
        tx
          .select({ id: outlets.id, timezone: outlets.timezone })
          .from(outlets)
          .where(
            and(
              eq(outlets.tenantId, tenantId),
              inArray(outlets.id, [
                ...new Set(kept.map((row) => row.outletId)),
              ]),
            ),
          ),
        stationIds.length === 0
          ? Promise.resolve([] as { id: string; name: string }[])
          : tx
              .select({ id: stations.id, name: stations.name })
              .from(stations)
              .where(
                and(
                  eq(stations.tenantId, tenantId),
                  inArray(stations.id, stationIds),
                ),
              ),
      ]),
  );
  const names = new Map(employeeRows.map((row) => [row.id, row.name]));
  const zones = new Map(outletRows.map((row) => [row.id, row.timezone]));
  const stationNames = new Map(stationRows.map((row) => [row.id, row.name]));

  const shifts = kept
    .map((row) => {
      const zone = zones.get(row.outletId) ?? DEFAULT_TIME_ZONE;
      const ordered = [...row.segments].sort(
        (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
      );
      const station =
        row.stationId === null
          ? undefined
          : stationNames.get(row.stationId)?.trim().slice(0, 80);
      return {
        shiftId: row.id,
        employeeId: row.employeeId,
        employeeName: names.get(row.employeeId)?.trim() || "Karyawan",
        outletId: row.outletId,
        date: row.businessDate,
        startTime: timeOfDay(ordered[0]!.startsAt, zone),
        endTime: timeOfDay(ordered[ordered.length - 1]!.endsAt, zone),
        ...(station ? { station } : {}),
      };
    })
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.startTime.localeCompare(right.startTime) ||
        left.employeeId.localeCompare(right.employeeId) ||
        left.shiftId.localeCompare(right.shiftId),
    );
  return { shifts, truncated: found.truncated };
}

export const getShiftSchedule: AiToolHandler = async (ctx, raw) => {
  const input = getShiftScheduleInputSchema.parse(raw);
  const period = { from: input.period.from, to: input.period.to };

  const manage = await tryResolveReach(ctx, "hr.schedule.manage", "TL-08");
  if (manage) {
    // Validates the outlet filter against the reach (outside it: forbidden).
    const scoped = scopeOutlets(manage, input.outletIds);
    // An outlet that is not this tenant's is denied, never dropped.
    await withTenant(db, manage.context, (tx) =>
      assertKnownOutlets(
        tx,
        ctx.access.tenant.tenantId,
        input.outletIds,
        scoped,
      ),
    );
    const only = scoped !== null && scoped.length === 1 ? scoped[0] : undefined;
    const found = await collect(
      ctx,
      manage,
      {
        ...period,
        ...(only !== undefined
          ? { outletId: only as ListQuery["outletId"] }
          : {}),
        ...(input.employeeId !== undefined
          ? { employeeId: input.employeeId }
          : {}),
      },
      scoped,
    );
    return toOutput(ctx, manage, found);
  }

  // Own schedule: the employee id comes from the caller's session, never from
  // the input. A different id is rejected, not rewritten.
  const self = await resolveReach(ctx, "self.schedule.view", "TL-08");
  const [own] = await withTenant(db, self.context, (tx) =>
    tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, ctx.access.tenant.tenantId),
          eq(employees.userId, userIdSchema.parse(ctx.access.userId)),
        ),
      )
      .limit(1),
  );
  if (
    input.employeeId !== undefined &&
    (!own || input.employeeId.toLowerCase() !== own.id.toLowerCase())
  )
    throw forbidden();
  if (!own) return { shifts: [], truncated: false };
  // An outlet outside the caller's reach is denied, never silently dropped.
  const scoped = scopeOutlets(self, input.outletIds);
  // The employee filter keeps the list to the caller's own rows.
  const found = await collect(
    ctx,
    self,
    { ...period, employeeId: own.id as ListQuery["employeeId"] },
    scoped,
  );
  return toOutput(ctx, self, found);
};
