// Outlet-bound pepper for staff device pins (bead legend-dxb; PRD v1.7 §3 F6,
// §6 B staff_pins "(T, E)"; legend-jmsdx). See device-pin-hash.ts for the
// construction.
//
// HKDF-SHA-256 over its own deployment secret STAFF_PIN_PEPPER with a fixed
// label, the pepper version and the ids. Version 1 is per tenant (the old
// info string, cloud only, dev/staging data). Version 2 and up is per outlet:
// info `legend:staff-pin-pepper:v{n}:{tenant}:{outlet}` (lowercase ids), so a
// pepper stolen with one outlet's edge fits no other outlet's hashes. The root
// secret lives ONLY on the cloud. An edge node (beads legend-ideif,
// legend-jmsdx) never holds it: config/env.ts refuses to boot an edge with
// STAFF_PIN_PEPPER set, and the edge receives only the peppers the cloud
// derived for its own outlet (versions >= 2) over the staff pin sync
// (services/staff-pin-sync.ts, edge/staff-pin-pepper-registry.ts). A stolen
// edge box can verify its own outlet's pins and nothing else.
//
// The pepper deliberately does NOT derive from BETTER_AUTH_SECRET: rotating the
// auth secret must never invalidate stored pins.
//
// Rotation (docs/deployment.md "Staff device pins"): raise
// STAFF_PIN_PEPPER_CURRENT_VERSION on the cloud. Peppers of every version from
// 1 up to the current one stay derivable on the cloud, so a pin hashed under an
// older version still verifies (a cloud verify rehashes it to the current
// version). An edge asks for the versions it lacks on the next sync and gets
// the versions its outlet's rows use plus the current one.
//
// config/env.ts requires STAFF_PIN_PEPPER in production on the cloud.
// Development and tests use a fixed, non-secret fallback so a fresh checkout
// works without setup; that fallback is never used when NODE_ENV=production
// and never on an edge node.

import { hkdfSync } from "node:crypto";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { env } from "../config/env";
import {
  EDGE_PEPPER_MIN_VERSION,
  edgeStaffPinPepper,
  edgeStaffPinPepperLatest,
  isEdgePepperRegistryActive,
} from "../edge/staff-pin-pepper-registry";

/** First pepper generation; the floor of the version range (cloud only, per tenant). */
export const STAFF_PIN_PEPPER_VERSION = 1;

/** First per-outlet generation; the only ones an edge ever holds. */
export const STAFF_PIN_PEPPER_OUTLET_MIN_VERSION = EDGE_PEPPER_MIN_VERSION;

/**
 * Development/test-only root secret. Not a credential: production refuses to
 * start without STAFF_PIN_PEPPER (config/env.ts), and this constant is checked
 * again below so a misconfigured production process cannot silently use it.
 */
const DEV_PEPPER = "legend-dev-only-staff-pin-pepper-not-a-secret";

const SALT = "legend";
const cache = new Map<string, Buffer>();

/** An edge node: the static setting, or peppers were installed (boot window, tests). */
function isEdgePepperProcess(): boolean {
  return env.EDGE_MODE || isEdgePepperRegistryActive();
}

function rootSecret(): string {
  if (isEdgePepperProcess())
    throw new Error("The root staff pin pepper is never available on an edge.");
  if (env.STAFF_PIN_PEPPER !== undefined) return env.STAFF_PIN_PEPPER;
  if (env.isProduction)
    throw new Error("STAFF_PIN_PEPPER is required in production.");
  return DEV_PEPPER;
}

/**
 * The pepper generation new pins are hashed under. Cloud: the configured
 * current version. Edge: the highest version delivered so far (0 = none yet,
 * so every pin operation fails closed until the first sync).
 */
export function currentStaffPinPepperVersion(): number {
  return isEdgePepperProcess()
    ? edgeStaffPinPepperLatest()
    : env.STAFF_PIN_PEPPER_CURRENT_VERSION;
}

/** True when a pin hashed under `version` can be verified by this process. */
export function isStaffPinPepperVersionUsable(version: number): boolean {
  if (!Number.isInteger(version) || version < STAFF_PIN_PEPPER_VERSION)
    return false;
  return version <= currentStaffPinPepperVersion();
}

/**
 * The pepper for one outlet (version >= 2) or, for version 1, its tenant.
 * Server-only: never put it in a response (except `staffPinPeppersForEdge` to
 * the outlet's own edge), log or event.
 * Edge: only the node's own outlet and only versions the cloud delivered
 * (never version 1).
 */
export function staffPinPepper(
  tenantId: string,
  outletId: string,
  version: number = currentStaffPinPepperVersion(),
): Buffer {
  const tenant = tenantIdSchema.parse(tenantId);
  const outlet = outletIdSchema.parse(outletId);
  if (isEdgePepperProcess()) {
    const delivered = edgeStaffPinPepper(tenant, outlet, version);
    if (delivered === null)
      throw new RangeError("Staff pin pepper is not available on this edge");
    return delivered;
  }
  if (!isStaffPinPepperVersionUsable(version))
    throw new RangeError("Unknown staff pin pepper version");
  return derive(tenant, outlet, version);
}

/**
 * Cloud only: the pepper for payslip PINs (hris-pii-pin). A payslip PIN belongs
 * to an employee, not to an outlet, so it is derived per tenant, under its own
 * HKDF label (never the staff-pin label), from the same root secret and the same
 * version range as the staff pins. Merge batch48c: the payslip PIN service was
 * written against the old tenant-level `staffPinPepper(tenant, version)`.
 * Payroll never runs on an edge, so an edge process refuses.
 */
export function payslipPinPepper(
  tenantId: string,
  version: number = currentStaffPinPepperVersion(),
): Buffer {
  const tenant = tenantIdSchema.parse(tenantId);
  if (isEdgePepperProcess())
    throw new Error("Payslip PIN peppers are not available on an edge.");
  if (!isStaffPinPepperVersionUsable(version))
    throw new RangeError("Unknown staff pin pepper version");
  const key = `payslip:${version}:${tenant}`;
  let pepper = cache.get(key);
  if (!pepper) {
    pepper = Buffer.from(
      hkdfSync(
        "sha256",
        rootSecret(),
        SALT,
        `legend:payslip-pin-pepper:v${version}:${tenant}`,
        32,
      ),
    );
    cache.set(key, pepper);
  }
  return pepper;
}

/**
 * Like `staffPinPepper`, but null when this process has no such pepper (an edge
 * before its first sync, a version it was never sent, another outlet, version
 * 1). For verification, where "cannot verify" must fail closed without throwing.
 */
export function staffPinPepperOrNull(
  tenantId: string,
  outletId: string,
  version: number,
): Buffer | null {
  try {
    return staffPinPepper(tenantId, outletId, version);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function derive(tenant: string, outlet: string, version: number): Buffer {
  const perOutlet = version >= STAFF_PIN_PEPPER_OUTLET_MIN_VERSION;
  const key = perOutlet
    ? `${version}:${tenant}:${outlet}`
    : `${version}:${tenant}`;
  let pepper = cache.get(key);
  if (!pepper) {
    pepper = Buffer.from(
      hkdfSync(
        "sha256",
        rootSecret(),
        SALT,
        perOutlet
          ? `legend:staff-pin-pepper:v${version}:${tenant}:${outlet}`
          : `legend:staff-pin-pepper:v${version}:${tenant}`,
        32,
      ),
    );
    cache.set(key, pepper);
  }
  return pepper;
}

/**
 * Cloud only: the derived peppers of ONE outlet the edge node of that outlet
 * lacks, for the staff pin sync response. Versions to send =
 * ({`usedVersions` >= 2} ∪ {current}) \ `have` \ {1}, ascending, never above
 * the current version (the cloud could not verify such a row anyway).
 * Tenant and outlet come from the verified edge credential, never from the
 * caller's query.
 */
export function staffPinPeppersForEdge(
  tenantId: string,
  outletId: string,
  have: readonly number[],
  usedVersions: readonly number[],
): Array<{ version: number; pepper: string }> {
  if (isEdgePepperProcess())
    throw new Error("An edge node cannot derive staff pin peppers.");
  const tenant = tenantIdSchema.parse(tenantId);
  const outlet = outletIdSchema.parse(outletId);
  const current = currentStaffPinPepperVersion();
  const wanted = new Set<number>([current, ...usedVersions]);
  const held = new Set<number>(have);
  return [...wanted]
    .filter(
      (version) =>
        Number.isInteger(version) &&
        version >= STAFF_PIN_PEPPER_OUTLET_MIN_VERSION &&
        version <= current &&
        !held.has(version),
    )
    .sort((a, b) => a - b)
    .map((version) => ({
      version,
      pepper: derive(tenant, outlet, version).toString("base64"),
    }));
}
