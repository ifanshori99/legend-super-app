// How stale the edge's copy of the device registry is (legend-2lgu). Soft stale:
// the last pull from the cloud is late. Hard stale: past the hard limit, so the
// edge refuses new device sessions; running sessions are not cut. The edge
// decides (`hardStale`); this only turns the status into what the screen shows.
const HOUR_MS = 3_600_000;

export interface DeviceRegistryFreshness {
  readonly lastPulledAt: string | null;
  readonly stale: boolean;
  readonly hardStale?: boolean;
  readonly maxStaleSeconds?: number;
}

export type RegistryStaleView =
  | { readonly kind: "hard"; readonly hours: number }
  | { readonly kind: "soft"; readonly since: string | null };

export function registryStaleView(
  registry: DeviceRegistryFreshness | undefined,
  nowMs: number,
): RegistryStaleView | null {
  if (!registry) return null;
  if (registry.hardStale === true) {
    const pulled = registry.lastPulledAt
      ? Date.parse(registry.lastPulledAt)
      : Number.NaN;
    const hours = Number.isNaN(pulled)
      ? Math.floor((registry.maxStaleSeconds ?? 0) / 3600)
      : Math.max(0, Math.floor((nowMs - pulled) / HOUR_MS));
    return { kind: "hard", hours };
  }
  if (registry.stale) return { kind: "soft", since: registry.lastPulledAt };
  return null;
}
