// "Masuk sekarang" wait queue (PRD v1.7 §3 F22 Pemesanan: estimate and notify
// when a unit is ready; bead legend-nm4f). The guest is identified by a
// customer profile id that the caller resolves from the session (see the
// port in routes/facility.routes.ts); no customer id ever comes from a body.
import { and, eq, inArray } from "drizzle-orm";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  FacilityError,
  facilityQueueEntrySchema,
  type FacilityQueueEntry,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { facilityQueueEntries } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  loadArea,
  loadFacility,
  OPERATE_PERMISSION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from "./facility-shared.ts";
import { notifyNextInQueue } from "./facility-slots.service.ts";
import { assertFacilityTicketsEnabled } from "./facility-tickets-gate.ts";

type Row = typeof facilityQueueEntries.$inferSelect;

function toEntry(row: Row): FacilityQueueEntry {
  return facilityQueueEntrySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    areaId: row.areaId,
    customerProfileId: row.customerProfileId,
    joinedAt: row.joinedAt.toISOString(),
    status: row.status,
    notifiedAt: row.notifiedAt?.toISOString() ?? null,
  });
}

export async function joinFacilityQueue(
  context: ScopedTenantContext,
  actorUserId: string,
  customerProfileId: string,
  input: { facilityId: string; areaId: string },
  now = new Date(),
): Promise<FacilityQueueEntry> {
  assertFacilityTicketsEnabled();
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const area = await loadArea(tx, context, input.areaId);
    if (area.facilityId !== facility.id)
      throw new HttpError(404, "NOT_FOUND", "Area tidak ditemukan.");
    try {
      const [row] = await tx
        .insert(facilityQueueEntries)
        .values({
          tenantId,
          outletId: facility.outletId,
          facilityId: facility.id,
          areaId: area.id,
          customerProfileId,
          status: "waiting",
          joinedAt: now,
          updatedAt: now,
        })
        .returning();
      await auditFacility(tx, context, actor, now, {
        action: "facility_queue.joined",
        objectType: "facility_queue_entry",
        objectId: row.id,
        outletId: row.outletId,
        before: null,
        after: {
          id: row.id,
          facilityId: row.facilityId,
          areaId: row.areaId,
          status: row.status,
        },
      });
      return toEntry(row);
    } catch (error) {
      // The partial unique index is the race-safe ALREADY_QUEUED guard.
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new FacilityError("ALREADY_QUEUED");
      throw error;
    }
  });
}

/** The caller's own place; null when not queued. */
export async function getCurrentFacilityQueueEntry(
  context: ScopedTenantContext,
  actorUserId: string,
  customerProfileId: string,
  query: { facilityId: string },
): Promise<FacilityQueueEntry | null> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const [row] = await tx
      .select()
      .from(facilityQueueEntries)
      .where(
        and(
          eq(facilityQueueEntries.tenantId, context.tenant.tenantId),
          eq(facilityQueueEntries.facilityId, facility.id),
          eq(facilityQueueEntries.customerProfileId, customerProfileId),
          inArray(facilityQueueEntries.status, ["waiting", "notified"]),
        ),
      )
      .limit(1);
    return row ? toEntry(row) : null;
  });
}

/** Leaving ends the caller's own place (status `expired`); idempotent. */
export async function leaveFacilityQueue(
  context: ScopedTenantContext,
  actorUserId: string,
  customerProfileId: string,
  entryId: string,
  now = new Date(),
): Promise<void> {
  const actor = userIdSchema.parse(actorUserId);
  await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [entry] = await tx
      .select()
      .from(facilityQueueEntries)
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.id, entryId),
          // Someone else's entry looks like a missing one.
          eq(facilityQueueEntries.customerProfileId, customerProfileId),
        ),
      )
      .limit(1)
      .for("update");
    if (!entry)
      throw new HttpError(404, "NOT_FOUND", "Antrean tidak ditemukan.");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      entry.outletId,
    );
    if (entry.status !== "waiting" && entry.status !== "notified") return;
    await tx
      .update(facilityQueueEntries)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.id, entryId),
        ),
      );
    await auditFacility(tx, context, actor, now, {
      action: "facility_queue.left",
      objectType: "facility_queue_entry",
      objectId: entry.id,
      outletId: entry.outletId,
      before: { id: entry.id, status: entry.status },
      after: { id: entry.id, status: "expired" },
    });
    // A notified guest who gives up passes the unit to the next in line.
    if (entry.status === "notified")
      await notifyNextInQueue(
        tx,
        tenantId,
        entry.facilityId,
        entry.areaId,
        now,
      );
  });
}
