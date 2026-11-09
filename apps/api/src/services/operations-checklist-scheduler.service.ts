// F45 / OPS-01 checklist scheduler (bead legend-5v69; PRD v1.7 §3 F45
// "Operasional Harian"). A checklist template that names a role is turned into
// that day's run automatically: one run per template and outlet-local shift
// date, assigned to the employee who holds the role, with the deadline read
// from the template's `dueTime` on the outlet wall clock.
//
// `generateScheduledChecklistRuns` runs inside the caller's tenant transaction
// on every worker relay tick, right before the missed-run sweep
// (`sweepMissedChecklistRuns`, operations-escalation.service.ts). Rules:
//   - Templates without `roleId` are manual-only and never auto-generated.
//   - A run is never created already past its deadline: it would be born
//     missed and raise a spurious supervisor alert, so the template waits for
//     the next day.
//   - No active holder of the role means no run (nobody to be accountable).
//   - A run already made by hand for the template and date counts: the
//     scheduler never doubles it (no second run, no second alert).
//   - The partial unique index `ops_checklist_runs_scheduled_key`
//     (tenant, template, shift date WHERE scheduled) plus `ON CONFLICT DO
//     NOTHING` makes a rerun or an overlapping tick insert nothing twice.
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  assertTrustedScopedContext,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  checklistTemplateSchema,
  snapshotChecklistTemplate,
} from "@starter/shared/operations";
import {
  opsChecklistRuns,
  opsChecklistTemplates,
} from "../db/schema/operations.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { zonedInstant } from "./facility-rules.ts";
import { minutesOfDay } from "./menu-availability.ts";
import type { OperationsTx } from "./operations-idempotency.ts";
import { localDate } from "./reservation-plan.ts";

/**
 * One relay tick processes at most this many well-formed templates; the next
 * tick continues. Malformed templates never count toward it (B11-2).
 */
const SCHEDULER_TEMPLATE_LIMIT = 500;

export type ScheduledChecklistRunOptions = {
  /** Well-formed templates per tick; overridable for tests. */
  templateLimit?: number;
};

/**
 * Creates today's scheduled runs for the context's tenant (and outlet scope)
 * and returns how many rows THIS call inserted. A second call for the same
 * instant returns 0.
 */
export async function generateScheduledChecklistRuns(
  tx: OperationsTx,
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: ScheduledChecklistRunOptions = {},
): Promise<number> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const nowIso = now.toISOString();
  const templateLimit = options.templateLimit ?? SCHEDULER_TEMPLATE_LIMIT;

  // Templates are read in id order, one keyset page at a time. A template that
  // passes the SQL filter but fails the contract schema is logged once and
  // skipped; it is behind the cursor afterwards, so it cannot be re-read this
  // tick or fill the cap ahead of healthy templates (B11-2). Paging stops once
  // `templateLimit` well-formed templates were handled or no rows are left.
  const selectPage = (afterId: string | null) =>
    tx
      .select({
        template: opsChecklistTemplates,
        timezone: outlets.timezone,
      })
      .from(opsChecklistTemplates)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, opsChecklistTemplates.tenantId),
          eq(outlets.id, opsChecklistTemplates.outletId),
        ),
      )
      .where(
        and(
          eq(opsChecklistTemplates.tenantId, tenantId),
          afterId === null ? undefined : gt(opsChecklistTemplates.id, afterId),
          isNotNull(opsChecklistTemplates.roleId),
          // RLS already narrows the rows; the explicit filter keeps an
          // outlet-scoped caller from depending on the policy alone (TEN-03).
          context.outletScope.kind === "outlets"
            ? inArray(opsChecklistTemplates.outletId, [
                ...context.outletScope.outletIds,
              ])
            : undefined,
          // Only templates still due today, with nobody's run yet, and with an
          // active role holder: skipped templates never fill the cap below and
          // starve the rest. Any run (manual or scheduled) for today's
          // outlet-local date counts, so a supervisor's hand-made run is never
          // doubled (and never alerted twice). The loop re-checks each rule.
          sql`NOT EXISTS (
          SELECT 1 FROM ${opsChecklistRuns}
          WHERE ${opsChecklistRuns.tenantId} = ${opsChecklistTemplates.tenantId}
            AND ${opsChecklistRuns.templateId} = ${opsChecklistTemplates.id}
            AND ${opsChecklistRuns.shiftDate} =
              (${nowIso}::timestamptz AT TIME ZONE ${outlets.timezone})::date
        )`,
          sql`CASE WHEN ${opsChecklistTemplates.schedule}->>'dueTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          THEN (((${nowIso}::timestamptz AT TIME ZONE ${outlets.timezone})::date
                + (${opsChecklistTemplates.schedule}->>'dueTime')::time)
                AT TIME ZONE ${outlets.timezone}) > ${nowIso}::timestamptz
          ELSE false END`,
          sql`EXISTS (
          SELECT 1 FROM ${roleAssignments}
          WHERE ${roleAssignments.tenantId} = ${opsChecklistTemplates.tenantId}
            AND ${roleAssignments.roleId} = ${opsChecklistTemplates.roleId}
            AND ${roleAssignments.validFrom} <= ${nowIso}::timestamptz
            AND (${roleAssignments.validUntil} IS NULL
              OR ${roleAssignments.validUntil} > ${nowIso}::timestamptz)
            AND (${roleAssignments.scopeType} = 'tenant'
              OR (${roleAssignments.scopeType} = 'outlet'
                AND ${roleAssignments.scopeId} = ${opsChecklistTemplates.outletId}))
        )`,
        ),
      )
      .orderBy(asc(opsChecklistTemplates.id))
      .limit(templateLimit);

  let inserted = 0;
  let wellFormed = 0;
  let afterId: string | null = null;
  while (wellFormed < templateLimit) {
    const templates = await selectPage(afterId);
    if (templates.length === 0) break;
    afterId = templates[templates.length - 1].template.id;
    for (const { template, timezone } of templates) {
      if (wellFormed >= templateLimit) break;
      const created = await createRunForTemplate(template, timezone);
      if (created === null) continue;
      wellFormed += 1;
      inserted += created;
    }
    if (templates.length < templateLimit) break;
  }
  return inserted;

  /** Returns null for a malformed template, else how many rows it inserted. */
  async function createRunForTemplate(
    template: typeof opsChecklistTemplates.$inferSelect,
    timezone: string,
  ): Promise<number | null> {
    const roleId = template.roleId;
    if (roleId === null) return null;
    // One malformed template must not abort the tenant's whole tick (the
    // transaction would roll back and every later template would starve):
    // validate without throwing, log once, and skip the bad row.
    const parsed = checklistTemplateSchema.safeParse({
      id: template.id,
      tenantId: template.tenantId,
      outletId: template.outletId,
      name: template.name,
      type: template.type,
      items: template.items,
      schedule: template.schedule,
      roleId: template.roleId,
      version: template.version,
      updatedAt: template.updatedAt.toISOString(),
    });
    if (!parsed.success) {
      console.error("Checklist template skipped by the run scheduler");
      return null;
    }

    const shiftDate = localDate(now, timezone);
    const dueAt = zonedInstant(
      shiftDate,
      minutesOfDay(template.schedule.dueTime),
      timezone,
    );
    // Never create a run that is born missed (no spurious alert).
    if (dueAt.getTime() <= now.getTime()) return 0;

    // Deterministic assignee: an outlet-scoped holder first, then the longest
    // standing assignment, then the lowest user id.
    const [assignee] = await tx
      .select({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.tenantId, tenantId),
          eq(roleAssignments.roleId, roleId),
          lte(roleAssignments.validFrom, now),
          or(
            isNull(roleAssignments.validUntil),
            gt(roleAssignments.validUntil, now),
          ),
          or(
            eq(roleAssignments.scopeType, "tenant"),
            and(
              eq(roleAssignments.scopeType, "outlet"),
              eq(roleAssignments.scopeId, template.outletId),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case when ${roleAssignments.scopeType} = 'outlet' then 0 else 1 end`,
        asc(roleAssignments.validFrom),
        asc(roleAssignments.userId),
      )
      .limit(1);
    if (!assignee) return 0;
    const assignedTo = userIdSchema.safeParse(assignee.userId);
    if (!assignedTo.success) {
      console.error("Checklist template skipped by the run scheduler");
      return null;
    }
    const snapshot = snapshotChecklistTemplate(parsed.data);
    const rows = await tx
      .insert(opsChecklistRuns)
      .values({
        tenantId,
        outletId: template.outletId,
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        items: snapshot.items,
        shiftDate,
        shiftTemplateId: template.schedule.shiftTemplateId ?? null,
        assignedTo: assignedTo.data,
        dueAt,
        completedAt: null,
        status: "pending",
        results: [],
        missedAt: null,
        alertedAt: null,
        scheduled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          opsChecklistRuns.tenantId,
          opsChecklistRuns.templateId,
          opsChecklistRuns.shiftDate,
        ],
        where: sql`${opsChecklistRuns.scheduled}`,
      })
      .returning({ id: opsChecklistRuns.id });
    return rows.length;
  }
}
