// Tenant-bound pepper for staff device pins (bead legend-dxb; PRD v1.7 §3 F6,
// §6 B staff_pins "(T, E)"). See device-pin-hash.ts for the construction.
//
// HKDF-SHA-256 over BETTER_AUTH_SECRET with a fixed label and the tenant id,
// so one tenant's edge box can be given its own pepper (edge provisioning,
// WS-02) without being able to verify another tenant's pins. No new
// deployment variable is required; a dedicated pin secret can replace the
// input key later by bumping `pepperVersion` and re-setting pins.
//
// Rotating BETTER_AUTH_SECRET invalidates every stored pin (staff set a new
// one), which is the safe outcome for a leaked secret.

import { hkdfSync } from "node:crypto";
import { tenantIdSchema } from "@starter/shared/core";
import { env } from "../config/env";

/** Current pepper generation, stored on every staff_pins row. */
export const STAFF_PIN_PEPPER_VERSION = 1;

const SALT = "legend";
const cache = new Map<string, Buffer>();

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
        env.BETTER_AUTH_SECRET,
        SALT,
        `legend:staff-pin-pepper:v${version}:${tenant}`,
        32,
      ),
    );
    cache.set(key, pepper);
  }
  return pepper;
}
