// TL-08 get_shift_schedule (bead legend-ktqc). Staff read only their own
// schedule (`self.schedule.view`); a manager with `hr.schedule.manage` reads
// the schedule of the outlets they reach.
//
// GAP: no shift-assignment table exists yet (the HRIS roster is not built), so
// the handler returns the contract's empty shape after the access checks.
import { and, eq } from "drizzle-orm";
import {
  getShiftScheduleInputSchema,
  type GetShiftScheduleOutput,
} from "@starter/shared/ai";
import { userIdSchema } from "@starter/shared/core";
import { db } from "../../../db/index.ts";
import { employees } from "../../../db/schema/hris.ts";
import { withTenant } from "../../../db/tenant.ts";
import type { AiToolHandler } from "../types.ts";
import {
  forbidden,
  resolveReach,
  scopeOutlets,
  tryResolveReach,
} from "./support.ts";

const EMPTY: GetShiftScheduleOutput = { shifts: [], truncated: false };

export const getShiftSchedule: AiToolHandler = async (ctx, raw) => {
  const input = getShiftScheduleInputSchema.parse(raw);

  const manage = await tryResolveReach(ctx, "hr.schedule.manage", "TL-08");
  if (manage) {
    // Validates the outlet filter against the reach (outside it: forbidden).
    scopeOutlets(manage, input.outletIds);
    return EMPTY;
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
  return EMPTY;
};
