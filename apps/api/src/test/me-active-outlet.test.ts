// Staff outlet selection for outlet-less routes (legend-6vgv; PRD v1.7 §3.7
// RBAC, TEN-02/TEN-03). /api/floor, /api/floor/zones, /api/floor/tables and
// /api/floor/layout carry no outlet id, so the caller pins one outlet and the
// server uses it, after checking it is inside the caller's role scope.
//
// Written from the shared validators and the bead, not from the route code.
// ASSUMPTIONS (the bead leaves the mechanism open; change `pinOutlet` and the
// two `activeOutletId` reads in one place if the contract differs):
//  - GET /api/me/access gains `activeOutletId` (outlet id or null).
//  - The caller pins with `PUT /api/me/active-outlet` body `{ outletId }`,
//    answered 200 `{ data: { activeOutletId } }`. The pin is kept on the
//    server session, never a tenant id from the client (TEN-02).
//  - An outlet the caller cannot reach (outside role scope, another tenant, or
//    unknown) is refused with 403 or 404, and another tenant's outlet is
//    indistinguishable from a nonexistent one and leaks no outlet data.
//  - A caller with exactly one reachable outlet has it as the active outlet
//    without pinning. With several and no pin the active outlet is null or one
//    of the assigned outlets (only that invariant is asserted).
//  - Malformed outlet id in the pin request: 400 or 422.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";
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
  type Staff,
} from "./floor-test-helpers";

let app: Express;
let tenantWide: Staff;
let outletScoped: Staff;
let otherTenantStaff: Staff;
let isolated: IsolatedTenant;
const zoneIds: string[] = [];

type Client = Staff["client"];

const pinOutlet = (client: Client, outletId: unknown) =>
  client.put("/api/me/active-outlet").set(originHeader).send({ outletId });

const accessOf = async (client: Client) => {
  const res = await client.get("/api/me/access");
  expect(res.status).toBe(200);
  return res.body.data as {
    outlets: { id: string; name: string }[];
    activeOutletId: string | null;
  };
};

const boardOf = async (client: Client) => {
  const res = await client.get("/api/floor");
  expect(res.status).toBe(200);
  return res.body.data as {
    outletId: string;
    zones: { id: string }[];
  };
};

beforeAll(async () => {
  app = createApp();
  tenantWide = await staffWithRole(app, {
    template: "owner",
    label: "Pemilik Dua Outlet",
  });
  outletScoped = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Manajer Satu Outlet",
  });
  isolated = await createIsolatedTenant(`pin-${randomUUID().slice(0, 8)}`);
  otherTenantStaff = await staffOfIsolatedTenant(app, isolated);
});

afterAll(async () => {
  await dropFloorRows({ tenantId: seededTenantId, zoneIds });
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("legend-6vgv GET /api/me/access outlets and active outlet", () => {
  it("lists every outlet a tenant-wide role reaches with a valid active outlet", async () => {
    const access = await accessOf(tenantWide.client);
    const ids = access.outlets.map((row) => row.id);
    expect(ids).toContain(seededOutletA);
    expect(ids).toContain(seededOutletB);
    // Another tenant's outlet never appears.
    expect(ids).not.toContain(isolated.outletId);
    expect(
      access.activeOutletId === null || ids.includes(access.activeOutletId),
    ).toBe(true);
  });

  it("lists only the assigned outlet for an outlet-scoped role and makes it active", async () => {
    const access = await accessOf(outletScoped.client);
    expect(access.outlets.map((row) => row.id)).toEqual([seededOutletA]);
    expect(access.activeOutletId).toBe(seededOutletA);
  });

  it("returns no outlet and no active outlet for an account without assignment", async () => {
    const plain = agent(app);
    await signUp(plain, "Tanpa Peran");
    const access = await accessOf(plain);
    expect(access.outlets).toEqual([]);
    expect(access.activeOutletId).toBeNull();
  });

  it("requires a signed-in session to read or change the active outlet", async () => {
    expect((await agent(app).get("/api/me/access")).status).toBe(401);
    const pin = await pinOutlet(agent(app), seededOutletA);
    expect([401, 403]).toContain(pin.status);
  });
});

describe("legend-6vgv pinning the outlet for floor routes", () => {
  it("pins an assigned outlet and the access view reports it", async () => {
    const pinned = await pinOutlet(tenantWide.client, seededOutletB);
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.activeOutletId).toBe(seededOutletB);
    expect((await accessOf(tenantWide.client)).activeOutletId).toBe(
      seededOutletB,
    );
  });

  it("reads the floor board and writes zones in the pinned outlet only", async () => {
    // Pinned to B: the board is B's, and a created zone lands in B.
    expect((await pinOutlet(tenantWide.client, seededOutletB)).status).toBe(
      200,
    );
    expect((await boardOf(tenantWide.client)).outletId).toBe(seededOutletB);
    const zoneInB = await createZone(tenantWide.client);
    zoneIds.push(zoneInB.id);
    expect(zoneInB.outletId).toBe(seededOutletB);
    expect(
      (await boardOf(tenantWide.client)).zones.map((row) => row.id),
    ).toContain(zoneInB.id);

    // Re-pinned to A: the board is A's and B's zone is not visible.
    expect((await pinOutlet(tenantWide.client, seededOutletA)).status).toBe(
      200,
    );
    const boardA = await boardOf(tenantWide.client);
    expect(boardA.outletId).toBe(seededOutletA);
    expect(boardA.zones.map((row) => row.id)).not.toContain(zoneInB.id);
    const zoneInA = await createZone(tenantWide.client);
    zoneIds.push(zoneInA.id);
    expect(zoneInA.outletId).toBe(seededOutletA);

    // Back to B: A's new zone stays out of B's board.
    expect((await pinOutlet(tenantWide.client, seededOutletB)).status).toBe(
      200,
    );
    expect(
      (await boardOf(tenantWide.client)).zones.map((row) => row.id),
    ).not.toContain(zoneInA.id);
  });

  it("keeps one account's pin from changing another account's board", async () => {
    expect((await pinOutlet(tenantWide.client, seededOutletB)).status).toBe(
      200,
    );
    expect((await boardOf(outletScoped.client)).outletId).toBe(seededOutletA);
  });

  it("rejects a malformed outlet id", async () => {
    for (const bad of ["bukan-uuid", "", 42, null]) {
      const res = await pinOutlet(tenantWide.client, bad);
      expect([400, 422]).toContain(res.status);
    }
  });
});

describe("legend-6vgv outlet outside the caller's scope (TEN-03)", () => {
  it("refuses to pin an outlet outside the role scope and keeps the current one", async () => {
    const before = await accessOf(outletScoped.client);
    const res = await pinOutlet(outletScoped.client, seededOutletB);
    expect([403, 404]).toContain(res.status);
    const after = await accessOf(outletScoped.client);
    expect(after.activeOutletId).toBe(before.activeOutletId);
    expect((await boardOf(outletScoped.client)).outletId).toBe(seededOutletA);
  });

  it("never lets an outlet-scoped caller write into another outlet by pinning", async () => {
    await pinOutlet(outletScoped.client, seededOutletB);
    const res = await outletScoped.client
      .post("/api/floor/zones")
      .set(originHeader)
      .send({
        name: `Zona Tembus ${randomUUID().slice(0, 8)}`,
        paymentMode: "pay_first",
        serviceChargeBp: 0,
        minimumSpendIdr: 0,
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
      });
    if (res.status === 201) {
      zoneIds.push(res.body.data.id);
      // If the role may create zones at all, it can only be in its own outlet.
      expect(res.body.data.outletId).toBe(seededOutletA);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });
});

describe("legend-6vgv other tenant's outlet is not leaked (TEN-01/TEN-02)", () => {
  it("answers a foreign outlet id exactly like an unknown one", async () => {
    const foreign = await pinOutlet(tenantWide.client, isolated.outletId);
    const unknown = await pinOutlet(tenantWide.client, randomUUID());
    expect([403, 404]).toContain(foreign.status);
    expect(foreign.status).toBe(unknown.status);
    expect(foreign.body.error?.code).toBe(unknown.body.error?.code);
    // No name or code of the other tenant's outlet in the answer.
    const text = JSON.stringify(foreign.body);
    expect(text).not.toContain(`Outlet ${isolated.hostname}`);
    expect(text).not.toContain("Jl. Uji 1");
    // The failed pin changes nothing.
    expect((await accessOf(tenantWide.client)).activeOutletId).not.toBe(
      isolated.outletId,
    );
    expect((await boardOf(tenantWide.client)).outletId).not.toBe(
      isolated.outletId,
    );
  });

  it("does not let the other tenant's staff pin this tenant's outlet", async () => {
    const res = await pinOutlet(otherTenantStaff.client, seededOutletA);
    expect([403, 404]).toContain(res.status);
    const access = await accessOf(otherTenantStaff.client);
    expect(access.outlets.map((row) => row.id)).not.toContain(seededOutletA);
    expect(access.activeOutletId).not.toBe(seededOutletA);
  });

  it("ignores a tenant or outlet id supplied in the floor request", async () => {
    const res = await outletScoped.client
      .get(`/api/floor?outletId=${seededOutletB}&tenantId=${isolated.tenantId}`)
      .set(originHeader);
    // Either the strict query contract refuses the unknown keys, or they are
    // ignored; in no case does the board switch outlet or tenant.
    if (res.status === 200) {
      expect(res.body.data.outletId).toBe(seededOutletA);
    } else {
      expect([400, 403, 404, 422]).toContain(res.status);
    }
  });
});
