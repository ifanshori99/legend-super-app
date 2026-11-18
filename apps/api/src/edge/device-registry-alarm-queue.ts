// Keep an offline hard-stale warning until it has been replayed over a
// compatible cloud link. The heartbeat has no acknowledgement, so replay it
// for 24 hours of heartbeats, just like the catalog alarm queue.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_HEARTBEATS = 5760;

export async function openDeviceRegistryAlarmQueue(options: {
  directory: string;
  edgeNodeId: string;
  onError?: (error: unknown) => void;
}): Promise<{
  enqueue(): Promise<void>;
  heartbeat(live: boolean): boolean;
  flush(): Promise<void>;
}> {
  const filename = `${createHash("sha256").update(options.edgeNodeId).digest("hex")}.json`;
  const path = join(options.directory, filename);
  let pending = false;
  let heartbeats = 0;
  let dirty = false;
  let writing = Promise.resolve();
  let needsLoad = true;
  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      needsLoad = false;
      return;
    }
    try {
      const saved: unknown = JSON.parse(raw);
      if (
        !saved ||
        typeof saved !== "object" ||
        !("version" in saved) ||
        saved.version !== 1 ||
        !("pending" in saved) ||
        typeof saved.pending !== "boolean" ||
        !("heartbeats" in saved) ||
        typeof saved.heartbeats !== "number" ||
        !Number.isSafeInteger(saved.heartbeats) ||
        saved.heartbeats < 0
      )
        throw new Error("Invalid device registry alarm queue");
      if (saved.pending) {
        heartbeats = pending
          ? Math.min(heartbeats, saved.heartbeats)
          : saved.heartbeats;
        pending = true;
      }
    } catch (error) {
      await rename(path, `${path}.${randomUUID()}.corrupt`);
      options.onError?.(error);
    }
    needsLoad = false;
  };
  try {
    await load();
  } catch (error) {
    // Do not overwrite an unreadable prior queue; retry before writing.
    options.onError?.(error);
  }
  const flush = (): Promise<void> => {
    writing = writing
      .catch(() => {})
      .then(async () => {
        if (needsLoad) await load();
        if (!dirty) return;
        const snapshot = JSON.stringify({ version: 1, pending, heartbeats });
        try {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          await chmod(options.directory, 0o700);
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temp, "wx", 0o600);
            try {
              await file.writeFile(snapshot);
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temp, path);
            const directory = await open(options.directory, "r");
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          } finally {
            await unlink(temp).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            });
          }
          if (snapshot === JSON.stringify({ version: 1, pending, heartbeats }))
            dirty = false;
        } catch (error) {
          dirty = true;
          throw error;
        }
      });
    return writing;
  };
  return {
    enqueue() {
      pending = true;
      heartbeats = 0;
      dirty = true;
      return flush();
    },
    heartbeat(live) {
      const send = live || pending;
      if (pending && !live) {
        heartbeats += 1;
        if (heartbeats >= MAX_HEARTBEATS) pending = false;
        dirty = true;
      }
      return send;
    },
    flush,
  };
}
