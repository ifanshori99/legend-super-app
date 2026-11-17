// TL-16 executor: create DRAFT shift assignments through
// `createShiftAssignment` (`hr.schedule.manage` at the outlet, re-checked by
// the service for the requester). The executor never publishes the roster: the
// manager still publishes it from the schedule screen.
//
// A draft shift names a start and end time; the roster works with shift
// templates, so each shift takes the outlet's active template with exactly one
// segment at those times (first by name when several match). A time with no
// template, or a station name unknown at the outlet, fails the whole request.
//
// Two phases. Phase 1 reads and validates every shift and writes nothing.
// Phase 2 writes; the roster service commits each assignment on its own, so
// on an error the drafts created in this run are cancelled before the error
// reaches the caller. Only drafts this run inserted are cancelled: a shift
// replayed from an earlier attempt, or one a manager has since published, stays.
//
// Idempotency: each assignment uses the key `ai-action:<actionRequestId>:<n>`
// (its index in the draft), so a re-run after a crash replays the stored
// assignments instead of creating a second set.
import { and, asc, eq } from "drizzle-orm";
import { draftShiftScheduleInputSchema } from "@starter/shared/ai";
import { createShiftAssignment as createShiftAssignmentEndpoint } from "@starter/shared/hris";
import { db } from "../../db/index.ts";
import {
  shiftAssignments,
  shiftTemplates,
  stations,
} from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import {
  cancelShiftAssignment,
  createShiftAssignment,
} from "../hris-scheduling-roster.service.ts";
import { holdsToolAccess } from "./access.ts";
import { ActionExecutionError, type ActionExecutor } from "./types.ts";

export const executeShiftSchedule: ActionExecutor = async ({
  access,
  row,
  now,
}) => {
  const payload = draftShiftScheduleInputSchema.parse(row.payload);
  const denied =
    "Pengaju tidak lagi boleh mengatur jadwal shift di outlet ini.";
  if (!holdsToolAccess(access, "TL-16", row.payload))
    throw new ActionExecutionError(denied);
  const context = access.contextFor("hr.schedule.manage", {
    type: "outlet",
    id: payload.outletId,
  });
  if (!context) throw new ActionExecutionError(denied);

  // Phase 1: resolve every shift to a template and station, write nothing.
  const { templates, outletStations } = await withTenant(
    db,
    context,
    async (tx) => ({
      templates: await tx
        .select({
          id: shiftTemplates.id,
          segments: shiftTemplates.segments,
          stationId: shiftTemplates.stationId,
        })
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.tenantId, row.tenantId),
            eq(shiftTemplates.outletId, payload.outletId),
            eq(shiftTemplates.isActive, true),
          ),
        )
        .orderBy(asc(shiftTemplates.name), asc(shiftTemplates.id)),
      outletStations: await tx
        .select({ id: stations.id, name: stations.name })
        .from(stations)
        .where(
          and(
            eq(stations.tenantId, row.tenantId),
            eq(stations.outletId, payload.outletId),
            eq(stations.isActive, true),
          ),
        ),
    }),
  );
  const steps = payload.shifts.map((shift, index) => {
    const template = templates.find(
      (candidate) =>
        candidate.segments.length === 1 &&
        candidate.segments[0]!.startTime === shift.startTime &&
        candidate.segments[0]!.endTime === shift.endTime,
    );
    if (!template)
      throw new ActionExecutionError(
        `Tidak ada template shift aktif ${shift.startTime}-${shift.endTime} di outlet ini.`,
      );
    let stationId: string | null = template.stationId;
    if (shift.station !== undefined) {
      const wanted = shift.station.trim().toLowerCase();
      const station = outletStations.find(
        (candidate) => candidate.name.trim().toLowerCase() === wanted,
      );
      if (!station)
        throw new ActionExecutionError(
          "Stasiun pada jadwal tidak dikenal di outlet ini.",
        );
      stationId = station.id;
    }
    return createShiftAssignmentEndpoint.body.parse({
      outletId: payload.outletId,
      employeeId: shift.employeeId,
      businessDate: shift.date,
      shiftTemplateId: template.id,
      stationId,
      idempotencyKey: `ai-action:${row.id}:${index}`,
    });
  });

  // Phase 2: write; undo the drafts this run inserted if one fails.
  const handled: string[] = [];
  const insertedHere: string[] = [];
  try {
    for (const step of steps) {
      let inserted = false;
      const assignment = await createShiftAssignment(
        context,
        row.requestedByUserId,
        step,
        now,
        (outcome) => {
          inserted = outcome.created;
        },
      );
      handled.push(assignment.id);
      if (inserted) insertedHere.push(assignment.id);
    }
  } catch (error) {
    for (const id of insertedHere) {
      // A manager may have published the draft meanwhile: leave it alone.
      const [current] = await withTenant(db, context, (tx) =>
        tx
          .select({ status: shiftAssignments.status })
          .from(shiftAssignments)
          .where(
            and(
              eq(shiftAssignments.tenantId, row.tenantId),
              eq(shiftAssignments.id, id),
            ),
          )
          .limit(1),
      ).catch(() => []);
      if (current?.status !== "draft") continue;
      await cancelShiftAssignment(
        context,
        row.requestedByUserId,
        id,
        now,
      ).catch(() => undefined);
    }
    throw error;
  }
  return { resultRef: `shift_assignment:${handled[0]}` };
};
