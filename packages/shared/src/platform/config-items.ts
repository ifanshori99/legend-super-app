// Strict item schema of the `wifi_policies` bundle section (TEN-09, bead
// legend-tct8). The other codec sections (tax_rules, service_charge_rules,
// zones, checklists, facilities, loyalty_policy) keep their schemas in their
// domain folders (`*/config-codec.ts`); wifi has no domain codec, so its
// schema lives here, not in config.ts, to let `config-section-codecs.ts` use
// it without an import cycle (config.ts -> config-codecs.ts -> codecs).
// Every item has a `key`; references to other rows are `*Key` fields (the
// importer resolves them), never ids. Field names must not match the
// identifier scan in config.ts.

import { z } from "../core/index.ts";
import { peakWindowSchema } from "../facility/schemas.ts";

const UUID_SHAPE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Business key, never a row id: UUID-shaped keys are refused (TEN-09). */
export const itemKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/)
  .refine((key) => !UUID_SHAPE.test(key), "Item keys must not look like an id");
/** Lower-cased source outlet code; resolved to a target outlet by code. */
const outletKeySchema = itemKey;
const money = z.number().int().min(0);
const minutes = z.number().int().min(0).max(1440);

export const wifiPolicyItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  zoneKey: itemKey,
  facilityKey: itemKey.nullable(),
  freeMinutes: minutes,
  peakFreeMinutes: minutes,
  spendPerExtraHourIdr: money,
  extraMinutes: z.number().int().min(1).max(1440),
  maxDevices: z.number().int().min(1).max(20),
  peakSchedule: z.array(peakWindowSchema).max(14),
  baseSpeedKbps: z.number().int().min(1).max(1_000_000),
  fullSpeedKbps: z.number().int().min(1).max(1_000_000),
  minSpendPerHourIdr: money.nullable(),
  // Same 1-30 character tier keys as the facility domain (facility/schemas.ts).
  tierBonusMinutes: z.record(
    z.string().trim().min(1).max(30),
    z.number().int().min(0).max(720),
  ),
});
