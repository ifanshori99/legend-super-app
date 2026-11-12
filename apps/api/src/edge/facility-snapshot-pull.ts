// Pull configuration while online; retain the last committed copy offline.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { facilitySnapshotSchema } from "../services/edge-facility-snapshot.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import { cloudGetJson, type CloudGetOptions } from "./cloud-http.ts";
import { parseEdgeCredential } from "./credential.ts";
import {
  createDeviceRegistryPuller,
  type DeviceRegistryPullerDeps,
} from "./device-registry-puller.ts";

export async function pullFacilitySnapshotOnce(
  config: Pick<CloudGetOptions, "cloudUrl" | "credential">,
  signal?: AbortSignal,
): Promise<void> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw new Error("EDGE_NODE_CREDENTIAL");
  const snapshot = facilitySnapshotSchema.parse(
    await cloudGetJson({
      ...config,
      path: "/api/edge-sync/device-records/facility-snapshot",
      signal,
    }),
  );
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !same(snapshot.tenantId, claims.tenantId) ||
    !same(snapshot.outletId, claims.outletId) ||
    [...snapshot.facilities, ...snapshot.areas, ...snapshot.units].some(
      (row) =>
        !same(row.tenantId, claims.tenantId) ||
        !same(row.outletId, claims.outletId),
    )
  )
    throw new Error("FACILITY_SNAPSHOT_SCOPE");
  const facilityIds = new Set(snapshot.facilities.map((row) => row.id));
  const areaKeys = new Set(
    snapshot.areas.map((row) => `${row.facilityId}/${row.id}`),
  );
  const panicIds = snapshot.units.flatMap((row) =>
    row.panicDeviceId ? [row.panicDeviceId.toLowerCase()] : [],
  );
  if (
    facilityIds.size !== snapshot.facilities.length ||
    new Set(snapshot.areas.map((row) => row.id.toLowerCase())).size !==
      snapshot.areas.length ||
    new Set(snapshot.units.map((row) => row.id.toLowerCase())).size !==
      snapshot.units.length ||
    new Set(panicIds).size !== panicIds.length ||
    snapshot.areas.some((row) => !facilityIds.has(row.facilityId)) ||
    snapshot.units.some(
      (row) =>
        !facilityIds.has(row.facilityId) ||
        !areaKeys.has(`${row.facilityId}/${row.areaId}`),
    )
  )
    throw new Error("FACILITY_SNAPSHOT_RELATION");
  await withTenant(db, edgeNodeContext(claims), async (tx) => {
    const tenantId = tenantIdSchema.parse(claims.tenantId);
    const outletId = outletIdSchema.parse(claims.outletId);
    // Free keys claimed by another row in the new snapshot before any upsert.
    // Historical rows stay present for incident references; only a conflicting
    // name or code is detached. A failed transaction restores every old key.
    const oldAreas = await tx
      .select({
        id: facilityAreas.id,
        facilityId: facilityAreas.facilityId,
        name: facilityAreas.name,
      })
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, tenantId),
          eq(facilityAreas.outletId, outletId),
        ),
      )
      .for("update");
    const oldUnits = await tx
      .select({
        id: facilityUnits.id,
        facilityId: facilityUnits.facilityId,
        code: facilityUnits.code,
      })
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.outletId, outletId),
        ),
      )
      .for("update");
    const key = (facilityId: string, value: string) =>
      `${facilityId.toLowerCase()}/${value}`;
    const areaTargets = new Map(
      snapshot.areas.map((row) => [
        key(row.facilityId, row.name),
        row.id.toLowerCase(),
      ]),
    );
    const unitTargets = new Map(
      snapshot.units.map((row) => [
        key(row.facilityId, row.code),
        row.id.toLowerCase(),
      ]),
    );
    const usedAreaKeys = new Set([
      ...oldAreas.map((row) => key(row.facilityId, row.name)),
      ...areaTargets.keys(),
    ]);
    const usedUnitKeys = new Set([
      ...oldUnits.map((row) => key(row.facilityId, row.code)),
      ...unitTargets.keys(),
    ]);
    const temporary = (facilityId: string, used: Set<string>) => {
      let value: string;
      do value = `~${randomUUID().replaceAll("-", "").slice(0, 19)}`;
      while (used.has(key(facilityId, value)));
      used.add(key(facilityId, value));
      return value;
    };
    for (const row of oldAreas) {
      const target = areaTargets.get(key(row.facilityId, row.name));
      if (target !== undefined && target !== row.id.toLowerCase()) {
        await tx
          .update(facilityAreas)
          .set({ name: temporary(row.facilityId, usedAreaKeys) })
          .where(
            and(
              eq(facilityAreas.tenantId, tenantId),
              eq(facilityAreas.outletId, outletId),
              eq(facilityAreas.id, row.id),
            ),
          );
      }
    }
    for (const row of oldUnits) {
      const target = unitTargets.get(key(row.facilityId, row.code));
      if (target !== undefined && target !== row.id.toLowerCase()) {
        await tx
          .update(facilityUnits)
          .set({ code: temporary(row.facilityId, usedUnitKeys) })
          .where(
            and(
              eq(facilityUnits.tenantId, tenantId),
              eq(facilityUnits.outletId, outletId),
              eq(facilityUnits.id, row.id),
            ),
          );
      }
    }
    // Removed mappings must stop authorizing a panic device. Keep historical
    // rows because local incidents may still reference them.
    await tx
      .update(facilityUnits)
      .set({ panicDeviceId: null })
      .where(
        and(
          eq(facilityUnits.tenantId, claims.tenantId),
          eq(facilityUnits.outletId, claims.outletId),
        ),
      );
    for (const row of snapshot.facilities) {
      const values = {
        ...row,
        tenantId,
        outletId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
      const result = await tx
        .insert(facilities)
        .values(values)
        .onConflictDoUpdate({
          target: facilities.id,
          set: {
            name: values.name,
            type: values.type,
            sessionMinutes: values.sessionMinutes,
            cleaningMinutes: values.cleaningMinutes,
            arrivalGraceMinutes: values.arrivalGraceMinutes,
            operatingHours: values.operatingHours,
            overtimePolicy: values.overtimePolicy,
            cancellationPolicy: values.cancellationPolicy,
            updatedAt: values.updatedAt,
          },
          setWhere: and(
            eq(facilities.tenantId, claims.tenantId),
            eq(facilities.outletId, claims.outletId),
          ),
        })
        .returning({ id: facilities.id });
      if (result.length !== 1) throw new Error("FACILITY_SNAPSHOT_CONFLICT");
    }
    for (const row of snapshot.areas) {
      const values = {
        ...row,
        tenantId,
        outletId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
      const result = await tx
        .insert(facilityAreas)
        .values(values)
        .onConflictDoUpdate({
          target: facilityAreas.id,
          set: {
            name: values.name,
            entranceLockDeviceId: values.entranceLockDeviceId,
            sortOrder: values.sortOrder,
            updatedAt: values.updatedAt,
          },
          setWhere: and(
            eq(facilityAreas.tenantId, claims.tenantId),
            eq(facilityAreas.outletId, claims.outletId),
            eq(facilityAreas.facilityId, values.facilityId),
          ),
        })
        .returning({ id: facilityAreas.id });
      if (result.length !== 1) throw new Error("FACILITY_SNAPSHOT_CONFLICT");
    }
    for (const row of snapshot.units) {
      const values = {
        ...row,
        tenantId,
        outletId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
      const result = await tx
        .insert(facilityUnits)
        .values(values)
        .onConflictDoUpdate({
          target: facilityUnits.id,
          set: {
            areaId: values.areaId,
            code: values.code,
            lockDeviceId: values.lockDeviceId,
            panicDeviceId: values.panicDeviceId,
            sortOrder: values.sortOrder,
            updatedAt: values.updatedAt,
          },
          setWhere: and(
            eq(facilityUnits.tenantId, claims.tenantId),
            eq(facilityUnits.outletId, claims.outletId),
            eq(facilityUnits.facilityId, values.facilityId),
          ),
        })
        .returning({ id: facilityUnits.id });
      if (result.length !== 1) throw new Error("FACILITY_SNAPSHOT_CONFLICT");
    }
  });
}

export function createFacilitySnapshotPuller(
  input: { config: Pick<CloudGetOptions, "cloudUrl" | "credential"> } & Pick<
    DeviceRegistryPullerDeps,
    "intervalMs" | "staleAfterMs" | "maxBackoffMs" | "onError"
  >,
) {
  return createDeviceRegistryPuller({
    pull: async (_since, signal) => {
      await pullFacilitySnapshotOnce(input.config, signal);
      return { watermark: null };
    },
    load: async () => ({ watermark: null, lastSuccessAt: null }),
    save: async () => undefined,
    intervalMs: input.intervalMs,
    staleAfterMs: input.staleAfterMs,
    maxBackoffMs: input.maxBackoffMs,
    onError: input.onError,
  });
}
