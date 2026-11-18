// legend-vzvok (tier K, access): follow-up to 5pipx/7yvmm. Written from the card
// brief, not from the implementation.
//
// Rules under test (the first request that carries a device token records the
// "shared device" mark on a cookie session):
//  a) FAIL CLOSED: when the token is valid and the database fails while
//     recording the mark (or looking the device up), the request answers 503
//     SERVICE_UNAVAILABLE instead of passing unmarked. Nothing is changed (no
//     owner action). Once the database works again, the same request stamps
//     and the header-less replay of the cookie is shared-device. No token, or a
//     badly signed token, is not affected.
//  b) RACE: the device becomes shared BETWEEN the stamp lookup and the guard
//     lookup of the same request (session still unmarked in the request's
//     snapshot). The guard must record the mark before refusing 403 so the
//     cookie stays shared-device; at the 8-mark limit it answers
//     403 SHARED_DEVICE_MARK_LIMIT.
//  c) QR ORDER: an unmarked cookie session of a member plus the token of an
//     active flagged device orders as an anonymous guest AND records the mark
//     (the header-less cookie is then shared-device on the back office). At the
//     mark limit, or when the database fails, it still orders as a guest.
//
// Assumptions (spec silent):
//  - A database failure is simulated for real, not by mocking the service (an
//    in-module call such as the stamp's own device lookup cannot be intercepted
//    by a module mock, so the device-lookup failure is not covered here): a
//    row trigger on "session" that raises when shared_device_ids is updated for
//    ONE session id (created and dropped by the test).
//  - The race is simulated through a partial mock of stampSharedDeviceFromToken
//    (same technique as the 7yvmm barrier test): the real stamp runs while the
//    device is NOT yet shared (nothing recorded), then the device is flagged
//    (and, in the limit variant, 8 marks appear), and the stale snapshot is
//    returned to the later guards.
//  - Back office = GET /api/org/brands on the seeded host (200 for a personal
//    owner session). A shared-device refusal is 403 ACTING_STAFF_NOT_ALLOWED.
//  - "Order has no member attached" = orders.customer_profile_id IS NULL.
//  - A badly signed token must not produce 503; the back office answer for it
//    is not pinned beyond "not 503" (the get-session answer is pinned to 200).
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
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
import { ulidToUuid } from "@starter/shared/core";

// Partial mock: everything real, except stampSharedDeviceFromToken can simulate
// the race while armed.
const stub = vi.hoisted(() => ({
  race: null as null | (() => Promise<void>),
  raceDone: false,
  raceSnapshot: undefined as unknown,
}));
vi.mock("../services/shared-device.service.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/shared-device.service.ts")>();
  return {
    ...actual,
    stampSharedDeviceFromToken: async (
      ...args: Parameters<typeof actual.stampSharedDeviceFromToken>
    ) => {
      const hook = stub.race;
      if (!hook) return actual.stampSharedDeviceFromToken(...args);
      // Armed: the first call runs for real (device not shared yet), then the
      // world changes; every later call of the request sees the stale snapshot.
      if (stub.raceDone) return stub.raceSnapshot as never;
      const result = await actual.stampSharedDeviceFromToken(...args);
      stub.raceSnapshot = result;
      stub.raceDone = true;
      await hook();
      return result;
    },
  };
});

import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import {
  hex64,
  owner as loyaltyOwner,
  seedMember,
  seedProgram,
} from "./member-loyalty-helpers.ts";

const NOT_ALLOWED = "ACTING_STAFF_NOT_ALLOWED";
const LIMIT = "SHARED_DEVICE_MARK_LIMIT";
const UNAVAILABLE = "SERVICE_UNAVAILABLE";

type Client_ = ReturnType<typeof agent>;
type Member = {
  client: Client_;
  userId: string;
  email: string;
  sessionId: string;
};
type Res = { status: number; body: unknown };
type Place = { tenantId: string; outletId: string };

let app: Express;
let qrTenant: IsolatedTenant;
let qrStaff: Staff;
let qrHeaders: { Host: string };
const seeded: Place = { tenantId: seededTenantId, outletId: seededOutletA };
const deviceIds: string[] = [];
const triggers: string[] = [];
const placeOf = new Map<string, Place>();

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

const codeOf = (response: Res) =>
  (response.body as { error?: { code?: string } }).error?.code ?? "";

function expectCode(response: Res, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(code);
}
const expectNotAllowed = (response: Res) =>
  expectCode(response, 403, NOT_ALLOWED);
const expectUnavailable = (response: Res) =>
  expectCode(response, 503, UNAVAILABLE);

async function newDevice(flagged: boolean, place: Place): Promise<string> {
  const id = randomUUID();
  deviceIds.push(id);
  placeOf.set(id, place);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', $5)`,
    [
      id,
      place.tenantId,
      place.outletId,
      `Kasir vzvok ${id.slice(0, 6)}`,
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

/** A validly formed token whose payload was altered: the signature cannot match. */
function tamperedToken(deviceId: string): string {
  const token = tokenOf(deviceId);
  const at = Math.floor(token.length / 2);
  const swap = token[at] === "A" ? "B" : "A";
  return token.slice(0, at) + swap + token.slice(at + 1);
}

/** A personal owner login (seeded tenant), MFA verified, never marked. */
async function member(label: string): Promise<Member> {
  const staff = await staffWithRole(app, { template: "owner", label });
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

const getSession = (who: Member, headers: Record<string, string> = {}) =>
  who.client.get("/api/auth/get-session").set(originHeader).set(headers);

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

/** The cookie replayed WITHOUT any device header must now be shared-device. */
async function expectReplayClosed(who: Member, originalName: string) {
  expectNotAllowed(await updateUser(who, "Dibajak Pemilik"));
  expect(await nameOf(who)).toBe(originalName);
  expectNotAllowed(await backoffice(who));
}

/**
 * Makes every write of session.shared_device_ids fail for ONE session, for real
 * (a trigger raising an exception). Returns the function that removes it.
 */
async function failMarkWrites(sessionId: string): Promise<() => Promise<void>> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId))
    throw new Error(`unexpected session id format: ${sessionId}`);
  const name = `vzvok_${randomBytes(5).toString("hex")}`;
  await owner.query(
    `CREATE TRIGGER ${name} BEFORE UPDATE OF shared_device_ids ON "session"
       FOR EACH ROW WHEN (NEW.id = '${sessionId}')
       EXECUTE FUNCTION vzvok_fail_mark_write()`,
  );
  triggers.push(name);
  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON "session"`);
  };
}

async function dropFaultFunction() {
  await owner.query("DROP FUNCTION IF EXISTS vzvok_fail_mark_write()");
}

// ---------------------------------------------------------------------------
// QR order fixtures (a pay-first zone, one coffee item, a loyalty programme).
// ---------------------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Guest = { token: string; sessionId: string };

async function seat(): Promise<Guest> {
  const zone = await createZone(
    qrStaff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    qrHeaders,
  );
  const table = await createTable(
    qrStaff.client,
    { zoneId: zone.id },
    qrHeaders,
  );
  const qr = await issueQr(qrStaff.client, table.id, qrHeaders);
  const response = await scan(app, {
    token: qr.token,
    hostname: qrTenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

/**
 * Places one pay-first order as the guest; `who`'s cookie and `extra` headers
 * ride on the checkout request.
 */
async function placeOrder(
  guest: Guest,
  who?: Member,
  extra: Record<string, string> = {},
) {
  const base = `/api/table-sessions/${guest.sessionId}`;
  const client = who ? who.client : agent(app);
  const auth = (test: ReturnType<typeof client.get>, withExtra = false) =>
    test
      .set("Host", qrTenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .set(withExtra ? extra : {});
  const guestClient = agent(app);
  const view = await auth(guestClient.get(base));
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  const added = await auth(guestClient.post(`${base}/cart/lines`)).send({
    idempotencyKey: randomUUID(),
    modifierIds: [],
    menuItemId: ids.kopi,
    quantity: 1,
    expectedCartVersion: view.body.data.cart.version,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await auth(client.post(`${base}/orders`), true).send({
    expectedCartVersion: added.body.data.cart.version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.data.order.id as string;
}

async function customerOf(orderId: string) {
  const { rows } = await owner.query<{
    customer_profile_id: string | null;
    customer_attached_via: string | null;
  }>(
    `SELECT customer_profile_id::text, customer_attached_via FROM orders
      WHERE tenant_id = $1 AND id = $2::uuid`,
    [qrTenant.tenantId, ulidToUuid(orderId)],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** A personal login that also owns an active member profile in the QR tenant. */
async function qrMember(
  label: string,
): Promise<Member & { profileId: string }> {
  const who = await member(label);
  const profile = await seedMember(qrTenant.tenantId, {
    userId: who.userId,
    name: await nameOf(who),
  });
  return { ...who, profileId: profile.id };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  await owner.query(
    `CREATE OR REPLACE FUNCTION vzvok_fail_mark_write() RETURNS trigger
       LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'vzvok: simulated shared-device mark write failure';
     END $$`,
  );

  qrTenant = await createIsolatedTenant(`vz-${randomUUID().slice(0, 6)}`);
  qrStaff = await staffOfIsolatedTenant(app, qrTenant);
  qrHeaders = { Host: qrTenant.hostname };
  await asOwnerTenant(qrTenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Gagal Tertutup Uji', 0)`,
      [ids.category, qrTenant.tenantId, qrTenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [
        ids.kopi,
        qrTenant.tenantId,
        qrTenant.brandId,
        ids.category,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, qrTenant.tenantId, qrTenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), qrTenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, qrTenant.tenantId, qrStaff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-VZ', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, qrTenant.tenantId, qrStaff.userId],
    );
    for (const purpose of ["loyalty", "marketing", "ai"])
      await client.query(
        `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
         VALUES ($1, $2, '2026-01', $3, '2026-01-01T00:00:00+07:00')
         ON CONFLICT (tenant_id, purpose, version) DO NOTHING`,
        [qrTenant.tenantId, purpose, hex64()],
      );
  });
  await seedProgram(qrTenant.tenantId, {
    isActive: true,
    earnSpendIdr: 1000,
    earnPoints: 1,
    expiryMonths: 12,
    dailyCap: 100_000,
  });
}, 120_000);

afterEach(() => {
  // Never leak an armed stub into the next test.
  stub.race = null;
  stub.raceDone = false;
  stub.raceSnapshot = undefined;
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  for (const name of triggers)
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON "session"`);
  await dropFaultFunction();
  if (deviceIds.length)
    await owner.query(
      "UPDATE devices SET shared_mode = false WHERE id = ANY($1::uuid[])",
      [deviceIds],
    );
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    qrTenant.tenantId,
    randomUUID(),
  ]);
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    deviceIds,
  ]);
  await owner.end();
  await loyaltyOwner.end();
});

// ---------------------------------------------------------------------------
// a) fail closed
// ---------------------------------------------------------------------------

describe("vzvok a) the stamp fails closed when the database fails", () => {
  it("vzvok a) back office: mark write fails -> 503 SERVICE_UNAVAILABLE, no 200; after recovery the same request stamps and the replay is closed", async () => {
    const device = await newDevice(true, seeded);
    const who = await member("Sesi Gagal Tulis Backoffice");
    const name = await nameOf(who);
    expect(await marks(who)).toEqual([]);

    const recover = await failMarkWrites(who.sessionId);
    try {
      expectUnavailable(await backoffice(who, withToken(device)));
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }

    expectNotAllowed(await backoffice(who, withToken(device)));
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok a) get-session: mark write fails -> 503 SERVICE_UNAVAILABLE; after recovery it answers 200 and stamps, the replay is closed", async () => {
    const device = await newDevice(true, seeded);
    const who = await member("Sesi Gagal Tulis GetSession");
    const name = await nameOf(who);

    const recover = await failMarkWrites(who.sessionId);
    try {
      expectUnavailable(await getSession(who, withToken(device)));
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }

    const ok = await getSession(who, withToken(device));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok a) update-user: mark write fails -> 503 SERVICE_UNAVAILABLE and the name is NOT changed; after recovery it is refused 403 and stamps, the replay is closed", async () => {
    const device = await newDevice(true, seeded);
    const who = await member("Sesi Gagal Tulis UpdateUser");
    const name = await nameOf(who);

    const recover = await failMarkWrites(who.sessionId);
    try {
      expectUnavailable(
        await updateUser(who, "Dibajak Pemilik", withToken(device)),
      );
      expect(await nameOf(who)).toBe(name);
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }

    expectNotAllowed(
      await updateUser(who, "Dibajak Pemilik", withToken(device)),
    );
    expect(await nameOf(who)).toBe(name);
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok a) control: with the write failing, a request WITHOUT a token is unaffected (no 503, nothing recorded)", async () => {
    const who = await member("Sesi Tanpa Token");
    const recover = await failMarkWrites(who.sessionId);
    try {
      const session = await getSession(who);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      const brands = await backoffice(who);
      expect(brands.status, JSON.stringify(brands.body)).toBe(200);
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }
  });

  it("vzvok a) control: with the write failing, a token that is badly formed or badly signed is unaffected (no 503, nothing recorded)", async () => {
    const device = await newDevice(true, seeded);
    const who = await member("Sesi Token Rusak");
    const recover = await failMarkWrites(who.sessionId);
    try {
      for (const bad of ["not-a-valid-token", tamperedToken(device)]) {
        const session = await getSession(who, { [DEVICE_TOKEN_HEADER]: bad });
        expect(session.status, JSON.stringify(session.body)).toBe(200);
        const brands = await backoffice(who, { [DEVICE_TOKEN_HEADER]: bad });
        expect(brands.status, JSON.stringify(brands.body)).not.toBe(503);
      }
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }
  });
});

// ---------------------------------------------------------------------------
// b) race between the stamp lookup and the guard lookup
// ---------------------------------------------------------------------------

describe("vzvok b) the device becomes shared between the stamp and the guard", () => {
  it("vzvok b) back office: 403 ACTING_STAFF_NOT_ALLOWED AND the mark is recorded; the header-less replay stays closed", async () => {
    const device = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Backoffice");
    const name = await nameOf(who);
    stub.race = () => setFlag(device, true).then(() => undefined);

    const response = await backoffice(who, withToken(device));
    stub.race = null;
    expect(stub.raceDone, "the stamp was never called by the request").toBe(
      true,
    );
    expectNotAllowed(response);
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok b) update-user: 403 ACTING_STAFF_NOT_ALLOWED, name unchanged AND the mark is recorded; the header-less replay stays closed", async () => {
    const device = await newDevice(false, seeded);
    const who = await member("Sesi Balapan UpdateUser");
    const name = await nameOf(who);
    stub.race = () => setFlag(device, true).then(() => undefined);

    const response = await updateUser(
      who,
      "Dibajak Pemilik",
      withToken(device),
    );
    stub.race = null;
    expect(stub.raceDone, "the stamp was never called by the request").toBe(
      true,
    );
    expectNotAllowed(response);
    expect(await nameOf(who)).toBe(name);
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok b) 8 marks appear in the meantime: back office answers 403 SHARED_DEVICE_MARK_LIMIT and the 9th device is not recorded", async () => {
    const ninth = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Penuh");
    const held: string[] = [];
    stub.race = async () => {
      for (let i = 0; i < 8; i += 1) {
        const id = await newDevice(true, seeded);
        expect(await markSessionSharedDevice(who.sessionId, id)).toBe(true);
        held.push(id);
      }
      await setFlag(ninth, true);
    };

    const response = await backoffice(who, withToken(ninth));
    stub.race = null;
    expect(stub.raceDone, "the stamp was never called by the request").toBe(
      true,
    );
    expectCode(response, 403, LIMIT);
    const recorded = await marks(who);
    expect(recorded).not.toContain(ninth);
    expect([...recorded].sort()).toEqual([...held].sort());
  });

  it("vzvok b) 8 marks appear in the meantime: update-user answers 403 SHARED_DEVICE_MARK_LIMIT and the name is unchanged", async () => {
    const ninth = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Penuh UpdateUser");
    const name = await nameOf(who);
    stub.race = async () => {
      for (let i = 0; i < 8; i += 1) {
        const id = await newDevice(true, seeded);
        expect(await markSessionSharedDevice(who.sessionId, id)).toBe(true);
      }
      await setFlag(ninth, true);
    };

    const response = await updateUser(who, "Dibajak Pemilik", withToken(ninth));
    stub.race = null;
    expect(stub.raceDone, "the stamp was never called by the request").toBe(
      true,
    );
    expectCode(response, 403, LIMIT);
    expect(await nameOf(who)).toBe(name);
    expect(await marks(who)).not.toContain(ninth);
  });

  it("vzvok b) race + the mark write fails: back office answers 503 SERVICE_UNAVAILABLE, nothing is recorded; once the database works the same request stamps and the replay is closed", async () => {
    const device = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Gagal Backoffice");
    const name = await nameOf(who);
    let recover: (() => Promise<void>) | null = null;
    stub.race = async () => {
      await setFlag(device, true);
      recover = await failMarkWrites(who.sessionId);
    };

    try {
      const response = await backoffice(who, withToken(device));
      stub.race = null;
      expect(stub.raceDone, "the stamp was never called by the request").toBe(
        true,
      );
      expectUnavailable(response);
      expect(await marks(who)).toEqual([]);
    } finally {
      stub.race = null;
      await (recover as (() => Promise<void>) | null)?.();
    }

    // Database back: the same request now records the mark and is refused.
    expectNotAllowed(await backoffice(who, withToken(device)));
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok b) race + the mark write fails: update-user answers 503 SERVICE_UNAVAILABLE, the name is unchanged and nothing is recorded; once the database works the same request is refused 403 and stamps", async () => {
    const device = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Gagal UpdateUser");
    const name = await nameOf(who);
    let recover: (() => Promise<void>) | null = null;
    stub.race = async () => {
      await setFlag(device, true);
      recover = await failMarkWrites(who.sessionId);
    };

    try {
      const response = await updateUser(
        who,
        "Dibajak Pemilik",
        withToken(device),
      );
      stub.race = null;
      expect(stub.raceDone, "the stamp was never called by the request").toBe(
        true,
      );
      expectUnavailable(response);
      expect(await nameOf(who)).toBe(name);
      expect(await marks(who)).toEqual([]);
    } finally {
      stub.race = null;
      await (recover as (() => Promise<void>) | null)?.();
    }

    expectNotAllowed(
      await updateUser(who, "Dibajak Pemilik", withToken(device)),
    );
    expect(await nameOf(who)).toBe(name);
    expect(await marks(who)).toEqual([device]);
    await expectReplayClosed(who, name);
  });

  it("vzvok b) control: a personal session with the token of a device that never becomes shared is untouched", async () => {
    const device = await newDevice(false, seeded);
    const who = await member("Sesi Balapan Kontrol");
    stub.race = () => Promise.resolve();

    const brands = await backoffice(who, withToken(device));
    stub.race = null;
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
    expect(await marks(who)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// c) QR order
// ---------------------------------------------------------------------------

describe("vzvok c) QR order records the mark and stays a guest order", () => {
  it("vzvok c) unmarked member cookie + token of a flagged device: no member attached AND the mark is recorded; the header-less cookie is shared-device on the back office", async () => {
    const device = await newDevice(true, qrTenant);
    const who = await qrMember("Anggota Tablet Baru");
    const name = await nameOf(who);
    expect(await marks(who)).toEqual([]);

    const orderId = await placeOrder(await seat(), who, withToken(device));
    const attached = await customerOf(orderId);
    expect(attached.customer_profile_id).toBeNull();
    expect(attached.customer_attached_via).toBeNull();
    expect(await marks(who)).toEqual([device]);

    await expectReplayClosed(who, name);
  });

  it("vzvok c) control: a personal session without a token still gets its member profile attached and records nothing", async () => {
    const who = await qrMember("Anggota Pribadi");
    const orderId = await placeOrder(await seat(), who);
    const attached = await customerOf(orderId);
    expect(attached.customer_profile_id).toBe(who.profileId);
    expect(attached.customer_attached_via).toBe("pwa_session");
    expect(await marks(who)).toEqual([]);
  });

  it("vzvok c) control: the token of a device that is NOT flagged leaves a personal session a member and records nothing", async () => {
    const device = await newDevice(false, qrTenant);
    const who = await qrMember("Anggota Perangkat Pribadi");
    const orderId = await placeOrder(await seat(), who, withToken(device));
    expect((await customerOf(orderId)).customer_profile_id).toBe(who.profileId);
    expect(await marks(who)).toEqual([]);
  });

  // Control of the guest flow, not a fail-first test: a session that already
  // holds marks returns anonymous early, so the 8-mark limit path of the new
  // stamp call is not reached here. It pins that the guest order still works and
  // that the session is not closed / no 9th mark is recorded.
  it("vzvok c) control: a session already holding 8 marks plus a 9th flagged device orders as an anonymous guest, is NOT closed and records no 9th mark", async () => {
    const who = await qrMember("Anggota Penuh");
    const held: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await newDevice(true, qrTenant);
      expect(await markSessionSharedDevice(who.sessionId, id)).toBe(true);
      held.push(id);
    }
    const ninth = await newDevice(true, qrTenant);

    const orderId = await placeOrder(await seat(), who, withToken(ninth));
    expect((await customerOf(orderId)).customer_profile_id).toBeNull();
    expect(await sessionEnded(who)).toBe(false);
    const recorded = await marks(who);
    expect(recorded).not.toContain(ninth);
    expect([...recorded].sort()).toEqual([...held].sort());
  });

  // Regression control, not fail-first: this also passes on the base commit (the
  // order was anonymous there too because the token's device is flagged). It
  // pins that a failing mark write never turns the guest order into a 5xx or
  // attaches a member.
  it("vzvok c) control: database failure while recording the mark still orders as an anonymous guest (no 5xx), no member attached", async () => {
    const device = await newDevice(true, qrTenant);
    const who = await qrMember("Anggota Gagal Tulis");
    const recover = await failMarkWrites(who.sessionId);
    try {
      // placeOrder asserts the checkout answered 201 (so no 5xx).
      const orderId = await placeOrder(await seat(), who, withToken(device));
      expect((await customerOf(orderId)).customer_profile_id).toBeNull();
      expect(await marks(who)).toEqual([]);
    } finally {
      await recover();
    }
  });
});
