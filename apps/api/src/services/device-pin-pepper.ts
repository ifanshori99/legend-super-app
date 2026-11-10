// Tenant-bound pepper for staff device pins (bead legend-dxb; PRD v1.7 §3 F6,
// §6 B staff_pins "(T, E)"). See device-pin-hash.ts for the construction.
//
// HKDF-SHA-256 over its own deployment secret STAFF_PIN_PEPPER with a fixed
// label, the pepper version and the tenant id. The root secret lives ONLY on
// the cloud. An edge node (bead legend-ideif) never holds it: config/env.ts
// refuses to boot an edge with STAFF_PIN_PEPPER set, and the edge receives the
// peppers the cloud derived for its own tenant (one per version) over the
// staff pin sync (services/staff-pin-sync.ts, edge/staff-pin-pepper-registry.ts).
// A stolen edge box can verify its own tenant's pins and nothing else.
//
// The pepper deliberately does NOT derive from BETTER_AUTH_SECRET: rotating the
// auth secret must never invalidate stored pins.
//
// Rotation (docs/deployment.md "Staff device pins"): raise
// STAFF_PIN_PEPPER_CURRENT_VERSION on the cloud. Peppers of every version from
// 1 up to the current one stay derivable, so a pin hashed under an older
// version still verifies until its owner sets a new pin (which hashes under the
// current version). Edges ask for the versions they lack on the next sync.
//
// config/env.ts requires STAFF_PIN_PEPPER in production on the cloud.
// Development and tests use a fixed, non-secret fallback so a fresh checkout
// works without setup; that fallback is never used when NODE_ENV=production
// and never on an edge node.

import { hkdfSync } from "node:crypto";
import { tenantIdSchema } from "@starter/shared/core";
import { env } from "../config/env";
import {
  edgeStaffPinPepper,
  edgeStaffPinPepperLatest,
  isEdgePepperRegistryActive,
} from "../edge/staff-pin-pepper-registry";

/** First pepper generation; the floor of the version range. */
export const STAFF_PIN_PEPPER_VERSION = 1;

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
 * The pepper for one tenant. Server-only: never put it in a response (except
 * `staffPinPeppersForEdge` to the tenant's own edge), log or event.
 * Edge: only the node's own tenant and only versions the cloud delivered.
 */
export function staffPinPepper(
  tenantId: string,
  version: number = currentStaffPinPepperVersion(),
): Buffer {
  const tenant = tenantIdSchema.parse(tenantId);
  if (isEdgePepperProcess()) {
    const delivered = edgeStaffPinPepper(tenant, version);
    if (delivered === null)
      throw new RangeError("Staff pin pepper is not available on this edge");
    return delivered;
  }
  if (!isStaffPinPepperVersionUsable(version))
    throw new RangeError("Unknown staff pin pepper version");
  return derive(tenant, version);
}

/**
 * Like `staffPinPepper`, but null when this process has no such pepper (an edge
 * before its first sync, a version it was never sent). For verification, where
 * "cannot verify" must fail closed without throwing.
 */
export function staffPinPepperOrNull(
  tenantId: string,
  version: number,
): Buffer | null {
  try {
    return staffPinPepper(tenantId, version);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function derive(tenant: string, version: number): Buffer {
  const key = `${version}:${tenant}`;
  let pepper = cache.get(key);
  if (!pepper) {
    pepper = Buffer.from(
      hkdfSync(
        "sha256",
        rootSecret(),
        SALT,
        `legend:staff-pin-pepper:v${version}:${tenant}`,
        32,
      ),
    );
    cache.set(key, pepper);
  }
  return pepper;
}

/**
 * Cloud only: the derived peppers of ONE tenant for every version above
 * `haveVersion`, for the staff pin sync response to that tenant's edge node.
 * The tenant comes from the verified edge credential, never from the caller.
 */
export function staffPinPeppersForEdge(
  tenantId: string,
  haveVersion: number,
): Array<{ version: number; pepper: string }> {
  if (isEdgePepperProcess())
    throw new Error("An edge node cannot derive staff pin peppers.");
  const tenant = tenantIdSchema.parse(tenantId);
  const out: Array<{ version: number; pepper: string }> = [];
  const current = currentStaffPinPepperVersion();
  for (
    let version = Math.max(haveVersion + 1, STAFF_PIN_PEPPER_VERSION);
    version <= current;
    version += 1
  )
    out.push({ version, pepper: derive(tenant, version).toString("base64") });
  return out;
}
