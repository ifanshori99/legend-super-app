// POS 936 second-opinion round 3, finding R3-01 (brief 1065).
// Written from docs/qa/second-opinion-pos-936-ronde3-1064.md (Temuan + Usul
// test) and the observable HTTP contract of pos-1059-*.test.ts, not from the
// service code.
//
// Finding: a device of outlet B in training mode, used by a staff member whose
// role reaches outlet A only (plain session, no acting-staff token), can sell
// a PRODUCTION facility ticket and a production POS order of outlet A, because
// the device lookup is sliced to the target outlet and "not found" is treated
// as normal mode. A device that does not belong to the target outlet (or is
// unknown) must be refused.
//
// ASSUMPTIONS (also in the report):
//   - "Refused" means the existing uniform refusals: 403 or 409 (the training
//     refusal of the ticket sale is 409 TICKET_TRAINING_REFUSED today; a
//     device-outlet mismatch may legitimately be 403). The test accepts either
//     status but nothing in the 2xx range and nothing else (no 5xx, no 422).
//   - The report says the device must be validated against the target outlet,
//     so a NORMAL device of outlet B is refused as well as the training one.
//   - An unknown device (validly signed token, never registered) is refused
//     with 401, 403 or 409 (the platform may stop it before the sale).
//   - "Nothing left behind" = no new row in orders / pos_orders / the ticket
//     link table / access_tickets for the unit, and the very same slot still
//     sells afterwards on a normal device of outlet A (so no hold or slot
//     change survived). A replay of the same request (same idempotency key)
//     is refused again and leaves nothing either.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asOwnerTenant,
  createPosOrder,
  errorCode,
  newUnit,
  sell,
  teardownWorld,
  buildWorld,
  type World,
} from "./pos-1065-world.ts";

let world: World;

beforeAll(async () => {
  world = await buildWorld("r301");
}, 180_000);

afterAll(async () => {
  await teardownWorld(world);
});

async function count(table: string, where = ""): Promise<number> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
      [world.tenant.tenantId],
    ),
  );
  return Number(rows[0]?.n);
}

async function snapshot(unitId?: string) {
  return {
    orders: await count("orders"),
    posOrders: await count("pos_orders"),
    ticketLines: await count("facility_ticket_pos_lines"),
    tickets: unitId
      ? await count("access_tickets", `AND unit_id = '${unitId}'::uuid`)
      : await count("access_tickets"),
  };
}

type Reply = { status: number; body: { error?: { code?: string } } };

function expectRefused(reply: Reply, allowed: number[] = [403, 409]) {
  expect(
    allowed,
    `status ${reply.status}: ${JSON.stringify(reply.body)}`,
  ).toContain(reply.status);
  expect(errorCode(reply.body), JSON.stringify(reply.body)).toBeTruthy();
}

describe("R3-01 facility ticket sale from a device that is not in the facility's outlet", () => {
  for (const [label, pick, allowed] of [
    ["training device of outlet B", "trainingB", [403, 409]],
    ["normal device of outlet B", "normalB", [403, 409]],
    ["unknown device", "unknown", [401, 403, 409]],
  ] as const) {
    it(`R3-01-ticket ${label}: the sale of outlet A's facility is refused, nothing is written, and the slot still sells`, async () => {
      const unitId = await newUnit(world);
      const before = await snapshot(unitId);
      const key = randomUUID();

      const refused = await sell(world, unitId, world[pick], key);
      expectRefused(refused, [...allowed]);
      expect(await snapshot(unitId)).toEqual(before);

      // Replay of the same request: refused again, still nothing written.
      const replay = await sell(world, unitId, world[pick], key);
      expectRefused(replay, [...allowed]);
      expect(await snapshot(unitId)).toEqual(before);

      // No hold or slot change survived: the same slot sells at a normal
      // device of outlet A (this is also the control of the scenario).
      const control = await sell(world, unitId, world.normalA);
      expect(control.status, JSON.stringify(control.body)).toBe(200);
      const after = await snapshot(unitId);
      expect(after.tickets).toBe(before.tickets + 1);
      expect(after.orders).toBe(before.orders + 1);
    });
  }

  it("R3-01-ticket-control a normal device of outlet A sells the ticket (200) and leaves exactly one order, one link and one ticket", async () => {
    const unitId = await newUnit(world);
    const before = await snapshot(unitId);
    const sold = await sell(world, unitId, world.normalA);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const after = await snapshot(unitId);
    expect(after.orders).toBe(before.orders + 1);
    expect(after.ticketLines).toBe(before.ticketLines + 1);
    expect(after.tickets).toBe(before.tickets + 1);
  });
});

describe("R3-01 POS order of outlet A from a device that is not in outlet A", () => {
  for (const [label, pick, allowed] of [
    ["training device of outlet B", "trainingB", [403, 409]],
    ["normal device of outlet B", "normalB", [403, 409]],
    ["unknown device", "unknown", [401, 403, 409]],
  ] as const) {
    it(`R3-01-order ${label}: creating an order in outlet A is refused and nothing is written, also on replay`, async () => {
      const before = await snapshot();
      const key = randomUUID();

      const refused = await createPosOrder(world, world[pick], key);
      expectRefused(refused, [...allowed]);
      expect(await snapshot()).toEqual(before);

      const replay = await createPosOrder(world, world[pick], key);
      expectRefused(replay, [...allowed]);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("R3-01-order-control a normal device of outlet A creates the order (201)", async () => {
    const before = await snapshot();
    const created = await createPosOrder(world, world.normalA);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const after = await snapshot();
    expect(after.orders).toBe(before.orders + 1);
    expect(after.posOrders).toBe(before.posOrders + 1);
  });
});
