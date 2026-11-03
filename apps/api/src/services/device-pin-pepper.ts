// Tenant-bound pepper for staff device pins (bead legend-dxb; PRD v1.7 §3 F6,
// §6 B staff_pins "(T, E)"). See device-pin-hash.ts for the construction.
//
// HKDF-SHA-256 over its own deployment secret STAFF_PIN_PEPPER with a fixed
// label and the tenant id, so one tenant's edge box can be given its own
// pepper (edge provisioning, WS-02) without being able to verify another
// tenant's pins.
//
// The pepper deliberately does NOT derive from BETTER_AUTH_SECRET: rotating the
// auth secret must never invalidate stored pins. Rotation of the pepper itself
// is an explicit, documented operation (docs/deployment.md "Staff device
// pins"): replace STAFF_PIN_PEPPER, then every staff member sets a new pin —
// rows hashed with the previous pepper no longer verify (services/
// device-pin.service.ts refuses an unknown `pepper_version` and a mismatched
// hash fails closed).
//
// config/env.ts requires STAFF_PIN_PEPPER in production. Development and tests
// use a fixed, non-secret fallback so a fresh checkout works without setup;
// that fallback is never used when NODE_ENV=production.

import { hkdfSync } from "node:crypto";
import { tenantIdSchema } from "@starter/shared/core";
import { env } from "../config/env";

/** Current pepper generation, stored on every staff_pins row. */
export const STAFF_PIN_PEPPER_VERSION = 1;

/**
 * Development/test-only root secret. Not a credential: production refuses to
 * start without STAFF_PIN_PEPPER (config/env.ts), and this constant is checked
 * again below so a misconfigured production process cannot silently use it.
 */
const DEV_PEPPER = "legend-dev-only-staff-pin-pepper-not-a-secret";

const SALT = "legend";
const cache = new Map<string, Buffer>();

function rootSecret(): string {
  if (env.STAFF_PIN_PEPPER !== undefined) return env.STAFF_PIN_PEPPER;
  if (env.isProduction)
    throw new Error("STAFF_PIN_PEPPER is required in production.");
  return DEV_PEPPER;
}

/**
 * The pepper for one tenant. Server-only: never put it in a response, log or
 * event. The edge receives it once, over its provisioning channel.
 */
export function staffPinPepper(
  tenantId: string,
  version: number = STAFF_PIN_PEPPER_VERSION,
): Buffer {
  if (version !== STAFF_PIN_PEPPER_VERSION)
    throw new RangeError("Unknown staff pin pepper version");
  const tenant = tenantIdSchema.parse(tenantId);
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
