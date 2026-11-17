// Roll-forward of `facilities.operating_hours` (bead legend-4us1a, card 987).
//
// `facilities.operating_hours` is the hours valid today. A version dated in
// the future must not touch it yet; once its date arrives, the sweep
// (`rollForwardOperatingHours`, run by the worker and before the admin reads
// the config) copies the latest version with `effective_from` <= today onto
// the column. Rerunning changes nothing, and another tenant is never touched.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { rollForwardOperatingHours } from "../services/facility-hours-versions.service.ts";
import {
  resetFacilityHoursRollJobThrottle,
  runFacilityHoursRollJob,
} from "../worker/facility-hours-roll.job.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const hoursOf = (opensAt: string, closesAt: string) => [
  { daysOfWeek: ALL_DAYS, opensAt, closesAt },
];
const OLD = hoursOf("08:00", "20:00");
const NEW = hoursOf("10:00", "16:00");
const FOREIGN = hoursOf("01:00", "02:00");

function context(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type World = { tenantId: string; outletId: string; facilityId: string };

/** A facility whose column holds `columnHours`, with one version per entry. */
async function makeWorld(
  label: string,
  columnHours: unknown,
  versions: ReadonlyArray<readonly [string, unknown]>,
): Promise<World> {
  const tenant = await createIsolatedTenant(
    `fhr-${label}-${randomUUID().slice(0, 6)}`,
  );
  const facilityId = randomUUID();
  await asOwner(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.tenantId,
        tenant.outletId,
        JSON.stringify(columnHours),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    for (const [effectiveFrom, hours] of versions)
      await client.query(
        `INSERT INTO facility_operating_hours_versions
           (tenant_id, outlet_id, facility_id, effective_from, operating_hours)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenant.tenantId,
          tenant.outletId,
          facilityId,
          effectiveFrom,
          JSON.stringify(hours),
        ],
      );
  });
  return { tenantId: tenant.tenantId, outletId: tenant.outletId, facilityId };
}

async function columnHours(w: World): Promise<unknown> {
  const { rows } = await owner.query<{ operating_hours: unknown }>(
    "SELECT operating_hours FROM facilities WHERE tenant_id = $1 AND id = $2",
    [w.tenantId, w.facilityId],
  );
  return rows[0]!.operating_hours;
}

/** Rolls one outlet as `w`'s tenant; returns the number of facilities changed. */
function roll(w: World, today: string, asOutletId = w.outletId) {
  return withTenant(db, context(w.tenantId), (tx) =>
    rollForwardOperatingHours(tx, {
      tenantId: tenantIdSchema.parse(w.tenantId),
      outletId: outletIdSchema.parse(asOutletId),
      today: businessDateSchema.parse(today),
    }),
  );
}

let pending: World;
let other: World;

beforeAll(async () => {
  // Column = OLD. Version 1970 = OLD, version 2031-03-01 = NEW (future).
  pending = await makeWorld("a", OLD, [
    ["1970-01-01", OLD],
    ["2031-03-01", NEW],
  ]);
  // Another tenant: its column is stale on purpose (a past version differs).
  other = await makeWorld("b", OLD, [
    ["1970-01-01", OLD],
    ["2025-01-01", FOREIGN],
  ]);
});

afterAll(async () => {
  await owner.end();
});

describe("legend-4us1a roll forward operating hours", () => {
  it("keeps the column while the newest version is still in the future", async () => {
    expect(await roll(pending, "2031-02-28")).toBe(0);
    expect(await columnHours(pending)).toEqual(OLD);
  });

  it("rolls the column once the version date arrives, and a rerun changes nothing", async () => {
    expect(await roll(pending, "2031-03-01")).toBe(1);
    expect(await columnHours(pending)).toEqual(NEW);
    expect(await roll(pending, "2031-03-01")).toBe(0);
    expect(await roll(pending, "2031-04-15")).toBe(0);
    expect(await columnHours(pending)).toEqual(NEW);
  });

  it("never touches another tenant, even when asked with its outlet id", async () => {
    // Tenant `pending` asks to roll the outlet of `other`: nothing to see.
    expect(await roll(pending, "2031-04-15", other.outletId)).toBe(0);
    expect(await columnHours(other)).toEqual(OLD);
    // Rolling `pending`'s own outlet leaves `other` stale as well.
    await roll(pending, "2031-04-15");
    expect(await columnHours(other)).toEqual(OLD);
  });

  it("the worker job rolls the outlet of its own tenant only", async () => {
    resetFacilityHoursRollJobThrottle();
    const result = await runFacilityHoursRollJob(
      context(other.tenantId),
      new Date("2031-04-15T05:00:00Z"),
      { force: true },
    );
    expect(result).toMatchObject({ failedOutlets: 0, rolled: 1 });
    expect(await columnHours(other)).toEqual(FOREIGN);
    // The first tenant's column is not part of this run.
    expect(await columnHours(pending)).toEqual(NEW);
  });
});
