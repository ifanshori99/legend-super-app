import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  heartbeatIsFresh,
  touchHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_SECONDS,
} from "../worker/heartbeat";
import { createRelayRuntime } from "../worker/relay";

// legend-z649: a hung worker (relay loop stuck) must stop touching the
// heartbeat file so the compose healthcheck turns unhealthy.
const dirs: string[] = [];
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "worker-heartbeat-"));
  dirs.push(dir);
  return join(dir, "alive");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

it("legend-z649: touchHeartbeat writes the file and heartbeatIsFresh reads its age", () => {
  const file = tempFile();
  const now = Date.now();
  expect(heartbeatIsFresh(file, now)).toBe(false);
  touchHeartbeat(file);
  expect(statSync(file).mtimeMs).toBeGreaterThan(now - 5_000);
  expect(heartbeatIsFresh(file, Date.now())).toBe(true);
  const stale = new Date(
    Date.now() - (WORKER_HEARTBEAT_MAX_AGE_SECONDS + 30) * 1000,
  );
  utimesSync(file, stale, stale);
  expect(heartbeatIsFresh(file, Date.now())).toBe(false);
});

it("legend-z649: touchHeartbeat never throws when the path is unwritable", () => {
  expect(() => touchHeartbeat("/nonexistent-dir/alive")).not.toThrow();
});

it("legend-z649: the relay reports progress after each tenant and each finished sweep, not while stuck", async () => {
  let scheduled: (() => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  const onProgress = vi.fn();
  const service = createRelayRuntime({
    scheduler: {
      start: async () => {},
      stop: async () => {},
      schedule: async (fn) => {
        scheduled = fn;
      },
    },
    listener: { start: async () => {}, stop: async () => {} },
    listActiveTenantIds: async () => ["a", "b"],
    resolveContext: async (id: string) => id,
    relay: async (id: string) => {
      if (id === "b" && release === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    onProgress,
  });
  const starting = service.start();
  await vi.waitFor(() => expect(release).toBeDefined());
  // Tenant a finished, tenant b is stuck: progress so far only for a.
  const stuckCalls = onProgress.mock.calls.length;
  expect(stuckCalls).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onProgress.mock.calls.length).toBe(stuckCalls);
  release!();
  await starting;
  expect(onProgress.mock.calls.length).toBeGreaterThan(stuckCalls);
  await scheduled!();
  await service.stop();
});
