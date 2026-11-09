import { statSync, utimesSync, writeFileSync } from "node:fs";

// legend-z649: liveness signal for the single-VM compose healthcheck. The
// relay touches this file after every tenant step and every finished sweep, so
// a stuck relay or a dead scheduler stops touching it and the file goes stale.
export const WORKER_HEARTBEAT_FILE = "/tmp/worker-heartbeat";
// The relay sweep is scheduled every minute: allow a few missed ticks.
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS = 180;

/** Best effort: a failing heartbeat must never break the relay. */
export function touchHeartbeat(file: string = WORKER_HEARTBEAT_FILE) {
  try {
    const now = new Date();
    try {
      utimesSync(file, now, now);
    } catch {
      writeFileSync(file, "");
    }
  } catch {
    // Unwritable path: the healthcheck turns unhealthy, which is the signal.
  }
}

export function heartbeatIsFresh(
  file: string = WORKER_HEARTBEAT_FILE,
  now: number = Date.now(),
  maxAgeSeconds: number = WORKER_HEARTBEAT_MAX_AGE_SECONDS,
) {
  try {
    return now - statSync(file).mtimeMs <= maxAgeSeconds * 1000;
  } catch {
    return false;
  }
}
