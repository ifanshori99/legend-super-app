// 1268 W4 review no. 2: the floor board (floor.table.view) tells staff that a
// reservation still holds an unseated table, without the guest's name,
// contact or note. A waiter without reservation.view reads only the marker.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTable,
  createZone,
  owner,
  staffOfIsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
let waiter: Awaited<ReturnType<typeof staffOfIsolatedTenant>>;
let zoneId: string;

beforeAll(async () => {
  fixture = await cashierFixture("floor-hold");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Waiter lantai', false, NULL, $3, false, '["outlet"]')`,
    [
      roleId,
      fixture.tenant.tenantId,
      JSON.stringify(["floor.table.view", "order.view"]),
    ],
  );
  waiter = await staffOfIsolatedTenant(fixture.app, fixture.tenant);
  await owner.query(
    `UPDATE role_assignments SET role_id = $3, scope_type = 'outlet', scope_id = $4
      WHERE tenant_id = $1 AND user_id = $2`,
    [fixture.tenant.tenantId, waiter.userId, roleId, fixture.tenant.outletId],
  );
  const zone = await createZone(fixture.staff.client, {}, fixture.headers);
  zoneId = zone.id as string;
  // A waiter reads the zones assigned to them.
  await owner.query(
    `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [fixture.tenant.tenantId, fixture.tenant.outletId, zoneId, waiter.userId],
  );
});
afterAll(async () => {
  await owner.end();
});

async function hold(
  tableId: string,
  input: {
    status?: string;
    startsInMin?: number;
    endsInMin?: number;
    released?: boolean;
    seated?: boolean;
    pax?: number;
  } = {},
) {
  const reservationId = randomUUID();
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax,
        deposit_idr, policy_snapshot, status, source, note, closed_at)
     VALUES ($1, $2, $3, 'Tamu Rahasia', now() + make_interval(mins => $4), 90, $5,
        0, '{}', $6::varchar, 'staff', 'catatan pribadi',
        CASE WHEN $6::varchar IN ('cancelled', 'no_show') THEN now() END)`,
    [
      reservationId,
      fixture.tenant.tenantId,
      fixture.tenant.outletId,
      input.startsInMin ?? 30,
      input.pax ?? 4,
      input.status ?? "confirmed",
    ],
  );
  await owner.query(
    `INSERT INTO reservation_tables
       (tenant_id, outlet_id, reservation_id, table_id, starts_at, ends_at, released_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5),
        now() + make_interval(mins => $6), $7)`,
    [
      fixture.tenant.tenantId,
      fixture.tenant.outletId,
      reservationId,
      tableId,
      input.startsInMin ?? 30,
      input.endsInMin ?? 120,
      input.released ? new Date() : null,
    ],
  );
  return reservationId;
}

const board = async () => {
  const response = await waiter.client
    .get(`/api/outlets/${fixture.tenant.outletId}/floor`)
    .set(fixture.headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.tables as {
    table: { id: string };
    reservationHold?: Record<string, unknown> | null;
  }[];
};
const newTable = async () =>
  (await createTable(fixture.staff.client, { zoneId }, fixture.headers))
    .id as string;

describe("floor board reservation hold marker", () => {
  it("marks a table a live reservation still holds, without PII", async () => {
    const tableId = await newTable();
    await hold(tableId, { pax: 6, startsInMin: -5 });
    const row = (await board()).find((entry) => entry.table.id === tableId);
    expect(row?.reservationHold).toEqual({
      startsAt: expect.any(String),
      endsAt: expect.any(String),
      pax: 6,
    });
    expect(JSON.stringify(row)).not.toMatch(/Rahasia|catatan|contact|guest/i);
  });

  it("does not mark a released, ended, cancelled or next-day hold", async () => {
    const released = await newTable();
    await hold(released, { released: true });
    const ended = await newTable();
    await hold(ended, { startsInMin: -180, endsInMin: -90 });
    const cancelled = await newTable();
    await hold(cancelled, { status: "cancelled" });
    // Tomorrow's booking does not hold the table today (business day).
    const tomorrow = await newTable();
    await hold(tomorrow, { startsInMin: 30 * 60, endsInMin: 32 * 60 });
    const plain = await newTable();
    const rows = await board();
    for (const id of [released, ended, cancelled, tomorrow, plain])
      expect(
        rows.find((entry) => entry.table.id === id)?.reservationHold ?? null,
      ).toBeNull();
  });

  it("shows the earliest of two holds", async () => {
    const tableId = await newTable();
    await hold(tableId, { startsInMin: 70, endsInMin: 120, pax: 2 });
    await hold(tableId, { startsInMin: -5, endsInMin: 60, pax: 3 });
    const row = (await board()).find((entry) => entry.table.id === tableId);
    expect(row?.reservationHold).toMatchObject({ pax: 3 });
  });
});
