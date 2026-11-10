// Links an edge selfie to its attendance log, in either arrival order (design
// docs/design/hris-edge-replication.md 6.3). Called after the selfie upload and
// after the attendance.logged applier inserts a log; whichever comes second
// does the linking. Linking is best effort: a failure never throws, it flags
// the log `selfie_unlinked` and drops its photo_key so the review stays usable.
import { and, eq, sql } from "drizzle-orm";
import { ulidToUuid } from "@starter/shared/core";
import type { AttendanceStoredFlagReason } from "@starter/shared/hris";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { employees } from "../db/schema/hris.ts";
import { logger } from "../lib/logger.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
import type { Tx } from "./hris-access.ts";

/**
 * linked: the object is now attached to the log.
 * already: it was attached to this log before.
 * waiting: the object or the log has not arrived yet.
 * unlinked: both exist but linking failed; the log is flagged `selfie_unlinked`.
 */
export type EdgeSelfieLinkResult =
  | "linked"
  | "already"
  | "waiting"
  | "unlinked";

export async function linkEdgeSelfie(
  tx: Tx,
  input: { tenantId: string; objectId: string },
): Promise<EdgeSelfieLinkResult> {
  const { tenantId, objectId } = input;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`attendance-selfie-link:${tenantId}:${objectId}`}, 0))`,
  );
  const [object] = await tx
    .select({
      sourceKind: coreStorageObjects.sourceKind,
      sourceId: coreStorageObjects.sourceId,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, tenantId),
        eq(coreStorageObjects.id, objectId),
      ),
    )
    .limit(1);
  if (!object) return "waiting";
  const [log] = await tx
    .select({
      id: attendanceLogs.id,
      outletId: attendanceLogs.outletId,
      employeeId: attendanceLogs.employeeId,
      flagReasons: attendanceLogs.flagReasons,
      reviewStatus: attendanceLogs.reviewStatus,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        eq(attendanceLogs.photoKey, objectId),
      ),
    )
    .limit(1);
  if (!log) return "waiting";

  const logUuid = ulidToUuid(log.id);
  if (object.sourceKind === "attendance" && object.sourceId === logUuid)
    return "already";

  try {
    await tx.transaction(async (savepoint) => {
      const [employee] = await savepoint
        .select({ userId: employees.userId })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, tenantId),
            eq(employees.id, log.employeeId),
          ),
        )
        .limit(1);
      if (!employee?.userId) throw new Error("employee has no user");
      await linkStorageObjectSource(savepoint, {
        tenantId,
        objectId,
        sourceKind: "attendance",
        sourceId: logUuid,
        actorUserId: employee.userId,
        outletId: log.outletId,
      });
    });
    return "linked";
  } catch {
    // The savepoint is rolled back; keep the log, drop the dead reference.
    const flags = new Set<AttendanceStoredFlagReason>(
      log.flagReasons as AttendanceStoredFlagReason[],
    );
    flags.add("selfie_unlinked");
    await tx
      .update(attendanceLogs)
      .set({
        photoKey: null,
        flagReasons: [...flags],
        ...(log.reviewStatus === "none" ? { reviewStatus: "pending" } : {}),
      })
      .where(
        and(
          eq(attendanceLogs.tenantId, tenantId),
          eq(attendanceLogs.id, log.id),
        ),
      );
    logger.warn({ logId: log.id, objectId }, "edge selfie could not be linked");
    return "unlinked";
  }
}
