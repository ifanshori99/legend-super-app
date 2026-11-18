// One definition of "edge reachable" for the cloud (beads legend-eo3lc;
// docs/design/edge-status-cloud.md section 3.3). Shared by QR order
// forwarding and the back-office edge node status list.

/** Link is up when the node's last heartbeat is at most this old. */
const DEFAULT_EDGE_LINK_STALE_SECONDS = 45;

/** Seconds a heartbeat stays fresh (`EDGE_LINK_STALE_SECONDS`, default 45). */
export function staleSeconds(): number {
  const parsed = Number(process.env.EDGE_LINK_STALE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EDGE_LINK_STALE_SECONDS;
}

/** True when the heartbeat exists and is at most `staleSeconds()` old. */
export function isHeartbeatFresh(
  lastHeartbeatAt: Date | null,
  now: Date,
): boolean {
  return (
    lastHeartbeatAt !== null &&
    lastHeartbeatAt.getTime() >= now.getTime() - staleSeconds() * 1000
  );
}
