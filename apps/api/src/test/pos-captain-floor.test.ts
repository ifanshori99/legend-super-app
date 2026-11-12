// legend-dysef G6: captain tables reuse the canonical floor board. Session
// summaries, live calls and waiter assignments must describe the same outlet.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { agent, originHeader } from "./helpers.ts";
import {
  createTable,
  owner,
  staffOfIsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
beforeAll(async () => {
  fixture = await cashierFixture("captain-floor");
});
afterAll(async () => {
  await owner.end();
});

const base = () => `/api/outlets/${fixture.tenant.outletId}/floor`;
type FloorRow = {
  table: { id: string; zoneId: string; capacity: number; code: string };
  session: { id: string; pax: number; billTotalIdr: number } | null;
  openServiceRequestCount: number;
  outstandingIdr: number;
};

async function board(query = "") {
  const result = await fixture.get(`${base()}${query}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.data as { zones: { id: string }[]; tables: FloorRow[] };
}

async function assign(zoneId: string, userId = fixture.staff.userId) {
  await owner.query(
    `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [fixture.tenant.tenantId, fixture.tenant.outletId, zoneId, userId],
  );
}

describe("legend-dysef captain floor board", () => {
  it("G6 distinguishes vacant tables from occupied QR sessions with guest and seat counts", async () => {
    const guest = await fixture.newGuest();
    const vacant = await createTable(
      fixture.staff.client,
      { zoneId: guest.zone.id },
      fixture.headers,
    );
    const result = await board();
    const active = result.tables.find(
      (row) => row.table.id === guest.table.id,
    )!;
    expect(active).toMatchObject({
      table: { id: guest.table.id, capacity: 4, code: guest.table.code },
      session: { id: guest.sessionId, pax: 2, billTotalIdr: 0 },
      openServiceRequestCount: 0,
      outstandingIdr: 0,
    });
    expect(
      result.tables.find((row) => row.table.id === vacant.id),
    ).toMatchObject({
      table: { id: vacant.id, capacity: 4 },
      session: null,
      openServiceRequestCount: 0,
      outstandingIdr: 0,
    });
  });

  it("G6 counts pending and acknowledged calls, then clears a resolved call", async () => {
    const guest = await fixture.newGuest();
    const created = await agent(fixture.app)
      .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
      .set(fixture.headers)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const count = async () =>
      (await board()).tables.find((row) => row.table.id === guest.table.id)
        ?.openServiceRequestCount;
    expect(await count()).toBe(1);
    const acknowledged = await fixture.post(
      `/api/service-requests/${created.body.data.id}/acknowledge`,
      {},
    );
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(await count()).toBe(1);
    const resolved = await fixture.post(
      `/api/service-requests/${created.body.data.id}/resolve`,
      {},
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(await count()).toBe(0);
  });

  it("G6 shows the server bill and remaining amount for an occupied captain table", async () => {
    const guest = await fixture.newGuest();
    const created = await fixture.create({
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: guest.sessionId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await fixture.post(
      `${fixture.base}/${created.body.data.id}/submit`,
      {
        expectedStatus: created.body.data.status,
        idempotencyKey: randomUUID(),
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const gross = submitted.body.data.totalIdr as number;
    const captured = 10_000;
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_order_tenders
       (id, tenant_id, outlet_id, order_id, method, provider, amount_idr,
        received_idr, change_idr, status, requested_at, resolved_at, captured_by)
       VALUES ($1, $2, $3, $4, 'cash', 'manual', $5, $5, 0, 'captured', now(), now(), $6)`,
        [
          randomUUID(),
          fixture.tenant.tenantId,
          fixture.tenant.outletId,
          ulidToUuid(created.body.data.id),
          captured,
          fixture.staff.userId,
        ],
      ),
    );
    const result = await board();
    expect(
      result.tables.find((row) => row.table.id === guest.table.id),
    ).toMatchObject({
      session: { id: guest.sessionId, billTotalIdr: gross },
      outstandingIdr: gross - captured,
    });
  });

  it("G6 filters a manager's board by zone or their own waiter assignments", async () => {
    const assigned = await fixture.newGuest();
    const unassigned = await fixture.newGuest();
    await assign(assigned.zone.id);
    const all = await board();
    expect(all.tables.map((row) => row.table.id)).toEqual(
      expect.arrayContaining([assigned.table.id, unassigned.table.id]),
    );
    const mine = await board("?assignedToMe=true");
    expect(mine.tables.map((row) => row.table.id)).toEqual([assigned.table.id]);
    expect(mine.zones.map((zone) => zone.id)).toEqual([assigned.zone.id]);
    const byZone = await board(`?zoneId=${unassigned.zone.id}`);
    expect(byZone.tables.map((row) => row.table.id)).toEqual([
      unassigned.table.id,
    ]);
    expect(byZone.zones.map((zone) => zone.id)).toEqual([unassigned.zone.id]);
    const both = await board(`?zoneId=${unassigned.zone.id}&assignedToMe=true`);
    expect(both.tables).toEqual([]);
  });

  it("G6 an ordinary waiter cannot broaden beyond assigned zones or read another outlet", async () => {
    const assigned = await fixture.newGuest();
    const unassigned = await fixture.newGuest();
    const privateOrder = await fixture.create({
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: unassigned.sessionId,
    });
    expect(privateOrder.status, JSON.stringify(privateOrder.body)).toBe(201);
    const privateSubmitted = await fixture.post(
      `${fixture.base}/${privateOrder.body.data.id}/submit`,
      {
        expectedStatus: privateOrder.body.data.status,
        idempotencyKey: randomUUID(),
      },
    );
    expect(privateSubmitted.status, JSON.stringify(privateSubmitted.body)).toBe(
      200,
    );
    const privateCall = await agent(fixture.app)
      .post(`/api/table-sessions/${unassigned.sessionId}/service-requests`)
      .set(fixture.headers)
      .set(originHeader)
      .set("Authorization", `Bearer ${unassigned.token}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(privateCall.status, JSON.stringify(privateCall.body)).toBe(201);
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Waiter Captain Board', false, NULL, '["floor.table.view"]', false, '["tenant"]')`,
      [roleId, fixture.tenant.tenantId],
    );
    const waiter = await staffOfIsolatedTenant(fixture.app, {
      ...fixture.tenant,
      roleId,
    });
    const noAssignment = await waiter.client.get(base()).set(fixture.headers);
    expect(noAssignment.status, JSON.stringify(noAssignment.body)).toBe(200);
    expect(noAssignment.body.data.tables).toEqual([]);
    await assign(assigned.zone.id, waiter.userId);
    const scoped = await waiter.client
      .get(`${base()}?assignedToMe=false`)
      .set(fixture.headers);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(
      scoped.body.data.tables.map((row: FloorRow) => row.table.id),
    ).toEqual([assigned.table.id]);
    // The legacy route must enforce the same assignment boundary (or deny
    // editor access), including live bill and call data in other zones.
    const legacy = await waiter.client.get("/api/floor").set(fixture.headers);
    expect([200, 403], JSON.stringify(legacy.body)).toContain(legacy.status);
    if (legacy.status === 200) {
      expect(
        legacy.body.data.tables.map((row: FloorRow) => row.table.id),
      ).toEqual([assigned.table.id]);
      expect(
        legacy.body.data.zones.map((zone: { id: string }) => zone.id),
      ).toEqual([assigned.zone.id]);
    }
    const legacyBody = JSON.stringify(legacy.body);
    for (const hidden of [
      unassigned.table.id,
      unassigned.zone.id,
      unassigned.sessionId,
      privateOrder.body.data.id,
      privateCall.body.data.id,
    ]) {
      expect(legacyBody).not.toContain(hidden);
    }
    const unassignedZone = await waiter.client
      .get(`${base()}?zoneId=${unassigned.zone.id}`)
      .set(fixture.headers);
    expect(unassignedZone.status, JSON.stringify(unassignedZone.body)).toBe(
      200,
    );
    expect(unassignedZone.body.data.tables).toEqual([]);
    const foreign = await cashierFixture("captain-floor-foreign");
    const refused = await waiter.client
      .get(`/api/outlets/${foreign.tenant.outletId}/floor`)
      .set(fixture.headers);
    expect([403, 404]).toContain(refused.status);
  });
});
