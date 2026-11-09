// Shift templates and working-time policy (PRD v1.7 §3 Kelompok D 28
// "Penjadwalan Shift", F26 "aturan yang dapat dikonfigurasi", HR-05; §6 H
// `shift_templates`; bead legend-jstx). Routes: routes/hris-scheduling.routes.ts.
//
// - Everything here is `hr.schedule.manage` with outlet reach. An outlet
//   outside the caller's reach answers 404 (same as a missing outlet). The
//   tenant-wide policy row needs tenant-wide reach (403 otherwise).
// - Default rule (changeable): a template belongs to one outlet; its station
//   must be a station of that outlet, its position a tenant position.
// - Editing a template never touches existing assignments: they snapshot
//   segments and break minutes.
// - The policy resolves outlet row, then tenant row, then the built-in
//   default (hris-scheduling-common.ts). The PUT is naturally idempotent
//   (same body, same row), so it takes no idempotency key.
// - Audit values are limits and flags only, never personal data.

import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { encodeCursor, type ScopedTenantContext } from "@starter/shared/core";
import type { z } from "@starter/shared/core";
import {
  createShiftTemplate as createShiftTemplateEndpoint,
  getShiftCompliancePolicy as getShiftCompliancePolicyEndpoint,
  listShiftTemplates as listShiftTemplatesEndpoint,
  shiftCompliancePolicySchema,
  shiftTemplateSchema,
  updateShiftCompliancePolicy as updateShiftCompliancePolicyEndpoint,
  updateShiftTemplate as updateShiftTemplateEndpoint,
  type ShiftCompliancePolicy,
  type ShiftTemplate,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { positions } from "../db/schema/hris.ts";
import { stations } from "../db/schema/menu.ts";
import {
  shiftCompliancePolicies,
  shiftTemplates,
} from "../db/schema/hris-scheduling.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import { tenantOrOutletAudit } from "./hris-holiday.service.ts";
import {
  HRIS_SCHEDULING_AUDIT_SAFE_FIELDS,
  loadOutletTimeZone,
  resolveCompliancePolicy,
  templateSpanMinutes,
  toShiftTemplate,
  type ShiftCompliancePolicySource,
} from "./hris-scheduling-common.ts";

export const HRIS_SCHEDULE_MANAGE_CODE = "hr.schedule.manage" as const;

type ShiftTemplateRow = typeof shiftTemplates.$inferSelect;
type ListTemplatesQuery = z.output<typeof listShiftTemplatesEndpoint.query>;
type CreateTemplateBody = z.output<typeof createShiftTemplateEndpoint.body>;
type UpdateTemplateBody = z.output<typeof updateShiftTemplateEndpoint.body>;
type PolicyQuery = z.output<typeof getShiftCompliancePolicyEndpoint.query>;
type PolicyBody = z.output<typeof updateShiftCompliancePolicyEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
export type ShiftCompliancePolicyView = ShiftCompliancePolicy & {
  source: ShiftCompliancePolicySource;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

const duplicateTemplate = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Template shift dengan nama ini sudah ada di outlet tersebut.",
  );

/** Outlet the caller may manage schedules at; anything else is a 404. */
function assertOutletManageable(access: HrisAccess, outletId: string): void {
  if (
    !access.snapshot.allows(HRIS_SCHEDULE_MANAGE_CODE, {
      type: "outlet",
      id: outletId,
    })
  )
    throw notFound("Outlet");
}

async function assertOutletExists(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<void> {
  const timeZone = await loadOutletTimeZone(
    tx,
    context.tenant.tenantId,
    outletId,
  );
  if (timeZone === null) throw notFound("Outlet");
}

/** A template reference to a station of the same outlet or a tenant position. */
async function assertTemplateReferences(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  stationId: string | null,
  positionId: string | null,
): Promise<void> {
  if (stationId !== null) {
    const [station] = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.id, stationId),
          eq(stations.outletId, outletId),
          isNull(stations.deletedAt),
        ),
      )
      .limit(1);
    if (!station) throw invalid("Stasiun tidak ditemukan di outlet ini.");
  }
  if (positionId !== null) {
    const [position] = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(
        and(
          eq(positions.tenantId, context.tenant.tenantId),
          eq(positions.id, positionId),
          eq(positions.isActive, true),
        ),
      )
      .limit(1);
    if (!position) throw invalid("Posisi tidak ditemukan.");
  }
}

/** Contract rules plus: the break must leave working time. */
function assertTemplateValid(candidate: ShiftTemplate): void {
  const parsed = shiftTemplateSchema.safeParse(candidate);
  if (!parsed.success)
    throw invalid(
      parsed.error.issues[0]?.message ?? "Template shift tidak valid.",
    );
  if (templateSpanMinutes(candidate) - candidate.breakMinutes <= 0)
    throw invalid("Waktu istirahat harus menyisakan waktu kerja.");
}

function auditTemplate(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: ShiftTemplateRow,
  action: string,
  changedFields?: string[],
) {
  return recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action,
      objectType: "shift_template",
      objectId: row.id,
      after: {
        isActive: row.isActive,
        ...(changedFields ? { changedFields } : {}),
      },
    }),
    HRIS_SCHEDULING_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------------- reads

/** GET /api/hris/shift-templates — templates of the outlets the caller manages. */
export async function listShiftTemplates(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListTemplatesQuery,
  now: Date = new Date(),
): Promise<Page<ShiftTemplate>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([HRIS_SCHEDULE_MANAGE_CODE]);
    if (reach === null) throw forbidden();
    const filters: SQL[] = [
      eq(shiftTemplates.tenantId, context.tenant.tenantId),
    ];
    if (query.outletId !== undefined) {
      assertOutletManageable(access, query.outletId);
      filters.push(eq(shiftTemplates.outletId, query.outletId));
    } else if (reach.kind === "outlets")
      filters.push(inArray(shiftTemplates.outletId, [...reach.outletIds]));
    if (!query.includeInactive) filters.push(eq(shiftTemplates.isActive, true));
    if (query.cursor) {
      const [name, id] = cursorPair(query.cursor);
      if (!UUID_PATTERN.test(id)) throw invalid("Check the cursor.");
      filters.push(
        or(
          gt(shiftTemplates.name, name),
          and(eq(shiftTemplates.name, name), gt(shiftTemplates.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(shiftTemplates)
      .where(and(...filters))
      .orderBy(asc(shiftTemplates.name), asc(shiftTemplates.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toShiftTemplate),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------------ writes

/** POST /api/hris/shift-templates — one template of one outlet; duplicate name → 409. */
export async function createShiftTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateTemplateBody,
  now: Date = new Date(),
): Promise<ShiftTemplate> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    assertOutletManageable(access, input.outletId);
    await assertOutletExists(tx, context, input.outletId);
    const id = crypto.randomUUID();
    assertTemplateValid({
      id,
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      name: input.name,
      segments: input.segments,
      breakMinutes: input.breakMinutes,
      stationId: input.stationId,
      positionId: input.positionId,
      isActive: true,
    } as ShiftTemplate);
    await assertTemplateReferences(
      tx,
      context,
      input.outletId,
      input.stationId,
      input.positionId,
    );
    let row: ShiftTemplateRow | undefined;
    try {
      // A savepoint keeps the transaction usable after a constraint error.
      row = await tx.transaction(async (inner) => {
        const [created] = await inner
          .insert(shiftTemplates)
          .values({
            id,
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            name: input.name,
            segments: input.segments,
            breakMinutes: input.breakMinutes,
            stationId: input.stationId,
            positionId: input.positionId,
            isActive: true,
            createdBy: access.actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return created;
      });
    } catch (error) {
      if (uniqueViolation(error)) throw duplicateTemplate();
      throw error;
    }
    if (!row) throw new Error("Shift template insert returned no row");
    await auditTemplate(
      tx,
      context,
      access.actorUserId,
      now,
      row,
      "hris.shift_template.created",
    );
    return toShiftTemplate(row);
  });
}

/** PATCH /api/hris/shift-templates/:templateId — partial; unchanged body is a no-op. */
export async function updateShiftTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  templateId: string,
  input: UpdateTemplateBody,
  now: Date = new Date(),
): Promise<ShiftTemplate> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [current] = await tx
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.tenantId, context.tenant.tenantId),
          eq(shiftTemplates.id, templateId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) throw notFound("Template shift");
    assertOutletManageable(access, current.outletId);

    const patch: Partial<ShiftTemplateRow> = {};
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== current.name) {
      patch.name = input.name;
      changed.push("name");
    }
    if (
      input.segments !== undefined &&
      JSON.stringify(input.segments) !== JSON.stringify(current.segments)
    ) {
      patch.segments = input.segments;
      changed.push("segments");
    }
    if (
      input.breakMinutes !== undefined &&
      input.breakMinutes !== current.breakMinutes
    ) {
      patch.breakMinutes = input.breakMinutes;
      changed.push("breakMinutes");
    }
    if (
      input.stationId !== undefined &&
      input.stationId !== current.stationId
    ) {
      patch.stationId = input.stationId;
      changed.push("stationId");
    }
    if (
      input.positionId !== undefined &&
      input.positionId !== current.positionId
    ) {
      patch.positionId = input.positionId;
      changed.push("positionId");
    }
    if (input.isActive !== undefined && input.isActive !== current.isActive) {
      patch.isActive = input.isActive;
      changed.push("isActive");
    }
    if (changed.length === 0) return toShiftTemplate(current);

    const next = { ...current, ...patch };
    assertTemplateValid({
      id: next.id,
      tenantId: next.tenantId,
      outletId: next.outletId,
      name: next.name,
      segments: next.segments,
      breakMinutes: next.breakMinutes,
      stationId: next.stationId,
      positionId: next.positionId,
      isActive: next.isActive,
    } as ShiftTemplate);
    await assertTemplateReferences(
      tx,
      context,
      next.outletId,
      patch.stationId !== undefined ? next.stationId : null,
      patch.positionId !== undefined ? next.positionId : null,
    );
    let row: ShiftTemplateRow | undefined;
    try {
      row = await tx.transaction(async (inner) => {
        const [updated] = await inner
          .update(shiftTemplates)
          .set({ ...patch, updatedAt: now })
          .where(
            and(
              eq(shiftTemplates.tenantId, context.tenant.tenantId),
              eq(shiftTemplates.id, current.id),
            ),
          )
          .returning();
        return updated;
      });
    } catch (error) {
      if (uniqueViolation(error)) throw duplicateTemplate();
      throw error;
    }
    if (!row) throw new Error("Shift template update returned no row");
    await auditTemplate(
      tx,
      context,
      access.actorUserId,
      now,
      row,
      "hris.shift_template.updated",
      changed,
    );
    return toShiftTemplate(row);
  });
}

// ------------------------------------------------------- compliance policy

function policyView(
  context: ScopedTenantContext,
  outletId: string | null,
  resolved: Awaited<ReturnType<typeof resolveCompliancePolicy>>,
): ShiftCompliancePolicyView {
  const policy = shiftCompliancePolicySchema.parse({
    tenantId: context.tenant.tenantId,
    outletId: resolved.source === "outlet" ? outletId : null,
    ...resolved.limits,
  });
  return { ...policy, source: resolved.source };
}

/** GET /api/hris/shift-compliance-policy — the effective limits for an outlet (or the tenant). */
export async function getShiftCompliancePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PolicyQuery,
  now: Date = new Date(),
): Promise<ShiftCompliancePolicyView> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const outletId = query.outletId ?? null;
    if (outletId !== null) {
      assertOutletManageable(access, outletId);
      await assertOutletExists(tx, context, outletId);
    } else if (access.reach([HRIS_SCHEDULE_MANAGE_CODE]) === null)
      throw forbidden();
    const resolved = await resolveCompliancePolicy(
      tx,
      context.tenant.tenantId,
      outletId,
    );
    return policyView(context, outletId, resolved);
  });
}

/**
 * PUT /api/hris/shift-compliance-policy — upserts the outlet row, or the
 * tenant default row (`outletId` null, tenant-wide reach). Serialised per
 * (tenant, outlet) so two first writes cannot both insert.
 */
export async function updateShiftCompliancePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  input: PolicyBody,
  now: Date = new Date(),
): Promise<ShiftCompliancePolicyView> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (input.outletId === null) {
      if (access.reach([HRIS_SCHEDULE_MANAGE_CODE])?.kind !== "tenant")
        throw forbidden();
    } else {
      assertOutletManageable(access, input.outletId);
      await assertOutletExists(tx, context, input.outletId);
    }
    const limits = {
      maxShiftMinutes: input.maxShiftMinutes,
      maxDailyMinutes: input.maxDailyMinutes,
      maxWeeklyMinutes: input.maxWeeklyMinutes,
      minRestMinutesBetweenShifts: input.minRestMinutesBetweenShifts,
      maxConsecutiveWorkDays: input.maxConsecutiveWorkDays,
    };
    const parsed = shiftCompliancePolicySchema.safeParse({
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      ...limits,
    });
    if (!parsed.success)
      throw invalid(
        parsed.error.issues[0]?.message ?? "Batas jam kerja tidak valid.",
      );

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:shift-policy:${context.tenant.tenantId}:${input.outletId ?? "tenant"}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: shiftCompliancePolicies.id })
      .from(shiftCompliancePolicies)
      .where(
        and(
          eq(shiftCompliancePolicies.tenantId, context.tenant.tenantId),
          input.outletId === null
            ? isNull(shiftCompliancePolicies.outletId)
            : eq(shiftCompliancePolicies.outletId, input.outletId),
        ),
      )
      .limit(1);
    let policyId: string;
    if (existing) {
      await tx
        .update(shiftCompliancePolicies)
        .set({ ...limits, updatedBy: access.actorUserId, updatedAt: now })
        .where(
          and(
            eq(shiftCompliancePolicies.tenantId, context.tenant.tenantId),
            eq(shiftCompliancePolicies.id, existing.id),
          ),
        );
      policyId = existing.id;
    } else {
      const [created] = await tx
        .insert(shiftCompliancePolicies)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          ...limits,
          updatedBy: access.actorUserId,
          updatedAt: now,
        })
        .returning({ id: shiftCompliancePolicies.id });
      if (!created) throw new Error("Shift policy insert returned no row");
      policyId = created.id;
    }
    await recordAudit(
      tx,
      context,
      tenantOrOutletAudit(context, access.actorUserId, now, {
        outletId: input.outletId,
        action: "hris.shift_policy.updated",
        objectType: "shift_compliance_policy",
        objectId: policyId,
        after: limits,
      }),
      HRIS_SCHEDULING_AUDIT_SAFE_FIELDS,
    );
    return policyView(context, input.outletId, {
      limits,
      source: input.outletId === null ? "tenant" : "outlet",
    });
  });
}
