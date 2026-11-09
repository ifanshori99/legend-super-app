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
//     scheduler never doubles it (no second run, no second alert). The reverse
//     is by design not guarded: a manual run made after the scheduled one is
//     not deduped against it (the supervisor chose to start it).
//   - The shift date is the outlet BUSINESS date (owner Q39: the local date of
//     now minus the outlet's `businessDayCutoff`, `businessDateOf`), and
//     `dueTime` combines with it on the outlet wall clock, like a manual run.
//     Before the cutoff the business date is still yesterday, whose deadline
//     has passed, so no run is made until the new business day starts.
//   - v1 assigns the earliest active role holder (outlet-scoped first)
//     regardless of the template's `shiftTemplateId`; the shift is only copied
//     onto the run, it does not pick the holder.
//   - An outlet with an invalid time zone is skipped (and logged once per
//     tick) instead of aborting the tenant's whole tick.
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
  businessDateOf,
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
import { outletBusinessDayClock } from "./outlet-clock.ts";

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
  const outletScopeFilter =
    context.outletScope.kind === "outlets"
      ? inArray(opsChecklistTemplates.outletId, [
          ...context.outletScope.outletIds,
        ])
      : undefined;
  // Outlet business date in SQL, same rule as `businessDateOf`: the local wall
  // clock of now minus the cutoff, as a date.
  const businessDateSql = sql`((${nowIso}::timestamptz AT TIME ZONE ${outlets.timezone})
    - ${outlets.businessDayCutoff}::interval)::date`;
  // Postgres matches zone names case-insensitively in AT TIME ZONE; so does this.
  const validZoneSql = sql`lower(${outlets.timezone}) IN (SELECT lower(name) FROM pg_timezone_names)`;
  // Outlets skipped for a bad time zone, logged once at the end of the tick.
  const badZoneOutlets = new Set<string>();

  // An invalid zone makes `AT TIME ZONE` raise and aborts the transaction, so
  // find those outlets first (their templates would pass the role filter) and
  // keep them out of every date computation below.
  const badZoneRows = await tx
    .selectDistinct({ outletId: opsChecklistTemplates.outletId })
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
        isNotNull(opsChecklistTemplates.roleId),
        outletScopeFilter,
        sql`NOT (${validZoneSql})`,
      ),
    );
  for (const row of badZoneRows) badZoneOutlets.add(row.outletId);

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
        businessDayCutoff: outlets.businessDayCutoff,
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
          outletScopeFilter,
          sql`${validZoneSql}`,
          // Only templates still due today, with nobody's run yet, and with an
          // active role holder: skipped templates never fill the cap below and
          // starve the rest. Any run (manual or scheduled) for today's
          // outlet-local date counts, so a supervisor's hand-made run is never
          // doubled (and never alerted twice). The loop re-checks each rule.
          // Outlets with an invalid time zone are filtered out above, but
          // SQL does not promise AND order, so the date maths below sits in a
          // CASE that only reaches `AT TIME ZONE` for a valid zone.
          sql`CASE WHEN ${validZoneSql} THEN NOT EXISTS (
          SELECT 1 FROM ${opsChecklistRuns}
          WHERE ${opsChecklistRuns.tenantId} = ${opsChecklistTemplates.tenantId}
            AND ${opsChecklistRuns.templateId} = ${opsChecklistTemplates.id}
            AND ${opsChecklistRuns.shiftDate} = ${businessDateSql}
        ) ELSE false END`,
          sql`CASE WHEN ${validZoneSql}
              AND ${opsChecklistTemplates.schedule}->>'dueTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          THEN ((${businessDateSql}
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
    for (const { template, timezone, businessDayCutoff } of templates) {
      if (wellFormed >= templateLimit) break;
      const created = await createRunForTemplate(template, {
        timezone,
        businessDayCutoff,
      });
      if (created === null) continue;
      wellFormed += 1;
      inserted += created;
    }
    if (templates.length < templateLimit) break;
  }
  if (badZoneOutlets.size > 0)
    console.error("Checklist outlet skipped by the run scheduler: time zone");
  return inserted;

  /** Returns null for a malformed template, else how many rows it inserted. */
  async function createRunForTemplate(
    template: typeof opsChecklistTemplates.$inferSelect,
    outlet: { timezone: string; businessDayCutoff: string },
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

    let shiftDate: string;
    let dueAt: Date;
    try {
      shiftDate = businessDateOf(now, outletBusinessDayClock(outlet));
      dueAt = zonedInstant(
        shiftDate,
        minutesOfDay(template.schedule.dueTime),
        outlet.timezone,
      );
    } catch {
      // A zone Postgres knows but the runtime does not: skip, log once per tick.
      // null, like a malformed template, so it never fills the template cap.
      badZoneOutlets.add(template.outletId);
      return null;
    }
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
