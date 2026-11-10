// In-memory holder of the staff pin peppers an EDGE node may use (bead
// legend-ideif; PRD v1.7 §3 F6 "Staf — PIN Perangkat", EDG-02, TEN-02).
//
// An edge node never holds the root STAFF_PIN_PEPPER (config/env.ts refuses to
// boot with it). It holds only the peppers the cloud derived for ITS tenant,
// one per pepper version, delivered over the staff pin sync
// (services/staff-pin-sync.ts) and kept sealed at rest in the edge database
// (edge/staff-pin-pepper-store.ts). Stealing an edge box therefore exposes one
// tenant's peppers, never another tenant's.
//
// Pure state, no I/O and no logging: a pepper value must never reach a log,
// an error or an event. `services/device-pin-pepper.ts` reads from here when
// the process is an edge node.

type Held = {
  readonly tenantId: string;
  readonly versions: Map<number, Buffer>;
};

const MIN_PEPPER_BYTES = 32;

let held: Held | null = null;

/** True once an edge node installed its peppers (or tests did). */
export function isEdgePepperRegistryActive(): boolean {
  return held !== null;
}

/**
 * Install (merge) peppers for the node's own tenant. A second tenant id is
 * refused: one edge box serves one tenant.
 */
export function installEdgeStaffPinPeppers(
  tenantId: string,
  peppers: ReadonlyArray<{ readonly version: number; readonly pepper: Buffer }>,
): void {
  const tenant = tenantId.toLowerCase();
  if (held !== null && held.tenantId !== tenant)
    throw new RangeError("Edge pepper registry belongs to another tenant");
  const next: Held = held ?? { tenantId: tenant, versions: new Map() };
  for (const { version, pepper } of peppers) {
    if (!Number.isInteger(version) || version < 1)
      throw new RangeError("Invalid staff pin pepper version");
    if (pepper.length < MIN_PEPPER_BYTES)
      throw new RangeError("Staff pin pepper is too short");
    next.versions.set(version, Buffer.from(pepper));
  }
  held = next;
}

/** Mark this process as an edge node before any pepper arrived (fail closed). */
export function activateEdgePepperRegistry(tenantId: string): void {
  installEdgeStaffPinPeppers(tenantId, []);
}

/** The pepper for the node's own tenant and `version`; null for anything else. */
export function edgeStaffPinPepper(
  tenantId: string,
  version: number,
): Buffer | null {
  if (held === null || held.tenantId !== tenantId.toLowerCase()) return null;
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
 * Highest N such that versions 1..N are ALL held (0 = none). This is what the
 * edge reports to the cloud as "have": reporting the plain maximum would hide a
 * lower version whose sealed row failed to open, and it would never be sent
 * again.
 */
export function edgeStaffPinPepperContiguous(): number {
  if (held === null) return 0;
  let n = 0;
  while (held.versions.has(n + 1)) n += 1;
  return n;
}

export function edgeStaffPinPepperVersions(): readonly number[] {
  return held === null ? [] : [...held.versions.keys()].sort((a, b) => a - b);
}

/** Tests only. */
export function resetEdgeStaffPinPeppers(): void {
  held = null;
}
