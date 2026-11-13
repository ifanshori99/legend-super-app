// Cloud manager side of the emergency button (bead legend-bod.5; design
// docs/design/edge-emergency.md D-07). Incident list, acknowledge and resolve
// on the cloud copy of `panic_alerts` (mirrored from the edge by
// edge/panic-alert-applier.ts, or raised directly by a cloud-only outlet).
//
// The first acknowledgement wins under a row lock; a later one by someone else
// gets 409 naming who acknowledged. Resolve is cloud only: it closes the
// incident with a note and acknowledges too when nobody did. Test presses
// (`kind = 'test'`) stay out of the list: it is the incident report.
import { and, desc, eq, sql } from "drizzle-orm";
import {
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { panicAlerts } from "../db/schema/panic-alert.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";

export type PanicAlertDto = {
  id: string;
  outletId: string;
  unitId: string | null;
  unitCode: string;
  facilityName: string;
  deviceLabel: string;
  kind: "press" | "test";
  receivedAt: string;
  pressCount: number;
  linkOffline: boolean;
  firstDeliveredAt: string | null;
  deliveredCount: number;
  fallbackShownAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

const iso = (value: Date | null) => (value ? toIsoDateTime(value) : null);

function toDto(row: typeof panicAlerts.$inferSelect): PanicAlertDto {
  return {
    id: row.id,
    outletId: row.outletId,
    unitId: row.unitId,
    unitCode: row.unitCodeSnapshot,
    facilityName: row.facilityNameSnapshot,
    deviceLabel: row.deviceLabelSnapshot,
    kind: row.kind === "test" ? "test" : "press",
    receivedAt: toIsoDateTime(row.receivedAt),
    pressCount: row.pressCount,
    linkOffline: row.linkOffline,
    firstDeliveredAt: iso(row.firstDeliveredAt),
    deliveredCount: row.deliveredCount,
    fallbackShownAt: iso(row.fallbackShownAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: iso(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
  };
}

/** Newest first; test presses are left out. */
export async function listEmergencyAlerts(
  context: ScopedTenantContext,
  outletId: string,
  limit: number,
): Promise<PanicAlertDto[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, context.tenant.tenantId),
          eq(panicAlerts.outletId, outletId as OutletId),
          sql`${panicAlerts.kind} <> 'test'`,
        ),
      )
      .orderBy(desc(panicAlerts.receivedAt))
      .limit(limit);
    return rows.map(toDto);
  });
}

/** Locks the alert row of this outlet, or 404. */
async function lockAlert(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  context: ScopedTenantContext,
  outletId: string,
  alertId: string,
) {
  const [row] = await tx
    .select()
    .from(panicAlerts)
    .where(
      and(
        eq(panicAlerts.tenantId, context.tenant.tenantId),
        eq(panicAlerts.outletId, outletId as OutletId),
        eq(panicAlerts.id, alertId),
      ),
    )
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Alert not found.");
  return row;
}

/** First acknowledgement wins; the same person repeating gets the same 200. */
export async function acknowledgeEmergencyAlert(
  context: ScopedTenantContext,
  outletId: string,
  alertId: string,
  userId: string,
): Promise<PanicAlertDto> {
  return withTenant(db, context, async (tx) => {
    const row = await lockAlert(tx, context, outletId, alertId);
    if (row.acknowledgedAt) {
      if (row.acknowledgedBy === userId) return toDto(row);
      throw new HttpError(
        409,
        "ALREADY_ACKNOWLEDGED",
        `Alert already acknowledged by ${row.acknowledgedBy}.`,
      );
    }
    const [updated] = await tx
      .update(panicAlerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: userId })
      .where(
        and(
          eq(panicAlerts.tenantId, context.tenant.tenantId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .returning();
    return toDto(updated!);
  });
}

/** Closes the incident with a note; acknowledges too when nobody did. */
export async function resolveEmergencyAlert(
  context: ScopedTenantContext,
  outletId: string,
  alertId: string,
  userId: string,
  note: string,
): Promise<PanicAlertDto> {
  return withTenant(db, context, async (tx) => {
    const row = await lockAlert(tx, context, outletId, alertId);
    if (row.resolvedAt)
      throw new HttpError(
        409,
        "ALREADY_RESOLVED",
        "Alert is already resolved.",
      );
    const now = new Date();
    const [updated] = await tx
      .update(panicAlerts)
      .set({
        resolvedAt: now,
        resolvedBy: userId,
        resolutionNote: note,
        ...(row.acknowledgedAt
          ? {}
          : { acknowledgedAt: now, acknowledgedBy: userId }),
      })
      .where(
        and(
          eq(panicAlerts.tenantId, context.tenant.tenantId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .returning();
    return toDto(updated!);
  });
}
