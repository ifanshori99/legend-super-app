// Acting staff wave 4 (brief 1094, cards legend-tlr6p and legend-13vhb):
// service-request (acknowledge/resolve), order issues, expo (delivered), menu
// availability status and collect-at-pos of an order-issue charge.
//
// Spec (docs/briefs/sub-1094-akses-perangkat-bersama-sisa.md, CTO decision 1054):
//  - On a shared (flagged) tablet the action must carry X-Acting-Staff; without
//    it the answer is 401 ACTING_STAFF_REQUIRED and nothing is written.
//  - With a valid cashier PIN token the cashier, not the tablet login owner, is
//    the recorded actor, and the cashier's own permissions and outlet scope
//    decide (a cashier of outlet A is refused on outlet B).
//  - Money, access: when in doubt, refuse.
//
// Round 2 (architect findings, "refuse when in doubt"): routes without
// :outletId (service-request acknowledge/resolve, menu availability status)
// take the outlet from the resource. With a PIN token the resource's outlet
// must equal the token's outlet (the tablet's outlet), otherwise 403
// ACTING_STAFF_OUTLET_MISMATCH. The two-outlet cashier below is staffed at BOTH outlets and
// signed in on outlet A's tablet, so permissions and scope alone would let
// them through and only the token-outlet check can refuse.
//
// Assumptions (spec silent):
//  - Round 2: a service request of outlet B is made by moving
//    service_requests.outlet_id of a request of outlet A to B in SQL (the guest
//    helper seats at outlet A only). Menu availability of outlet B is seeded
//    directly. PATCH availability and the zone-waiter routes are not covered
//    here (paths are not named by the brief).
//  - The shared-tablet refusal is 401 ACTING_STAFF_REQUIRED (the shared
//    contract code), as asserted by acting-staff-w3-recovery.test.ts.
//  - The tablet login owner is TENANT-wide with the same permissions as the
//    cashiers, so a wrong implementation that falls back to the session owner
//    would pass outlet scope: only the cashier's outlet scope can refuse.
//  - Another outlet / unreachable resource is refused with 403 or 404.
//  - Actor evidence = actor-ish columns of the row, audit_logs rows naming the
//    object (event.actorId) and the actor.id of outbox events about it.
//  - Acknowledging a service request needs "floor.table.operate" and a zone
//    assignment; only the cashier is assigned to the zone.
//  - Cashier B signs in at a shared tablet of outlet B (device resolver maps
//    the device to the outlet) and has an open shift there, so only an outlet
//    check can refuse the collect of outlet A's charge.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  businessDateOf,
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  PRICES,
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN_A = "582914";
const PIN_B = "674025";
const PIN_AB = "913607";
const CLOCK = { timeZone: "Asia/Jakarta", cutoff: "04:00" };
const DIFFERENCE = PRICES.kopi - PRICES.roti;
const PERMISSIONS = [
  "order.view",
  "order.recovery.handle",
  "kds.expo.operate",
  "menu.availability.toggle",
  "floor.table.view",
  "floor.table.operate",
  "pos.payment.accept",
];

type Person = { client: ReturnType<typeof agent>; userId: string };
type Response = { status: number; body: unknown };

let w: World;
let outletA: string;
let outletB: string;
let roleId: string;
let cashierA: Person;
let cashierB: Person;
/** Staffed at both outlets (round 2), PIN sign-in on outlet A's tablet. */
let cashierAB: Person;
/** Shared-tablet login of the current test (tenant-wide, fresh per test). */
let session: Person;
/** deviceId -> outlet, read by the device outlet resolver. */
const devices = new Map<string, string>();
let deviceA: string;
let deviceB: string;
/** Shift ids by cashier, opened once on first use. */
const shifts = new Map<string, string>();

beforeAll(async () => {
  w = await createWorld();
  outletA = w.tenant.outletId;
  outletB = w.ids.otherOutlet;
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId ? (devices.get(deviceId) ?? null) : null,
  );
  roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Bersama 1094', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, JSON.stringify(PERMISSIONS)],
  );
  cashierA = await makeUser("Kasir A 1094", { outletId: outletA });
  cashierB = await makeUser("Kasir B 1094", { outletId: outletB });
  cashierAB = await makeUser("Kasir A+B 1094", { outletId: outletA });
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, cashierAB.userId, roleId, outletB],
  );
  deviceA = await newDevice(outletA);
  deviceB = await newDevice(outletB);
}, 120_000);

beforeEach(async () => {
  session = await makeUser("Login Tablet 1094", null);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

// ---- fixtures ----------------------------------------------------------------

async function makeUser(
  label: string,
  scope: { outletId: string } | null,
): Promise<Person> {
  const client = agent(w.app);
  await signUp(client, label);
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      w.tenant.tenantId,
      userId,
      roleId,
      scope ? "outlet" : "tenant",
      scope?.outletId ?? null,
    ],
  );
  return { client, userId };
}

/** A shared-mode POS tablet registered at the outlet. */
async function newDevice(outletId: string): Promise<string> {
  const id = randomUUID();
  devices.set(id, outletId);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
    [id, w.tenant.tenantId, outletId, `Tablet 1094 ${id.slice(0, 6)}`],
  );
  return id;
}

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** The cashier signs in with a PIN on the tablet the login owner is using. */
async function cashierToken(
  who: Person,
  pin: string,
  outletId: string,
  deviceId: string,
): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    who.userId,
    { outletId, userId: who.userId },
    { pin },
  );
  const response = await session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: who.userId, pin });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

const tokenA = () => cashierToken(cashierA, PIN_A, outletA, deviceA);
const tokenB = () => cashierToken(cashierB, PIN_B, outletB, deviceB);
const tokenAB = () => cashierToken(cashierAB, PIN_AB, outletA, deviceA);

type Call = { deviceId?: string; token?: string };

/** A request as the shared-tablet login owner, with optional PIN token. */
function asTablet(
  method: "get" | "post",
  path: string,
  body: Record<string, unknown>,
  call: Call,
) {
  let request = session.client[method](path).set(w.headers).set(originHeader);
  if (call.deviceId)
    request = request.set(DEVICE_TOKEN_HEADER, tokenOf(call.deviceId));
  if (call.token) request = request.set(ACTING_HEADER, call.token);
  return method === "post" ? request.send(body) : request;
}

function expectError(response: Response, status: number, code: string) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

/** Refused as another outlet's resource or unknown credentials. */
function expectRefused(response: Response, allowed: number[] = [403, 404]) {
  expect(allowed, JSON.stringify(response.body)).toContain(response.status);
}

const idOf = (response: Response) =>
  (response.body as { data: { id: string } }).data.id;

/** Every user id that audit, outbox and actor-ish columns record for these ids. */
async function evidence(table: string | null, ids: string[]): Promise<string> {
  const columns: string[] = [];
  if (table) {
    const row = await owner.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id = $1 AND id::text = $2`,
      [w.tenant.tenantId, ids[0]],
    );
    columns.push(
      ...Object.entries(row.rows[0]?.row ?? {})
        .filter(([key]) =>
          /(reported_by|resolved_by|acknowledged_by|assigned_to|handled_by|created_by|updated_by|actor)/i.test(
            key,
          ),
        )
        .map(([, value]) => String(value)),
    );
  }
  const audit = await owner.query<{ actor: string | null }>(
    `SELECT event->>'actorId' AS actor FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = ANY($2)`,
    [w.tenant.tenantId, ids],
  );
  const outbox = await owner.query<{ actor: string | null }>(
    `SELECT event->'actor'->>'id' AS actor FROM domain_event_outbox
     WHERE tenant_id = $1
       AND (aggregate_id::text = ANY($2) OR event->'payload'->>'itemId' = ANY($2))`,
    [w.tenant.tenantId, ids],
  );
  return [
    ...columns,
    ...audit.rows.map((r) => String(r.actor)),
    ...outbox.rows.map((r) => String(r.actor)),
  ].join("\n");
}

function expectCashier(text: string, cashier: Person) {
  expect(text).toContain(cashier.userId);
  expect(text).not.toContain(session.userId);
}

// ---- service request ---------------------------------------------------------

async function openServiceRequest(assignee: Person | null = cashierA) {
  const guest = await w.seat();
  const response = await agent(w.app)
    .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({
      type: "call_waiter",
      reason: "utensils",
      idempotencyKey: randomUUID(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const data = (response.body as { data: { id: string; zoneId: string } }).data;
  if (assignee)
    await owner.query(
      `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [w.tenant.tenantId, outletA, data.zoneId, assignee.userId],
    );
  return data.id;
}

async function requestStatus(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM service_requests WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, id],
  );
  return rows[0]!.status;
}

/** Moves a request to outlet B (see Assumptions, round 2). */
async function moveRequestToOutletB(id: string) {
  await owner.query(
    "UPDATE service_requests SET outlet_id = $3 WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, id, outletB],
  );
}

const ackRequest = (id: string, call: Call): Promise<Response> =>
  asTablet("post", `/api/service-requests/${id}/acknowledge`, {}, call);
const resolveRequest = (id: string, call: Call): Promise<Response> =>
  asTablet("post", `/api/service-requests/${id}/resolve`, {}, call);

describe("service request on a shared tablet (legend-tlr6p)", () => {
  it("acknowledge without a PIN token: 401 ACTING_STAFF_REQUIRED, request stays pending", async () => {
    const id = await openServiceRequest();
    expectError(
      await ackRequest(id, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    expect(await requestStatus(id)).toBe("pending");
  });

  it("acknowledge with a cashier token: the cashier is the actor, not the login owner", async () => {
    const id = await openServiceRequest();
    const token = await tokenA();
    const response = await ackRequest(id, { deviceId: deviceA, token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await requestStatus(id)).not.toBe("pending");
    expectCashier(await evidence("service_requests", [id]), cashierA);
  });

  it("resolve with a cashier token: the cashier is the actor, not the login owner", async () => {
    const id = await openServiceRequest();
    const token = await tokenA();
    expect((await ackRequest(id, { deviceId: deviceA, token })).status).toBe(
      200,
    );
    const response = await resolveRequest(id, { deviceId: deviceA, token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await requestStatus(id)).toBe("resolved");
    expectCashier(await evidence("service_requests", [id]), cashierA);
  });

  it("the cashier of outlet B cannot acknowledge a request of outlet A", async () => {
    const id = await openServiceRequest();
    const token = await tokenB();
    expectRefused(await ackRequest(id, { deviceId: deviceB, token }));
    expect(await requestStatus(id)).toBe("pending");
  });

  it("two-outlet cashier with an outlet A token: acknowledge of an outlet A request works", async () => {
    const id = await openServiceRequest(cashierAB);
    const token = await tokenAB();
    const response = await ackRequest(id, { deviceId: deviceA, token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expectCashier(await evidence("service_requests", [id]), cashierAB);
  });

  it("two-outlet cashier with an outlet A token: acknowledge of an outlet B request is 403 ACTING_STAFF_OUTLET_MISMATCH, stays pending", async () => {
    const id = await openServiceRequest(cashierAB);
    await moveRequestToOutletB(id);
    const token = await tokenAB();
    expectError(
      await ackRequest(id, { deviceId: deviceA, token }),
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
    );
    expect(await requestStatus(id)).toBe("pending");
  });

  it("two-outlet cashier with an outlet A token: resolve of an outlet B request is 403 ACTING_STAFF_OUTLET_MISMATCH, status unchanged", async () => {
    const id = await openServiceRequest(cashierAB);
    const token = await tokenAB();
    expect((await ackRequest(id, { deviceId: deviceA, token })).status).toBe(
      200,
    );
    const acknowledged = await requestStatus(id);
    await moveRequestToOutletB(id);
    expectError(
      await resolveRequest(id, { deviceId: deviceA, token }),
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
    );
    expect(await requestStatus(id)).toBe(acknowledged);
  });
});

// ---- order issues ------------------------------------------------------------

async function issueCount(itemId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1 AND order_item_id::text = $2",
    [w.tenant.tenantId, itemId],
  );
  return Number(rows[0]!.n);
}

const reportIssue = (itemId: string, call: Call): Promise<Response> =>
  asTablet(
    "post",
    `/api/order-items/${itemId}/issues`,
    { type: "unfulfillable", reason: "out_of_stock", reasonNote: "Roti habis" },
    call,
  );

describe("order issues on a shared tablet (legend-tlr6p)", () => {
  it("report without a PIN token: 401 ACTING_STAFF_REQUIRED, no issue written", async () => {
    const { roti } = await w.paidOrder();
    expectError(
      await reportIssue(roti.id, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    expect(await issueCount(roti.id)).toBe(0);
  });

  it("report with a cashier token: the cashier is the reporter, not the login owner", async () => {
    const { roti } = await w.paidOrder();
    const token = await tokenA();
    const response = await reportIssue(roti.id, { deviceId: deviceA, token });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expectCashier(await evidence("order_issues", [idOf(response)]), cashierA);
  });

  it("the cashier of outlet B cannot report on an item of outlet A", async () => {
    const { roti } = await w.paidOrder();
    const token = await tokenB();
    expectRefused(await reportIssue(roti.id, { deviceId: deviceB, token }));
    expect(await issueCount(roti.id)).toBe(0);
  });
});

// ---- expo ----------------------------------------------------------------------

/** An order with one done kitchen ticket at the outlet: ready to be delivered. */
async function seedReadyOrder(outletId: string): Promise<string> {
  const orderId = createUlid();
  const stationId = randomUUID();
  const date = businessDateOf(new Date(), CLOCK);
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 10000, 0, 0, 0, 0, 10000,
         'sent', $5, now())`,
      [
        ulidToUuid(orderId),
        w.tenant.tenantId,
        outletId,
        `EX-${orderId.slice(-10)}`,
        date,
      ],
    );
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'hot_kitchen')`,
      [stationId, w.tenant.tenantId, outletId, `Dapur Siap ${stationId}`],
    );
    await client.query(
      `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id,
         business_date, ticket_no, status, priority, fired_at, done_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01',
         (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m
           WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'),
         'done', 0, now() - interval '20 minutes', now() - interval '15 minutes')`,
      [
        ulidToUuid(createUlid()),
        w.tenant.tenantId,
        outletId,
        ulidToUuid(orderId),
        stationId,
        ulidToUuid(createUlid()),
      ],
    );
  });
  return orderId;
}

async function deliveredBy(orderId: string): Promise<(string | null)[]> {
  const { rows } = await owner.query<{ delivered_by: string | null }>(
    `SELECT delivered_by FROM expo_assignments
     WHERE tenant_id = $1 AND order_id = $2 AND delivered_at IS NOT NULL`,
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.map((row) => row.delivered_by);
}

const deliver = (
  outletId: string,
  orderId: string,
  call: Call,
): Promise<Response> =>
  asTablet(
    "post",
    `/api/outlets/${encodeURIComponent(outletId)}/expo/${orderId}/delivered`,
    {},
    call,
  );

/** F12: a runner must be assigned before an order can be marked delivered. */
const assignRunner = (
  outletId: string,
  orderId: string,
  runner: Person,
  call: Call,
): Promise<Response> =>
  asTablet(
    "post",
    `/api/outlets/${encodeURIComponent(outletId)}/expo/${orderId}/runner`,
    { runnerId: runner.userId },
    call,
  );

describe("expo on a shared tablet (legend-tlr6p)", () => {
  it("delivered without a PIN token: 401 ACTING_STAFF_REQUIRED, nothing is recorded", async () => {
    const orderId = await seedReadyOrder(outletA);
    expectError(
      await deliver(outletA, orderId, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    expect(await deliveredBy(orderId)).toHaveLength(0);
  });

  it("delivered with a cashier token: delivered_by is the cashier, not the login owner", async () => {
    const orderId = await seedReadyOrder(outletA);
    const token = await tokenA();
    const assigned = await assignRunner(outletA, orderId, cashierA, {
      deviceId: deviceA,
      token,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const response = await deliver(outletA, orderId, {
      deviceId: deviceA,
      token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await deliveredBy(orderId)).toEqual([cashierA.userId]);
  });

  it("the cashier of outlet A cannot deliver an order of outlet B", async () => {
    const orderId = await seedReadyOrder(outletB);
    const token = await tokenA();
    expectRefused(
      await deliver(outletB, orderId, { deviceId: deviceA, token }),
    );
    expect(await deliveredBy(orderId)).toHaveLength(0);
  });
});

// ---- menu availability ---------------------------------------------------------

/** A fresh menu item with an available availability row at the outlet. */
async function seedAvailability(outletId: string) {
  const itemId = randomUUID();
  const availabilityId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        itemId,
        w.tenant.tenantId,
        w.tenant.brandId,
        w.ids.category,
        `Menu 86 ${itemId.slice(0, 6)}`,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO item_availability
         (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, sold_out_until, status, source)
       VALUES ($1, $2, $3, $4, '[]', NULL, NULL, 'available', NULL)`,
      [availabilityId, w.tenant.tenantId, outletId, itemId],
    );
  });
  return { itemId, availabilityId };
}

async function availabilityStatus(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM item_availability WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, id],
  );
  return rows[0]!.status;
}

const sellOut = (availabilityId: string, call: Call): Promise<Response> =>
  asTablet(
    "post",
    `/api/menu/availability/${availabilityId}/status`,
    { action: "sell_out", idempotencyKey: randomUUID() },
    call,
  );

describe("menu availability on a shared tablet (legend-tlr6p)", () => {
  it("86 without a PIN token: 401 ACTING_STAFF_REQUIRED, the item stays available", async () => {
    const { availabilityId } = await seedAvailability(outletA);
    expectError(
      await sellOut(availabilityId, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    expect(await availabilityStatus(availabilityId)).toBe("available");
  });

  it("86 with a cashier token: the cashier is the actor, not the login owner", async () => {
    const { itemId, availabilityId } = await seedAvailability(outletA);
    const token = await tokenA();
    const response = await sellOut(availabilityId, {
      deviceId: deviceA,
      token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await availabilityStatus(availabilityId)).toBe("sold_out");
    expectCashier(
      await evidence("item_availability", [availabilityId, itemId]),
      cashierA,
    );
  });

  it("the cashier of outlet A cannot 86 an item of outlet B", async () => {
    const { availabilityId } = await seedAvailability(outletB);
    const token = await tokenA();
    expectRefused(await sellOut(availabilityId, { deviceId: deviceA, token }));
    expect(await availabilityStatus(availabilityId)).toBe("available");
  });

  it("two-outlet cashier with an outlet A token: 86 of an outlet A item works, the cashier is the actor", async () => {
    const { availabilityId } = await seedAvailability(outletA);
    const token = await tokenAB();
    const response = await sellOut(availabilityId, {
      deviceId: deviceA,
      token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await availabilityStatus(availabilityId)).toBe("sold_out");
  });

  it("two-outlet cashier with an outlet A token: 86 of an outlet B item is 403 ACTING_STAFF_OUTLET_MISMATCH, stays available", async () => {
    const { availabilityId } = await seedAvailability(outletB);
    const token = await tokenAB();
    expectError(
      await sellOut(availabilityId, { deviceId: deviceA, token }),
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
    );
    expect(await availabilityStatus(availabilityId)).toBe("available");
  });
});

// ---- manual refund is closed on a shared tablet (round 3) ----------------------

async function issueState(issueId: string) {
  const { rows } = await owner.query<{
    status: string;
    resolution: string | null;
  }>(
    "SELECT status, resolution FROM order_issues WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!;
}

describe("manual refund resolve on a shared tablet (round 3, refuse when in doubt)", () => {
  // Assumption: the PIN guard runs first, so without a token the tablet gets
  // 401 ACTING_STAFF_REQUIRED; with a valid cashier token the route is closed
  // (403 SHARED_DEVICE_SCREEN_CLOSED). A resolve of the same kind from a
  // private browser is unchanged (200).
  it("tablet: 401 ACTING_STAFF_REQUIRED without a PIN token, 403 SHARED_DEVICE_SCREEN_CLOSED with one, nothing resolved; private browser still resolves 200", async () => {
    const paid = await w.paidOrder();
    const reported = await w.report(paid.roti.id);
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const issueId = reported.body.data.id as string;
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const body = {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: "Pelanggan kecewa, refund manual disetujui",
    };
    const path = `/api/order-issues/${issueId}/resolve`;
    const before = await issueState(issueId);

    // Shared tablet, no PIN token: the PIN guard answers first.
    expectError(
      await asTablet("post", path, body, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    // Shared tablet, valid cashier PIN token: still closed.
    const token = await tokenA();
    expectError(
      await asTablet("post", path, body, { deviceId: deviceA, token }),
      403,
      "SHARED_DEVICE_SCREEN_CLOSED",
    );
    expect(await issueState(issueId)).toEqual(before);
    expect(
      await w.outboxRows("order_issue.manual_refund_approved", issueId),
    ).toHaveLength(0);

    // Private device / ordinary browser: behaviour unchanged.
    const resolved = await w.staffPost(w.supervisor, path, body);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(
      await w.outboxRows("order_issue.manual_refund_approved", issueId),
    ).toHaveLength(1);
  });
});

// ---- collect an order-issue charge at the till ---------------------------------

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** One open shift per cashier on the given outlet tablet, opened once. */
async function openShift(
  cashier: Person,
  outletId: string,
  deviceId: string,
  businessDate: string,
) {
  if (shifts.has(cashier.userId)) return;
  const id = randomUUID();
  shifts.set(cashier.userId, id);
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
    [
      id,
      w.tenant.tenantId,
      outletId,
      deviceId,
      cashier.userId,
      businessDate,
      randomUUID(),
      "b".repeat(64),
    ],
  );
}

/** A paid order whose swap to a dearer item left an open charge at outlet A. */
async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const charged = await owner.query<{ id: string }>(
    "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(charged.rows).toHaveLength(1);
  const dateRow = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(order.order.id)],
  );
  return { chargeId: charged.rows[0]!.id, businessDate: dateRow.rows[0]!.d };
}

type ChargeRow = {
  status: string;
  paid_by: string | null;
  cash_movement_id: string | null;
};

async function chargeRow(chargeId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT status, paid_by, cash_movement_id
     FROM order_issue_charges WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

async function cashMovementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM cash_movements WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

const collect = (chargeId: string, call: Call): Promise<Response> =>
  asTablet(
    "post",
    `/api/order-issue-charges/${chargeId}/collect-at-pos`,
    { idempotencyKey: randomUUID(), method: "cash", receivedIdr: 8_085 },
    call,
  );

describe("collect an order-issue charge on a shared tablet (legend-13vhb)", () => {
  it("without a PIN token: 401 ACTING_STAFF_REQUIRED, no cash is written", async () => {
    const { chargeId } = await openCharge();
    const before = await chargeRow(chargeId);
    const movements = await cashMovementCount();
    expectError(
      await collect(chargeId, { deviceId: deviceA }),
      401,
      "ACTING_STAFF_REQUIRED",
    );
    expect(await chargeRow(chargeId)).toEqual(before);
    expect(await cashMovementCount()).toBe(movements);
  });

  it("cashier of outlet A collects charge of outlet A: the cashier is the payee; cashier of outlet B is refused, no cash written", async () => {
    const first = await openCharge();
    await openShift(cashierA, outletA, deviceA, first.businessDate);
    await openShift(cashierB, outletB, deviceB, first.businessDate);

    // Outlet B first: refused, charge untouched, nothing in any drawer.
    const tokenOfB = await tokenB();
    const before = await chargeRow(first.chargeId);
    const movements = await cashMovementCount();
    expectRefused(
      await collect(first.chargeId, { deviceId: deviceB, token: tokenOfB }),
    );
    expect(await chargeRow(first.chargeId)).toEqual(before);
    expect(await cashMovementCount()).toBe(movements);

    // Outlet A: accepted, the cashier (not the tablet login) is recorded.
    const token = await tokenA();
    const response = await collect(first.chargeId, {
      deviceId: deviceA,
      token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await chargeRow(first.chargeId);
    expect(after.paid_by).toBe(cashierA.userId);
    expect(after.paid_by).not.toBe(session.userId);
    const { rows } = await owner.query<{ recorded_by: string }>(
      "SELECT recorded_by FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [w.tenant.tenantId, shifts.get(cashierA.userId)],
    );
    expect(rows.map((r) => r.recorded_by)).toEqual([cashierA.userId]);
  });
});
