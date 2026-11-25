// legend-5pipx (P1) + legend-7yvmm (P2), tier K (access). Written from the card
// brief, not from the implementation.
//
// P1: a login session created BEFORE its device was flagged shared holds no
// mark. The first request that carries the device token must record the mark
// even when it only hits an allowlisted /api/auth path (get-session, keep-alive)
// or a refused one (update-user). Replaying the same cookie without the device
// header must then stay shared-device: no account change, no back office, POS
// asks for a cashier PIN.
//
// P2: when the early stamp records device D in the same request, the guards
// that run later in that request must see D as a mark, even if D is unflagged
// between the stamp and the guard (barrier test through a partial mock of
// stampSharedDeviceFromToken).
//
// Assumptions (spec silent):
//  - Device flagging after session creation is simulated with an owner-pool
//    UPDATE (no session close), as in the 1027 tests.
//  - "No owner-action audit row" is covered by asserting the user's name is
//    unchanged after the refused update-user (the refusal happens before Better
//    Auth runs, so no change can be written); audit tables are not inspected.
//  - Back office = GET /api/org/brands on the seeded host (200 for a personal
//    owner session); POS = GET /api/outlets/:o/pos/parked-orders on an isolated
//    tenant (401 ACTING_STAFF_REQUIRED for a marked session without a PIN).
//  - Keep-alive POST /api/auth/sessions/current/activity needs a management-kind
//    session; the test sets that kind and accepts 200 or 204.
//  - A refused push removal is 401, 403 or 404 (the row must stay); a barrier
//    that is never reached fails with a clear message instead of hanging.
import { createECDH, randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";

// config/env.ts reads process.env once at import, so the push configuration
// must exist before the app module graph loads.
await vi.hoisted(async () => {
  const { createECDH } = await import("node:crypto");
  const key = createECDH("prime256v1");
  key.generateKeys();
  process.env.NOTIFICATION_PUSH_PROVIDER = "web_push";
  process.env.VAPID_PUBLIC_KEY = key.getPublicKey().toString("base64url");
  process.env.VAPID_PRIVATE_KEY = Buffer.from(
    key.getPrivateKey("hex").padStart(64, "0"),
    "hex",
  ).toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:push@example.test";
});

// Partial mock: everything real, except stampSharedDeviceFromToken can pause
// AFTER the real call resolved (the stamp is already in the database) until the
// test releases it. Only active while armed, and only for one call.
const barrier = vi.hoisted(() => ({
  armed: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock("../services/shared-device.service.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/shared-device.service.ts")>();
  return {
    ...actual,
    stampSharedDeviceFromToken: async (
      ...args: Parameters<typeof actual.stampSharedDeviceFromToken>
    ) => {
      const result = await actual.stampSharedDeviceFromToken(...args);
      if (barrier.armed) {
        barrier.armed = false;
        const release = barrier.release;
        barrier.reached?.();
        if (release) await release;
      }
      return result;
    },
  };
});

import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const NOT_ALLOWED = "ACTING_STAFF_NOT_ALLOWED";
const REQUIRED = "ACTING_STAFF_REQUIRED";
const LIMIT = "SHARED_DEVICE_MARK_LIMIT";
const RESPOND = "facility.emergency.respond";
const PASSWORD = "Test-password-123!";
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
type Member = {
  client: Client;
  userId: string;
  email: string;
  sessionId: string;
};
type Res = { status: number; body: unknown };

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
const roleIds = new Map<string, string>();
const deviceIds: string[] = [];
const userIds: string[] = [];

const codeOf = (response: Res) =>
  (response.body as { error?: { code?: string } }).error?.code ?? "";

function expectCode(response: Res, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(code);
}
const expectNotAllowed = (response: Res) =>
  expectCode(response, 403, NOT_ALLOWED);
const expectRequired = (response: Res) => expectCode(response, 401, REQUIRED);

type Place = { tenantId: string; outletId: string };
const seeded: Place = { tenantId: seededTenantId, outletId: seededOutletA };
// device id -> the tenant it belongs to (its token carries that tenant, and a
// request with a token must use the Host of the same tenant)
const placeOf = new Map<string, Place>();

async function newDevice(
  flagged: boolean,
  tenant: Place = tenantA,
): Promise<string> {
  const id = randomUUID();
  deviceIds.push(id);
  placeOf.set(id, tenant);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', $5)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      `Kasir 5pipx ${id.slice(0, 6)}`,
      flagged,
    ],
  );
  return id;
}

const setFlag = (id: string, value: boolean) =>
  owner.query("UPDATE devices SET shared_mode = $2 WHERE id = $1", [id, value]);

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: placeOf.get(deviceId)!.tenantId,
    brandId: null,
    deviceId,
  });

const withToken = (deviceId: string) => ({
  [DEVICE_TOKEN_HEADER]: tokenOf(deviceId),
});

async function assignPos(tenant: IsolatedTenant, userId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleIds.get(tenant.tenantId)],
  );
}

/**
 * A personal login (owner template in the seeded tenant, POS role in both
 * isolated tenants), MFA verified, never marked.
 */
async function member(label: string): Promise<Member> {
  const staff = await staffWithRole(app, { template: "owner", label });
  userIds.push(staff.userId);
  await assignPos(tenantA, staff.userId);
  await assignPos(tenantB, staff.userId);
  await verifySessionMfa(staff.email);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session" WHERE user_id = $1`,
    [staff.userId],
  );
  expect(rows).toHaveLength(1);
  return {
    client: staff.client,
    userId: staff.userId,
    email: staff.email,
    sessionId: rows[0]!.id,
  };
}

async function marks(who: Member): Promise<string[]> {
  const { rows } = await owner.query<{ ids: string[] }>(
    `SELECT shared_device_ids::text[] AS ids FROM "session" WHERE id = $1`,
    [who.sessionId],
  );
  return rows[0]?.ids ?? [];
}

async function sessionEnded(who: Member): Promise<boolean> {
  const { rows } = await owner.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM "session" WHERE id = $1`,
    [who.sessionId],
  );
  return rows.length === 0 || rows[0]!.revoked_at !== null;
}

async function nameOf(who: Member): Promise<string> {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT name FROM "user" WHERE id = $1`,
    [who.userId],
  );
  return rows[0]!.name;
}

async function makeManagement(who: Member) {
  await owner.query(
    `UPDATE "session" SET kind = 'management', created_at = now() - interval '40 minutes',
       last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes'
     WHERE id = $1`,
    [who.sessionId],
  );
}

const getSession = (who: Member, headers: Record<string, string> = {}) =>
  who.client.get("/api/auth/get-session").set(originHeader).set(headers);

const keepAlive = (who: Member, headers: Record<string, string> = {}) =>
  who.client
    .post("/api/auth/sessions/current/activity")
    .set(originHeader)
    .set(headers)
    .send({});

const updateUser = (
  who: Member,
  name: string,
  headers: Record<string, string> = {},
) =>
  who.client
    .post("/api/auth/update-user")
    .set(originHeader)
    .set(headers)
    .send({ name });

const backoffice = (who: Member, headers: Record<string, string> = {}) =>
  who.client
    .get("/api/org/brands")
    .set({ Host: seededHostname })
    .set(originHeader)
    .set(headers);

const pos = (
  who: Member,
  tenant: IsolatedTenant = tenantA,
  headers: Record<string, string> = {},
) =>
  who.client
    .get(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/parked-orders`,
    )
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(headers);

/** The cookie replayed WITHOUT any device header must now be shared-device. */
async function expectReplayClosed(who: Member, originalName: string) {
  expectNotAllowed(await updateUser(who, "Dibajak Pemilik"));
  expect(await nameOf(who)).toBe(originalName);
  expectNotAllowed(await backoffice(who));
  expectRequired(await pos(who, tenantA));
  expectRequired(await pos(who, tenantB));
}

beforeAll(async () => {
  app = createApp();
  tenantA = await createIsolatedTenant(`fa-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`fb-${randomUUID().slice(0, 6)}`);
  for (const tenant of [tenantA, tenantB]) {
    const roleId = randomUUID();
    roleIds.set(tenant.tenantId, roleId);
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Kasir Tanda Pertama 5pipx', false, NULL, $3, false, '["tenant"]')`,
      [roleId, tenant.tenantId, JSON.stringify(POS_PERMISSIONS)],
    );
    await owner.query(
      `INSERT INTO notification_policies
         (tenant_id, web_push_enabled, email_enabled, whatsapp, max_attempts, retry_backoff_seconds)
       VALUES ($1, true, true, $2::jsonb, 3, '[30,120]'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET web_push_enabled = true`,
      [
        tenant.tenantId,
        JSON.stringify({
          enabled: false,
          allowedCategories: [],
          monthlyCap: 0,
          costPerMessageIdr: 0,
        }),
      ],
    );
  }
  setDeviceOutletResolver(async ({ tenantId }) =>
    tenantId === tenantA.tenantId
      ? tenantA.outletId
      : tenantId === tenantB.tenantId
        ? tenantB.outletId
        : null,
  );
}, 90_000);

afterEach(() => {
  // Never leak an armed barrier into the next test.
  barrier.armed = false;
  barrier.reached = null;
  barrier.release = null;
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  for (const tenant of [tenantA, tenantB]) {
    await owner.query("DELETE FROM push_subscriptions WHERE tenant_id = $1", [
      tenant.tenantId,
    ]);
    await owner.query("DELETE FROM pos_acting_staff WHERE tenant_id = $1", [
      tenant.tenantId,
    ]);
  }
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    deviceIds,
  ]);
  await dropIsolatedTenant(tenantA);
  await dropIsolatedTenant(tenantB);
  await owner.end();
});

describe("5pipx a) first token request on get-session records the mark", () => {
  it("5pipx a) get-session with cookie + token of a device flagged after login stamps the session; the header-less replay is shared-device in every tenant", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi Sebelum Dibendera");
    const name = await nameOf(who);
    expect(await marks(who)).toEqual([]);
    // The device is flagged shared only now; the login predates it.
    await setFlag(device, true);

    const response = await getSession(who, withToken(device));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await marks(who)).toEqual([device]);

    await expectReplayClosed(who, name);
  });
});

describe("5pipx b) a refused path records the mark too", () => {
  it("5pipx b) POST update-user with the token is refused 403 and still stamps; the header-less replay stays shared-device", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi Jalur Ditolak");
    const name = await nameOf(who);
    await setFlag(device, true);

    const refused = await updateUser(who, "Dibajak Pemilik", withToken(device));
    expectNotAllowed(refused);
    expect(await nameOf(who)).toBe(name);
    expect(await marks(who)).toEqual([device]);

    await expectReplayClosed(who, name);
  });
});

describe("5pipx c) keep-alive records the mark", () => {
  it("5pipx c) POST sessions/current/activity with the token succeeds and stamps; the header-less replay stays shared-device", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi KeepAlive Pertama");
    await makeManagement(who);
    const name = await nameOf(who);
    await setFlag(device, true);

    const response = await keepAlive(who, withToken(device));
    expect([200, 204], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await marks(who)).toEqual([device]);

    await expectReplayClosed(who, name);
    // The keep-alive path itself stays reachable for the marked session.
    const again = await keepAlive(who);
    expect([200, 204], JSON.stringify(again.body)).toContain(again.status);
  });
});

describe("5pipx d) controls", () => {
  it("5pipx d) personal session: get-session and keep-alive without a token record nothing and stay open", async () => {
    const who = await member("Sesi Pribadi Kontrol");
    await makeManagement(who);
    const session = await getSession(who);
    expect(session.status).toBe(200);
    const alive = await keepAlive(who);
    expect([200, 204], JSON.stringify(alive.body)).toContain(alive.status);
    expect(await marks(who)).toEqual([]);
    const brands = await backoffice(who);
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
  });

  it("5pipx d) token of an UNflagged device: get-session and keep-alive record nothing, the session stays personal", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi Perangkat Pribadi");
    await makeManagement(who);
    const session = await getSession(who, withToken(device));
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    const alive = await keepAlive(who, withToken(device));
    expect([200, 204], JSON.stringify(alive.body)).toContain(alive.status);
    expect(await marks(who)).toEqual([]);
    const brands = await backoffice(who);
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
    const update = await updateUser(who, "Pribadi Tetap Boleh");
    expect(update.status, JSON.stringify(update.body)).toBe(200);
  });

  it("5pipx d) 8 active marks + a 9th flagged device on get-session: 403 SHARED_DEVICE_MARK_LIMIT, marks unchanged, session closed", async () => {
    const who = await member("Sesi Penuh Pertama");
    const held: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await newDevice(true);
      expect(await markSessionSharedDevice(who.sessionId, id)).toBe(true);
      held.push(id);
    }
    const ninth = await newDevice(true);

    expectCode(await getSession(who, withToken(ninth)), 403, LIMIT);
    expect(await sessionEnded(who)).toBe(true);
    const ids = await marks(who);
    expect(ids).not.toContain(ninth);
    expect([...ids].sort()).toEqual([...held].sort());
    // The cookie is dead afterwards.
    expect((await backoffice(who)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// P2: the snapshot used by later guards of the SAME request includes the stamp.
// ---------------------------------------------------------------------------

type Pending = PromiseLike<{ status: number; body: unknown }>;

/**
 * Sends `start()`, waits until the real stamp has been written (barrier), asserts
 * the mark is in the database, unflags the device WITHOUT closing sessions, then
 * releases the request and returns its response.
 */
async function runWithBarrier(
  who: Member,
  device: string,
  start: () => Pending,
): Promise<Res> {
  let releaseNow!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseNow = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    barrier.reached = resolve;
  });
  barrier.release = release;
  barrier.armed = true;
  const pending: Promise<Res> = Promise.resolve(start()).then((r) => ({
    status: r.status,
    body: r.body,
  }));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "barrier not reached: the request never called stampSharedDeviceFromToken",
              ),
            ),
          15_000,
        );
      }),
    ]);
    expect(await marks(who)).toEqual([device]);
    // Unflag in SQL only: sessions stay open, exactly the lapse under test.
    await setFlag(device, false);
  } finally {
    if (timer) clearTimeout(timer);
    releaseNow();
  }
  return pending;
}

describe("7yvmm P2: later guards of the same request see the fresh stamp", () => {
  it("7yvmm back office: device unflagged between stamp and guard -> 403 ACTING_STAFF_NOT_ALLOWED, and the next header-less request stays closed", async () => {
    // Back office lives on the seeded host, so the device belongs to that tenant.
    const device = await newDevice(true, seeded);
    const who = await member("Sesi Barrier Backoffice");
    expect(await marks(who)).toEqual([]);

    const response = await runWithBarrier(who, device, () =>
      backoffice(who, withToken(device)),
    );
    expectNotAllowed(response);
    expectNotAllowed(await backoffice(who));
    expectRequired(await pos(who, tenantA));
  });

  it("7yvmm POS route: device unflagged between stamp and guard -> 401 ACTING_STAFF_REQUIRED, and the next header-less request stays closed", async () => {
    const device = await newDevice(true);
    const who = await member("Sesi Barrier POS");
    expect(await marks(who)).toEqual([]);

    const response = await runWithBarrier(who, device, () =>
      pos(who, tenantA, withToken(device)),
    );
    expectRequired(response);
    expectRequired(await pos(who, tenantA));
    expectNotAllowed(await backoffice(who));
  });

  it("7yvmm push removal: device unflagged between stamp and guard -> the phone's subscription is NOT deleted", async () => {
    // One account, a phone (personal) and a tablet login; each registered a
    // push subscription before the tablet is used on the shared device.
    const tablet = await member("Pemilik Push Barrier");
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Respond Push 5pipx', false, $3, false, '["tenant"]')`,
      [randomUUID(), tenantA.tenantId, JSON.stringify([RESPOND])],
    );
    const respondRole = (
      await owner.query<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Respond Push 5pipx'`,
        [tenantA.tenantId],
      )
    ).rows[0]!.id;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantA.tenantId, tablet.userId, respondRole],
    );
    const phone = agent(app);
    const login = await phone
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email: tablet.email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    await verifySessionMfa(tablet.email);

    const registerSub = async (client: Client) => {
      const key = createECDH("prime256v1");
      key.generateKeys();
      const response = await client
        .post("/api/notifications/push-subscriptions")
        .set({ Host: tenantA.hostname, ...originHeader })
        .send({
          endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
          keys: {
            p256dh: key.getPublicKey().toString("base64url"),
            auth: Buffer.alloc(16, 7).toString("base64url"),
          },
          deviceLabel: null,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.id as string;
    };
    const exists = async (id: string) =>
      (
        await owner.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [
          id,
        ])
      ).rowCount === 1;

    const phoneSub = await registerSub(phone);
    const tabletSub = await registerSub(tablet.client);
    const device = await newDevice(true);
    expect(await marks(tablet)).toEqual([]);

    const response = await runWithBarrier(tablet, device, () =>
      tablet.client
        .delete(
          `/api/notifications/push-subscriptions/${encodeURIComponent(phoneSub)}`,
        )
        .set({ Host: tenantA.hostname, ...originHeader })
        .set(withToken(device)),
    );
    expect(
      [401, 403, 404],
      `phone subscription removal must be refused: ${JSON.stringify(response.body)}`,
    ).toContain(response.status);
    expect(await exists(phoneSub)).toBe(true);
    expect(await exists(tabletSub)).toBe(true);

    // A later header-less request from the marked tablet is still refused.
    const later = await tablet.client
      .delete(
        `/api/notifications/push-subscriptions/${encodeURIComponent(phoneSub)}`,
      )
      .set({ Host: tenantA.hostname, ...originHeader });
    expect([401, 403, 404], JSON.stringify(later.body)).toContain(later.status);
    expect(await exists(phoneSub)).toBe(true);
  });

  it("7yvmm control: a personal session sending the token of an unflagged device passes unchanged and is never marked", async () => {
    const seededDevice = await newDevice(false, seeded);
    const device = await newDevice(false);
    const who = await member("Sesi Barrier Pribadi");
    // Not armed: the mock must behave exactly like the real function.
    const brands = await backoffice(who, withToken(seededDevice));
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
    const parked = await pos(who, tenantA, withToken(device));
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    expect(await marks(who)).toEqual([]);
  });
});
