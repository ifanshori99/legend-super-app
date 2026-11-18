// Edge selfie local retention (design docs/design/hris-edge-replication.md
// section 5 "Local retention", 9 T7). One sweep an hour keeps the edge disk and
// tables from growing: it expires selfies that never left, removes leftover and
// stray files, and purges old attendance logs once the cloud has them.
// Sealed files are never read here, and logs carry counts only: no object ids,
// tenant ids or file names.
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import { db as sharedDb } from "../db/index.ts";
import type * as schema from "../db/schema";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { edgeSelfieUploads } from "../db/schema/edge-hris.ts";
import { edgeOutboundQueue } from "../db/schema/edge-node.ts";
import {
  attendanceCorrections,
  attendanceLogs,
} from "../db/schema/hris-attendance.ts";
import { staffPinProofs } from "../db/schema/staff-pin-proof.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import {
  EDGE_SEALED_KEY_PREFIX,
  edgeSealedFilePath,
  parseEdgeSealedObjectKey,
} from "./selfie-paths.ts";
import type { TrustedClock } from "./trusted-clock.ts";

type Database = NodePgDatabase<typeof schema>;

/** legend-4sesc: the part of the edge trusted clock a purge relies on. */
export type RetentionClock = Pick<TrustedClock, "purgeSafeNow">;

const DAY_MS = 86_400_000;
const REJECTED_KEEP_DAYS = 7;
const ATTENDANCE_KEEP_DAYS = 35;
/**
 * A selfie object without an upload row, or a stray file, waits this long. It
 * stays clearly above the clock's photo age limit (24 h, PHOTO_MAX_AGE_MS in
 * hris-attendance.service.ts), so a clock that passed the age check is never
 * racing the sweep for the same object.
 */
const DEFAULT_ORPHAN_MS = 25 * 3_600_000;
const DEFAULT_INTERVAL_MS = 3_600_000;
const PAGE = 500;
const SEALED_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lss$/;

export interface EdgeSelfieSweepOptions {
  context: ScopedTenantContext;
  /** EDGE_SELFIE_DIR. */
  dir: string;
  /** EDGE_SELFIE_MAX_AGE_DAYS: a pending selfie older than this is given up. */
  maxAgeDays: number;
  now?: () => Date;
  /**
   * legend-4sesc: trusted clock. Cutoffs come from `clock.purgeSafeNow()` (not
   * `now`): never later than the last cloud server time plus the monotonic time
   * since, so a wall clock set forward deletes nothing early. The whole sweep
   * is skipped, with nothing deleted, until the cloud has been heard since
   * boot. The next interval retries.
   */
  clock?: RetentionClock;
  /** Grace for objects without an upload row and stray files. Default 25 h. */
  orphanMs?: number;
  /** Default: the shared API pool. */
  database?: Database;
}

export interface EdgeSelfieSweepResult {
  expiredPending: number;
  expiredRejected: number;
  leftoverFiles: number;
  orphanObjects: number;
  orphanFiles: number;
  logsPurged: number;
  uploadRowsPurged: number;
  pinProofsPurged: number;
}

type FileOutcome = "removed" | "missing" | "skipped";

/**
 * Deletes one regular file. A symlink, directory or anything else is left
 * alone and never followed. A failure other than ENOENT throws.
 */
async function removeRegularFile(filePath: string): Promise<FileOutcome> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) return "skipped";
    await unlink(filePath);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PAGE)
    out.push(items.slice(i, i + PAGE));
  return out;
}

/**
 * A stored path is trusted only when it is absolute, already normalized (no
 * `..`), and names <objectId>.lss inside a folder called <tenantId>.
 */
function isStoredSealedPath(
  filePath: string,
  tenantId: string,
  objectId: string,
): boolean {
  return (
    path.isAbsolute(filePath) &&
    path.normalize(filePath) === filePath &&
    path.basename(filePath) === `${objectId}.lss` &&
    path.basename(path.dirname(filePath)) === tenantId
  );
}

/**
 * pending past maxAgeDays and rejected past 7 days (from rejected_at, created_at
 * for rows rejected before that column): file gone, state expired.
 */
async function expireUploads(
  database: Database,
  context: ScopedTenantContext,
  dir: string,
  now: Date,
  maxAgeDays: number,
): Promise<{ expiredPending: number; expiredRejected: number }> {
  const tenantId = context.tenant.tenantId;
  const pendingCutoff = new Date(now.getTime() - maxAgeDays * DAY_MS);
  const rejectedCutoff = new Date(now.getTime() - REJECTED_KEEP_DAYS * DAY_MS);
  const rows = await withTenant(database, context, (tx) =>
    tx
      .select({
        objectId: edgeSelfieUploads.objectId,
        state: edgeSelfieUploads.state,
        filePath: edgeSelfieUploads.filePath,
      })
      .from(edgeSelfieUploads)
      .where(
        and(
          eq(edgeSelfieUploads.tenantId, tenantId),
          or(
            and(
              eq(edgeSelfieUploads.state, "pending"),
              lt(edgeSelfieUploads.createdAt, pendingCutoff),
            ),
            and(
              eq(edgeSelfieUploads.state, "rejected"),
              lt(
                sql`COALESCE(${edgeSelfieUploads.rejectedAt}, ${edgeSelfieUploads.createdAt})`,
                rejectedCutoff,
              ),
            ),
          ),
        ),
      ),
  );
  const done: Record<"pending" | "rejected", string[]> = {
    pending: [],
    rejected: [],
  };
  let badPaths = 0;
  for (const row of rows) {
    if (row.state !== "pending" && row.state !== "rejected") continue;
    // The uploader reads row.filePath, so the file is where the row says even
    // when EDGE_SELFIE_DIR has changed since. Only a path that still has the
    // shape <any dir>/<tenantId>/<objectId>.lss is trusted.
    if (!isStoredSealedPath(row.filePath, tenantId, row.objectId)) {
      badPaths += 1;
      continue;
    }
    try {
      const outcome = await removeRegularFile(row.filePath);
      if (outcome !== "skipped") done[row.state].push(row.objectId);
    } catch {
      // The row stays as it is; the next sweep tries again.
    }
  }
  for (const state of ["pending", "rejected"] as const)
    for (const ids of chunks(done[state]))
      await withTenant(database, context, (tx) =>
        tx
          .update(edgeSelfieUploads)
          .set({ state: "expired" })
          .where(
            and(
              eq(edgeSelfieUploads.tenantId, tenantId),
              eq(edgeSelfieUploads.state, state),
              inArray(edgeSelfieUploads.objectId, ids),
            ),
          ),
      );
  // Class only: no object ids or paths.
  if (badPaths > 0)
    logger.warn(
      { badPaths },
      "Edge selfie rows with an unusable file path were skipped",
    );
  return {
    expiredPending: done.pending.length,
    expiredRejected: done.rejected.length,
  };
}

/** Edge-sealed selfie objects whose clock was never made: row and file go. */
async function removeOrphanObjects(
  database: Database,
  context: ScopedTenantContext,
  dir: string,
  now: Date,
  orphanMs: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(now.getTime() - orphanMs);
  const rows = await withTenant(database, context, (tx) =>
    tx
      .select({
        id: coreStorageObjects.id,
        objectKey: coreStorageObjects.objectKey,
      })
      .from(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, tenantId),
          eq(coreStorageObjects.purpose, "selfie"),
          like(coreStorageObjects.objectKey, `${EDGE_SEALED_KEY_PREFIX}%`),
          lt(coreStorageObjects.createdAt, cutoff),
          isNull(coreStorageObjects.sourceId),
          notExists(
            tx
              .select({ one: edgeSelfieUploads.objectId })
              .from(edgeSelfieUploads)
              .where(
                and(
                  eq(edgeSelfieUploads.tenantId, coreStorageObjects.tenantId),
                  eq(edgeSelfieUploads.objectId, coreStorageObjects.id),
                ),
              ),
          ),
        ),
      ),
  );
  const candidates: string[] = [];
  for (const row of rows) {
    const parsed = parseEdgeSealedObjectKey(row.objectKey);
    if (!parsed || parsed.tenantId !== tenantId || parsed.objectId !== row.id)
      continue;
    candidates.push(row.id);
  }
  // The row goes first, with the guards inside the DELETE itself: a clock
  // that linked the object or queued its upload since the select above makes
  // the DELETE match nothing, and its file stays. Files go only for the rows
  // that were really deleted; a crash in between leaves a stray file that
  // sweepDirectory removes later.
  let removed = 0;
  for (const ids of chunks(candidates)) {
    const gone = await withTenant(database, context, (tx) =>
      tx
        .delete(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, tenantId),
            eq(coreStorageObjects.purpose, "selfie"),
            like(coreStorageObjects.objectKey, `${EDGE_SEALED_KEY_PREFIX}%`),
            lt(coreStorageObjects.createdAt, cutoff),
            isNull(coreStorageObjects.sourceId),
            inArray(coreStorageObjects.id, ids),
            notExists(
              tx
                .select({ one: edgeSelfieUploads.objectId })
                .from(edgeSelfieUploads)
                .where(
                  and(
                    eq(edgeSelfieUploads.tenantId, coreStorageObjects.tenantId),
                    eq(edgeSelfieUploads.objectId, coreStorageObjects.id),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: coreStorageObjects.id }),
    );
    for (const { id } of gone) {
      removed += 1;
      try {
        await removeRegularFile(edgeSealedFilePath(dir, tenantId, id));
      } catch {
        // The row is gone; sweepDirectory removes the stray file later.
      }
    }
  }
  return removed;
}

/**
 * Walks dir/<tenantId>/ once. Only regular files named <uuid>.lss or *.tmp are
 * considered (a symlink or directory is never touched). A file whose upload row
 * is `uploaded` or `expired` is a leftover. A file with no upload row and no
 * storage row, or any .tmp, goes after the grace period (by file mtime).
 */
async function sweepDirectory(
  database: Database,
  context: ScopedTenantContext,
  dir: string,
  now: Date,
  orphanMs: number,
): Promise<{ leftoverFiles: number; orphanFiles: number }> {
  const tenantId = context.tenant.tenantId;
  const tenantDir = path.join(dir, tenantId);
  let entries: string[];
  try {
    entries = (await readdir(tenantDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          (SEALED_NAME.test(entry.name) || entry.name.endsWith(".tmp")),
      )
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { leftoverFiles: 0, orphanFiles: 0 };
    throw error;
  }

  const stateOf = new Map<string, string>();
  const hasObject = new Set<string>();
  const sealed = entries
    .filter((name) => SEALED_NAME.test(name))
    .map((name) => name.slice(0, -".lss".length));
  for (const ids of chunks(sealed)) {
    const [uploads, objects] = await withTenant(
      database,
      context,
      async (tx) =>
        [
          await tx
            .select({
              objectId: edgeSelfieUploads.objectId,
              state: edgeSelfieUploads.state,
            })
            .from(edgeSelfieUploads)
            .where(
              and(
                eq(edgeSelfieUploads.tenantId, tenantId),
                inArray(edgeSelfieUploads.objectId, ids),
              ),
            ),
          await tx
            .select({ id: coreStorageObjects.id })
            .from(coreStorageObjects)
            .where(
              and(
                eq(coreStorageObjects.tenantId, tenantId),
                inArray(coreStorageObjects.id, ids),
              ),
            ),
        ] as const,
    );
    for (const row of uploads) stateOf.set(row.objectId, row.state);
    for (const row of objects) hasObject.add(row.id);
  }

  const graceCutoff = now.getTime() - orphanMs;
  let leftoverFiles = 0;
  let orphanFiles = 0;
  for (const name of entries) {
    const filePath = path.join(tenantDir, name);
    try {
      if (name.endsWith(".tmp")) {
        if ((await lstat(filePath)).mtimeMs >= graceCutoff) continue;
        if ((await removeRegularFile(filePath)) === "removed") orphanFiles += 1;
        continue;
      }
      const objectId = name.slice(0, -".lss".length);
      const state = stateOf.get(objectId);
      if (state === "uploaded" || state === "expired") {
        if ((await removeRegularFile(filePath)) === "removed")
          leftoverFiles += 1;
      } else if (state === undefined && !hasObject.has(objectId)) {
        if ((await lstat(filePath)).mtimeMs >= graceCutoff) continue;
        if ((await removeRegularFile(filePath)) === "removed") orphanFiles += 1;
      }
    } catch {
      // Gone already, or not removable now: the next sweep looks again.
    }
  }
  return { leftoverFiles, orphanFiles };
}

/**
 * Edge attendance logs received over 35 days ago, once every outbox event for
 * the log is acked (at least one) and no correction names the log. Then the
 * terminal upload rows older than 35 days go, with their edge-sealed objects.
 */
async function purgeOldAttendance(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
): Promise<{ logsPurged: number; uploadRowsPurged: number }> {
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(now.getTime() - ATTENDANCE_KEEP_DAYS * DAY_MS);
  let logsPurged = 0;
  let lastId: string | null = null;
  for (;;) {
    const after: string | null = lastId;
    const page: { scanned: number; purged: number; last: string | null } =
      await withTenant(database, context, async (tx) => {
        const candidates: { id: string }[] = await tx
          .select({ id: attendanceLogs.id })
          .from(attendanceLogs)
          .where(
            and(
              eq(attendanceLogs.tenantId, tenantId),
              lt(attendanceLogs.receivedAt, cutoff),
              after === null ? undefined : gt(attendanceLogs.id, after),
            ),
          )
          .orderBy(asc(attendanceLogs.id))
          .limit(PAGE);
        const ids = candidates.map((row) => row.id);
        const last = ids[ids.length - 1] ?? null;
        if (last === null) return { scanned: 0, purged: 0, last };
        // The outbox names a log by the id the envelope carried: a ULID, with
        // the uuid form accepted too.
        const logOf = new Map<string, string>();
        for (const id of ids) {
          logOf.set(id, id);
          logOf.set(ulidToUuid(id), id);
        }
        const queue = await tx
          .select({
            aggregateId: edgeOutboundQueue.aggregateId,
            status: edgeOutboundQueue.status,
          })
          .from(edgeOutboundQueue)
          .where(
            and(
              eq(edgeOutboundQueue.tenantId, tenantId),
              inArray(edgeOutboundQueue.aggregateId, [...logOf.keys()]),
            ),
          );
        const acked = new Set<string>();
        const blocked = new Set<string>();
        for (const row of queue) {
          const log = logOf.get(row.aggregateId);
          if (!log) continue;
          if (row.status === "acked") acked.add(log);
          else blocked.add(log);
        }
        const corrections = await tx
          .select({
            logId: attendanceCorrections.attendanceLogId,
            resultingLogId: attendanceCorrections.resultingLogId,
          })
          .from(attendanceCorrections)
          .where(
            and(
              eq(attendanceCorrections.tenantId, tenantId),
              or(
                inArray(attendanceCorrections.attendanceLogId, ids),
                inArray(attendanceCorrections.resultingLogId, ids),
              ),
            ),
          );
        for (const row of corrections) {
          if (row.logId) blocked.add(row.logId);
          if (row.resultingLogId) blocked.add(row.resultingLogId);
        }
        const doomed = ids.filter((id) => acked.has(id) && !blocked.has(id));
        if (doomed.length > 0)
          await tx
            .delete(attendanceLogs)
            .where(
              and(
                eq(attendanceLogs.tenantId, tenantId),
                inArray(attendanceLogs.id, doomed),
              ),
            );
        return { scanned: ids.length, purged: doomed.length, last };
      });
    logsPurged += page.purged;
    if (page.scanned < PAGE || page.last === null) break;
    lastId = page.last;
  }

  const uploadRowsPurged = await withTenant(database, context, async (tx) => {
    const gone = await tx
      .delete(edgeSelfieUploads)
      .where(
        and(
          eq(edgeSelfieUploads.tenantId, tenantId),
          ne(edgeSelfieUploads.state, "pending"),
          lt(edgeSelfieUploads.createdAt, cutoff),
        ),
      )
      .returning({ objectId: edgeSelfieUploads.objectId });
    for (const ids of chunks(gone.map((row) => row.objectId)))
      await tx
        .delete(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, tenantId),
            eq(coreStorageObjects.purpose, "selfie"),
            like(coreStorageObjects.objectKey, `${EDGE_SEALED_KEY_PREFIX}%`),
            inArray(coreStorageObjects.id, ids),
          ),
        );
    return gone.length;
  });
  return { logsPurged, uploadRowsPurged };
}

/**
 * Proofs are single-use and leave the edge after one day, used or unused.
 * With a `clock` (legend-4sesc) the cutoff is `clock.purgeSafeNow()` minus one
 * day, and nothing is purged before the cloud has been heard since boot.
 */
export async function purgeOldPinProofs(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  clock?: RetentionClock,
): Promise<number> {
  const base = clock ? clock.purgeSafeNow() : now;
  if (base === null) return 0;
  const cutoff = new Date(base.getTime() - DAY_MS);
  let purged = 0;
  for (;;) {
    const page = await withTenant(database, context, async (tx) => {
      const eligible = and(
        eq(staffPinProofs.tenantId, context.tenant.tenantId),
        lt(staffPinProofs.createdAt, cutoff),
      );
      const rows = await tx
        .select({ id: staffPinProofs.id })
        .from(staffPinProofs)
        .where(eligible)
        .limit(PAGE);
      if (rows.length === 0) return { selected: 0, deleted: 0 };
      const deleted = await tx
        .delete(staffPinProofs)
        .where(
          and(
            eligible,
            inArray(
              staffPinProofs.id,
              rows.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: staffPinProofs.id });
      return { selected: rows.length, deleted: deleted.length };
    });
    purged += page.deleted;
    if (page.selected < PAGE || page.deleted === 0) return purged;
  }
}

/**
 * One retention pass. A failing step does not stop the others; the first
 * failure is thrown at the end so the caller can log it.
 */
export async function sweepEdgeSelfies(
  options: EdgeSelfieSweepOptions,
): Promise<EdgeSelfieSweepResult> {
  const database = options.database ?? sharedDb;
  const { context, dir } = options;
  const orphanMs = options.orphanMs ?? DEFAULT_ORPHAN_MS;
  const result: EdgeSelfieSweepResult = {
    expiredPending: 0,
    expiredRejected: 0,
    leftoverFiles: 0,
    orphanObjects: 0,
    orphanFiles: 0,
    logsPurged: 0,
    uploadRowsPurged: 0,
    pinProofsPurged: 0,
  };
  const safeNow = options.clock ? options.clock.purgeSafeNow() : undefined;
  if (safeNow === null) {
    // No cloud server time since boot: nothing is deleted on a clock that may
    // be wrong; the next interval looks again once the cloud has been heard.
    logger.warn(
      "Edge selfie retention sweep skipped: edge clock is not trusted",
    );
    return result;
  }
  const now = safeNow ?? (options.now ?? (() => new Date()))();
  const failures: unknown[] = [];
  const step = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  await step(async () => {
    Object.assign(
      result,
      await expireUploads(database, context, dir, now, options.maxAgeDays),
    );
  });
  await step(async () => {
    result.orphanObjects = await removeOrphanObjects(
      database,
      context,
      dir,
      now,
      orphanMs,
    );
  });
  await step(async () => {
    Object.assign(
      result,
      await sweepDirectory(database, context, dir, now, orphanMs),
    );
  });
  await step(async () => {
    Object.assign(result, await purgeOldAttendance(database, context, now));
  });
  await step(async () => {
    result.pinProofsPurged = await purgeOldPinProofs(database, context, now);
  });

  // Counts only: no ids, names or tenant.
  if (result.expiredPending > 0)
    logger.warn(
      { expiredPending: result.expiredPending },
      "Edge selfies expired before reaching the cloud",
    );
  if (result.orphanObjects > 0)
    logger.warn(
      { orphanObjects: result.orphanObjects },
      "Edge selfie objects without an upload clock were removed",
    );
  if (failures.length > 0) throw failures[0];
  return result;
}

export interface EdgeSelfieSweeper {
  /** One sweep now; the call in flight is returned when one is running. */
  runOnce(): Promise<EdgeSelfieSweepResult | null>;
  stop(): Promise<void>;
}

export interface StartEdgeSelfieSweepOptions extends EdgeSelfieSweepOptions {
  intervalMs?: number;
  /** Default: setTimeout + unref. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/** Error name/code only: messages may carry data. */
function errorLabel(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.name === "string") return candidate.name;
  return "Error";
}

/**
 * Sweeps now, then once an hour. The next run is scheduled when the current
 * one ends, so two sweeps never overlap. Timers are unref'd.
 */
export function startEdgeSelfieSweep(
  options: StartEdgeSelfieSweepOptions,
): EdgeSelfieSweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<EdgeSelfieSweepResult | null> | null = null;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(): void {
    cancelTimer();
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void runOnce();
    }, intervalMs);
  }

  async function execute(): Promise<EdgeSelfieSweepResult | null> {
    let result: EdgeSelfieSweepResult | null = null;
    try {
      result = await sweepEdgeSelfies(options);
    } catch (error) {
      try {
        logger.error(
          { code: errorLabel(error) },
          "Edge selfie retention sweep failed",
        );
      } catch {
        // A broken logger must not stop the schedule.
      }
    }
    schedule();
    return result;
  }

  function runOnce(): Promise<EdgeSelfieSweepResult | null> {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve(null);
    cancelTimer();
    const promise = execute().finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  void runOnce();
  return {
    runOnce,
    async stop() {
      stopped = true;
      cancelTimer();
      if (inFlight) await inFlight;
    },
  };
}
