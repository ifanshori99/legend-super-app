// Q62: a warning recorded offline must reach the owner even if the catalog
// recovers, or the edge restarts, before reconnecting. The heartbeat protocol
// has no delivery ACK for alarms, so keep and replay these records; the cloud
// deduplicates by node, stream and staleSince. Rotate batches rather than drop
// old records when more than the protocol's 16 entries are pending.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { catalogStaleSchema, type CatalogStale } from "./protocol.ts";

export type CatalogAlarmQueue = {
  enqueue(alarms: CatalogStale): Promise<void>;
  /** null pauses replay while the live tracker is unavailable or incompatible. */
  heartbeat(live: CatalogStale | null): CatalogStale;
  flush(): Promise<void>;
};

const keyOf = (alarm: CatalogStale[number]): string =>
  JSON.stringify([alarm.stream, alarm.staleSince]);

export async function openCatalogAlarmQueue(options: {
  directory: string;
  edgeNodeId: string;
  onError?: (error: unknown) => void;
}): Promise<CatalogAlarmQueue> {
  // Scope the file to the local node without allowing identifiers to become paths.
  const filename = `${createHash("sha256").update(options.edgeNodeId).digest("hex")}.json`;
  const filePath = join(options.directory, filename);
  const entries = new Map<string, CatalogStale[number]>();
  let needsLoad = true;
  let dirty = false;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // An alarm sink failure must not hold ordinary sales.
    }
  };
  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      needsLoad = false;
      return;
    }
    let saved: CatalogStale;
    try {
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
      // A persisted queue can hold many heartbeat batches. Validate every
      // entry before merging so malformed files cannot partly replace memory.
      saved = stored.entries.map(
        (entry: unknown) => catalogStaleSchema.parse([entry])[0]!,
      );
    } catch (error) {
      // Preserve the exact unreadable bytes for recovery; never overwrite
      // them with an empty queue or make the POS wait for manual repair.
      await rename(filePath, `${filePath}.${randomUUID()}.corrupt`);
      needsLoad = false;
      report(error);
      return;
    }
    for (const alarm of saved)
      if (!entries.has(keyOf(alarm))) entries.set(keyOf(alarm), alarm);
    needsLoad = false;
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
          JSON.stringify({ version: 1, entries: [...entries.values()] }),
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

  const flush = (alarms: CatalogStale = []): Promise<void> => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        for (const alarm of alarms) entries.set(keyOf(alarm), { ...alarm });
        if (alarms.length) dirty = true;
        if (needsLoad) await load();
        if (!dirty) return;
        await persist();
        dirty = false;
      });
    return pending;
  };

  return {
    enqueue: (alarms) => flush(catalogStaleSchema.parse(alarms)),
    heartbeat(live) {
      if (live === null) return [];
      const combined = new Map(entries);
      for (const alarm of catalogStaleSchema.parse(live))
        combined.set(keyOf(alarm), alarm);
      const all = [...combined.values()];
      if (!all.length) return [];
      const count = Math.min(16, all.length);
      const batch = Array.from({ length: count }, (_, index) => ({
        ...all[(cursor + index) % all.length]!,
      }));
      cursor = (cursor + count) % all.length;
      return batch;
    },
    flush: () => flush(),
  };
}
