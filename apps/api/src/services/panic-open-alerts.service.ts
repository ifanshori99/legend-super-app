import { and, asc, eq, isNull } from "drizzle-orm";
import {
  outletIdSchema,
  tenantIdSchema,
  toIsoDateTime,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { facilityAreas, facilityUnits } from "../db/schema/facility.ts";
import { panicAlerts } from "../db/schema/panic-alert.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import type { ReceiverSession } from "./panic-receiver-session.ts";

/** The session is already authenticated and identifies both tenant and outlet. */
export async function listOpenPanicAlerts(session: ReceiverSession) {
  const tenantId = tenantIdSchema.parse(session.tenantId);
  const outletId = outletIdSchema.parse(session.outletId);
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "device",
  });
  return withTenant(db, outletContext(tenant, outletId), async (tx) => {
    const rows = await tx
      .select({ alert: panicAlerts, areaName: facilityAreas.name })
      .from(panicAlerts)
      .leftJoin(
        facilityUnits,
        and(
          eq(facilityUnits.tenantId, panicAlerts.tenantId),
          eq(facilityUnits.outletId, panicAlerts.outletId),
          eq(facilityUnits.id, panicAlerts.unitId),
        ),
      )
      .leftJoin(
        facilityAreas,
        and(
          eq(facilityAreas.tenantId, facilityUnits.tenantId),
          eq(facilityAreas.outletId, facilityUnits.outletId),
          eq(facilityAreas.facilityId, facilityUnits.facilityId),
          eq(facilityAreas.id, facilityUnits.areaId),
        ),
      )
      .where(
        and(
          eq(panicAlerts.tenantId, tenantId),
          eq(panicAlerts.outletId, outletId),
          isNull(panicAlerts.acknowledgedAt),
          isNull(panicAlerts.resolvedAt),
        ),
      )
      .orderBy(asc(panicAlerts.receivedAt));
    return rows.map(({ alert, areaName }) => ({
      type: "panic" as const,
      alertId: alert.id,
      outletId,
      unitId: alert.unitId,
      unitCode: alert.unitCodeSnapshot || null,
      areaName,
      receivedAt: toIsoDateTime(alert.receivedAt),
      kind: alert.kind === "test" ? ("test" as const) : ("press" as const),
    }));
  });
}
