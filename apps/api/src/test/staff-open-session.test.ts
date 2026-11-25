// Walk-in seating (POS B1, brief 1268):
// POST /api/outlets/:outletId/tables/:tableId/staff-session.
//
// Contract (HTTP + DB rows only):
//  - floor.table.operate seats a party at an empty table; the session is a
//    normal table session (pay-first opens at once), the table turns occupied.
//  - The same key answers the same session and writes nothing twice.
//  - Two devices racing for one table give one session; the loser gets 409.
//  - A dirty or inactive table, a table of another outlet or tenant, and a
//    caller without the permission are refused and write no session.
//  - A shared device must carry a cashier token (ACTING_STAFF_REQUIRED).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createReservationInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { seatReservation } from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { HttpError } from "../lib/http-error.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  owner,
  staffOfIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

// Spy on the provider confirmation that scan, close and reservation seating run
// before they expire a stale session (legend-ukbq3). It passes through unless a
// test makes it refuse.
const confirmSpy = vi.hoisted(() => vi.fn());
vi.mock("../services/order-recovery-charge.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../services/order-recovery-charge.ts")
    >();
  confirmSpy.mockImplementation(
    (...args: Parameters<typeof original.confirmChargeLinksUnpaid>) =>
      original.confirmChargeLinksUnpaid(...args),
  );
  return { ...original, confirmChargeLinksUnpaid: confirmSpy };
});

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const [device, sharedDevice] = [randomUUID(), randomUUID()];
const roles = { till: randomUUID(), limited: randomUUID() };
const HOURS = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
];

type Member = { client: ReturnType<typeof agent>; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let till: Member;
let cashierB: Member;
let limited: Member;
let payFirstZone: string;
let openBillZone: string;
let otherOutletId: string;

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

const deviceToken = (deviceId = device) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function tokenFor(
  who: Member,
  client: Member = till,
  deviceId = device,
): Promise<string> {
  const response = await client.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

const newKey = () => `walkin-${randomUUID()}`;

/** POST as `who` on the registered till device; `token` adds X-Acting-Staff. */
function seat(
  tableId: string,
  body: Record<string, unknown>,
  options: {
    client?: Member;
    token?: string;
    outletId?: string;
    deviceId?: typeof device;
  } = {},
) {
  // A cashier token is bound to the login session of the till it was issued on.
  const request = (options.client ?? till).client
    .post(
      `/api/outlets/${options.outletId ?? tenant.outletId}/tables/${tableId}/staff-session`,
    )
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(options.deviceId));
  return (
    options.token ? request.set(ACTING_HEADER, options.token) : request
  ).send(body);
}

async function emptyTable(zoneId = payFirstZone): Promise<string> {
  const table = await createTable(till.client, { zoneId }, headers);
  return table.id as string;
}

async function sessionsOf(tableId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id, status FROM table_sessions WHERE tenant_id = $1 AND table_id = $2`,
    [tenant.tenantId, tableId],
  );
  return rows;
}

async function tableStatus(tableId: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM tables WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, tableId],
  );
  return rows[0]?.status;
}

/** A walk-in session on `tableId`, aged past the 12-hour window. */
async function staleSession(tableId: string): Promise<string> {
  const response = await seat(tableId, { pax: 2, idempotencyKey: newKey() });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const sessionId = response.body.data.id as string;
  await owner.query(
    `UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours'
     WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, sessionId],
  );
  return sessionId;
}

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

beforeEach(() => {
  confirmSpy.mockClear();
});

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`soss-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (deviceId === device || deviceId === sharedDevice)
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "Meja Walk-in",
      [
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
        "reservation.view",
        "reservation.manage",
      ],
    ],
    [roles.limited, "Meja Walk-in Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  till = await member("Walkin Till", roles.till);
  cashierB = await member("Walkin Kasir B", roles.till);
  limited = await member("Walkin Terbatas", roles.limited);
  const ctx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const who of [cashierB, limited])
    await setStaffPin(
      ctx,
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Walkin 1', now() - interval '1 minute')`,
    [device, tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', 'Kasir Bersama 1', now() - interval '1 minute', true)`,
    [sharedDevice, tenant.tenantId, tenant.outletId],
  );
  payFirstZone = (await createZone(till.client, { hours: HOURS }, headers)).id;
  openBillZone = (
    await createZone(
      till.client,
      { paymentMode: "open_bill", hours: HOURS },
      headers,
    )
  ).id;
  // A second outlet in the same tenant (the till's token is bound to the first).
  otherOutletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua Walkin', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE id = $3`,
    [
      otherOutletId,
      `W2${randomUUID().slice(0, 6)}`.toUpperCase(),
      tenant.outletId,
    ],
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("POST /api/outlets/:outletId/tables/:tableId/staff-session", () => {
  it("seats a walk-in party and marks the table occupied", async () => {
    const tableId = await emptyTable();

    const response = await seat(tableId, { pax: 3, idempotencyKey: newKey() });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      tableId,
      pax: 3,
      status: "open",
      reservationId: null,
    });
    expect(await sessionsOf(tableId)).toHaveLength(1);
    expect(await tableStatus(tableId)).toBe("occupied");
  });

  it("answers a repeated key with the same session and writes nothing twice", async () => {
    const tableId = await emptyTable();
    const body = { pax: 2, idempotencyKey: newKey() };

    const first = await seat(tableId, body);
    const again = await seat(tableId, body);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await sessionsOf(tableId)).toHaveLength(1);
    const { rows } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'table_session.opened'`,
      [tenant.tenantId, first.body.data.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses the same key with another pax or table", async () => {
    const tableId = await emptyTable();
    const key = newKey();
    expect((await seat(tableId, { pax: 2, idempotencyKey: key })).status).toBe(
      200,
    );

    expectError(
      await seat(tableId, { pax: 4, idempotencyKey: key }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    const other = await emptyTable();
    expectError(
      await seat(other, { pax: 2, idempotencyKey: key }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await sessionsOf(other)).toHaveLength(0);
  });

  it("gives one session when two devices race for the same table", async () => {
    const tableId = await emptyTable();
    const tokenB = await tokenFor(cashierB);

    const [a, b] = await Promise.all([
      seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      seat(tableId, { pax: 4, idempotencyKey: newKey() }, { token: tokenB }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it("answers a second party at a seated table with 409 CONFLICT", async () => {
    const tableId = await emptyTable();
    expect(
      (await seat(tableId, { pax: 2, idempotencyKey: newKey() })).status,
    ).toBe(200);

    expectError(
      await seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it.each(["dirty", "inactive", "reserved", "occupied"])(
    "refuses a %s table that has no session of its own",
    async (status) => {
      // `occupied` without a session is the second table of a reservation
      // party: seating a walk-in there would share the party's bill (review
      // 1268 B1, no. 2).
      const tableId = await emptyTable();
      await owner.query(
        `UPDATE tables SET status = $1 WHERE tenant_id = $2 AND id = $3`,
        [status, tenant.tenantId, tableId],
      );

      expectError(
        await seat(tableId, { pax: 2, idempotencyKey: newKey() }),
        409,
        "CONFLICT",
      );
      expect(await sessionsOf(tableId)).toHaveLength(0);
      expect(await tableStatus(tableId)).toBe(status);
    },
  );

  it("leaves the second table of a seated reservation party alone", async () => {
    // Real shape: a primary table with the party's session, a secondary table
    // marked occupied by seating and released by closing the primary session.
    const primary = await emptyTable();
    const secondary = await emptyTable();
    expect(
      (await seat(primary, { pax: 4, idempotencyKey: newKey() })).status,
    ).toBe(200);
    await owner.query(
      `UPDATE tables SET status = 'occupied' WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, secondary],
    );

    expectError(
      await seat(secondary, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );
    expect(await sessionsOf(secondary)).toHaveLength(0);
  });

  it("confirms the payment links of a stale session unpaid before expiring it, and refuses when the provider is unsure", async () => {
    // Review 1268 B1, no. 1: a link already paid at the provider must never be
    // cancelled by a walk-in taking the table over.
    const tableId = await emptyTable();
    const first = await seat(tableId, { pax: 2, idempotencyKey: newKey() });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const staleId = first.body.data.id as string;
    await owner.query(
      `UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours'
       WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, staleId],
    );
    confirmSpy.mockRejectedValueOnce(
      new HttpError(
        409,
        "PAYMENT_PROVIDER_UNCONFIRMED",
        "Status pembayaran belum terkonfirmasi.",
      ),
    );

    const refused = await seat(tableId, {
      pax: 3,
      idempotencyKey: newKey(),
    });

    expectError(refused, 409, "PAYMENT_PROVIDER_UNCONFIRMED");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[1]).toEqual({ sessionId: staleId });
    const rows = await sessionsOf(tableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: staleId, status: "open" });
  });

  it("takes a table over from a stale session once the provider confirms nothing is owed", async () => {
    const tableId = await emptyTable();
    const first = await seat(tableId, { pax: 2, idempotencyKey: newKey() });
    const staleId = first.body.data.id as string;
    await owner.query(
      `UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours'
       WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, staleId],
    );

    const next = await seat(tableId, { pax: 3, idempotencyKey: newKey() });

    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.data.id).not.toBe(staleId);
    expect(confirmSpy.mock.calls.map((call) => call[1])).toContainEqual({
      sessionId: staleId,
    });
    const rows = await sessionsOf(tableId);
    expect(rows.filter((row) => row.status === "open")).toHaveLength(1);
    expect(rows.find((row) => row.id === staleId)?.status).not.toBe("open");
  });

  it("refuses a stale session that was moved onto the table after the provider confirmation", async () => {
    // Re-review: the 12-hour exception covers only the session whose payment
    // links were confirmed unpaid, not whatever stale session sits here later.
    const tableId = await emptyTable();
    const elsewhere = await emptyTable();
    const confirmed = await staleSession(tableId);
    const moved = await staleSession(elsewhere);
    confirmSpy.mockImplementationOnce(async () => {
      await owner.query(
        `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_reason = 'expired'
         WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, confirmed],
      );
      await owner.query(
        `UPDATE table_sessions SET table_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, moved, tableId],
      );
    });

    const response = await seat(tableId, {
      pax: 2,
      idempotencyKey: newKey(),
    });

    expectError(response, 409, "CONFLICT");
    const rows = await sessionsOf(tableId);
    // The confirmed session was closed by the hook; the moved one stays open.
    expect(rows.filter((row) => row.status === "open")).toEqual([
      expect.objectContaining({ id: moved }),
    ]);
    expect(rows.find((row) => row.id === confirmed)?.status).toBe("closed");
  });

  it("refuses a stale session that still carries an unpaid bill", async () => {
    const tableId = await emptyTable();
    const staleId = await staleSession(tableId);
    const orderUuid = randomUUID();
    await owner.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id,
          payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
          total_idr, prices_include_tax, status, business_date, placed_at, fired_at)
       SELECT $1, tenant_id, outlet_id, $2, 'qr', 'dine_in', id, payment_mode, 30000, 0, 0, 0, 0,
          30000, false, 'sent', current_date, now(), now()
       FROM table_sessions WHERE id = $3`,
      [orderUuid, `SOS-${randomUUID().slice(0, 12)}`, staleId],
    );

    const response = await seat(tableId, {
      pax: 2,
      idempotencyKey: newKey(),
    });

    expectError(response, 409, "CONFLICT");
    expect(confirmSpy.mock.calls.map((call) => call[1])).toContainEqual({
      sessionId: staleId,
    });
    expect(await sessionsOf(tableId)).toEqual([
      expect.objectContaining({ id: staleId, status: "open" }),
    ]);
  });

  it("gives one new session when two tablets seat a walk-in at the same stale table", async () => {
    const tableId = await emptyTable();
    const staleId = await staleSession(tableId);
    const tokenB = await tokenFor(cashierB);

    const [a, b] = await Promise.all([
      seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      seat(tableId, { pax: 3, idempotencyKey: newKey() }, { token: tokenB }),
    ]);

    expect(
      [a.status, b.status].sort(),
      JSON.stringify([a.body, b.body]),
    ).toEqual([200, 409]);
    const rows = await sessionsOf(tableId);
    expect(rows.filter((row) => row.status === "open")).toHaveLength(1);
    expect(rows.find((row) => row.id === staleId)?.status).not.toBe("open");
  });

  it("answers two simultaneous requests with the same key and body with one session", async () => {
    const tableId = await emptyTable();
    const body = { pax: 2, idempotencyKey: newKey() };

    const [a, b] = await Promise.all([
      seat(tableId, body),
      seat(tableId, body),
    ]);

    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it("refuses the second table of a real reservation party", async () => {
    const ctx = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const outlet = outletIdSchema.parse(tenant.outletId);
    await owner.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'sos-1', 'none', 0, 60, 24, 0, 0, 0, 90, 30, true)`,
      [tenant.tenantId, tenant.outletId],
    );
    const primary = await emptyTable();
    const secondary = await emptyTable();
    const created = await createReservation(
      ctx,
      outlet,
      createReservationInputSchema.parse({
        reservedFor: zonedInstant(
          "2027-04-04",
          "19:00",
          "Asia/Jakarta",
        ).toISOString(),
        pax: 2,
        zoneId: payFirstZone,
        guestName: "Tamu Walkin",
        contactPhone: "081234567890",
      }),
      `rsv-${randomUUID()}`,
    );
    const seated = await seatReservation(
      ctx,
      till.userId,
      outlet,
      created.reservation.id,
      seatReservationInputSchema.parse({ tableIds: [primary, secondary] }),
      `rsv-${randomUUID()}`,
    );
    expect(await tableStatus(secondary)).toBe("occupied");
    expect(await sessionsOf(secondary)).toHaveLength(0);

    expectError(
      await seat(secondary, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );
    expectError(
      await seat(primary, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );

    expect(await sessionsOf(secondary)).toHaveLength(0);
    expect(await sessionsOf(primary)).toEqual([
      expect.objectContaining({ id: seated.tableSessionId, status: "open" }),
    ]);
  });

  it("answers the same session to a replay after the party moved tables", async () => {
    // Review 1268 B1, no. 4: the key lives in its own table, not on a
    // participant row that follows the session.
    const tableId = await emptyTable();
    const target = await emptyTable();
    const body = { pax: 2, idempotencyKey: newKey() };
    const first = await seat(tableId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const moved = await till.client
      .post(`/api/table-sessions/${first.body.data.id}/move`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ toTableId: target });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const again = await seat(tableId, body);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("is not tricked by a guest who chose a device hash like the key", async () => {
    const tableId = await emptyTable();
    const key = newKey();
    const first = await seat(tableId, { pax: 2, idempotencyKey: key });
    expect(first.status).toBe(200);
    const { rows } = await owner.query(
      `SELECT device_hash FROM session_participants WHERE tenant_id = $1 AND table_session_id = $2`,
      [tenant.tenantId, first.body.data.id],
    );
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it("opens an open-bill zone at once, confirmed by the host, with an audit row", async () => {
    // Review 1268 B1, no. 5.
    const tableId = await emptyTable(openBillZone);
    const token = await tokenFor(cashierB);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "open",
      paymentMode: "open_bill",
      confirmedBy: cashierB.userId,
    });
    const { rows } = await owner.query<{ actor: string; after: string }>(
      `SELECT event->>'actorId' AS actor, event->'maskedChanges'->'after' AS after
       FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'table_session.staff_opened'
         AND event->>'objectId' = $2`,
      [tenant.tenantId, response.body.data.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(cashierB.userId);
    // The audited `after` names who confirmed and the zone's pay mode.
    expect(rows[0]?.after).toMatchObject({
      id: response.body.data.id,
      tableId,
      pax: 2,
      paymentMode: "open_bill",
      confirmedBy: cashierB.userId,
    });
  });

  it("writes an audit row for a pay-first walk-in too", async () => {
    const tableId = await emptyTable();
    const response = await seat(tableId, { pax: 2, idempotencyKey: newKey() });
    const { rows } = await owner.query(
      `SELECT 1 FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'table_session.staff_opened'
         AND event->>'objectId' = $2`,
      [tenant.tenantId, response.body.data.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("does not seat a table of another outlet through this outlet's path", async () => {
    // The till's login reaches every outlet of the tenant, so the refusal is
    // the table's own outlet check.
    const tableId = await emptyTable();

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { outletId: otherOutletId },
    );

    expectError(response, 404, "NOT_FOUND");
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("refuses a cashier token of outlet A on the path of outlet B", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(cashierB);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token, outletId: otherOutletId },
    );

    expectError(response, 403, "ACTING_STAFF_OUTLET_MISMATCH");
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("does not find a real table of another tenant, by its own outlet or ours", async () => {
    const foreign = await createIsolatedTenant(
      `soss2-${randomUUID().slice(0, 6)}`,
    );
    const foreignStaff = await staffOfIsolatedTenant(app, foreign);
    const foreignHeaders = { Host: foreign.hostname };
    const zone = await createZone(
      foreignStaff.client,
      { hours: HOURS },
      foreignHeaders,
    );
    const foreignTable = (
      await createTable(
        foreignStaff.client,
        { zoneId: zone.id },
        foreignHeaders,
      )
    ).id as string;

    const viaOurOutlet = await seat(foreignTable, {
      pax: 2,
      idempotencyKey: newKey(),
    });
    const viaTheirOutlet = await seat(
      foreignTable,
      { pax: 2, idempotencyKey: newKey() },
      { outletId: foreign.outletId },
    );

    expectError(viaOurOutlet, 404, "NOT_FOUND");
    expectError(viaTheirOutlet, 403, "PERMISSION_DENIED");
    const { rows } = await owner.query(
      `SELECT 1 FROM table_sessions WHERE table_id = $1`,
      [foreignTable],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a cashier without floor.table.operate", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(limited);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token },
    );

    expectError(response, 403, "PERMISSION_DENIED");
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("records the acting cashier as the one who seated the party", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(cashierB);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await owner.query<{ actor: string }>(
      `SELECT event->'actor'->>'id' AS actor FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'table_session.opened'`,
      [tenant.tenantId, response.body.data.id],
    );
    expect(JSON.stringify(rows)).toContain(cashierB.userId);
  });

  it("on a shared device needs a cashier token, and a token seats the party", async () => {
    const tableId = await emptyTable();
    // A fresh login on a device flagged shared: marks stick to that session.
    const sharedTill = await member("Walkin Bersama", roles.till);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { client: sharedTill, deviceId: sharedDevice },
    );

    expectError(response, 401, "ACTING_STAFF_REQUIRED");
    expect(await sessionsOf(tableId)).toHaveLength(0);

    const token = await tokenFor(cashierB, sharedTill, sharedDevice);
    const seated = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { client: sharedTill, deviceId: sharedDevice, token },
    );
    expect(seated.status, JSON.stringify(seated.body)).toBe(200);
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it("rejects a body that carries unknown fields or a bad pax", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(cashierB);

    for (const body of [
      { pax: 0, idempotencyKey: newKey() },
      { pax: 31, idempotencyKey: newKey() },
      { pax: 2 },
      { pax: 2, idempotencyKey: newKey(), tenantId: tenant.tenantId },
    ])
      expect(
        (await seat(tableId, body, { token })).status,
        JSON.stringify(body),
      ).toBe(422);
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });
});
