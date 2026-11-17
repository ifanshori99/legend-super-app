// legend-jqurl: the login session remembers EVERY shared device it touched
// (`session.shared_device_ids uuid[]`, replacing the single `shared_device_id`).
// Written from the card brief, not from the implementation.
//
// Rules under test:
//  - A stamp appends the device id (no duplicate). The list holds at most 8 ids.
//    When it is full and the new id is absent: the OLDEST INACTIVE mark (device
//    unflagged, revoked or gone) is dropped and the new id added; when all 8 are
//    still active and flagged the new id is NOT added and the list is unchanged,
//    so a live mark can never be pushed out.
//  - The guard refuses a request (401 ACTING_STAFF_REQUIRED) when ANY marked
//    device is still active and flagged, in ANY tenant of the same login
//    (the cookie is shared across tenants through the parent cookie domain).
//    The mark lapses only when every marked device is unflagged/revoked/gone.
//  - Early stamp: a request on a route that is NOT guarded but is behind
//    requireAuth, carrying the validly signed token of an active flagged device,
//    stamps the session (tenant taken from the token payload). Unflagged devices
//    stamp nothing; a badly signed token stamps nothing and does not break the
//    request.
//
// legend-sq1ux / legend-dn7uo (brief 1006): sign-in itself stamps the new session
// from X-Device-Token, and a 9th live shared device is REFUSED (403
// SHARED_DEVICE_MARK_LIMIT) instead of passing as owner; the mark list is then
// unchanged and `markSessionSharedDevice` answers false.
//
// Assumptions:
//  - The non-guarded requireAuth route is GET /api/me/access (answers 200 to any
//    signed-in account, 401 anonymously). It is sent WITHOUT a Host header so the
//    tenant can only come from the token payload.
//  - The guarded route is GET /api/outlets/:outletId/pos/parked-orders (same as
//    acting-staff-shared-device.test.ts); header-less it answers 200 when no
//    marked device is flagged, 401 ACTING_STAFF_REQUIRED otherwise.
//  - The cap tests stamp real, active, flagged devices through the service
//    function `markSessionSharedDevice(sessionId, deviceId)`; "newest" is the
//    most recently stamped id; "oldest" means first stamped, assuming the array
//    keeps stamp order (append). When several marks are inactive, exactly the
//    oldest inactive one is dropped (only one is asserted gone per stamp).
//  - Postgres rule `devices_shared_mode_pos_only`: CHECK (NOT shared_mode OR type =
//    'pos'); violations raise 23514.
//  - A "badly signed" token is a real token with its signature tail replaced, plus
//    a plain garbage string. Only "request still answers 200 and stamps nothing"
//    is asserted.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, setRole, signUp } from "./helpers.ts";
import { requestSupportAccess } from "../services/platform-support.service.ts";
import { requestSupportAccessInputSchema } from "@starter/shared/platform";

import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const REQUIRED_CODE = "ACTING_STAFF_REQUIRED";
const POS_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "shift.cash.operate",
  "floor.table.view",
  "floor.table.operate",
  "floor.table.manage",
  "kds.ticket.process",
  "kds.station.manage",
];

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string; sessionId: string };

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
// device id -> tenant it is registered in (for the outlet resolver)
const knownDevices = new Map<string, IsolatedTenant>();
const supportAdminIds: string[] = [];

async function addRole(tenant: IsolatedTenant): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Tanda Perangkat', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(POS_PERMISSIONS)],
  );
  return roleId;
}

const roles = new Map<string, string>();

async function assign(tenant: IsolatedTenant, userId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roles.get(tenant.tenantId)],
  );
}

/** A fresh login (one session) with the POS role in tenant A and tenant B. */
async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await assign(tenantA, userId);
  await assign(tenantB, userId);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session" WHERE user_id = $1`,
    [userId],
  );
  expect(rows).toHaveLength(1);
  return { client, userId, sessionId: rows[0]!.id };
}

async function newDevice(
  tenant: IsolatedTenant,
  flagged: boolean,
): Promise<string> {
  const id = randomUUID();
  knownDevices.set(id, tenant);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, tenant.tenantId, tenant.outletId, `Kasir Tanda ${id.slice(0, 6)}`],
  );
  if (flagged) await setFlag(id, true);
  return id;
}

const setFlag = (id: string, value: boolean) =>
  owner.query("UPDATE devices SET shared_mode = $2 WHERE id = $1", [id, value]);

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: knownDevices.get(deviceId)!.tenantId,
    brandId: null,
    deviceId,
  });

async function marks(who: Member): Promise<string[]> {
  const { rows } = await owner.query<{ ids: string[] }>(
    `SELECT shared_device_ids::text[] AS ids FROM "session" WHERE id = $1`,
    [who.sessionId],
  );
  return rows[0]!.ids;
}

/**
 * A refused 9th device ends the login session: a normal session keeps its row
 * with revoked_at set (and an expiry in the past); an impersonated one is
 * deleted. Either way the session is no longer usable.
 */
async function sessionEnded(who: Member): Promise<boolean> {
  const { rows } = await owner.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM "session" WHERE id = $1`,
    [who.sessionId],
  );
  return rows.length === 0 || rows[0]!.revoked_at !== null;
}

/** Guarded route of a tenant; `deviceId` adds that device's token header. */
const parked = (who: Member, tenant: IsolatedTenant, deviceId?: string) => {
  let request = who.client
    .get(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/parked-orders`,
    )
    .set({ Host: tenant.hostname })
    .set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
  return request;
};

/** Non-guarded route that only needs requireAuth; no Host header on purpose. */
const access = (who: Member, tokenHeader?: string) => {
  let request = who.client.get("/api/me/access").set(originHeader);
  if (tokenHeader) request = request.set(DEVICE_TOKEN_HEADER, tokenHeader);
  return request;
};

function expectRequired(response: { status: number; body: unknown }) {
  const body = response.body as { error?: { code?: string; message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(401);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(REQUIRED_CODE);
  expect(body.error?.message ?? "").not.toBe("");
}

function expectLimit(response: { status: number; body: unknown }) {
  const body = response.body as { error?: { code?: string; message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(
    "SHARED_DEVICE_MARK_LIMIT",
  );
  expect(body.error?.message ?? "").not.toBe("");
}

function expectUnauthorized(response: { status: number; body: unknown }) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(401);
  expect(body.error?.code, JSON.stringify(response.body)).toBe("UNAUTHORIZED");
}

function expectOk(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

beforeAll(async () => {
  app = createApp();
  tenantA = await createIsolatedTenant(`mka-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`mkb-${randomUUID().slice(0, 6)}`);
  roles.set(tenantA.tenantId, await addRole(tenantA));
  roles.set(tenantB.tenantId, await addRole(tenantB));
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    const tenant = knownDevices.get(deviceId);
    return tenant && tenant.tenantId === tenantId ? tenant.outletId : null;
  });
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query(
    "DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])",
    [supportAdminIds],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [supportAdminIds],
  );
  for (const t of [tenantA, tenantB]) {
    await owner.query("DELETE FROM staff_pins WHERE tenant_id = $1", [
      t.tenantId,
    ]);
    await owner.query("DELETE FROM devices WHERE tenant_id = $1", [t.tenantId]);
  }
  await dropIsolatedTenant(tenantA);
  await dropIsolatedTenant(tenantB);
  await owner.end();
});

describe("shared device marks: several devices on one session", () => {
  it("a second flagged device does not erase the first mark", async () => {
    const a = await newDevice(tenantA, true);
    const b = await newDevice(tenantA, true);
    const who = await member("Sesi Dua Perangkat");

    expectRequired(await parked(who, tenantA, a));
    expectRequired(await parked(who, tenantA, b));
    const ids = await marks(who);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).toHaveLength(2);

    // B is unflagged, A still is: a header-less request is still refused.
    await setFlag(b, false);
    expectRequired(await parked(who, tenantA));

    // Every marked device unflagged: the old behaviour returns.
    await setFlag(a, false);
    expectOk(await parked(who, tenantA));
  });

  it("an unflagged device's valid token does not let a session with a live mark escape", async () => {
    const a = await newDevice(tenantA, true);
    const plain = await newDevice(tenantA, false);
    const who = await member("Sesi Tukar Header");
    expectRequired(await parked(who, tenantA, a));
    expectRequired(await parked(who, tenantA, plain));
    expect(await marks(who)).toEqual([a]);
  });

  it("a mark on a revoked device lapses; a mark on another still flagged device keeps the refusal", async () => {
    const a = await newDevice(tenantA, true);
    const b = await newDevice(tenantA, true);
    const who = await member("Sesi Cabut Sebagian");
    expectRequired(await parked(who, tenantA, a));
    expectRequired(await parked(who, tenantA, b));

    await owner.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [a],
    );
    expectRequired(await parked(who, tenantA));
    await owner.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [b],
    );
    expectOk(await parked(who, tenantA));
  });
});

describe("shared device marks: another tenant of the same login", () => {
  it("a mark from a flagged device of tenant A refuses a guarded route of tenant B until A's device is unflagged", async () => {
    const deviceOfA = await newDevice(tenantA, true);
    const who = await member("Sesi Lintas Tenant");
    expectRequired(await parked(who, tenantA, deviceOfA));
    expect(await marks(who)).toEqual([deviceOfA]);

    // Cookie only, no device header, Host of tenant B.
    expectRequired(await parked(who, tenantB));

    await setFlag(deviceOfA, false);
    expectOk(await parked(who, tenantB));
    expectOk(await parked(who, tenantA));
  });

  it("a session that never touched a flagged device is open in both tenants", async () => {
    await newDevice(tenantA, true);
    const who = await member("Sesi Bersih Lintas");
    expectOk(await parked(who, tenantA));
    expectOk(await parked(who, tenantB));
    expect(await marks(who)).toEqual([]);
  });
});

describe("shared device marks: early stamp on a route that is not guarded", () => {
  it("a flagged device's token on GET /api/me/access marks the session, and the cookie alone is then refused on a guarded route", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await member("Sesi Tanda Awal");
    expect(await marks(who)).toEqual([]);

    expectOk(await access(who, tokenOf(flagged)));
    expect(await marks(who)).toEqual([flagged]);

    expectRequired(await parked(who, tenantA));
  });

  it("an unflagged device's token stamps nothing", async () => {
    const plain = await newDevice(tenantA, false);
    const who = await member("Sesi Tanpa Bendera");
    expectOk(await access(who, tokenOf(plain)));
    expect(await marks(who)).toEqual([]);
    expectOk(await parked(who, tenantA));
  });

  it("a revoked device's token stamps nothing", async () => {
    const gone = await newDevice(tenantA, true);
    await owner.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [gone],
    );
    const who = await member("Sesi Perangkat Dicabut");
    // Status of the request itself is not fixed (the route's own checks decide).
    await access(who, tokenOf(gone));
    expect(await marks(who)).toEqual([]);
    expectOk(await parked(who, tenantA));
  });

  it("a garbage token stamps nothing and does not break the request", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await member("Sesi Token Sampah");
    expectOk(await access(who, "not-a-device-token"));
    expect(await marks(who)).toEqual([]);

    // A real token with a damaged signature behaves the same.
    const damaged = `${tokenOf(flagged).slice(0, -6)}AAAAAA`;
    expectOk(await access(who, damaged));
    expect(await marks(who)).toEqual([]);

    // Nothing was stamped, so the cookie alone is still open.
    expectOk(await parked(who, tenantA));
  });

  it("an anonymous request with a flagged device's token is still 401 and stamps no session", async () => {
    const flagged = await newDevice(tenantA, true);
    const response = await agent(app)
      .get("/api/me/access")
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, tokenOf(flagged));
    expect(response.status, JSON.stringify(response.body)).toBe(401);
  });
});

describe("shared device marks: stamp function", () => {
  it("stamping the same device twice leaves one id", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await member("Sesi Tanpa Duplikat");
    await markSessionSharedDevice(who.sessionId, flagged);
    await markSessionSharedDevice(who.sessionId, flagged);
    expect(await marks(who)).toEqual([flagged]);

    // The same through requests: two guarded calls from the same device.
    expectRequired(await parked(who, tenantA, flagged));
    expectRequired(await parked(who, tenantA, flagged));
    expect(await marks(who)).toEqual([flagged]);
  });
});

/** A fresh session whose mark list holds 8 active, flagged devices (oldest first). */
async function fullSession(label: string) {
  const who = await member(label);
  const devices: string[] = [];
  for (let i = 0; i < 8; i += 1) devices.push(await newDevice(tenantA, true));
  for (const id of devices) await markSessionSharedDevice(who.sessionId, id);
  expect([...(await marks(who))].sort()).toEqual([...devices].sort());
  return { who, devices };
}

const revoke = (id: string) =>
  owner.query(
    "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
    [id],
  );

describe("shared device marks: cap of 8 never evicts a live mark", () => {
  it("stamp function on a full live session returns false for a 9th device, true for an already marked one", async () => {
    const { who, devices } = await fullSession("Sesi Penuh Nilai Balik");
    const ninth = await newDevice(tenantA, true);
    // The stamp function reports it could not mark (false), and does not add.
    expect(await markSessionSharedDevice(who.sessionId, ninth)).toBe(false);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(ninth);
    expect([...ids].sort()).toEqual([...devices].sort());
    // A device already marked still reports true.
    expect(await markSessionSharedDevice(who.sessionId, devices[0]!)).toBe(
      true,
    );
  });

  it("8 active flagged marks: a 9th device on a guarded route is refused 403 SHARED_DEVICE_MARK_LIMIT and the login session is revoked", async () => {
    const { who } = await fullSession("Sesi Penuh Aktif");
    const ninth = await newDevice(tenantA, true);

    // Refused, not owner-passed.
    expectLimit(await parked(who, tenantA, ninth));
    // The refusal revokes the login session (revoked or gone).
    expect(await sessionEnded(who)).toBe(true);

    // The cookie is dead everywhere, with or without a device header.
    expectUnauthorized(await parked(who, tenantA));
    expectUnauthorized(await parked(who, tenantB));
    expectUnauthorized(await access(who));
  });

  it("8 active flagged marks: a 9th device on a non-guarded requireAuth route is refused 403 SHARED_DEVICE_MARK_LIMIT and the session is revoked", async () => {
    const { who } = await fullSession("Sesi Penuh Rute Bebas");
    const ninth = await newDevice(tenantA, true);

    expectLimit(await access(who, tokenOf(ninth)));
    expect(await sessionEnded(who)).toBe(true);
    expectUnauthorized(await access(who));
    expectUnauthorized(await parked(who, tenantA));
  });

  it("8 old marks unflagged after a refused 9th: the old residual hole is closed, the cookie stays 401 UNAUTHORIZED", async () => {
    const { who, devices } = await fullSession("Sesi Sembilan Ditolak");
    const ninth = await newDevice(tenantA, true);

    // The 9th-device request is refused outright (not a 200 owner pass), and
    // the session is revoked before the 403 is sent.
    expectLimit(await parked(who, tenantA, ninth));
    expect(await sessionEnded(who)).toBe(true);

    // Devices 1-8 lapse. Before the fix the cookie alone passed as owner here.
    for (const id of devices) await setFlag(id, false);
    expectUnauthorized(await parked(who, tenantA));
    expectUnauthorized(await parked(who, tenantB));
    expectUnauthorized(await access(who));
    // The 9th device is not an owner pass either: still no session.
    expectUnauthorized(await parked(who, tenantA, ninth));
  });

  it("an impersonated (support) session at the 8-mark limit gets 403 SHARED_DEVICE_MARK_LIMIT, the row is deleted and impersonation_ended (cause revoked) is audited", async () => {
    // Assumption: a support grant for tenant A plus the tenant user's POS role
    // in tenant A is enough to impersonate (same flow as
    // impersonation-grant.test.ts); the admin client then carries the
    // impersonated session cookie.
    const target = await member("Pemilik Dukungan Penuh");
    const devices: string[] = [];
    for (let i = 0; i < 8; i += 1) devices.push(await newDevice(tenantA, true));

    const adminClient = agent(app);
    const adminEmail = await signUp(adminClient, "Admin Dukungan Penuh");
    await setRole(adminEmail, "admin");
    const adminId = (await adminClient.get("/api/auth/get-session")).body.user
      .id as string;
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      adminId,
    ]);
    supportAdminIds.push(adminId);
    const grant = await requestSupportAccess({
      tenantId: tenantA.tenantId,
      actorUserId: adminId,
      request: requestSupportAccessInputSchema.parse({
        reason: "Menelusuri keluhan pelanggan atas perangkat bersama.",
        mfaCode: "123456",
      }),
      mfaVerifiedAt: new Date().toISOString(),
      now: new Date(),
    });
    const started = await adminClient
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: target.userId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const supportSessionId = (await adminClient.get("/api/auth/get-session"))
      .body.session.id as string;
    expect(supportSessionId).not.toBe(target.sessionId);
    const support: Member = {
      client: adminClient,
      userId: target.userId,
      sessionId: supportSessionId,
    };
    for (const id of devices)
      await markSessionSharedDevice(supportSessionId, id);
    expect([...(await marks(support))].sort()).toEqual([...devices].sort());

    const ninth = await newDevice(tenantA, true);
    expectLimit(await parked(support, tenantA, ninth));

    // An impersonated session is deleted, not kept as a revoked row.
    const rows = await owner.query(`SELECT 1 FROM "session" WHERE id = $1`, [
      supportSessionId,
    ]);
    expect(rows.rowCount).toBe(0);
    // The tenant user's own session is untouched.
    expect(await sessionEnded(target)).toBe(false);

    const { rows: audit } = await owner.query<{
      event: {
        actorId: string | null;
        objectId: string | null;
        maskedChanges: { after: Record<string, unknown> | null };
      };
    }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'support_access.impersonation_ended'
          AND event->>'actorId' = $2`,
      [tenantA.tenantId, adminId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event.objectId).toBe(grant.id);
    expect(audit[0]!.event.maskedChanges.after).toMatchObject({
      impersonatedUserId: target.userId,
      impersonationId: supportSessionId,
      cause: "revoked",
    });
  });

  it("POST /api/staff-pins/pos-session on a full live session with a 9th device token: 403 SHARED_DEVICE_MARK_LIMIT, no acting-staff token", async () => {
    const PIN = "582914";
    const { who, devices } = await fullSession("Sesi Penuh PIN");
    const cashier = await member("Kasir Sesi Penuh PIN");
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantA.tenantId),
        brandId: null,
        source: "session",
      }),
      cashier.userId,
      { outletId: tenantA.outletId, userId: cashier.userId },
      { pin: PIN },
    );
    const ninth = await newDevice(tenantA, true);

    const response = await who.client
      .post("/api/staff-pins/pos-session")
      .set({ Host: tenantA.hostname })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, tokenOf(ninth))
      .send({ userId: cashier.userId, pin: PIN });
    expectLimit(response);
    expect(JSON.stringify(response.body)).not.toContain('"token"');
    expect((response.body as { data?: unknown }).data).toBeUndefined();

    // The login session is revoked before the 403 (row revoked) and the
    // cookie is 401 UNAUTHORIZED afterwards, also once devices 1-8 lapse.
    expect(await sessionEnded(who)).toBe(true);
    for (const id of devices) await setFlag(id, false);
    expectUnauthorized(await parked(who, tenantA));
    expectUnauthorized(await access(who));
  });

  it("8 marks, the oldest unflagged: it leaves, the 9th enters, the other 7 stay", async () => {
    const { who, devices } = await fullSession("Sesi Tertua Tak Aktif");
    await setFlag(devices[0]!, false);
    const ninth = await newDevice(tenantA, true);

    await markSessionSharedDevice(who.sessionId, ninth);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(devices[0]);
    expect(ids).toContain(ninth);
    for (const id of devices.slice(1)) expect(ids).toContain(id);
  });

  it("8 marks, the oldest revoked: it leaves, the 9th enters, the other 7 stay", async () => {
    const { who, devices } = await fullSession("Sesi Tertua Dicabut");
    await revoke(devices[0]!);
    const ninth = await newDevice(tenantA, true);

    await markSessionSharedDevice(who.sessionId, ninth);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(devices[0]);
    expect(ids).toContain(ninth);
    for (const id of devices.slice(1)) expect(ids).toContain(id);
  });

  it("8 marks, the oldest device no longer exists: it leaves, the 9th enters, the other 7 stay", async () => {
    const { who, devices } = await fullSession("Sesi Tertua Hilang");
    await owner.query("DELETE FROM devices WHERE id = $1", [devices[0]]);
    const ninth = await newDevice(tenantA, true);

    await markSessionSharedDevice(who.sessionId, ninth);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(devices[0]);
    expect(ids).toContain(ninth);
    for (const id of devices.slice(1)) expect(ids).toContain(id);
  });

  it("8 marks, an inactive one in the middle (not the oldest): that one leaves, the oldest active stays", async () => {
    const { who, devices } = await fullSession("Sesi Tengah Tak Aktif");
    await setFlag(devices[4]!, false);
    const ninth = await newDevice(tenantA, true);

    await markSessionSharedDevice(who.sessionId, ninth);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(devices[4]);
    expect(ids).toContain(ninth);
    expect(ids).toContain(devices[0]);
    for (const id of devices.filter((_, i) => i !== 4))
      expect(ids).toContain(id);
  });

  it("8 marks with several inactive: only one inactive mark (the oldest inactive) is dropped per new stamp", async () => {
    const { who, devices } = await fullSession("Sesi Beberapa Tak Aktif");
    await setFlag(devices[2]!, false);
    await setFlag(devices[5]!, false);
    const ninth = await newDevice(tenantA, true);

    await markSessionSharedDevice(who.sessionId, ninth);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    expect(ids).toContain(ninth);
    expect(ids).not.toContain(devices[2]);
    expect(ids).toContain(devices[5]);
    for (const id of [0, 1, 3, 4, 6, 7].map((i) => devices[i]!))
      expect(ids).toContain(id);
  });

  it("stamping one of its own ids on a full session stays at 8 and drops nothing", async () => {
    const { who, devices } = await fullSession("Sesi Delapan Sama");
    await markSessionSharedDevice(who.sessionId, devices[0]!);
    const ids = await marks(who);
    expect(ids).toHaveLength(8);
    for (const id of devices) expect(ids).toContain(id);
  });

  it("attack: flag/unflag churn on other devices never evicts the live mark D, and header-less stays refused", async () => {
    const who = await member("Sesi Serangan Tanda");
    const d = await newDevice(tenantA, true);
    await markSessionSharedDevice(who.sessionId, d);
    const others: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = await newDevice(tenantA, true);
      others.push(id);
      await markSessionSharedDevice(who.sessionId, id);
    }
    expect(await marks(who)).toHaveLength(8);

    for (let round = 0; round < 6; round += 1) {
      // Everything active: a new flagged device cannot push anything out.
      const blocked = await newDevice(tenantA, true);
      await markSessionSharedDevice(who.sessionId, blocked);
      expect(await marks(who)).not.toContain(blocked);

      // The attacker unflags one other device, then stamps a fresh flagged one.
      const victim = others.shift()!;
      await setFlag(victim, false);
      const fresh = await newDevice(tenantA, true);
      await markSessionSharedDevice(who.sessionId, fresh);
      others.push(fresh);

      const ids = await marks(who);
      expect(ids).toHaveLength(8);
      expect(ids).toContain(d);
      expect(ids).toContain(fresh);
      expect(ids).not.toContain(victim);
      expectRequired(await parked(who, tenantA));
    }

    // Also unflag everything but D: D alone keeps the refusal; unflag D: open.
    for (const id of others) await setFlag(id, false);
    expectRequired(await parked(who, tenantA));
    expectRequired(await parked(who, tenantB));
    await setFlag(d, false);
    expectOk(await parked(who, tenantA));
  });
});

describe("shared device marks: sign-in with a shared device token stamps the new session (legend-sq1ux)", () => {
  // Assumption: Better Auth's sign-in endpoint is POST /api/auth/sign-in/email
  // and the X-Device-Token header on it is the device token of the tablet.
  // signUp() uses password "Test-password-123!".
  const PASSWORD = "Test-password-123!";

  async function signInFresh(label: string, tokenHeader?: string) {
    const first = agent(app);
    const email = await signUp(first, label);
    const userId = (await first.get("/api/auth/get-session")).body.user
      .id as string;
    await assign(tenantA, userId);
    await assign(tenantB, userId);
    const before = await owner.query<{ id: string }>(
      `SELECT id FROM "session" WHERE user_id = $1`,
      [userId],
    );
    const client = agent(app);
    let request = client.post("/api/auth/sign-in/email").set(originHeader);
    if (tokenHeader) request = request.set(DEVICE_TOKEN_HEADER, tokenHeader);
    const response = await request.send({ email, password: PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const known = new Set(before.rows.map((r) => r.id));
    const after = await owner.query<{ id: string }>(
      `SELECT id FROM "session" WHERE user_id = $1`,
      [userId],
    );
    const fresh = after.rows.filter((r) => !known.has(r.id));
    expect(fresh).toHaveLength(1);
    return { client, userId, sessionId: fresh[0]!.id } as Member;
  }

  it("sign-in with the token of an active shared device: cookie-only POS request is 401 ACTING_STAFF_REQUIRED in both tenants", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await signInFresh("Masuk Perangkat Bersama", tokenOf(flagged));
    expect(await marks(who)).toEqual([flagged]);
    expectRequired(await parked(who, tenantA));
    expectRequired(await parked(who, tenantB));
  });

  it("sign-in with an unflagged (private) device token stamps nothing and the cookie works", async () => {
    const privateDevice = await newDevice(tenantA, false);
    const who = await signInFresh(
      "Masuk Perangkat Pribadi",
      tokenOf(privateDevice),
    );
    expect(await marks(who)).toEqual([]);
    expectOk(await parked(who, tenantA));
    expectOk(await parked(who, tenantB));
  });

  it("sign-in with a garbage token succeeds, stamps nothing and the cookie works", async () => {
    const flagged = await newDevice(tenantA, true);
    const good = tokenOf(flagged);
    for (const [name, value] of [
      ["no dots", "abc"],
      ["tampered signature", `${good.slice(0, -6)}AAAAAA`],
      ["very long", "a".repeat(4000)],
    ] as const) {
      const who = await signInFresh(`Masuk Token Rusak ${name}`, value);
      expect(await marks(who), name).toEqual([]);
      expectOk(await parked(who, tenantA));
    }
  });

  it("sign-in without any token header stamps nothing", async () => {
    const who = await signInFresh("Masuk Tanpa Token");
    expect(await marks(who)).toEqual([]);
    expectOk(await parked(who, tenantA));
  });

  it("sign-in with a revoked shared device token stamps nothing", async () => {
    const flagged = await newDevice(tenantA, true);
    await revoke(flagged);
    const who = await signInFresh("Masuk Perangkat Dicabut", tokenOf(flagged));
    expect(await marks(who)).toEqual([]);
    expectOk(await parked(who, tenantA));
  });
});

describe("shared device marks: a badly signed token never breaks requireAuth", () => {
  // Assumption: "treated as no stamp" means the route answers exactly as it
  // would without the header, and never 500.
  const variants = (flaggedToken: string) =>
    [
      ["empty-ish", " "],
      ["no dots", "abc"],
      ["tampered signature", `${flaggedToken.slice(0, -6)}AAAAAA`],
      ["tampered payload", `x${flaggedToken}`],
      ["truncated", flaggedToken.slice(0, Math.floor(flaggedToken.length / 2))],
      ["very long", "a".repeat(4000)],
    ] as const;

  it("every malformed variant answers like a request without the header and stamps nothing", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await member("Sesi Tanda Tangan Buruk");
    for (const [name, value] of variants(tokenOf(flagged))) {
      const response = await access(who, value);
      expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(
        200,
      );
      expect(await marks(who), name).toEqual([]);
    }
    expectOk(await parked(who, tenantA));
  });

  it("on a session that already has a live mark, a bad token neither errors nor clears it", async () => {
    const flagged = await newDevice(tenantA, true);
    const who = await member("Sesi Tanda Hidup Token Buruk");
    expectRequired(await parked(who, tenantA, flagged));
    for (const [name, value] of variants(tokenOf(flagged))) {
      const response = await access(who, value);
      expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(
        200,
      );
    }
    expect(await marks(who)).toEqual([flagged]);
    expectRequired(await parked(who, tenantA));
  });
});

describe("shared device database rule: shared_mode only on POS devices", () => {
  const tenantFor = () => tenantA;

  it("setting shared_mode = true on a kds device is rejected by the database (23514)", async () => {
    const tenant = tenantFor();
    const id = randomUUID();
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'kds', $4, now() - interval '1 minute')`,
      [id, tenant.tenantId, tenant.outletId, `Layar Dapur ${id.slice(0, 6)}`],
    );
    await expect(
      owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [id]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "devices_shared_mode_pos_only",
    });
    const { rows } = await owner.query<{ shared_mode: boolean }>(
      "SELECT shared_mode FROM devices WHERE id = $1",
      [id],
    );
    expect(rows[0]!.shared_mode).toBe(false);
  });

  it("inserting a kds device already flagged is rejected (23514)", async () => {
    const tenant = tenantFor();
    const id = randomUUID();
    await expect(
      owner.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
         VALUES ($1, $2, $3, 'kds', $4, now() - interval '1 minute', true)`,
        [id, tenant.tenantId, tenant.outletId, `Layar Dapur ${id.slice(0, 6)}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("setting shared_mode = true on a pos device succeeds", async () => {
    const id = await newDevice(tenantFor(), false);
    await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
      id,
    ]);
    const { rows } = await owner.query<{ shared_mode: boolean }>(
      "SELECT shared_mode FROM devices WHERE id = $1",
      [id],
    );
    expect(rows[0]!.shared_mode).toBe(true);
  });
});
