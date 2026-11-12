// Outlet-scoped facility configuration for the offline emergency receiver.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  cancellationPolicySchema,
  facilityHoursSchema,
  overtimePolicySchema,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { edgeNodeContext } from "./edge-node.service.ts";
import {
  verifiedEdgeNodeSchema,
  type VerifiedEdgeNode,
} from "./staff-pin-sync.ts";

const uuid = z.string().uuid();
const stamp = z.string().datetime();
const facility = z.strictObject({
  id: uuid,
  tenantId: uuid,
  outletId: uuid,
  name: z.string().min(1).max(150),
  type: z.enum(["shower", "locker", "meeting_room", "coworking"]),
  sessionMinutes: z.number().int().min(1).max(480),
  cleaningMinutes: z.number().int().min(0).max(240),
  arrivalGraceMinutes: z.number().int().min(0).max(1440),
  operatingHours: facilityHoursSchema,
  overtimePolicy: overtimePolicySchema,
  cancellationPolicy: cancellationPolicySchema,
  createdAt: stamp,
  updatedAt: stamp,
});
const area = z.strictObject({
  id: uuid,
  tenantId: uuid,
  outletId: uuid,
  facilityId: uuid,
  name: z.string().min(1).max(150),
  entranceLockDeviceId: uuid.nullable(),
  sortOrder: z.number().int().nonnegative(),
  createdAt: stamp,
  updatedAt: stamp,
});
const unit = z.strictObject({
  id: uuid,
  tenantId: uuid,
  outletId: uuid,
  facilityId: uuid,
  areaId: uuid,
  code: z.string().min(1).max(20),
  lockDeviceId: uuid.nullable(),
  panicDeviceId: uuid.nullable(),
  status: z.enum([
    "available",
    "in_use",
    "needs_cleaning",
    "cleaning",
    "maintenance",
  ]),
  sortOrder: z.number().int().nonnegative(),
  createdAt: stamp,
  updatedAt: stamp,
});
export const facilitySnapshotSchema = z.strictObject({
  tenantId: uuid,
  outletId: uuid,
  facilities: z.array(facility),
  areas: z.array(area),
  units: z.array(unit),
});
export type FacilitySnapshot = z.infer<typeof facilitySnapshotSchema>;

/** Only the authenticated node's outlet is ever read. */
export async function buildFacilitySnapshot(
  node: VerifiedEdgeNode,
): Promise<FacilitySnapshot> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  return withTenant(db, edgeNodeContext(verified), async (tx) => {
    const scope = { tenantId: verified.tenantId, outletId: verified.outletId };
    const facilityRows = await tx
      .select()
      .from(facilities)
      .where(
        and(
          eq(facilities.tenantId, scope.tenantId),
          eq(facilities.outletId, scope.outletId),
        ),
      );
    const areaRows = await tx
      .select()
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, scope.tenantId),
          eq(facilityAreas.outletId, scope.outletId),
        ),
      );
    const unitRows = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, scope.tenantId),
          eq(facilityUnits.outletId, scope.outletId),
        ),
      );
    return facilitySnapshotSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...scope,
          facilities: facilityRows,
          areas: areaRows,
          units: unitRows,
        }),
      ),
    );
  });
}
