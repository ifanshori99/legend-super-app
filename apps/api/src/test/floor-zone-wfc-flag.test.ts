// Zone WFC flag admin path (legend-p4q10, bead 987 card 3).
//
// Contract under test (brief-987b B2, no implementation read):
//   - floor_zones.is_wfc already exists (migration 0570, default false).
//   - Zone response DTO carries a required boolean `isWfc`.
//   - POST /api/floor/zones accepts optional `isWfc` (omitted => false).
//   - PATCH /api/floor/zones/:zoneId accepts optional `isWfc`, other fields
//     keep their value when only `isWfc` is sent.
//   - Same permission as every zone edit: floor.table.manage.
//   - Non-boolean `isWfc` => 422. Zone of another tenant or outlet => 404.
//   - The stored value is read back by GET /api/floor and
//     GET /api/outlets/:outletId/floor.
//
// Assumption: the owner's current outlet is the first seeded outlet (as in
// floor-api.test.ts), so a zone in the second seeded outlet is "another
// outlet" for the PATCH route and answers 404.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { idr, tenantIdSchema } from "@starter/shared/core";
import { createFloorZone } from "../services/floor.service";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers";

let app: Express;
let staff: Awaited<ReturnType<typeof staffWithRole>>;
const zoneIds: string[] = [];
let isolated: IsolatedTenant | undefined;

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function storedIsWfc(zoneId: string): Promise<boolean | undefined> {
  const { rows } = await owner.query<{ is_wfc: boolean }>(
    "SELECT is_wfc FROM floor_zones WHERE id = $1",
    [zoneId],
  );
  return rows[0]?.is_wfc;
}

type ZoneRow = { id: string; isWfc: boolean; name: string };

async function zoneOnBoard(
  client: ReturnType<typeof agent>,
  path: string,
  zoneId: string,
  headers: Record<string, string> = {},
): Promise<ZoneRow | undefined> {
  const board = await client.get(path).set(headers);
  expect(board.status).toBe(200);
  return (board.body.data.zones as ZoneRow[]).find((row) => row.id === zoneId);
}

function patchZone(
  client: ReturnType<typeof agent>,
  zoneId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return client
    .patch(`/api/floor/zones/${zoneId}`)
    .set(originHeader)
    .set(headers)
    .send(body);
}

beforeAll(async () => {
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Zone WFC Owner",
  });
});

afterAll(async () => {
  await dropFloorRows({ tenantId: seededTenantId, zoneIds });
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("P4Q10 zone WFC flag (legend-p4q10)", () => {
  it("P4Q10-01 a zone created without isWfc is not a WFC zone", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);

    expect(zone.isWfc).toBe(false);
    expect(await storedIsWfc(zone.id)).toBe(false);

    const row = await zoneOnBoard(staff.client, "/api/floor", zone.id);
    expect(row?.isWfc).toBe(false);
  });

  it("P4Q10-02 create with isWfc true persists and is read back on both floor boards", async () => {
    const zone = await createZone(staff.client, { isWfc: true });
    zoneIds.push(zone.id);

    expect(zone.isWfc).toBe(true);
    expect(await storedIsWfc(zone.id)).toBe(true);

    const current = await zoneOnBoard(staff.client, "/api/floor", zone.id);
    expect(current?.isWfc).toBe(true);
    const outletBoard = await zoneOnBoard(
      staff.client,
      `/api/outlets/${seededOutletA}/floor`,
      zone.id,
    );
    expect(outletBoard?.isWfc).toBe(true);
  });

  it("P4Q10-03 create with explicit isWfc false stays false", async () => {
    const zone = await createZone(staff.client, { isWfc: false });
    zoneIds.push(zone.id);
    expect(zone.isWfc).toBe(false);
    expect(await storedIsWfc(zone.id)).toBe(false);
  });

  it("P4Q10-04 every zone on the board has a boolean isWfc", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const board = await staff.client.get("/api/floor");
    expect(board.status).toBe(200);
    const zones = board.body.data.zones as { isWfc: unknown }[];
    expect(zones.length).toBeGreaterThan(0);
    for (const row of zones) expect(typeof row.isWfc).toBe("boolean");
  });

  it("P4Q10-05 PATCH toggles isWfc on and off and the board shows it", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);

    const on = await patchZone(staff.client, zone.id, { isWfc: true });
    expect(on.status).toBe(200);
    expect(on.body.data.isWfc).toBe(true);
    expect(await storedIsWfc(zone.id)).toBe(true);
    expect(
      (await zoneOnBoard(staff.client, "/api/floor", zone.id))?.isWfc,
    ).toBe(true);

    const off = await patchZone(staff.client, zone.id, { isWfc: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isWfc).toBe(false);
    expect(await storedIsWfc(zone.id)).toBe(false);
    expect(
      (await zoneOnBoard(staff.client, "/api/floor", zone.id))?.isWfc,
    ).toBe(false);
  });

  it("P4Q10-06 PATCH of another field keeps the WFC flag, and the flag PATCH keeps other fields", async () => {
    const zone = await createZone(staff.client, {
      isWfc: true,
      minimumSpendIdr: 25000,
    });
    zoneIds.push(zone.id);

    const renamed = await patchZone(staff.client, zone.id, {
      name: `Zona WFC ${randomUUID().slice(0, 6)}`,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.isWfc).toBe(true);
    expect(await storedIsWfc(zone.id)).toBe(true);

    const flagOnly = await patchZone(staff.client, zone.id, { isWfc: false });
    expect(flagOnly.status).toBe(200);
    expect(flagOnly.body.data.name).toBe(renamed.body.data.name);
    expect(flagOnly.body.data.minimumSpendIdr).toBe(25000);
    expect(flagOnly.body.data.paymentMode).toBe("pay_first");
  });

  it("P4Q10-07 a non-boolean isWfc is rejected with 422 and changes nothing", async () => {
    const zone = await createZone(staff.client, { isWfc: true });
    zoneIds.push(zone.id);

    for (const bad of ["true", "yes", 1, 0, null, {}, []]) {
      const patched = await patchZone(staff.client, zone.id, { isWfc: bad });
      expect(patched.status, `PATCH isWfc=${JSON.stringify(bad)}`).toBe(422);
    }
    expect(await storedIsWfc(zone.id)).toBe(true);

    const created = await staff.client
      .post("/api/floor/zones")
      .set(originHeader)
      .send({
        name: `Zona Salah ${randomUUID().slice(0, 6)}`,
        paymentMode: "pay_first",
        serviceChargeBp: 0,
        minimumSpendIdr: 0,
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        isWfc: "true",
      });
    expect(created.status).toBe(422);
  });

  it("P4Q10-08 an account without floor.table.manage cannot change the flag (403)", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);

    const waiter = await staffWithRole(app, {
      template: "waiter",
      label: "Zone WFC Waiter",
    });
    const patched = await patchZone(waiter.client, zone.id, { isWfc: true });
    expect(patched.status).toBe(403);
    expect(await storedIsWfc(zone.id)).toBe(false);

    const created = await waiter.client
      .post("/api/floor/zones")
      .set(originHeader)
      .send({
        name: `Zona Waiter ${randomUUID().slice(0, 6)}`,
        paymentMode: "pay_first",
        serviceChargeBp: 0,
        minimumSpendIdr: 0,
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        isWfc: true,
      });
    expect(created.status).toBe(403);
  });

  it("P4Q10-09 an anonymous caller cannot change the flag", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const response = await patchZone(agent(app), zone.id, { isWfc: true });
    expect(response.status).toBe(401);
    expect(await storedIsWfc(zone.id)).toBe(false);
  });

  it("P4Q10-10 a zone of another outlet answers 404 and stays unchanged", async () => {
    const otherZone = await createFloorZone(
      tenantContext(),
      seededOutletB,
      {
        name: `Zona WFC B ${randomUUID().slice(0, 6)}`,
        paymentMode: "open_bill",
        serviceChargeBp: 0,
        minimumSpendIdr: idr(0),
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        status: "active",
        sortOrder: 1,
      },
      staff.userId,
    );
    zoneIds.push(otherZone.id);

    const patched = await patchZone(staff.client, otherZone.id, {
      isWfc: true,
    });
    expect(patched.status).toBe(404);
    expect(await storedIsWfc(otherZone.id)).toBe(false);

    // An outlet-scoped manager of outlet A cannot reach it either.
    const managerA = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Zone WFC Manager A",
    });
    const denied = await patchZone(managerA.client, otherZone.id, {
      isWfc: true,
    });
    expect([403, 404]).toContain(denied.status);
    expect(await storedIsWfc(otherZone.id)).toBe(false);
  });

  it("P4Q10-11 a zone of another tenant answers 404 both ways and the flag does not leak", async () => {
    const own = await createZone(staff.client, { isWfc: true });
    zoneIds.push(own.id);

    isolated = await createIsolatedTenant(`wfc-${randomUUID().slice(0, 6)}`);
    const tenantTwo = await staffOfIsolatedTenant(app, isolated);
    const headers = { Host: isolated.hostname };
    const foreignZone = await createZone(
      tenantTwo.client,
      { isWfc: true },
      headers,
    );

    // Tenant two sees its own flag, not tenant one's zones.
    const boardTwo = await zoneOnBoard(
      tenantTwo.client,
      "/api/floor",
      foreignZone.id,
      headers,
    );
    expect(boardTwo?.isWfc).toBe(true);
    expect(
      await zoneOnBoard(tenantTwo.client, "/api/floor", own.id, headers),
    ).toBeUndefined();

    // Neither tenant can flip the other's zone.
    const intoOne = await patchZone(
      tenantTwo.client,
      own.id,
      { isWfc: false },
      headers,
    );
    expect(intoOne.status).toBe(404);
    expect(await storedIsWfc(own.id)).toBe(true);

    const intoTwo = await patchZone(staff.client, foreignZone.id, {
      isWfc: false,
    });
    expect(intoTwo.status).toBe(404);
    expect(await storedIsWfc(foreignZone.id)).toBe(true);
  });

  it("P4Q10-12 an unknown zone id answers 404", async () => {
    const response = await patchZone(staff.client, randomUUID(), {
      isWfc: true,
    });
    expect(response.status).toBe(404);
  });
});
