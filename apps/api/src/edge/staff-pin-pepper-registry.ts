// In-memory holder of the staff pin peppers an EDGE node may use (bead
// legend-ideif; PRD v1.7 §3 F6 "Staf — PIN Perangkat", EDG-02, TEN-02).
//
// An edge node never holds the root STAFF_PIN_PEPPER (config/env.ts refuses to
// boot with it). It holds only the peppers the cloud derived for ITS outlet
// (legend-jmsdx), one per pepper version >= 2 (version 1 is per tenant and
// never leaves the cloud), delivered over the staff pin sync
// (services/staff-pin-sync.ts) and kept sealed at rest in the edge database
// (edge/staff-pin-pepper-store.ts). Stealing an edge box therefore exposes one
// outlet's peppers, never another outlet's or tenant's.
//
// Pure state, no I/O and no logging: a pepper value must never reach a log,
// an error or an event. `services/device-pin-pepper.ts` reads from here when
// the process is an edge node.

type Held = {
  readonly tenantId: string;
  readonly outletId: string;
  readonly versions: Map<number, Buffer>;
};

const MIN_PEPPER_BYTES = 32;

/** First per-outlet pepper generation; an edge never holds version 1. */
export const EDGE_PEPPER_MIN_VERSION = 2;

let held: Held | null = null;

/** True once an edge node installed its peppers (or tests did). */
export function isEdgePepperRegistryActive(): boolean {
  return held !== null;
}

/**
 * Install (merge) peppers for the node's own outlet. A second tenant or outlet
 * id is refused: one edge box serves one outlet.
 */
export function installEdgeStaffPinPeppers(
  tenantId: string,
  outletId: string,
  peppers: ReadonlyArray<{ readonly version: number; readonly pepper: Buffer }>,
): void {
  const tenant = tenantId.toLowerCase();
  const outlet = outletId.toLowerCase();
  if (held !== null && (held.tenantId !== tenant || held.outletId !== outlet))
    throw new RangeError("Edge pepper registry belongs to another outlet");
  const next: Held = held ?? {
    tenantId: tenant,
    outletId: outlet,
    versions: new Map(),
  };
  for (const { version, pepper } of peppers) {
    if (!Number.isInteger(version) || version < EDGE_PEPPER_MIN_VERSION)
      throw new RangeError("Invalid staff pin pepper version");
    if (pepper.length < MIN_PEPPER_BYTES)
      throw new RangeError("Staff pin pepper is too short");
    next.versions.set(version, Buffer.from(pepper));
  }
  held = next;
}

/** Mark this process as an edge node before any pepper arrived (fail closed). */
export function activateEdgePepperRegistry(
  tenantId: string,
  outletId: string,
): void {
  installEdgeStaffPinPeppers(tenantId, outletId, []);
}

/** The pepper for the node's own tenant, outlet and `version`; null for anything else. */
export function edgeStaffPinPepper(
  tenantId: string,
  outletId: string,
  version: number,
): Buffer | null {
  if (
    held === null ||
    held.tenantId !== tenantId.toLowerCase() ||
    held.outletId !== outletId.toLowerCase()
  )
    return null;
  return held.versions.get(version) ?? null;
}

/** Highest version held; 0 when none (the cloud then sends all of them). */
export function edgeStaffPinPepperLatest(): number {
  if (held === null) return 0;
  let latest = 0;
  for (const version of held.versions.keys())
    latest = Math.max(latest, version);
  return latest;
}

/**
 * The versions held, ascending. This is what the edge reports to the cloud as
 * "have" (`peppers=2,3`; empty = holds none): the cloud sends the difference
 * from the versions this outlet's rows use plus the current one, so a version
 * whose sealed row failed to open is simply sent again.
 */
export function edgeStaffPinPepperVersionsHeld(): number[] {
  return held === null ? [] : [...held.versions.keys()].sort((a, b) => a - b);
}

/** Tests only. */
export function resetEdgeStaffPinPeppers(): void {
  held = null;
}
