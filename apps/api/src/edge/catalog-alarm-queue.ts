// Q62: a warning recorded offline must reach the owner even if the catalog
// recovers, or the edge restarts, before reconnecting. The heartbeat protocol
// has no delivery ACK for alarms, so keep and replay these records; the cloud
// deduplicates by node, stream and staleSince. Rotate batches rather than drop
// old records when more than the protocol's 16 entries are pending.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { catalogStaleSchema, type CatalogStale } from "./protocol.ts";

// 533 A4: an alarm about an old clock doubt must not nag the owner forever.
// The cloud sends no delivery ack, so "delivered" means "sent in a heartbeat
// over an open link". An entry expires after this many such heartbeats (24 h of
// 15 s heartbeats), or, once it was sent at least ALARM_MIN_SENDS_BEFORE_AGE_EXPIRY
// times (about 1 h of heartbeats), after ALARM_MAX_AGE_MS since it was first
// enqueued, measured with the `now` option (the runtime passes the trusted
// clock). An entry sent fewer times is never dropped by age: an offline edge, a
// flapping link or a clock jump forward must not delete an alarm the owner may
// not have received.
export const ALARM_MAX_HEARTBEATS = 5760;
export const ALARM_MIN_SENDS_BEFORE_AGE_EXPIRY = 240;
export const ALARM_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export type CatalogAlarmQueue = {
  enqueue(alarms: CatalogStale): Promise<void>;
  /** null pauses replay while the live tracker is unavailable or incompatible. */
  heartbeat(live: CatalogStale | null): CatalogStale;
  flush(): Promise<void>;
  /**
   * Drop the queued entries with this reason (533 A2: the clock was proven,
   * so the unproven-time alarms are moot) and persist the result. With `since`
   * only entries whose staleSince is at or after it go (533b: the alarms of this
   * boot; older ones may not have reached the owner). Without it, all of them.
   */
  clearReason(reason: string, since?: Date): Promise<void>;
};

const keyOf = (alarm: CatalogStale[number]): string =>
  JSON.stringify([alarm.stream, alarm.staleSince]);

export async function openCatalogAlarmQueue(options: {
  directory: string;
  edgeNodeId: string;
  /** Previous location of this queue's file (import once, then remove). */
  legacyDirectory?: string;
  /** Clock for the 7 day expiry; the runtime passes the trusted clock. */
  now?: () => Date;
  onError?: (error: unknown) => void;
}): Promise<CatalogAlarmQueue> {
  // Scope the file to the local node without allowing identifiers to become paths.
  const filename = `${createHash("sha256").update(options.edgeNodeId).digest("hex")}.json`;
  const filePath = join(options.directory, filename);
  const now = options.now ?? (() => new Date());
  const entries = new Map<string, CatalogStale[number]>();
  // Expiry bookkeeping per entry, persisted next to the alarm fields.
  const meta = new Map<string, { enqueuedAt: number; heartbeats: number }>();
  let needsLoad = true;
  let dirty = false;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // An alarm sink failure must not hold ordinary sales.
    }
  };
  type Meta = { enqueuedAt: number; heartbeats: number };
  // Validate every entry before merging so a malformed file cannot partly
  // replace memory. Throws on any invalid content.
  type Saved = { alarm: CatalogStale[number]; meta: Meta };
  const parseQueue = (raw: string): Saved[] => {
    const stored: unknown = JSON.parse(raw);
    if (
      !stored ||
      typeof stored !== "object" ||
      !("version" in stored) ||
      stored.version !== 1 ||
      !("entries" in stored) ||
      !Array.isArray(stored.entries)
    )
      throw new Error("Invalid catalog alarm queue");
    return stored.entries.map((entry: unknown) => {
      const { enqueuedAt, heartbeats, ...alarm } = (entry ?? {}) as Record<
        string,
        unknown
      >;
      const enqueuedMs =
        typeof enqueuedAt === "string" ? Date.parse(enqueuedAt) : NaN;
      return {
        alarm: catalogStaleSchema.parse([alarm])[0]!,
        meta: {
          // A file from before 533 has no bookkeeping: its lease starts now.
          enqueuedAt: Number.isFinite(enqueuedMs)
            ? enqueuedMs
            : now().getTime(),
          heartbeats:
            typeof heartbeats === "number" &&
            Number.isInteger(heartbeats) &&
            heartbeats >= 0
              ? heartbeats
              : 0,
        },
      };
    });
  };
  const merge = (saved: Saved[]): void => {
    for (const { alarm, meta: saveMeta } of saved) {
      if (entries.has(keyOf(alarm))) continue;
      entries.set(keyOf(alarm), alarm);
      meta.set(keyOf(alarm), saveMeta);
    }
  };
  const loadMain = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    let saved: Saved[];
    try {
      saved = parseQueue(raw);
    } catch (error) {
      // Preserve the exact unreadable bytes for recovery; never overwrite
      // them with an empty queue or make the POS wait for manual repair.
      await rename(filePath, `${filePath}.${randomUUID()}.corrupt`);
      report(error);
      return;
    }
    merge(saved);
  };
  // 533 R4: the previous build kept this queue in the selfie directory. Import
  // that file once; it is unlinked only after the new file is persisted.
  const legacyPath = options.legacyDirectory
    ? join(options.legacyDirectory, filename)
    : null;
  let legacyToRemove: string | null = null;
  let legacyDone = legacyPath === null || legacyPath === filePath;
  const importLegacy = async (): Promise<void> => {
    if (legacyDone || !legacyPath) return;
    legacyDone = true;
    try {
      const saved = parseQueue(await readFile(legacyPath, "utf8"));
      merge(saved);
      legacyToRemove = legacyPath;
      dirty = true;
    } catch (error) {
      // Missing legacy file: nothing to import. Unreadable: ignore it for the
      // import, leave it in place, but tell the operator.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
    }
  };
  const load = async (): Promise<void> => {
    await loadMain();
    needsLoad = false;
    await importLegacy();
  };
  try {
    await load();
  } catch (error) {
    // Keep retrying the read before any later write: a temporary disk failure
    // must not replace previously queued alarms with just the current boot.
    report(error);
  }

  let pending = Promise.resolve();
  let cursor = 0;
  const persist = async (): Promise<void> => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            entries: [...entries].map(([key, alarm]) => ({
              ...alarm,
              enqueuedAt: new Date(meta.get(key)!.enqueuedAt).toISOString(),
              heartbeats: meta.get(key)!.heartbeats,
            })),
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filePath);
      const directory = await open(options.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  };

  const removeLegacy = async (): Promise<void> => {
    if (!legacyToRemove) return;
    const path = legacyToRemove;
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    legacyToRemove = null;
  };

  const flush = (alarms: CatalogStale = []): Promise<void> => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        for (const alarm of alarms) {
          const key = keyOf(alarm);
          entries.set(key, { ...alarm });
          // The same episode again keeps its lease and heartbeat count.
          if (!meta.has(key))
            meta.set(key, { enqueuedAt: now().getTime(), heartbeats: 0 });
        }
        if (alarms.length) dirty = true;
        if (needsLoad) await load();
        if (dirty) {
          await persist();
          dirty = false;
        }
        // A failed unlink retries on every later flush.
        await removeLegacy();
      });
    return pending;
  };

  // Persist an imported legacy queue now; a failure stays dirty for a retry.
  if (legacyToRemove) await flush().catch(report);

  return {
    enqueue: (alarms) => flush(catalogStaleSchema.parse(alarms)),
    heartbeat(live) {
      if (live === null) return [];
      const liveAlarms = catalogStaleSchema.parse(live);
      const nowMs = now().getTime();
      for (const [key, entry] of meta)
        if (
          entry.heartbeats >= ALARM_MAX_HEARTBEATS ||
          (entry.heartbeats >= ALARM_MIN_SENDS_BEFORE_AGE_EXPIRY &&
            nowMs - entry.enqueuedAt > ALARM_MAX_AGE_MS)
        ) {
          entries.delete(key);
          meta.delete(key);
          dirty = true;
        }
      const combined = new Map(entries);
      for (const alarm of liveAlarms) combined.set(keyOf(alarm), alarm);
      const all = [...combined.entries()];
      if (!all.length) return [];
      const count = Math.min(16, all.length);
      const batch = Array.from({ length: count }, (_, index) => {
        const [key, alarm] = all[(cursor + index) % all.length]!;
        // Only a stored entry that is not live any more spends its budget:
        // a live alarm is current news, not a replay.
        const entry = meta.get(key);
        if (entry && !liveAlarms.some((item) => keyOf(item) === key)) {
          entry.heartbeats += 1;
          dirty = true;
        }
        return { ...alarm };
      });
      cursor = (cursor + count) % all.length;
      return batch;
    },
    flush: () => flush(),
    clearReason: (reason, since) => {
      const sinceMs = since?.getTime();
      // Run behind queued writes so a pending enqueue cannot bring it back.
      pending = pending
        .catch(() => {})
        .then(async () => {
          if (needsLoad) await load();
          for (const [key, alarm] of entries)
            if (
              alarm.reason === reason &&
              (sinceMs === undefined || Date.parse(alarm.staleSince) >= sinceMs)
            ) {
              entries.delete(key);
              meta.delete(key);
              dirty = true;
            }
          if (dirty) {
            await persist();
            dirty = false;
          }
          // A failed unlink retries on every later flush.
          await removeLegacy();
        });
      return pending;
    },
  };
}
