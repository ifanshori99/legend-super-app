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
import {
  ALARM_MAX_HEARTBEATS,
  openCatalogAlarmQueue,
} from "./catalog-alarm-queue.ts";
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
    // 533 A4: entries also persist their expiry bookkeeping (first enqueued
    // time, heartbeat count) as extra fields next to the alarm fields.
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toMatchObject({ version: 1, entries: [alarm()] });
    expect(saved.entries).toHaveLength(1);
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

// 533 A4 (money rule: an alarm for an old clock doubt must not nag the owner
// forever, but an alarm the owner never received must never be lost).
// Expected API: `export const ALARM_MAX_HEARTBEATS` (= 5760, 24h of 15s
// heartbeats) and, in openCatalogAlarmQueue's options, `now?: () => Date` and
// `legacyDirectory?: string` (R4). Rules, derived from the review:
//  - each heartbeat(live) call with a non-null `live` counts one heartbeat for
//    every entry it returns (the cloud sends no ack: "sent on an open link");
//    heartbeat(null) (paused) counts nothing; flush() saves the counters;
//  - an entry is dropped once it was sent ALARM_MAX_HEARTBEATS times;
//  - an entry that was sent at least once is also dropped when more than 7 days
//    passed since it was first enqueued; an entry never sent is never dropped by
//    age (a clock jump or a long offline period must not delete it).
describe("533 A4 owner alarm queue expiry", () => {
  const DAY = 24 * 60 * 60_000;
  const START = new Date("2026-11-11T00:00:00.000Z");
  const at = (ms: number) => new Date(START.getTime() + ms);

  it("uses 24 hours of 15 second heartbeats as the send budget", () => {
    expect(ALARM_MAX_HEARTBEATS).toBe((24 * 60 * 60) / 15);
  });

  it("replays an entry for exactly ALARM_MAX_HEARTBEATS heartbeats, then drops it", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await queue.enqueue([alarm()]);
    for (let i = 0; i < ALARM_MAX_HEARTBEATS; i += 1)
      expect(queue.heartbeat([])).toEqual([alarm()]);
    expect(queue.heartbeat([])).toEqual([]);
    expect(queue.heartbeat([])).toEqual([]);
  });

  it("does not count paused heartbeats (live snapshot unavailable)", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await queue.enqueue([alarm()]);
    for (let i = 0; i < ALARM_MAX_HEARTBEATS + 10; i += 1)
      expect(queue.heartbeat(null)).toEqual([]);
    expect(queue.heartbeat([])).toEqual([alarm()]);
  });

  it("keeps the heartbeat count across a restart", async () => {
    const options = await fixture();
    const half = Math.floor(ALARM_MAX_HEARTBEATS / 2);
    const first = await openCatalogAlarmQueue(options);
    await first.enqueue([alarm()]);
    for (let i = 0; i < half; i += 1) first.heartbeat([]);
    await first.flush();
    const restarted = await openCatalogAlarmQueue(options);
    for (let i = half; i < ALARM_MAX_HEARTBEATS; i += 1)
      expect(restarted.heartbeat([])).toEqual([alarm()]);
    expect(restarted.heartbeat([])).toEqual([]);
    await restarted.flush();
    // The expired entry is gone for good, not just in memory.
    expect((await openCatalogAlarmQueue(options)).heartbeat([])).toEqual([]);
  });

  it("an expired entry does not hide a newer one", async () => {
    const queue = await openCatalogAlarmQueue(await fixture());
    await queue.enqueue([alarm()]);
    for (let i = 0; i < ALARM_MAX_HEARTBEATS; i += 1) queue.heartbeat([]);
    await queue.enqueue([alarm(1)]);
    expect(queue.heartbeat([])).toEqual([alarm(1)]);
  });

  it("drops an entry that was sent once when it is more than 7 days old", async () => {
    let now = START;
    const queue = await openCatalogAlarmQueue({
      ...(await fixture()),
      now: () => now,
    });
    await queue.enqueue([alarm()]);
    expect(queue.heartbeat([])).toEqual([alarm()]); // sent once on day 0
    now = at(7 * DAY - 1);
    expect(queue.heartbeat([])).toEqual([alarm()]);
    now = at(7 * DAY + 1);
    expect(queue.heartbeat([])).toEqual([]);
  });

  it("never drops an entry that was never sent by age: the first heartbeat after day 8 still sends it once", async () => {
    let now = START;
    const queue = await openCatalogAlarmQueue({
      ...(await fixture()),
      now: () => now,
    });
    await queue.enqueue([alarm()]);
    now = at(8 * DAY); // offline (no heartbeat) for 8 days
    expect(queue.heartbeat([])).toEqual([alarm()]);
    // It has now been sent, so the age rule applies from here on.
    expect(queue.heartbeat([])).toEqual([]);
  });

  it("a wall clock jump forward of more than 7 days does not delete an unsent entry, also after a restart", async () => {
    const options = await fixture();
    let now = START;
    const first = await openCatalogAlarmQueue({ ...options, now: () => now });
    await first.enqueue([alarm()]);
    await first.flush();
    now = at(30 * DAY); // the device date jumped a month ahead
    const restarted = await openCatalogAlarmQueue({
      ...options,
      now: () => now,
    });
    expect(restarted.heartbeat([])).toEqual([alarm()]);
  });

  it("applies the age rule per entry: a sent old entry goes, an unsent old entry stays", async () => {
    let now = START;
    const queue = await openCatalogAlarmQueue({
      ...(await fixture()),
      now: () => now,
    });
    await queue.enqueue([alarm()]);
    expect(queue.heartbeat([])).toEqual([alarm()]);
    await queue.enqueue([alarm(1)]); // queued on day 0 as well, offline since
    // Age both past 7 days with no heartbeat in between: only the entry that
    // was already sent may expire.
    now = at(8 * DAY);
    const batch = queue.heartbeat([]);
    expect(batch).toEqual([alarm(1)]);
  });

  it("measures the 7 days from the first enqueue across restarts and re-enqueues", async () => {
    const options = await fixture();
    let now = START;
    const first = await openCatalogAlarmQueue({ ...options, now: () => now });
    await first.enqueue([alarm()]);
    expect(first.heartbeat([])).toEqual([alarm()]); // sent at least once
    await first.flush();
    now = at(6 * DAY);
    const restarted = await openCatalogAlarmQueue({
      ...options,
      now: () => now,
    });
    await restarted.enqueue([alarm()]); // same episode again: no new lease
    expect(restarted.heartbeat([])).toEqual([alarm()]);
    now = at(7 * DAY + 1);
    expect(restarted.heartbeat([])).toEqual([]);
    await restarted.flush();
    expect(
      (await openCatalogAlarmQueue({ ...options, now: () => now })).heartbeat(
        [],
      ),
    ).toEqual([]);
  });
});

// 533 R4: alarms queued by the previous build live in the old directory (the
// selfie directory). Expected API: `legacyDirectory?: string` on
// openCatalogAlarmQueue. At load it reads `<legacyDirectory>/<same file name>`
// once, merges its entries, persists them in the new directory, then unlinks
// the legacy file. A missing legacy directory or file is fine; an unreadable
// legacy file is ignored. The legacy format is the old one: version 1 with plain
// alarm entries.
describe("533 R4 legacy owner alarms are imported once", () => {
  async function legacyFixture() {
    const options = await fixture();
    const legacyDirectory = join(
      options.directory,
      "..",
      "legacy-selfie-directory",
    );
    // Let a queue write the legacy file so its name is the real one.
    const old = await openCatalogAlarmQueue({
      directory: legacyDirectory,
      edgeNodeId: options.edgeNodeId,
    });
    await old.enqueue([alarm()]);
    const [name] = await readdir(legacyDirectory);
    // Write it in the old format: plain alarm entries, no bookkeeping.
    await writeFile(
      join(legacyDirectory, name!),
      JSON.stringify({ version: 1, entries: [alarm()] }),
    );
    return {
      ...options,
      legacyDirectory,
      legacyFile: join(legacyDirectory, name!),
    };
  }
  const staleSinceOf = (entries: { staleSince: string }[]) =>
    entries.map((entry) => entry.staleSince).sort();

  it("replays a legacy alarm, persists it in the new directory and removes the legacy file", async () => {
    const { legacyFile, ...options } = await legacyFixture();
    const queue = await openCatalogAlarmQueue(options);
    expect(queue.heartbeat([])).toEqual([alarm()]);
    await queue.flush();
    await expect(stat(legacyFile)).rejects.toMatchObject({ code: "ENOENT" });
    // Restart WITHOUT the legacy option: the alarm now lives in the new place.
    const plain = { ...options, legacyDirectory: undefined };
    expect((await openCatalogAlarmQueue(plain)).heartbeat([])).toEqual([
      alarm(),
    ]);
    // And with the legacy option again nothing comes back twice.
    expect(
      staleSinceOf((await openCatalogAlarmQueue(options)).heartbeat([])),
    ).toEqual([alarm().staleSince]);
  });

  it("merges legacy alarms with the ones already in the new directory", async () => {
    const { legacyFile, ...options } = await legacyFixture();
    void legacyFile;
    const plain = { ...options, legacyDirectory: undefined };
    await (await openCatalogAlarmQueue(plain)).enqueue([alarm(1)]);
    const queue = await openCatalogAlarmQueue(options);
    expect(staleSinceOf(queue.heartbeat([]))).toEqual(
      [alarm().staleSince, alarm(1).staleSince].sort(),
    );
  });

  it("does not import another edge node's legacy file", async () => {
    const { legacyFile, ...options } = await legacyFixture();
    const queue = await openCatalogAlarmQueue({
      ...options,
      edgeNodeId: "other-edge",
    });
    expect(queue.heartbeat([])).toEqual([]);
    expect((await stat(legacyFile)).isFile()).toBe(true);
  });

  it("starts normally when the legacy directory does not exist", async () => {
    const options = await fixture();
    const queue = await openCatalogAlarmQueue({
      ...options,
      legacyDirectory: join(options.directory, "..", "never-created"),
    });
    expect(queue.heartbeat([])).toEqual([]);
    await queue.enqueue([alarm()]);
    expect(queue.heartbeat([])).toEqual([alarm()]);
  });

  it("starts normally when the legacy directory has no file for this node", async () => {
    const options = await fixture();
    const legacyDirectory = join(options.directory, "..", "empty-legacy");
    await openCatalogAlarmQueue({
      directory: legacyDirectory,
      edgeNodeId: "someone-else",
    }).then((queue) => queue.enqueue([alarm()]));
    const queue = await openCatalogAlarmQueue({ ...options, legacyDirectory });
    expect(queue.heartbeat([])).toEqual([]);
  });

  it("ignores an unreadable legacy file and still serves new alarms", async () => {
    const { legacyFile, ...options } = await legacyFixture();
    await writeFile(legacyFile, "{broken");
    const queue = await openCatalogAlarmQueue(options);
    expect(queue.heartbeat([])).toEqual([]);
    await queue.enqueue([alarm(1)]);
    expect(queue.heartbeat([])).toEqual([alarm(1)]);
  });
});
