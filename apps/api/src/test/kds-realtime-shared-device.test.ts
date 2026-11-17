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
//
// legend-dsbqr (brief 1018 part A): a browser cannot set WebSocket headers, so
// the same two credentials may ride in `Sec-WebSocket-Protocol`. Contract from
// the coordinator: the client offers "legend-kds.v1", "legend-kds-device.<device
// token>" and (when needed) "legend-kds-staff.<acting staff token>". Same
// validation as the header path; a header, when present, wins over the
// subprotocol; the server answers with exactly "legend-kds.v1" and never echoes
// a credential protocol; the token is never read from the query string and never
// logged. A refused upgrade answers 403.
// Assumptions:
//  - "header wins" is tested per credential pair: a valid header pair beats a
//    garbage subprotocol pair, and a garbage header pair is not rescued by a
//    valid subprotocol pair.
//  - Log check spies on the pino `logger` singleton (every level method and
//    child()), console and process stdout/stderr writes.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Express } from "express";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KITCHEN_REALTIME_PROTOCOL } from "@starter/shared/kitchen";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { logger } from "../lib/logger.ts";
import { attachKdsRealtime } from "../services/kds-realtime.ts";
import { resolveKdsStaffConnection } from "../services/kds-realtime-auth.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const ACTING_HEADER = "x-acting-staff";
const PASSWORD = "Test-password-123!";
const DEVICE_PROTOCOL_PREFIX = "legend-kds-device.";
const STAFF_PROTOCOL_PREFIX = "legend-kds-staff.";

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
  /** Raw Sec-WebSocket-Protocol offer, in the order the browser sends it. */
  protocols?: string[];
  /** Extra query string (must never be honoured as a credential carrier). */
  query?: string;
};

/** The offer a browser makes: KDS protocol plus credential protocols. */
const offer = (deviceTokenValue?: string, actingToken?: string) => [
  KITCHEN_REALTIME_PROTOCOL,
  ...(deviceTokenValue ? [`${DEVICE_PROTOCOL_PREFIX}${deviceTokenValue}`] : []),
  ...(actingToken ? [`${STAFF_PROTOCOL_PREFIX}${actingToken}`] : []),
];

function upgrade(input: Upgrade): IncomingMessage {
  const outletId = input.outletId ?? tenant.outletId;
  const stationId = input.stationId ?? stationA;
  return {
    url: `/api/outlets/${outletId}/kitchen/stations/${stationId}/realtime?after=0${input.query ?? ""}`,
    headers: {
      host: input.host ?? tenant.hostname,
      cookie: input.cookie,
      ...(input.protocols
        ? { "sec-websocket-protocol": input.protocols.join(", ") }
        : {}),
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

describe("KDS socket: credentials in Sec-WebSocket-Protocol (legend-dsbqr)", () => {
  it("device + live cook token in the subprotocol open the socket as the acting cook", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        protocols: offer(deviceToken(sharedDevice), token),
      }),
    );
    expect(result?.userId).toBe(cook.userId);
    expect(result?.userId).not.toBe(sharedLogin.userId);
  });

  it("a marked session with the subprotocol pair is accepted too", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        protocols: offer(deviceToken(sharedDevice), token),
      }),
    );
    expect(result?.userId).toBe(cook.userId);
  });

  it("the device protocol alone (no staff protocol) is denied", async () => {
    const session = await login(sharedLogin);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(deviceToken(sharedDevice)),
        }),
      ),
    ).toBeNull();
  });

  it("the staff protocol alone (no device protocol) is denied", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(undefined, token),
        }),
      ),
    ).toBeNull();
  });

  it("a wrong staff token in the subprotocol is denied", async () => {
    const session = await login(sharedLogin);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(deviceToken(sharedDevice), "pas_garbage-token"),
        }),
      ),
    ).toBeNull();
  });

  it("a wrong device token in the subprotocol is denied", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer("not-a-signed-device-token", token),
        }),
      ),
    ).toBeNull();
  });

  it("a subprotocol token revoked later is denied on the next call", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const request = upgrade({
      cookie: session.cookie,
      protocols: offer(deviceToken(sharedDevice), token),
    });
    expect((await resolveKdsStaffConnection(request))?.userId).toBe(
      cook.userId,
    );
    await endToken(session, sharedDevice);
    expect(await resolveKdsStaffConnection(request)).toBeNull();
  });

  it("a token for another device of the same outlet is denied via the subprotocol", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(deviceToken(otherSharedDevice), token),
        }),
      ),
    ).toBeNull();
  });

  it("a subprotocol token for outlet A is denied on a station of outlet B", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const protocols = offer(deviceToken(sharedDevice), token);
    expect(
      (
        await resolveKdsStaffConnection(
          upgrade({ cookie: session.cookie, protocols }),
        )
      )?.userId,
    ).toBe(cook.userId);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols,
          outletId: outletB,
          stationId: stationB,
        }),
      ),
    ).toBeNull();
  });

  it("another tenant's host refuses a tenant A subprotocol pair", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          host: tenantB.hostname,
          cookie: session.cookie,
          protocols: offer(deviceToken(sharedDevice), token),
        }),
      ),
    ).toBeNull();
  });

  it("a device token signed for another tenant in the subprotocol is denied", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(deviceToken(sharedDevice, tenantB), token),
        }),
      ),
    ).toBeNull();
  });

  it("a subprotocol token from another login session is denied", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const otherSession = await login(sharedLogin);
    await markSession(otherSession.sessionId, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: otherSession.cookie,
          protocols: offer(deviceToken(sharedDevice), token),
        }),
      ),
    ).toBeNull();
  });

  it("an acting person without kds.ticket.process is denied via the subprotocol", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, waiter, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          protocols: offer(deviceToken(sharedDevice), token),
        }),
      ),
    ).toBeNull();
  });

  it("a header pair wins over a garbage subprotocol pair", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        deviceToken: deviceToken(sharedDevice),
        acting: token,
        protocols: offer("not-a-signed-device-token", "pas_garbage-token"),
      }),
    );
    expect(result?.userId).toBe(cook.userId);
  });

  it("a garbage header pair is not rescued by a valid subprotocol pair", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    await markSession(session.sessionId, sharedDevice);
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          deviceToken: deviceToken(sharedDevice),
          acting: "pas_garbage-token",
          protocols: offer(deviceToken(sharedDevice), token),
        }),
      ),
    ).toBeNull();
  });

  it("credentials in the query string are never accepted", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    await markSession(session.sessionId, sharedDevice);
    const device = encodeURIComponent(deviceToken(sharedDevice));
    expect(
      await resolveKdsStaffConnection(
        upgrade({
          cookie: session.cookie,
          query: `&deviceToken=${device}&x-device-token=${device}&token=${token}&actingStaff=${token}&x-acting-staff=${token}`,
        }),
      ),
    ).toBeNull();
  });

  it("a personal login offering only the KDS protocol opens as the session owner", async () => {
    const session = await login(personal);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        protocols: [KITCHEN_REALTIME_PROTOCOL],
      }),
    );
    expect(result?.userId).toBe(personal.userId);
  });

  it("a personal login with an unflagged device protocol needs no staff protocol", async () => {
    const session = await login(personal);
    const result = await resolveKdsStaffConnection(
      upgrade({
        cookie: session.cookie,
        protocols: offer(deviceToken(personalDevice)),
      }),
    );
    expect(result?.userId).toBe(personal.userId);
  });
});

describe("KDS socket handshake: Sec-WebSocket-Protocol on a real upgrade (legend-dsbqr)", () => {
  let server: Server;
  let realtime: ReturnType<typeof attachKdsRealtime>;
  let port = 0;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    server = createServer();
    realtime = attachKdsRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
      resolveConnection: resolveKdsStaffConnection,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    port = address.port;
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await realtime?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  type Outcome =
    | { opened: true; protocol: string; upgradeProtocolHeader: unknown }
    | { opened: false; status: number };

  async function handshake(
    cookie: string,
    protocols: string[],
    headers: Record<string, string> = {},
  ): Promise<Outcome> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/outlets/${tenant.outletId}/kitchen/stations/${stationA}/realtime?after=0`,
      protocols,
      {
        headers: {
          origin: WEB_ORIGIN,
          host: tenant.hostname,
          cookie,
          ...headers,
        },
      },
    );
    sockets.push(ws);
    ws.on("error", () => {});
    let upgradeProtocolHeader: unknown;
    ws.on("upgrade", (response) => {
      upgradeProtocolHeader = response.headers["sec-websocket-protocol"];
    });
    const outcome = await Promise.race([
      once(ws, "open").then((): Outcome => ({
        opened: true,
        protocol: ws.protocol,
        upgradeProtocolHeader,
      })),
      once(ws, "unexpected-response").then(([, response]): Outcome => ({
        opened: false,
        status: (response as { statusCode?: number }).statusCode ?? 0,
      })),
    ]);
    ws.terminate();
    return outcome;
  }

  it("a valid subprotocol pair opens; the server answers with the KDS protocol only and never echoes a credential", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const device = deviceToken(sharedDevice);
    const outcome = await handshake(session.cookie, offer(device, token));
    expect(outcome.opened, JSON.stringify(outcome)).toBe(true);
    if (!outcome.opened) return;
    expect(outcome.protocol).toBe(KITCHEN_REALTIME_PROTOCOL);
    expect(outcome.upgradeProtocolHeader).toBe(KITCHEN_REALTIME_PROTOCOL);
    expect(String(outcome.upgradeProtocolHeader)).not.toContain(device);
    expect(String(outcome.upgradeProtocolHeader)).not.toContain(token);
  });

  it("a shared-device login with only the KDS protocol is refused 403", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    expect(
      await handshake(session.cookie, [KITCHEN_REALTIME_PROTOCOL]),
    ).toEqual({ opened: false, status: 403 });
  });

  it("a wrong staff token in the subprotocol is refused 403", async () => {
    const session = await login(sharedLogin);
    expect(
      await handshake(
        session.cookie,
        offer(deviceToken(sharedDevice), "pas_garbage-token"),
      ),
    ).toEqual({ opened: false, status: 403 });
  });

  it("a revoked staff token in the subprotocol is refused 403", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const protocols = offer(deviceToken(sharedDevice), token);
    expect((await handshake(session.cookie, protocols)).opened).toBe(true);
    await endToken(session, sharedDevice);
    expect(await handshake(session.cookie, protocols)).toEqual({
      opened: false,
      status: 403,
    });
  });

  it("another tenant's device token in the subprotocol is refused 403", async () => {
    const session = await login(sharedLogin);
    await markSession(session.sessionId, sharedDevice);
    const token = await issueToken(session, cook, sharedDevice);
    expect(
      await handshake(
        session.cookie,
        offer(deviceToken(sharedDevice, tenantB), token),
      ),
    ).toEqual({ opened: false, status: 403 });
  });

  it("a personal login still opens with only the KDS protocol", async () => {
    const session = await login(personal);
    const outcome = await handshake(session.cookie, [
      KITCHEN_REALTIME_PROTOCOL,
    ]);
    expect(outcome.opened, JSON.stringify(outcome)).toBe(true);
    if (outcome.opened)
      expect(outcome.protocol).toBe(KITCHEN_REALTIME_PROTOCOL);
  });

  it("the header path still opens a shared-device socket", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const outcome = await handshake(
      session.cookie,
      [KITCHEN_REALTIME_PROTOCOL],
      {
        [DEVICE_TOKEN_HEADER]: deviceToken(sharedDevice),
        [ACTING_HEADER]: token,
      },
    );
    expect(outcome.opened, JSON.stringify(outcome)).toBe(true);
  });

  it("neither token appears in any log output, accepted or refused", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const device = deviceToken(sharedDevice);
    const seen: string[] = [];
    const record = (...args: unknown[]) => {
      seen.push(
        args
          .map((arg) => {
            try {
              return typeof arg === "string" ? arg : JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(" "),
      );
    };
    const spies = [
      ...(["trace", "debug", "info", "warn", "error", "fatal"] as const).map(
        (level) => vi.spyOn(logger, level).mockImplementation(record as never),
      ),
      ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(record as never),
      ),
      vi.spyOn(process.stdout, "write").mockImplementation(((
        chunk: unknown,
      ) => {
        record(chunk);
        return true;
      }) as never),
      vi.spyOn(process.stderr, "write").mockImplementation(((
        chunk: unknown,
      ) => {
        record(chunk);
        return true;
      }) as never),
    ];
    let accepted: Outcome;
    let refused: Outcome;
    try {
      accepted = await handshake(session.cookie, offer(device, token));
      refused = await handshake(
        session.cookie,
        offer(device, "pas_garbage-token"),
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // Connect must work first, or the log check proves nothing.
    expect(accepted.opened, JSON.stringify(accepted)).toBe(true);
    expect(refused.opened).toBe(false);
    const output = seen.join("\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(device);
  });
});
