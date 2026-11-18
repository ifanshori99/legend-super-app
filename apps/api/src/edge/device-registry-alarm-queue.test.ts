import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDeviceRegistryAlarmQueue } from "./device-registry-alarm-queue.ts";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legend-device-alarm-"));
  directories.push(root);
  return { directory: join(root, "alarms"), edgeNodeId: "edge-uvnll" };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("legend-uvnll durable registry alarm", () => {
  it("replays an offline episode after recovery and restart", async () => {
    const options = await fixture();
    const first = await openDeviceRegistryAlarmQueue(options);
    expect(first.heartbeat(false)).toBe(false);
    await first.enqueue();
    expect(first.heartbeat(false)).toBe(true);
    const restarted = await openDeviceRegistryAlarmQueue(options);
    expect(restarted.heartbeat(false)).toBe(true);
    expect(restarted.heartbeat(false)).toBe(true);
  });

  it("keeps pending alarms isolated by node", async () => {
    const options = await fixture();
    const first = await openDeviceRegistryAlarmQueue(options);
    await first.enqueue();
    const other = await openDeviceRegistryAlarmQueue({ ...options, edgeNodeId: "other" });
    expect(other.heartbeat(false)).toBe(false);
    expect(first.heartbeat(false)).toBe(true);
  });
});
