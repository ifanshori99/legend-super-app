import type { PushState } from "./push";

// Keeps the server's push registration in step with this browser (bead
// legend-xdlxa). The browser can hold a live subscription while the server no
// longer counts it deliverable (registered_at empty or older than 30 days), so
// "active" in the UI must be confirmed by the server's own device list. Pure
// module: no React, no DOM; every effect arrives through `deps`.

export type PushSyncOutcome =
  "confirmed" | "reregistered" | "failed" | "skipped";

/** This browser's stored row id is among the server's deliverable devices. */
export function isRegisteredOnServer(
  devices: ReadonlyArray<{ id: string }>,
  storedId: string | null,
): boolean {
  if (storedId === null) return false;
  return devices.some((device) => device.id === storedId);
}

/**
 * Only a browser that is already subscribed ("active") is checked; nothing
 * here asks for permission. A failed device lookup counts as not registered,
 * so the browser tries to register again. Never throws.
 */
export async function syncPushRegistration(deps: {
  browserState: PushState;
  storedId: string | null;
  listDevices: () => Promise<ReadonlyArray<{ id: string }>>;
  register: () => Promise<void>;
}): Promise<PushSyncOutcome> {
  if (deps.browserState !== "active") return "skipped";
  try {
    const devices = await deps.listDevices();
    if (isRegisteredOnServer(devices, deps.storedId)) return "confirmed";
  } catch {
    // Unknown server state: fall through and register again.
  }
  try {
    await deps.register();
    return "reregistered";
  } catch {
    return "failed";
  }
}
