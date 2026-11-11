import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCatalogAlarmQueue } from "./catalog-alarm-queue.ts";
import { decodeFrame, encodeFrame, type CatalogStale } from "./protocol.ts";

const directories: string[] = [];
const alarm = (index = 0): CatalogStale[number] => ({
  stream: "price_lists",
  staleSince: new Date(Date.UTC(2026, 10, 11, 0, index)).toISOString(),
  reason: "CLOCK_ELAPSED_UNPROVEN",
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legend-catalog-alarm-"));
  directories.push(root);
  return { directory: join(root, "catalog-alarms"), edgeNodeId: "edge-526" };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("Q62 durable owner alarm queue", () => {
  it("replays the offline alarm after recovery and a process restart", async () => {
    const options = await fixture();
    const first = await openCatalogAlarmQueue(options);
    await first.enqueue([alarm()]);
    // The catalog recovers while offline: the live snapshot no longer alarms.
    expect(first.heartbeat([])).toEqual([alarm()]);
    const restarted = await openCatalogAlarmQueue(options);
    expect(restarted.heartbeat([])).toEqual([alarm()]);
    // Heartbeats have no delivery ACK: repeat until the cloud can deduplicate.
    expect(restarted.heartbeat([])).toEqual([alarm()]);
  });

  it("deduplicates the same episode without dropping a later one", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await queue.enqueue([alarm()]);
    await queue.enqueue([alarm(), alarm(1)]);
    expect(queue.heartbeat([])).toEqual([alarm(), alarm(1)]);
  });

  it("keeps each edge node's pending alarms separate", async () => {
    const options = await fixture();
    const first = await openCatalogAlarmQueue(options);
    await first.enqueue([alarm()]);
    const other = await openCatalogAlarmQueue({
      ...options,
      edgeNodeId: "other-edge",
    });
    expect(other.heartbeat([])).toEqual([]);
    expect(first.heartbeat([])).toEqual([alarm()]);
  });

  it("serializes concurrent writes so every episode survives restart", async () => {
    const options = await fixture();
    const queue = await openCatalogAlarmQueue(options);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => queue.enqueue([alarm(i)])),
    );
    const restarted = await openCatalogAlarmQueue(options);
    const replayed = [...restarted.heartbeat([]), ...restarted.heartbeat([])];
    expect(new Set(replayed.map((entry) => entry.staleSince)).size).toBe(30);
  });

  it("flush waits for a boot callback's pending write before returning", async () => {
    const options = await fixture();
    const queue = await openCatalogAlarmQueue(options);
    const pending = queue.enqueue([alarm()]);
    await queue.flush();
    expect((await openCatalogAlarmQueue(options)).heartbeat([])).toEqual([
      alarm(),
    ]);
    await pending;
  });

  it("rotates queued and live alarms fairly within the heartbeat schema limit", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await Promise.all(
      Array.from({ length: 18 }, (_, i) => queue.enqueue([alarm(i)])),
    );
    const live = Array.from({ length: 16 }, (_, i) => alarm(i + 18));
    const replayed = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const batch = queue.heartbeat(live);
      expect(batch.length).toBeLessThanOrEqual(16);
      const frame = {
        type: "heartbeat" as const,
        version: "1.0.0",
        occurredAt: "2026-11-11T04:00:00.000Z",
        catalogStale: batch,
      };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
      for (const entry of batch) replayed.add(entry.staleSince);
    }
    expect(replayed.size).toBe(34);
  });

  it("stores only validated alarm data in a private atomic snapshot", async () => {
    const options = await fixture();
    const queue = await openCatalogAlarmQueue(options);
    await queue.enqueue([alarm()]);
    const files = await readdir(options.directory);
    expect(files).toHaveLength(1);
    const file = join(options.directory, files[0]!);
    expect((await stat(options.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      entries: [alarm()],
    });
  });

  it("keeps corrupt bytes for recovery while allowing startup and new alarms", async () => {
    const options = await fixture();
    const queue = await openCatalogAlarmQueue(options);
    await queue.enqueue([alarm()]);
    const [file] = await readdir(options.directory);
    await writeFile(join(options.directory, file!), "{broken");
    const onError = vi.fn();
    const recovered = await openCatalogAlarmQueue({ ...options, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(recovered.heartbeat([])).toEqual([]);
    await recovered.enqueue([alarm(1)]);
    const quarantined = (await readdir(options.directory)).find((name) =>
      name.endsWith(".corrupt"),
    );
    expect(quarantined).toBeDefined();
    expect(await readFile(join(options.directory, quarantined!), "utf8")).toBe(
      "{broken",
    );
    expect((await openCatalogAlarmQueue(options)).heartbeat([])).toEqual([
      alarm(1),
    ]);
  });

  it("keeps alarms in memory when storage is unreadable and retries merging the saved queue on flush", async () => {
    const options = await fixture();
    await (await openCatalogAlarmQueue(options)).enqueue([alarm()]);
    const heldDirectory = `${options.directory}.held`;
    await rename(options.directory, heldDirectory);
    await writeFile(options.directory, "temporarily unavailable");
    const onError = vi.fn();
    const queue = await openCatalogAlarmQueue({ ...options, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(queue.enqueue([alarm(1)])).rejects.toThrow();
    expect(queue.heartbeat([])).toEqual([alarm(1)]);
    await rm(options.directory);
    await rename(heldDirectory, options.directory);
    // No new enqueue: the periodic flush must retry the dirty write itself.
    await queue.flush();
    expect((await openCatalogAlarmQueue(options)).heartbeat([])).toEqual([
      alarm(1),
      alarm(),
    ]);
  });

  it("does not fail startup when reporting a read failure also throws", async () => {
    const options = await fixture();
    await writeFile(options.directory, "temporarily unavailable");
    const queue = await openCatalogAlarmQueue({
      ...options,
      onError: () => {
        throw new Error("logger failed");
      },
    });
    expect(queue.heartbeat([])).toEqual([]);
  });

  it("pauses retained replay until a live freshness snapshot is available", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await queue.enqueue([alarm()]);
    expect(queue.heartbeat(null)).toEqual([]);
    expect(queue.heartbeat([])).toEqual([alarm()]);
  });
});
