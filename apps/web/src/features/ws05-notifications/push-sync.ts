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

/** A registration older than this is renewed before the server drops it. */
export const PUSH_RENEW_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

type SyncDevice = { id: string; registeredAt?: string };

/** The stored row is listed, but its registration is older than 7 days. */
export function isRenewalDue(
  devices: ReadonlyArray<SyncDevice>,
  storedId: string | null,
  nowMs: number,
): boolean {
  if (storedId === null) return false;
  const device = devices.find((entry) => entry.id === storedId);
  if (!device?.registeredAt) return false;
  const registeredMs = Date.parse(device.registeredAt);
  if (Number.isNaN(registeredMs)) return false;
  return nowMs - registeredMs > PUSH_RENEW_AFTER_MS;
}

/**
 * Only a browser that is already subscribed ("active") is checked; nothing
 * here asks for permission. A failed device lookup counts as not registered,
 * so the browser tries to register again. A listed device whose registration
 * is due for renewal is registered again too; if that fails it still counts as
 * "confirmed", because the server still delivers to it. Never throws.
 */
export async function syncPushRegistration(deps: {
  browserState: PushState;
  storedId: string | null;
  listDevices: () => Promise<ReadonlyArray<SyncDevice>>;
  register: () => Promise<void>;
  now?: () => number;
}): Promise<PushSyncOutcome> {
  if (deps.browserState !== "active") return "skipped";
  let renewalDue = false;
  try {
    const devices = await deps.listDevices();
    if (isRegisteredOnServer(devices, deps.storedId)) {
      renewalDue = isRenewalDue(
        devices,
        deps.storedId,
        (deps.now ?? Date.now)(),
      );
      if (!renewalDue) return "confirmed";
    }
  } catch {
    // Unknown server state: fall through and register again.
  }
  try {
    await deps.register();
    return "reregistered";
  } catch {
    return renewalDue ? "confirmed" : "failed";
  }
}
