// KDS station socket on a shared device (bead legend-wa9n7, part 1).
//
// Spec = brief 1017 Card A plus docs/DECISIONS.md "Kasir aktif per perangkat
// lewat token server" and the 1012 shared-device contract: a login session
// that touched a device flagged `devices.shared_mode` serves several people, so
// every protected channel must name the acting person. A WebSocket upgrade does
// not pass the Express chain, so `resolveKdsStaffConnection` must itself:
//  - collect marks = `session.shared_device_ids` + the device of a validly
//    signed `x-device-token` upgrade header of this tenant;
//  - no active shared device among them -> unchanged behaviour;
//  - otherwise REQUIRE `x-device-token` (registry-valid) and `x-acting-staff`
//    (live cashier/cook token for this device, login session and path outlet);
//    any failure answers null; the acting staff member (not the login owner)
//    is the user whose `kds.ticket.process` is resolved.
//  - the check repeats on every wakeup/recheck, so a revoked token answers null
//    on the next call (the upgrade request keeps its headers).
//
// Assumptions:
//  - The session mark is set by SQL (`session.shared_device_ids`); the HTTP
//    stamping is covered in acting-staff-shared-device.test.ts. Header-only
//    marking (session never marked) has its own case.
//  - The shared login session owner holds `kds.ticket.process` itself, so a
//    refusal can only come from the missing/invalid acting person, never from
//    a missing permission of the login.
//  - Cross-tenant: a cook token of tenant A sent to tenant B's host is refused
//    (the login has no access there either); this is a regression guard that
//    holds before and after the fix.
//  - A browser cannot set WebSocket headers, so a shared-device browser socket
//    is denied by default (limitation, follow-up carrier needed). Not tested.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { resolveKdsStaffConnection } from "../services/kds-realtime-auth.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const ACTING_HEADER = "x-acting-staff";
const PASSWORD = "Test-password-123!";

type Member = { userId: string; email: string };
type Login = { cookie: string; sessionId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let kdsRole: string;
let noKdsRole: string;
let sharedLogin: Member; // the login owner of the shared tablet
let personal: Member; // a staff member on their own phone
let cook: Member; // the acting person with kds.ticket.process
let waiter: Member; // an acting person WITHOUT kds.ticket.process
const outletB = randomUUID();
const stationA = randomUUID(); // outlet A
const stationB = randomUUID(); // outlet B, same tenant
const sharedDevice = randomUUID(); // flagged, outlet A
const otherSharedDevice = randomUUID(); // flagged, outlet A
const personalDevice = randomUUID(); // registered, NOT flagged, outlet A
const knownDevices = new Set<string>();

async function member(
  roleId: string,
  label: string,
  forTenant: IsolatedTenant = tenant,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId],
  );
  return { userId, email };
}

/** A fresh login session (password sign-in) of the member. */
async function login(who: Member): Promise<Login> {
  const response = await agent(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: who.email, password: PASSWORD });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const header = response.headers["set-cookie"] as unknown as string[] | string;
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  const current = await agent(app)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  return { cookie, sessionId: current.body.session.id as string };
}

const deviceToken = (deviceId: string, forTenant: IsolatedTenant = tenant) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: forTenant.tenantId,
    brandId: null,
    deviceId,
  });

/** Marks the login session as used on a shared device (as stamping does). */
async function markSession(sessionId: string, deviceId: string) {
  await owner.query(
    `UPDATE "session" SET shared_device_ids = ARRAY[$2]::uuid[] WHERE id = $1`,
    [sessionId, deviceId],
  );
}

/** Issues an acting token for `who` on `deviceId` from the login session. */
async function issueToken(
  session: Login,
  who: Member,
  deviceId: string,
): Promise<string> {
  const response = await agent(app)
    .post("/api/staff-pins/pos-session")
    .set("Cookie", session.cookie)
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

async function endToken(session: Login, deviceId: string) {
  const response = await agent(app)
    .post("/api/staff-pins/pos-session/end")
    .set("Cookie", session.cookie)
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({});
  expect(response.status, JSON.stringify(response.body)).toBe(204);
}

type Upgrade = {
  host?: string;
  cookie: string;
  outletId?: string;
  stationId?: string;
  deviceToken?: string;
  acting?: string;
};

function upgrade(input: Upgrade): IncomingMessage {
  const outletId = input.outletId ?? tenant.outletId;
  const stationId = input.stationId ?? stationA;
  return {
    url: `/api/outlets/${outletId}/kitchen/stations/${stationId}/realtime?after=0`,
    headers: {
      host: input.host ?? tenant.hostname,
      cookie: input.cookie,
      ...(input.deviceToken
        ? { [DEVICE_TOKEN_HEADER]: input.deviceToken }
        : {}),
      ...(input.acting ? { [ACTING_HEADER]: input.acting } : {}),
    },
  } as unknown as IncomingMessage;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`kdssd-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdssb-${randomUUID().slice(0, 6)}`);
  kdsRole = randomUUID();
  noKdsRole = randomUUID();
  for (const [id, name, permissions] of [
    [kdsRole, "KDS Bersama Uji", ["kds.ticket.process"]],
    [noKdsRole, "Pelayan Tanpa KDS", ["order.view"]],
  ] as const)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sharedLogin = await member(kdsRole, "Login Tablet Bersama");
  personal = await member(kdsRole, "Koki Ponsel Pribadi");
  cook = await member(kdsRole, "Koki Bergilir");
  waiter = await member(noKdsRole, "Pelayan Bergilir");

  // Second outlet of the same tenant with its own station.
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet KDS Bersama B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      outletB,
      `SB-${randomUUID().slice(0, 6)}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  for (const [id, outletId] of [
    [stationA, tenant.outletId],
    [stationB, outletB],
  ])
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Dapur Uji', 'hot_kitchen')`,
      [id, tenant.tenantId, outletId],
    );

  for (const [id, label, shared] of [
    [sharedDevice, "Tablet Dapur Bersama", true],
    [otherSharedDevice, "Tablet Dapur Bersama 2", true],
    [personalDevice, "Tablet Pribadi", false],
  ] as const) {
    knownDevices.add(id);
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', $5)`,
      [id, tenant.tenantId, tenant.outletId, label, shared],
    );
  }
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && knownDevices.has(deviceId)
      ? tenant.outletId
      : null,
  );
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const who of [cook, waiter])
    await setStaffPin(
      context,
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("KDS socket: personal device is unaffected", () => {
  it("a session with no shared-device mark and no device header opens the socket as the session owner", async () => {
    const session = await login(personal);
    const result = await resolveKdsStaffConnection(
      upgrade({ cookie: session.cookie }),
    );
    expect(result?.userId).toBe(personal.userId);
  });

  it("an unflagged registered device token needs no acting token", async () => {
    const session = await login(personal);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        deviceToken: deviceToken(personalDevice),
      }),
    );
    expect(result?.userId).toBe(personal.userId);
  });
});

describe("KDS socket: shared-device session", () => {
  it("marked session without any token is denied", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    expect(
      await resolveKdsStaffConnection(upgrade({ cookie: session.cookie })),
    ).toBeNull();
  });

  it("a shared device token in the upgrade alone marks the call: without an acting token it is denied", async () => {
    // The session itself was never marked; the header names a flagged device.
    const session = await login(sharedLogin);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
        }),
      ),
    ).toBeNull();
  });

  it("marked session with an acting token but no device token is denied", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({ cookie: session.cookie, acting: token }),
      ),
    ).toBeNull();
  });

  it("a garbage acting token is denied", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: "pas_garbage-token",
        }),
      ),
    ).toBeNull();
  });

  it("device token plus a live cook token opens the socket as the acting cook, not the login owner", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        deviceToken: deviceToken(sharedDevice),
        acting: token,
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(cook.userId);
    expect(result?.userId).not.toBe(sharedLogin.userId);
  });

  it("a successful connect stamps the shared device on the login session", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    // Start from an unmarked session: only the upgrade header can stamp it.
    await owner.query(
      `UPDATE "session" SET shared_device_ids = '{}'::uuid[] WHERE id = $1`,
      [session.sessionId],
    );
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        deviceToken: deviceToken(sharedDevice),
        acting: token,
      }),
    );
    expect(result?.userId).toBe(cook.userId);
    const { rows } = await owner.query<{ ids: string[] }>(
      `SELECT shared_device_ids AS ids FROM "session" WHERE id = $1`,
      [session.sessionId],
    );
    expect(rows[0]?.ids).toContain(sharedDevice);
  });

  it("a ninth shared device is denied when the session already holds 8 active marks", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const eight: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const id = randomUUID();
      eight.push(id);
      await owner.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
         VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
        [id, tenant.tenantId, tenant.outletId, `Tablet Penuh ${index}`],
      );
    }
    await owner.query(
      `UPDATE "session" SET shared_device_ids = $2::uuid[] WHERE id = $1`,
      [session.sessionId, eight],
    );
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: token,
        }),
      ),
    ).toBeNull();
    const { rows } = await owner.query<{ ids: string[] }>(
      `SELECT shared_device_ids AS ids FROM "session" WHERE id = $1`,
      [session.sessionId],
    );
    expect(rows[0]?.ids).not.toContain(sharedDevice);
  });

  it("an acting person without kds.ticket.process is denied even though the login owner has it", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, waiter, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: token,
        }),
      ),
    ).toBeNull();
  });

  it("a revoked token is denied on the next call (wakeup/recheck re-run the same upgrade)", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const request = upgrade({
      cookie: session.cookie,
      deviceToken: deviceToken(sharedDevice),
      acting: token,
    });
    expect((await resolveKdsStaffConnection(request))?.userId).toBe(
      cook.userId,
    );
    await endToken(session, sharedDevice);
    expect(await resolveKdsStaffConnection(request)).toBeNull();
  });

  it("a token switched away by a newer cook token is denied", async () => {
    const session = await login(sharedLogin);
    const first = await issueToken(session, cook, sharedDevice);
    await issueToken(session, waiter, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: first,
        }),
      ),
    ).toBeNull();
  });
});

describe("KDS socket: shared device, cross-device, cross-outlet and cross-tenant", () => {
  it("a token issued for one device does not work with another device's token", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(otherSharedDevice),
          acting: token,
        }),
      ),
    ).toBeNull();
  });

  it("a token for outlet A is refused on a station of another outlet of the same tenant", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const own = upgrade({
      cookie: session.cookie,
      deviceToken: deviceToken(sharedDevice),
      acting: token,
    });
    expect((await resolveKdsStaffConnection(own))?.userId).toBe(cook.userId);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: token,
          outletId: outletB,
          stationId: stationB,
        }),
      ),
    ).toBeNull();
  });

  it("a token used from another login session is denied", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const otherSession = await login(sharedLogin);
    await markSession(otherSession.sessionId, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: otherSession.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: token,
        }),
      ),
    ).toBeNull();
  });

  it("another tenant's host refuses a tenant A cook token", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          host: tenantB.hostname,
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: token,
        }),
      ),
    ).toBeNull();
  });

  it("a device token signed for another tenant never counts as this tenant's device", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice, tenantB),
          acting: token,
        }),
      ),
    ).toBeNull();
  });
});
