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
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KITCHEN_REALTIME_PROTOCOL } from "@starter/shared/kitchen";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  getRequestContext,
  runWithEdgeDevice,
  setRequestAuthMethod,
  setRequestUser,
} from "../lib/request-context.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  revokeDevice,
  setDeviceSharedMode,
} from "../services/device.service.ts";
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

  // `recheckKdsSockets` resolves every open screen inside the request of the
  // manager who revoked a device.
  it("a recheck inside another user's request leaves that request's identity alone", async () => {
    const session = await login(personal);
    const manager = randomUUID();
    await runWithEdgeDevice(undefined, async () => {
      setRequestUser(manager);
      setRequestAuthMethod("magic_link");
      const result = await resolveKdsStaffConnection(
        upgrade({ cookie: session.cookie }),
      );
      expect(result?.userId).toBe(personal.userId);
      expect(getRequestContext()).toMatchObject({
        userId: manager,
        authMethod: "magic_link",
      });
    });
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

describe("KDS socket: cashier token revoked while connected (legend-t0m89)", () => {
  // Spec (brief 1021 item 4 + 1017 contract "the check repeats on every
  // wakeup/recheck"): a shared-device screen whose acting-staff token is
  // revoked mid-connection is closed by the server with 1008 within the recheck
  // interval, and no ticket frame reaches that screen afterwards.
  // Assumptions:
  //  - Changes are fed by writing a feed row + cursor and calling
  //    `realtime.dispatch` (the relay entry point), not via NOTIFY.
  //  - The control (a ticket frame before the revoke) proves the screen was
  //    live, so "nothing afterwards" is not a vacuous check.
  const RECHECK_MS = 100;
  let server: Server;
  let realtime: ReturnType<typeof attachKdsRealtime>;
  let port = 0;
  const sockets: WebSocket[] = [];
  const category = randomUUID();
  const menuItem = randomUUID();
  const orderItem = randomUUID();
  const ticketId = randomUUID();

  async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
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

  beforeAll(async () => {
    server = createServer();
    realtime = attachKdsRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
      resolveConnection: resolveKdsStaffConnection,
      recheckIntervalMs: RECHECK_MS,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    port = address.port;

    const orderId = randomUUID();
    await asTenant(async (client) => {
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'Cabut Token Uji', 0)`,
        [category, tenant.tenantId, tenant.brandId],
      );
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5, $6, 'hot_kitchen')`,
        [
          menuItem,
          tenant.tenantId,
          tenant.brandId,
          category,
          randomUUID(),
          stationA,
        ],
      );
      await client.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           status, business_date, placed_at)
         VALUES ($1, $2, $3, $4, 'pos', 'dine_in', NULL, 'pay_first', 20000, 0, 0, 0, 0, 20000,
                 'sent', '2026-11-01', now())`,
        [
          orderId,
          tenant.tenantId,
          tenant.outletId,
          `RVK-${randomUUID().slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
           unit_price_idr, modifiers_total_idr, line_total_idr, modifiers, fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, 'Kopi Susu', 1, 20000, 0, 20000, '[]', 'fired', 'queued', '2026-11-01')`,
        [orderItem, tenant.tenantId, tenant.outletId, orderId, menuItem],
      );
      await client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no, status, priority, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), 'new', 0, now())`,
        [
          ticketId,
          tenant.tenantId,
          tenant.outletId,
          orderId,
          stationA,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO kitchen_ticket_items (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id,
           name, quantity, modifiers, status, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Kopi Susu', 1, '{}', 'queued', now())`,
        [
          randomUUID(),
          tenant.tenantId,
          tenant.outletId,
          ticketId,
          orderId,
          orderItem,
          menuItem,
        ],
      );
      await client.query(
        `INSERT INTO kitchen_station_cursors (tenant_id, outlet_id, station_id, last_sequence)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT DO NOTHING`,
        [tenant.tenantId, tenant.outletId, stationA],
      );
    });
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await realtime?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /** One more change on the station: feed row, cursor, relay wake-up. */
  async function emitChange(
    sequence: number,
    target: ReturnType<typeof attachKdsRealtime> = realtime,
  ) {
    await asTenant(async (client) => {
      await client.query(
        `INSERT INTO kitchen_station_feed (id, tenant_id, outlet_id, station_id, sequence, ticket_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::uuid, now())`,
        [
          randomUUID(),
          tenant.tenantId,
          tenant.outletId,
          stationA,
          sequence,
          ticketId,
        ],
      );
      await client.query(
        "UPDATE kitchen_station_cursors SET last_sequence = $2 WHERE station_id = $1",
        [stationA, sequence],
      );
    });
    await target.dispatch({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      stationId: stationA,
      sequence,
    });
  }

  async function waitFor(check: () => boolean, label: string, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("a revoked cashier token closes the socket with 1008 within the recheck interval and no ticket arrives afterwards", async () => {
    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/outlets/${tenant.outletId}/kitchen/stations/${stationA}/realtime?after=0`,
      offer(deviceToken(sharedDevice), token),
      {
        headers: {
          origin: WEB_ORIGIN,
          host: tenant.hostname,
          cookie: session.cookie,
        },
      },
    );
    sockets.push(ws);
    ws.on("error", () => {});
    const frames: { type: string }[] = [];
    let closeCode: number | null = null;
    let closedAt = 0;
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.on("close", (code) => {
      closeCode = code;
      closedAt = Date.now();
    });

    await waitFor(() => frames.some((f) => f.type === "hello"), "hello frame");

    // Control: while the token is valid, a change reaches the screen.
    await emitChange(1);
    await waitFor(
      () => frames.some((f) => f.type === "ticket"),
      "ticket frame before the revoke",
    );
    expect(closeCode).toBeNull();

    // The cashier ends their session on the shared device: token revoked.
    const revokedAt = Date.now();
    await endToken(session, sharedDevice);
    await waitFor(() => closeCode !== null, "server close after the revoke");
    expect(closeCode).toBe(1008);
    // Generous bound over the 100 ms recheck: proves the recheck, not a
    // 30 s default timer, closed it.
    expect(closedAt - revokedAt).toBeLessThan(RECHECK_MS * 20);

    // A change after the revoke must not reach the screen.
    const framesAtClose = frames.length;
    await emitChange(2);
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 4));
    expect(frames.filter((f) => f.type === "ticket")).toHaveLength(1);
    expect(frames).toHaveLength(framesAtClose);
  });

  // Same revoke, but the periodic recheck is far away (60 s): the ticket
  // delivery itself must re-validate the token, so a change emitted right
  // after the revoke closes the socket with 1008 instead of being delivered.
  // Assumption: the relay dispatch is the "ticket change" path; the cursor
  // starts at the current sequence (after=2) so no old entry is replayed.
  it("with a large recheck interval, a ticket change right after the revoke closes 1008 and delivers no second ticket frame", async () => {
    const slowServer = createServer();
    const slowRealtime = attachKdsRealtime(slowServer, {
      trustedOrigins: [WEB_ORIGIN],
      resolveConnection: resolveKdsStaffConnection,
      recheckIntervalMs: 60_000,
    });
    slowServer.listen(0, "127.0.0.1");
    await once(slowServer, "listening");
    const address = slowServer.address();
    if (!address || typeof address === "string") throw new Error("address");

    const session = await login(sharedLogin);
    const token = await issueToken(session, cook, sharedDevice);
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/outlets/${tenant.outletId}/kitchen/stations/${stationA}/realtime?after=2`,
      offer(deviceToken(sharedDevice), token),
      {
        headers: {
          origin: WEB_ORIGIN,
          host: tenant.hostname,
          cookie: session.cookie,
        },
      },
    );
    sockets.push(ws);
    ws.on("error", () => {});
    const frames: { type: string }[] = [];
    let closeCode: number | null = null;
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.on("close", (code) => {
      closeCode = code;
    });

    try {
      await waitFor(
        () => frames.some((f) => f.type === "hello"),
        "hello frame",
      );

      // Control: while the token is valid, a change reaches the screen.
      await emitChange(3, slowRealtime);
      await waitFor(
        () => frames.some((f) => f.type === "ticket"),
        "ticket frame before the revoke",
      );
      expect(closeCode).toBeNull();

      // Revoke, then change at once: far inside the 60 s recheck interval.
      await endToken(session, sharedDevice);
      await emitChange(4, slowRealtime);
      await waitFor(
        () => closeCode !== null,
        "server close after the revoke",
        3_000,
      );
      expect(closeCode).toBe(1008);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(frames.filter((f) => f.type === "ticket")).toHaveLength(1);
    } finally {
      ws.terminate();
      await slowRealtime.close();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  });
});

// Second opinion round 2 (docs/qa/second-opinion-akses-ronde2.md), P1 and the
// 9th-device P2, on REAL sockets. Spec = the 1006/1012/1017 contract in the
// header above plus the findings' expected outcomes.
// Assumptions:
//  - A device token (header or subprotocol) that the device registry no longer
//    accepts is refused 403 regardless of shared marks; a sent acting token is
//    always resolved and limits the identity (never falls back to the owner),
//    also on an unflagged device.
//  - A live cook token of outlet A on an unflagged device may be accepted for
//    station A (as the cook); only station B (other outlet) is asserted refused.
//  - A refused upgrade answers 403 (header contract of legend-dsbqr).
//  - "Session closed" = login session row revoked or gone (as in
//    shared-device-marks.test.ts).
describe("KDS socket: revoked device and ninth device on real sockets (second opinion round 2)", () => {
  const RECHECK_MS = 100;
  let server: Server;
  let realtime: ReturnType<typeof attachKdsRealtime>;
  let port = 0;
  const sockets: WebSocket[] = [];
  const actor = randomUUID();

  type Outcome = { opened: true } | { opened: false; status: number };
  const refused403: Outcome = { opened: false, status: 403 };

  beforeAll(async () => {
    server = createServer();
    realtime = attachKdsRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
      resolveConnection: resolveKdsStaffConnection,
      recheckIntervalMs: RECHECK_MS,
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

  async function waitFor(check: () => boolean, label: string, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function socketUrl(outletId: string, stationId: string) {
    return `ws://127.0.0.1:${port}/api/outlets/${outletId}/kitchen/stations/${stationId}/realtime?after=0`;
  }

  /** One real upgrade attempt; closes the socket at once. */
  async function connect(
    cookie: string,
    protocols: string[],
    headers: Record<string, string> = {},
    place: { outletId: string; stationId: string } = {
      outletId: tenant.outletId,
      stationId: stationA,
    },
  ): Promise<Outcome> {
    const ws = new WebSocket(
      socketUrl(place.outletId, place.stationId),
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
    const outcome = await Promise.race([
      once(ws, "open").then((): Outcome => ({ opened: true })),
      once(ws, "unexpected-response").then(([, response]): Outcome => ({
        opened: false,
        status: (response as { statusCode?: number }).statusCode ?? 0,
      })),
    ]);
    ws.terminate();
    return outcome;
  }

  const where = {
    a: () => ({ outletId: tenant.outletId, stationId: stationA }),
    b: () => ({ outletId: outletB, stationId: stationB }),
  };

  async function newDevice(flagged: boolean): Promise<string> {
    const id = randomUUID();
    knownDevices.add(id);
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', $5)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        `Tablet R2 ${id.slice(0, 6)}`,
        flagged,
      ],
    );
    return id;
  }

  const outletScope = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
    );

  async function sessionEnded(sessionId: string): Promise<boolean> {
    const { rows } = await owner.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "session" WHERE id = $1`,
      [sessionId],
    );
    return rows.length === 0 || rows[0]!.revoked_at !== null;
  }

  /** Both credential carriers a client uses, for station A and B. */
  async function allReconnects(
    cookie: string,
    device: string,
    token: string | undefined,
  ) {
    const results: Record<string, Outcome> = {};
    for (const [name, place] of [
      ["A", where.a()],
      ["B", where.b()],
    ] as const) {
      results[`header ${name}`] = await connect(
        cookie,
        [KITCHEN_REALTIME_PROTOCOL],
        {
          [DEVICE_TOKEN_HEADER]: device,
          ...(token ? { [ACTING_HEADER]: token } : {}),
        },
        place,
      );
      results[`subprotocol ${name}`] = await connect(
        cookie,
        offer(device, token),
        {},
        place,
      );
    }
    return results;
  }

  it("P1 revoking the device while the screen is open closes it 1008, and reconnecting with the old header or subprotocol tokens (station A and B) is refused 403", async () => {
    const device = await newDevice(true);
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    const deviceJwt = deviceToken(device);

    const ws = new WebSocket(
      socketUrl(tenant.outletId, stationA),
      offer(deviceJwt, token),
      {
        headers: {
          origin: WEB_ORIGIN,
          host: tenant.hostname,
          cookie: session.cookie,
        },
      },
    );
    sockets.push(ws);
    ws.on("error", () => {});
    const frames: { type: string }[] = [];
    let closeCode: number | null = null;
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.on("close", (code) => {
      closeCode = code;
    });
    await waitFor(() => frames.some((f) => f.type === "hello"), "hello frame");

    // Control: before the revoke the same credentials open station A.
    expect(await connect(session.cookie, offer(deviceJwt, token))).toEqual({
      opened: true,
    });

    await revokeDevice(outletScope(), actor, {
      deviceId: device,
      reason: "hilang",
    });
    await waitFor(() => closeCode !== null, "server close after the revoke");
    expect(closeCode).toBe(1008);

    // The old credentials must stay refused: neither the retry of the screen
    // nor a station of the other outlet may fall back to the login owner.
    const outcomes = await allReconnects(session.cookie, deviceJwt, token);
    expect(outcomes).toEqual({
      "header A": refused403,
      "subprotocol A": refused403,
      "header B": refused403,
      "subprotocol B": refused403,
    });
    // Only the (revoked) device token, or only the acting token, is no way back.
    expect(
      await connect(
        session.cookie,
        [KITCHEN_REALTIME_PROTOCOL],
        { [DEVICE_TOKEN_HEADER]: deviceJwt },
        where.b(),
      ),
    ).toEqual(refused403);
    expect(
      await connect(
        session.cookie,
        [KITCHEN_REALTIME_PROTOCOL],
        { [ACTING_HEADER]: token },
        where.b(),
      ),
    ).toEqual(refused403);
  });

  it("control: a personal login with no tokens, and with only an unflagged device's token, opens station A and B", async () => {
    const session = await login(personal);
    for (const place of [where.a(), where.b()]) {
      expect(
        await connect(session.cookie, [KITCHEN_REALTIME_PROTOCOL], {}, place),
      ).toEqual({ opened: true });
      expect(
        await connect(
          session.cookie,
          offer(deviceToken(personalDevice)),
          {},
          place,
        ),
      ).toEqual({ opened: true });
    }
  });

  it("an ended cashier token on a device that is no longer flagged is refused on station A and B, never owner", async () => {
    const device = await newDevice(true);
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    await endToken(session, device);
    await owner.query(`UPDATE devices SET shared_mode = false WHERE id = $1`, [
      device,
    ]);
    const outcomes = await allReconnects(
      session.cookie,
      deviceToken(device),
      token,
    );
    expect(outcomes).toEqual({
      "header A": refused403,
      "subprotocol A": refused403,
      "header B": refused403,
      "subprotocol B": refused403,
    });
  });

  it("an expired cashier token on an unflagged device is refused on station A and B, never owner", async () => {
    const device = await newDevice(true);
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    await owner.query(`UPDATE devices SET shared_mode = false WHERE id = $1`, [
      device,
    ]);
    await owner.query(
      `UPDATE pos_acting_staff
         SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
       WHERE device_id = $1`,
      [device],
    );
    const outcomes = await allReconnects(
      session.cookie,
      deviceToken(device),
      token,
    );
    expect(outcomes).toEqual({
      "header A": refused403,
      "subprotocol A": refused403,
      "header B": refused403,
      "subprotocol B": refused403,
    });
  });

  it("a live outlet-A cashier token on an unflagged device does not open station B of another outlet", async () => {
    const device = await newDevice(true);
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    await owner.query(`UPDATE devices SET shared_mode = false WHERE id = $1`, [
      device,
    ]);
    const outcomes = await allReconnects(
      session.cookie,
      deviceToken(device),
      token,
    );
    expect(outcomes["header B"]).toEqual(refused403);
    expect(outcomes["subprotocol B"]).toEqual(refused403);
  });

  describe.each(["unflagged", "revoked"] as const)(
    "P2 ninth device upgrade, the eight old devices become %s afterwards",
    (how) => {
      it("refuses the direct ninth-device upgrade AND closes the login session, so the old cookie stays dead on websocket and back office", async () => {
        const ninth = await newDevice(true);

        // Control: on a clean session the same ninth-device credentials open,
        // so the refusal below can only come from the eight-mark limit.
        const clean = await login(sharedLogin);
        const cleanToken = await issueToken(clean, cook, ninth);
        expect(
          await connect(clean.cookie, offer(deviceToken(ninth), cleanToken)),
        ).toEqual({ opened: true });

        const session = await login(sharedLogin);
        const token = await issueToken(session, cook, ninth);
        const eight: string[] = [];
        for (let index = 0; index < 8; index += 1)
          eight.push(await newDevice(true));
        await owner.query(
          `UPDATE "session" SET shared_device_ids = $2::uuid[] WHERE id = $1`,
          [session.sessionId, eight],
        );
        expect(await sessionEnded(session.sessionId)).toBe(false);

        // The ninth device upgrades directly: refused, and the login session
        // is closed (same outcome as the HTTP route).
        expect(
          await connect(session.cookie, offer(deviceToken(ninth), token)),
        ).toEqual(refused403);
        expect(await sessionEnded(session.sessionId)).toBe(true);

        // Another admin lapses the eight old marks.
        for (const id of eight) {
          if (how === "unflagged")
            await owner.query(
              `UPDATE devices SET shared_mode = false WHERE id = $1`,
              [id],
            );
          else
            await owner.query(
              `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1`,
              [id],
            );
        }

        // The old cookie, without any header, is no owner pass anywhere.
        for (const place of [where.a(), where.b()])
          expect(
            await connect(
              session.cookie,
              [KITCHEN_REALTIME_PROTOCOL],
              {},
              place,
            ),
          ).toEqual(refused403);
        const backOffice = await agent(app)
          .get("/api/me/access")
          .set("Cookie", session.cookie)
          .set(originHeader);
        expect(backOffice.status, JSON.stringify(backOffice.body)).toBe(401);
        const parkedOrders = await agent(app)
          .get(
            `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/parked-orders`,
          )
          .set("Cookie", session.cookie)
          .set({ Host: tenant.hostname })
          .set(originHeader);
        expect(parkedOrders.status, JSON.stringify(parkedOrders.body)).toBe(
          401,
        );
      });
    },
  );
});

// legend-1024 hardening (architect review). Written from the 1012/1017 contract:
// a login session that served a shared device never becomes the owner pass
// again, however the device was taken away.
// Assumptions:
//  - A device revoked by plain SQL (status + revoked_at) keeps the login
//    session alive on purpose: the socket gate alone must refuse, with header,
//    subprotocol and cookie only, and for a personal login that merely carries
//    the revoked device's token.
//  - `recheckIntervalMs` is one minute, so an open screen can only close within
//    the test window because revokeDevice / setDeviceSharedMode call
//    `recheckKdsSockets()` themselves.
//  - Turning shared mode off, or revoking again, closes every login session
//    that was used on the device; GET /api/me/access then answers 401. Before
//    that the cookie is merely "not 401" (a marked session may need a cashier
//    token for some routes, which is outside this case).
describe("KDS socket: revoked / unshared device closes sessions and screens (legend-1024)", () => {
  let server: Server;
  let realtime: ReturnType<typeof attachKdsRealtime>;
  let port = 0;
  const sockets: WebSocket[] = [];
  const actor = randomUUID();
  type Outcome = { opened: true } | { opened: false; status: number };
  const refused403: Outcome = { opened: false, status: 403 };

  beforeAll(async () => {
    server = createServer();
    realtime = attachKdsRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
      resolveConnection: resolveKdsStaffConnection,
      recheckIntervalMs: 60_000,
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

  const url = () =>
    `ws://127.0.0.1:${port}/api/outlets/${tenant.outletId}/kitchen/stations/${stationA}/realtime?after=0`;

  function open(
    cookie: string,
    protocols: string[],
    headers: Record<string, string> = {},
  ) {
    const ws = new WebSocket(url(), protocols, {
      headers: {
        origin: WEB_ORIGIN,
        host: tenant.hostname,
        cookie,
        ...headers,
      },
    });
    sockets.push(ws);
    ws.on("error", () => {});
    return ws;
  }

  async function connect(
    cookie: string,
    protocols: string[],
    headers: Record<string, string> = {},
  ): Promise<Outcome> {
    const ws = open(cookie, protocols, headers);
    const outcome = await Promise.race([
      once(ws, "open").then((): Outcome => ({ opened: true })),
      once(ws, "unexpected-response").then(([, response]): Outcome => ({
        opened: false,
        status: (response as { statusCode?: number }).statusCode ?? 0,
      })),
    ]);
    ws.terminate();
    return outcome;
  }

  async function newDevice(): Promise<string> {
    const id = randomUUID();
    knownDevices.add(id);
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
      [id, tenant.tenantId, tenant.outletId, `Tablet 1024 ${id.slice(0, 6)}`],
    );
    return id;
  }

  const scope = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
    );

  async function sessionEnded(sessionId: string): Promise<boolean> {
    const { rows } = await owner.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "session" WHERE id = $1`,
      [sessionId],
    );
    return rows.length === 0 || rows[0]!.revoked_at !== null;
  }

  const meAccess = (cookie: string) =>
    agent(app)
      .get("/api/me/access")
      .set("Cookie", cookie)
      .set({ Host: tenant.hostname })
      .set(originHeader);

  async function closedWithin(ws: WebSocket, label: string) {
    let code: number | null = null;
    ws.on("close", (value) => {
      code = value;
    });
    const deadline = Date.now() + 5_000;
    while (code === null) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return code;
  }

  async function openAndWaitHello(
    session: Login,
    device: string,
    token: string,
  ) {
    const ws = open(session.cookie, offer(deviceToken(device), token));
    const frames: { type: string }[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    const deadline = Date.now() + 5_000;
    while (!frames.some((f) => f.type === "hello")) {
      if (Date.now() > deadline) throw new Error("Timed out: hello frame");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ws;
  }

  it("a device revoked by SQL (session still alive) is refused 403 with the header only, the subprotocol only, the cookie only and with both tokens", async () => {
    const device = await newDevice();
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    const jwt = deviceToken(device);

    // Control: before the revoke the full credentials open the screen.
    expect(await connect(session.cookie, offer(jwt, token))).toEqual({
      opened: true,
    });

    await owner.query(
      `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [device],
    );
    // The point of this case: only the socket gate can refuse here.
    expect(await sessionEnded(session.sessionId)).toBe(false);

    const outcomes = {
      "device header only": await connect(
        session.cookie,
        [KITCHEN_REALTIME_PROTOCOL],
        { [DEVICE_TOKEN_HEADER]: jwt },
      ),
      "device subprotocol only": await connect(session.cookie, offer(jwt)),
      "cookie only": await connect(session.cookie, [KITCHEN_REALTIME_PROTOCOL]),
      "header pair": await connect(
        session.cookie,
        [KITCHEN_REALTIME_PROTOCOL],
        { [DEVICE_TOKEN_HEADER]: jwt, [ACTING_HEADER]: token },
      ),
      "subprotocol pair": await connect(session.cookie, offer(jwt, token)),
    };
    expect(outcomes).toEqual({
      "device header only": refused403,
      "device subprotocol only": refused403,
      "cookie only": refused403,
      "header pair": refused403,
      "subprotocol pair": refused403,
    });
    expect(await sessionEnded(session.sessionId)).toBe(false);
  });

  it("a personal (never marked) login that carries a revoked device's token is refused 403, by header and by subprotocol", async () => {
    const device = await newDevice();
    const session = await login(personal);
    const jwt = deviceToken(device);
    // The login was never marked; the revoked device's token alone must not
    // let it through as the owner.
    await owner.query(
      `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [device],
    );
    expect(await sessionEnded(session.sessionId)).toBe(false);
    expect(
      await connect(session.cookie, [KITCHEN_REALTIME_PROTOCOL], {
        [DEVICE_TOKEN_HEADER]: jwt,
      }),
    ).toEqual(refused403);
    expect(await connect(session.cookie, offer(jwt))).toEqual(refused403);
    // A personal login with no device token at all still opens (control).
    expect(await connect(session.cookie, [KITCHEN_REALTIME_PROTOCOL])).toEqual({
      opened: true,
    });
  });

  it("revokeDevice closes an open screen 1008 although the recheck interval is one minute (recheckKdsSockets), and the login session is closed", async () => {
    const device = await newDevice();
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    const ws = await openAndWaitHello(session, device, token);

    await revokeDevice(scope(), actor, { deviceId: device, reason: "hilang" });
    expect(await closedWithin(ws, "1008 after revokeDevice")).toBe(1008);
    expect(await sessionEnded(session.sessionId)).toBe(true);
  });

  it("switching shared mode off closes an open screen 1008 within the test window and closes the login session (cookie then answers 401)", async () => {
    const device = await newDevice();
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    const token = await issueToken(session, cook, device);
    const ws = await openAndWaitHello(session, device, token);
    expect((await meAccess(session.cookie)).status).not.toBe(401);

    await setDeviceSharedMode(scope(), actor, {
      deviceId: device,
      sharedMode: false,
    });
    expect(await closedWithin(ws, "1008 after shared mode off")).toBe(1008);
    expect(await sessionEnded(session.sessionId)).toBe(true);
    const after = await meAccess(session.cookie);
    expect(after.status, JSON.stringify(after.body)).toBe(401);
  });

  it("switching shared mode off without an open screen still closes the login session: the old cookie answers 401", async () => {
    const device = await newDevice();
    const session = await login(sharedLogin);
    await markSession(session.sessionId, device);
    expect((await meAccess(session.cookie)).status).not.toBe(401);

    await setDeviceSharedMode(scope(), actor, {
      deviceId: device,
      sharedMode: false,
    });
    const after = await meAccess(session.cookie);
    expect(after.status, JSON.stringify(after.body)).toBe(401);
  });

  it("revoking an already revoked device (idempotent) still closes a session that was marked afterwards", async () => {
    const device = await newDevice();
    const first = await login(sharedLogin);
    await markSession(first.sessionId, device);
    await revokeDevice(scope(), actor, { deviceId: device, reason: "hilang" });
    expect(await sessionEnded(first.sessionId)).toBe(true);

    // A session that still holds the mark (e.g. a cleanup that failed before).
    const late = await login(sharedLogin);
    await markSession(late.sessionId, device);
    expect(await sessionEnded(late.sessionId)).toBe(false);
    expect((await meAccess(late.cookie)).status).not.toBe(401);

    const again = await revokeDevice(scope(), actor, {
      deviceId: device,
      reason: "hilang",
    });
    expect(again.status).toBe("revoked");
    expect(await sessionEnded(late.sessionId)).toBe(true);
    const after = await meAccess(late.cookie);
    expect(after.status, JSON.stringify(after.body)).toBe(401);
  });
});
