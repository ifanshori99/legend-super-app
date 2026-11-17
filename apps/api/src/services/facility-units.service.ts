// Staff unit status board and maintenance flag (PRD v1.7 §3 F22 "Siklus
// Kebersihan"; FAC-06; bead legend-nm4f). Cleaning tasks themselves are a
// later bead: this module only reads the board and flips the maintenance
// state through the contract's unit state machine.
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  canTransitionUnit,
  SLOT_HOLD_PREDICATE_SQL,
  transitionUnit,
  type FacilityUnit,
  type FacilityUnitBoardRow,
  type UpdateFacilityUnitInput,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { accessTickets, facilityUnits } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  loadFacility,
  notFound,
  OPERATE_PERMISSION,
  toUnit,
} from "./facility-shared.ts";

export async function getFacilityUnitBoard(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { facilityId: string; status?: FacilityUnit["status"] },
  now = new Date(),
): Promise<{ rows: FacilityUnitBoardRow[]; serverTime: string }> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const units = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.facilityId, facility.id),
          // The operator board lists live units only (legend-etawy).
          isNull(facilityUnits.retiredAt),
          ...(query.status ? [eq(facilityUnits.status, query.status)] : []),
        ),
      )
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));
    const current =
      units.length === 0
        ? []
        : await tx
            .select()
            .from(accessTickets)
            .where(
              and(
                eq(accessTickets.tenantId, tenantId),
                inArray(
                  accessTickets.unitId,
                  units.map((unit) => unit.id),
                ),
                eq(accessTickets.status, "in_use"),
                lte(accessTickets.startsAt, now),
                gt(accessTickets.cleaningEndsAt, now),
                sql.raw(SLOT_HOLD_PREDICATE_SQL),
              ),
            );
    return {
      rows: units.map((unit) => {
        const ticket = current.find((row) => row.unitId === unit.id);
        return {
          unit: toUnit(unit),
          currentTicket:
            ticket && ticket.firstOpenedAt
              ? {
                  ticketId: ticket.id,
                  startedAt: ticket.firstOpenedAt.toISOString(),
                  scheduledEndsAt: ticket.endsAt.toISOString(),
                }
              : null,
          // Cleaning tasks arrive with the cleaning bead.
          cleaningTask: null,
        } as FacilityUnitBoardRow;
      }),
      serverTime: now.toISOString(),
    };
  });
}

/**
 * FAC-06: flag a unit for maintenance (blocks new holds) or release it. A
 * released unit returns as `needs_cleaning`, never straight to `available`
 * (contract unit machine), so it is still not bookable until cleaned.
 */
export async function updateFacilityUnit(
  context: ScopedTenantContext,
  actorUserId: string,
  unitId: string,
  input: UpdateFacilityUnitInput,
  now = new Date(),
): Promise<FacilityUnit> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [locked] = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(eq(facilityUnits.tenantId, tenantId), eq(facilityUnits.id, unitId)),
      )
      .limit(1)
      .for("update");
    if (!locked) throw notFound("Bilik");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      locked.outletId,
    );
    if (!canTransitionUnit(locked.status, input.action))
      throw new HttpError(
        409,
        "UNIT_TRANSITION_INVALID",
        `Bilik berstatus ${locked.status} tidak dapat menjalani ${input.action}.`,
      );
    const status = transitionUnit(locked.status, input.action);
    const [row] = await tx
      .update(facilityUnits)
      // `updatedAt` stays: it only stamps configuration (stale-check of
      // PATCH /units/:unitId/config), not the operational status.
      .set({ status })
      .where(
        and(eq(facilityUnits.tenantId, tenantId), eq(facilityUnits.id, unitId)),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: `facility_unit.${input.action}`,
      objectType: "facility_unit",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: locked.id, status: locked.status },
      after: { id: row.id, status: row.status },
    });
    return toUnit(row);
  });
}
