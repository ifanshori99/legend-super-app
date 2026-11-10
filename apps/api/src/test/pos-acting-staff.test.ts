// Acting cashier token per device (bead legend-aruta, slice E; spec = the
// DECISIONS.md entry "Kasir aktif per perangkat lewat token server").
//
// Contract under test (HTTP only, derived from the spec):
//  - POST /api/staff-pins/pos-session {userId, pin} with the session cookie, a
//    trusted Origin, the tenant Host and X-Device-Token answers 201
//    {data:{token, expiresAt, staff, outletId}}. Wrong PIN issues nothing.
//  - POST /api/staff-pins/pos-session/end answers 204 and revokes the token.
//  - POS calls that carry X-Acting-Staff run as that staff member: the actor is
//    the staff, permissions are the staff's (never the session owner's).
//  - Errors: 401 ACTING_STAFF_INVALID / _EXPIRED / _REVOKED, 403
//    ACTING_STAFF_OUTLET_MISMATCH / _INACTIVE / _NOT_ALLOWED, 403
//    PERMISSION_DENIED when the staff lacks the permission.
//  - Without the header nothing changes: the session owner is the actor.
//
// Assumptions (the spec leaves these open):
//  - "Inactive staff" is exercised by removing the staff member's role
//    assignments after the token was issued (no longer active in the outlet).
//  - The token is exercised on GET .../pos/shifts?deviceId=, which any holder
//    of shift.cash.operate may call (200). Permission denial uses POST
//    .../pos/orders (pos.sale.create) and POST .../pos/shifts (shift.cash.operate).
//  - Expiry is simulated by moving expires_at (and issued_at) into the past in
//    pos_acting_staff as the database owner.
//  - Shift close revokes the token of the device's shift (reason shift_closed).
//  - A request that reaches POS with the token of another session (same user,
//    second sign-in) is ACTING_STAFF_INVALID, as is another device's token.
//  - The outlet mismatch is a second outlet of the same tenant, called with the
//    token issued for the first outlet.
//  - Day close (second describe): a manager closes the empty business day
//    2025-01-15 through POST .../pos/day/close; every live token of the outlet
//    is then ACTING_STAFF_REVOKED with reason day_closed.
//  - MFA: a role with mfa_required only grants its permissions when the
//    session verified a second factor. The session owner verifies MFA; the
//    acting staff member (same role) must still be refused, as MFA is never
//    inherited from the session. The spec fixes "mfaVerified = false" but not
//    the error code, so 403 PERMISSION_DENIED or MFA_REQUIRED are both accepted.
//  - ACTING_STAFF_UNSUPPORTED: GET /api/outlets/:id/floor is a router the
//    decision lists as a later wave (no acting-staff middleware yet). If that
//    router gains the middleware, pick another unwired router.
//  - Idempotency: POST .../pos/orders carries the key in the body
//    (`idempotencyKey`); the same key with another acting staff is 409
//    IDEMPOTENCY_KEY_REUSED, the same key with the same staff replays.
//  - Concurrency: two simultaneous pos-session issues on one device end with
//    exactly one live token row. Observed: both answer 201 and the later one
//    switches the earlier (revoked, reason switched); a refusal must be 409
//    CONFLICT.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

// Lets the MFA test hand loadRequestAccess a hand-built request: the real
// getTenantContext only knows requests that went through the tenant middleware.
// Every other request (the whole HTTP suite) takes the real implementation.
const fakeTenantContexts = vi.hoisted(() => new WeakMap<object, unknown>());
vi.mock("../middleware/tenant", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../middleware/tenant")>();
  return {
    ...original,
    getTenantContext: (req: object) =>
      fakeTenantContexts.get(req) ??
      original.getTenantContext(
        req as Parameters<typeof original.getTenantContext>[0],
      ),
  };
});

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const NEW_PIN = "730416";
const WRONG = "907153";
const PASSWORD = "Test-password-123!";

const [category, kopi, priceList, device, device2, outlet2] = [
  1, 2, 3, 4, 5, 6,
].map(() => randomUUID()) as [string, string, string, string, string, string];
const roles = {
  till: randomUUID(),
  limited: randomUUID(),
  supervisor: randomUUID(),
};

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string; email: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member; // logged in on the till, holds every POS permission
let cashierB: Member;
let cashierC: Member; // wrong-PIN test only
let limited: Member; // order.view only
let inactive: Member;
let pinReset: Member;
let supervisor: Member;

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId, email };
}

const tenantCtx = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });

async function givePin(who: Member, pin = PIN) {
  await setStaffPin(
    tenantCtx(),
    who.userId,
    { outletId: tenant.outletId, userId: who.userId },
    { pin },
  );
}

const deviceToken = (deviceId = device) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

const posBase = (outletId = tenant.outletId) =>
  `/api/outlets/${encodeURIComponent(outletId)}/pos`;

/** Session owner (or another client) asks the server to make `userId` the acting cashier. */
function startSession(
  userId: string,
  pin: string,
  options: { client?: Client; deviceId?: string } = {},
) {
  return (options.client ?? sessionOwner.client)
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(options.deviceId))
    .send({ userId, pin });
}

/** Issues a token for `who` and returns it, failing the test when refused. */
async function tokenFor(
  who: Member,
  options: { client?: Client; deviceId?: string } = {},
): Promise<string> {
  const response = await startSession(who.userId, PIN, options);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const token = response.body.data.token as string;
  expect(token).toMatch(/^pas_/);
  return token;
}

type CallOptions = {
  client?: Client;
  deviceId?: string;
  outletId?: string;
  token?: string | null;
};

function withIdentity(request: ReturnType<Client["get"]>, o: CallOptions) {
  const base = request
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(o.deviceId));
  return o.token ? base.set(ACTING_HEADER, o.token) : base;
}

/** The call used to find out whether a token still works: list shifts of the device. */
function probe(o: CallOptions = {}) {
  const client = o.client ?? sessionOwner.client;
  const url = `${posBase(o.outletId)}/shifts?deviceId=${o.deviceId ?? device}`;
  return withIdentity(client.get(url), o);
}

function posPost(path: string, body: Record<string, unknown>, o: CallOptions) {
  const client = o.client ?? sessionOwner.client;
  return withIdentity(client.post(`${posBase(o.outletId)}/${path}`), o).send({
    idempotencyKey: randomUUID(),
    ...body,
  });
}

const orderBody = () => ({
  channel: "pos",
  serviceType: "takeaway",
  items: [{ menuItemId: kopi, quantity: 1, modifierIds: [] }],
});

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

async function count(table: string) {
  const sql = `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`;
  return (await owner.query(sql, [tenant.tenantId])).rows[0].n as number;
}

async function actingRows(staffUserId: string) {
  return asOwnerTenant(async (client) => {
    const { rows } = await client.query<{
      revoked_at: string | null;
      revoke_reason: string | null;
      device_id: string;
    }>(
      `SELECT revoked_at, revoke_reason, device_id FROM pos_acting_staff
       WHERE tenant_id = $1 AND staff_user_id = $2 ORDER BY issued_at`,
      [tenant.tenantId, staffUserId],
    );
    return rows;
  });
}

async function actingTotal() {
  return asOwnerTenant(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_acting_staff WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    return rows[0]!.n;
  });
}

function actorColumns(row: Record<string, unknown> | undefined) {
  return Object.entries(row ?? {}).filter(
    ([key, value]) =>
      typeof value === "string" &&
      /(created_by|cashier|actor|opened_by|captured_by)/i.test(key),
  );
}

async function actorsOfShift(shiftId: string) {
  const { rows } = await owner.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(t) AS row FROM pos_shifts t WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, shiftId],
  );
  return actorColumns(rows[0]?.row);
}

function countsFor(totalIdr: number) {
  const lines: { denominationIdr: number; quantity: number }[] = [];
  let rest = totalIdr;
  for (const denominationIdr of [100_000, 50_000, 20_000, 10_000, 5_000]) {
    const quantity = Math.floor(rest / denominationIdr);
    if (quantity > 0) lines.push({ denominationIdr, quantity });
    rest -= quantity * denominationIdr;
  }
  return lines;
}

const FLOAT_IDR = 100_000;

/** B (acting) opens a shift, counts the drawer exactly and asks the supervisor PIN override. */
async function openCountOverride(token: string) {
  const opened = await posPost(
    "shifts",
    { openingFloatIdr: FLOAT_IDR },
    { token },
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const shiftId = opened.body.data.id as string;
  const counted = await posPost(
    `shifts/${shiftId}/counts`,
    { counts: countsFor(FLOAT_IDR) },
    { token },
  );
  expect(counted.status, JSON.stringify(counted.body)).toBe(201);
  const countId = counted.body.data.id as string;
  const override = await sessionOwner.client
    .post("/api/pos-overrides")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .set(ACTING_HEADER, token)
    .set("Idempotency-Key", randomUUID())
    .send({
      outletId: tenant.outletId,
      action: "cash_shift_close",
      valueIdr: 0,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval: {
        method: "supervisor_pin",
        approverUserId: supervisor.userId,
        pin: PIN,
      },
    });
  return { shiftId, countId, override };
}

function closeShift(
  token: string,
  flow: {
    shiftId: string;
    countId: string;
    override: { body: { data: { id: string } } };
  },
) {
  return posPost(
    `shifts/${flow.shiftId}/close`,
    {
      countId: flow.countId,
      approvedBy: supervisor.userId,
      approvalRequestId: flow.override.body.data.id,
    },
    { token },
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`actg-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (deviceId === device || deviceId === device2)
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "POS Kasir Aktif",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ],
    ],
    [roles.limited, "POS Terbatas", ["order.view"]],
    [roles.supervisor, "POS Supervisor Aktif", ["shift.cash.approve_close"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Login", roles.till);
  cashierB = await member("Kasir B", roles.till);
  cashierC = await member("Kasir C", roles.till);
  limited = await member("Staf Terbatas", roles.limited);
  inactive = await member("Staf Nonaktif", roles.till);
  pinReset = await member("Staf Reset PIN", roles.till);
  supervisor = await member("Supervisor", roles.supervisor);
  for (const who of [
    cashierB,
    cashierC,
    limited,
    inactive,
    pinReset,
    supervisor,
  ])
    await givePin(who);

  const { tenantId: t, brandId: b, outletId: o } = tenant;
  const u = sessionOwner.userId;
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Dua', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outlet2,
      t,
      b,
      tenant.legalEntityId,
      `OU2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant((client) =>
    client.query(`
      INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at) VALUES ('${device}', '${t}', '${o}', 'pos', 'Kasir Aktif 1', now() - interval '1 minute');
      INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at) VALUES ('${device2}', '${t}', '${o}', 'pos', 'Kasir Aktif 2', now() - interval '1 minute');
      INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ('${category}', '${t}', '${b}', 'POS Aktif', 0);
      INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ('${kopi}', '${t}', '${b}', '${category}', 'Kopi Susu', true, '${randomUUID()}');
      INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ('${priceList}', '${t}', '${o}', 'takeaway', '2026-01-01');
      INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr) VALUES ('${randomUUID()}', '${t}', '${priceList}', '${kopi}', 25000);
      INSERT INTO tax_settings (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode, tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL, 'fixed_bp', 1, '2026-01-01', 'published', now(), '${u}');
      INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to, price_includes_tax, include_service_in_base, is_active, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'PBJT-ACT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]', '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}', false, true, true, 1, '2026-01-01', 'published', now(), '${u}');
    `),
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-aruta acting cashier token", () => {
  it("issuing a token for the right PIN answers 201 with a pas_ token, the staff and the outlet", async () => {
    const response = await startSession(cashierB.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.token).toMatch(/^pas_/);
    expect(response.body.data.staff.id).toBe(cashierB.userId);
    expect(response.body.data.outletId).toBe(tenant.outletId);
    const expiresAt = new Date(response.body.data.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + 12 * 60 * 60 * 1000 + 60_000,
    );
    const working = await probe({ token: response.body.data.token });
    expect(working.status, JSON.stringify(working.body)).toBe(200);
  });

  it("a wrong PIN is refused with PIN_INVALID and issues no token", async () => {
    const before = await actingTotal();
    const wrong = await startSession(cashierC.userId, WRONG);
    expectError(wrong, 401, "PIN_INVALID");
    expect(wrong.body.data).toBeUndefined();
    expect(await actingTotal()).toBe(before);
    expect(await actingRows(cashierC.userId)).toEqual([]);
  });

  it("a token past its expiry is refused with ACTING_STAFF_EXPIRED", async () => {
    const token = await tokenFor(cashierB);
    expect((await probe({ token })).status).toBe(200);
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE pos_acting_staff
           SET issued_at = now() - interval '2 hours',
               expires_at = now() - interval '1 minute'
         WHERE tenant_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL`,
        [tenant.tenantId, cashierB.userId],
      ),
    );
    expectError(await probe({ token }), 401, "ACTING_STAFF_EXPIRED");
  });

  it("a made-up token and a token without the pas_ prefix are refused with ACTING_STAFF_INVALID", async () => {
    expectError(
      await probe({ token: `pas_${randomUUID()}` }),
      401,
      "ACTING_STAFF_INVALID",
    );
    expectError(
      await probe({ token: "not-a-token" }),
      401,
      "ACTING_STAFF_INVALID",
    );
  });

  it("a token used from another device is refused with ACTING_STAFF_INVALID", async () => {
    const token = await tokenFor(cashierB);
    expect((await probe({ token })).status).toBe(200);
    expectError(
      await probe({ token, deviceId: device2 }),
      401,
      "ACTING_STAFF_INVALID",
    );
  });

  it("a token used from another login session (same user signed in again) is refused with ACTING_STAFF_INVALID", async () => {
    const token = await tokenFor(cashierB);
    const second = agent(app);
    const signedIn = await second
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email: sessionOwner.email, password: PASSWORD });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expectError(
      await probe({ token, client: second }),
      401,
      "ACTING_STAFF_INVALID",
    );
    // The token still works in the session it was issued for.
    expect((await probe({ token })).status).toBe(200);
  });

  it("a token used for another outlet of the tenant is refused with ACTING_STAFF_OUTLET_MISMATCH", async () => {
    const token = await tokenFor(cashierB);
    const response = await posPost("orders", orderBody(), {
      token,
      outletId: outlet2,
    });
    expectError(response, 403, "ACTING_STAFF_OUTLET_MISMATCH");
  });

  it("a new switch on the device revokes the earlier token: ACTING_STAFF_REVOKED, while the new token works", async () => {
    const first = await tokenFor(cashierB);
    expect((await probe({ token: first })).status).toBe(200);
    const second = await tokenFor(cashierC);
    expectError(await probe({ token: first }), 401, "ACTING_STAFF_REVOKED");
    expect((await probe({ token: second })).status).toBe(200);
    const rows = await actingRows(cashierB.userId);
    expect(rows.at(-1)).toMatchObject({ revoke_reason: "switched" });
  });

  it("ending the session answers 204 and revokes the token", async () => {
    const token = await tokenFor(cashierB);
    const ended = await sessionOwner.client
      .post("/api/staff-pins/pos-session/end")
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken());
    expect(ended.status, JSON.stringify(ended.body)).toBe(204);
    expectError(await probe({ token }), 401, "ACTING_STAFF_REVOKED");
    expect((await actingRows(cashierB.userId)).at(-1)).toMatchObject({
      revoke_reason: "ended",
    });
  });

  it("resetting the staff member's PIN revokes their token", async () => {
    const token = await tokenFor(pinReset);
    expect((await probe({ token })).status).toBe(200);
    await givePin(pinReset, NEW_PIN);
    expectError(await probe({ token }), 401, "ACTING_STAFF_REVOKED");
    expect((await actingRows(pinReset.userId)).at(-1)).toMatchObject({
      revoke_reason: "pin_reset",
    });
  });

  it("a staff member who is no longer active is refused with ACTING_STAFF_INACTIVE", async () => {
    const token = await tokenFor(inactive);
    expect((await probe({ token })).status).toBe(200);
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenant.tenantId, inactive.userId],
    );
    expectError(await probe({ token }), 403, "ACTING_STAFF_INACTIVE");
  });

  it("closing the device's shift revokes the acting token: ACTING_STAFF_REVOKED afterwards", async () => {
    const token = await tokenFor(cashierB);
    const flow = await openCountOverride(token);
    expect(flow.override.status, JSON.stringify(flow.override.body)).toBe(201);
    const closed = await closeShift(token, flow);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expectError(await probe({ token }), 401, "ACTING_STAFF_REVOKED");
    expect((await actingRows(cashierB.userId)).at(-1)).toMatchObject({
      revoke_reason: "shift_closed",
    });
  });

  it("a staff member without the permission gets PERMISSION_DENIED even though the session owner has it", async () => {
    const token = await tokenFor(limited);
    const ordersBefore = await count("orders");
    const denied = await posPost("orders", orderBody(), { token });
    expectError(denied, 403, "PERMISSION_DENIED");
    expect(await count("orders")).toBe(ordersBefore);
  });

  it("the session owner's permissions are not inherited: opening a shift as a limited staff member is denied and records nothing", async () => {
    const token = await tokenFor(limited);
    const shiftsBefore = await count("pos_shifts");
    const denied = await posPost(
      "shifts",
      { openingFloatIdr: FLOAT_IDR },
      { token },
    );
    expectError(denied, 403, "PERMISSION_DENIED");
    expect(await count("pos_shifts")).toBe(shiftsBefore);
  });

  it("sending the acting header to receipt write-off is refused with ACTING_STAFF_NOT_ALLOWED and writes nothing", async () => {
    const token = await tokenFor(cashierB);
    const before = await count("receipt_number_writeoffs");
    const response = await posPost(
      "receipt-writeoffs",
      { prefix: "AC", sequenceNumber: 1, reason: "Struk hilang saat uji" },
      { token },
    );
    expectError(response, 403, "ACTING_STAFF_NOT_ALLOWED");
    expect(await count("receipt_number_writeoffs")).toBe(before);
  });

  it("a supervisor override asked while a cashier is acting names the acting cashier as requester", async () => {
    const token = await tokenFor(cashierB);
    const flow = await openCountOverride(token);
    expect(flow.override.status, JSON.stringify(flow.override.body)).toBe(201);
    const { rows } = await owner.query<{
      requested_by: string;
      approved_by: string;
    }>(
      `SELECT requested_by::text AS requested_by, approved_by::text AS approved_by
       FROM pos_overrides
       WHERE tenant_id = $1 AND object_id::text = $2 AND method = 'supervisor_pin'`,
      [tenant.tenantId, flow.countId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requested_by).toBe(cashierB.userId);
    expect(rows[0]!.approved_by).toBe(supervisor.userId);
    expect(rows[0]!.requested_by).not.toBe(sessionOwner.userId);
    // Leave the device clean for later tests.
    const closed = await closeShift(token, flow);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("without the header the old behaviour stays: the session owner is the actor", async () => {
    const opened = await posPost(
      "shifts",
      { openingFloatIdr: FLOAT_IDR },
      { deviceId: device2 },
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const recorded = await actorsOfShift(opened.body.data.id);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).toEqual(
      recorded.map(([key]) => [key, sessionOwner.userId]),
    );
  });
});

describe("legend-aruta acting cashier token: edge cases", () => {
  const MFA_DAY = "2025-01-15";
  const extraRoles = { manager: randomUUID(), mfaTill: randomUUID() };
  let manager: Member;
  let mfaOwner: Member; // session on the till, MFA verified
  let mfaStaff: Member; // same MFA role, acting through a PIN

  beforeAll(async () => {
    const defs: [string, string, string[], boolean][] = [
      [extraRoles.manager, "POS Manajer Aktif", ["pos.day.close"], false],
      [
        extraRoles.mfaTill,
        "POS Kasir MFA",
        ["order.view", "shift.cash.operate"],
        true,
      ],
    ];
    for (const [id, name, permissions, mfa] of defs)
      await owner.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         VALUES ($1, $2, $3, false, NULL, $4, $5, '["tenant"]')`,
        [id, tenant.tenantId, name, JSON.stringify(permissions), mfa],
      );
    manager = await member("Manajer Tutup Hari", extraRoles.manager);
    mfaOwner = await member("Sesi MFA", extraRoles.mfaTill);
    mfaStaff = await member("Staf MFA", extraRoles.mfaTill);
    await verifySessionMfa(mfaOwner.email);
    await givePin(mfaStaff);
  });

  it("closing the business day revokes every live acting token of the outlet: ACTING_STAFF_REVOKED with reason day_closed", async () => {
    const token = await tokenFor(cashierB);
    expect((await probe({ token })).status).toBe(200);
    const closed = await manager.client
      .post(`${posBase()}/day/close`)
      .set(headers)
      .set(originHeader)
      .send({
        businessDate: MFA_DAY,
        inventoryDeduction: false,
        idempotencyKey: randomUUID(),
      });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expectError(await probe({ token }), 401, "ACTING_STAFF_REVOKED");
    expect((await actingRows(cashierB.userId)).at(-1)).toMatchObject({
      revoke_reason: "day_closed",
    });
  });

  it("the session owner's verified MFA is not inherited: with an acting staff member the access snapshot reports mfaVerified=false", async () => {
    // No POS route enforces an MFA-gated permission over HTTP, so this checks
    // the decision input itself: loadRequestAccess (permissions middleware).
    const sessionId = (await mfaOwner.client.get("/api/auth/get-session")).body
      .session.id as string;
    const fakeRequest = (acting: boolean, userId: string) => {
      const req = {
        headers: {},
        auth: { user: { id: mfaOwner.userId }, session: { id: sessionId } },
        ...(acting
          ? {
              actingStaff: {
                staffUserId: userId,
                sessionUserId: mfaOwner.userId,
                tokenId: randomUUID(),
                outletId: tenant.outletId,
              },
            }
          : {}),
      };
      fakeTenantContexts.set(req, tenantCtx());
      return req as unknown as Parameters<typeof loadRequestAccess>[0];
    };
    // Control: the session owner acting as themself has verified MFA.
    const own = await loadRequestAccess(fakeRequest(false, mfaOwner.userId));
    expect(own.userId).toBe(mfaOwner.userId);
    expect(own.mfaRequired).toBe(true);
    expect(own.mfaVerified).toBe(true);
    // Same session, but the actor is the PIN-authenticated staff member.
    const staff = await loadRequestAccess(fakeRequest(true, mfaStaff.userId));
    expect(staff.userId).toBe(mfaStaff.userId);
    expect(staff.mfaRequired).toBe(true);
    expect(staff.mfaVerified).toBe(false);
  });

  it("the acting header on a router without the acting-staff middleware is refused with 400 ACTING_STAFF_UNSUPPORTED, never ignored", async () => {
    const token = await tokenFor(cashierB);
    const response = await sessionOwner.client
      .get(`/api/outlets/${encodeURIComponent(tenant.outletId)}/floor`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .set(ACTING_HEADER, token);
    expectError(response, 400, "ACTING_STAFF_UNSUPPORTED");
  });

  it("the same Idempotency-Key reused with a different acting staff member is 409 IDEMPOTENCY_KEY_REUSED; the same staff member replays", async () => {
    const idempotencyKey = randomUUID();
    const tokenB = await tokenFor(cashierB);
    const first = await posPost(
      "orders",
      { ...orderBody(), idempotencyKey },
      { token: tokenB },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await posPost(
      "orders",
      { ...orderBody(), idempotencyKey },
      { token: tokenB },
    );
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const ordersBefore = await count("orders");
    const tokenC = await tokenFor(cashierC);
    const reused = await posPost(
      "orders",
      { ...orderBody(), idempotencyKey },
      { token: tokenC },
    );
    expectError(reused, 409, "IDEMPOTENCY_KEY_REUSED");
    expect(await count("orders")).toBe(ordersBefore);
  });

  it("two simultaneous pos-session issues on one device leave exactly one live token", async () => {
    await sessionOwner.client
      .post("/api/staff-pins/pos-session/end")
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken());
    const [a, b] = await Promise.all([
      startSession(cashierB.userId, PIN),
      startSession(cashierC.userId, PIN),
    ]);
    // Assumption: serialized issues may both answer 201 (the later one switches
    // the earlier one) or the loser may get 409 CONFLICT. Either way exactly one
    // token stays live; any refusal is 409 CONFLICT and issues nothing.
    for (const r of [a, b].filter((x) => x.status !== 201))
      expectError(r, 409, "CONFLICT");
    const winners = [a, b].filter((r) => r.status === 201);
    expect(winners.length).toBeGreaterThan(0);
    const live = await asOwnerTenant(async (client) => {
      const { rows } = await client.query<{ staff_user_id: string }>(
        `SELECT staff_user_id FROM pos_acting_staff
         WHERE tenant_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [tenant.tenantId, device],
      );
      return rows;
    });
    expect(live).toHaveLength(1);
    const liveWinners = [];
    for (const w of winners) {
      const status = (await probe({ token: w.body.data.token })).status;
      if (status === 200) liveWinners.push(w);
      else
        expectError(
          await probe({ token: w.body.data.token }),
          401,
          "ACTING_STAFF_REVOKED",
        );
    }
    expect(liveWinners).toHaveLength(1);
    expect(liveWinners[0]!.body.data.staff.id).toBe(live[0]!.staff_user_id);
  });
});
