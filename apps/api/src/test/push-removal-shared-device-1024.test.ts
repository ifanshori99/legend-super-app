// legend 1024 (brief D): removing a web push subscription from a shared
// (cashier) device. Written from the card brief and the 1012 contract, not from
// the implementation.
//
// Rules under test:
//  - One owner account has two logins: a phone (personal) and a tablet. The
//    tablet login is marked as used on an active flagged shared device
//    (markSessionSharedDevice). Each login registered a push subscription:
//    P (phone) and T (tablet).
//  - DELETE /api/notifications/push-subscriptions/:id from the marked tablet
//    cookie WITHOUT a cashier PIN token: its own subscription T is removed
//    (204); the owner's other subscription P is refused and stays.
//  - A subscription of the same owner in ANOTHER tenant is refused and stays,
//    also from the marked cookie.
//  - A marked session that carries the flagged device's X-Device-Token may also
//    remove a subscription bound to that device (device_id match).
//  - Personal sessions / personal devices keep the old behaviour: they remove
//    any subscription of the user (204).
//
// ASSUMPTIONS where the brief is silent:
//  - "Refused" = 403 or 404 (the brief says "404/403"); the row must remain.
//  - A successful DELETE answers 204 (as in push-registration.test.ts).
//  - The notification route is a SHELL route: a marked session reaches it
//    without a cashier token (1012 contract), so a refusal can only come from
//    the new ownership restriction.
//  - Registering a push subscription is NOT a shell route (a marked session is
//    refused 403 ACTING_STAFF_NOT_ALLOWED), so every subscription is registered
//    BEFORE the tablet login is marked/flagged. T carries session_id (and, in
//    the device test, device_id from the still-unflagged device's token).
import { createECDH, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
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

import { createApp } from "../app.ts";
import { enrollDevice } from "../services/device.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers";

const RESPOND = "facility.emergency.respond";
const PASSWORD = "Test-password-123!";
const app = createApp();
const actor = randomUUID();

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA: string;
const userIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Account = { userId: string; email: string };

async function seedOutlet(tenant: IsolatedTenant, label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `PD-${id.slice(0, 8)}`.toUpperCase(),
      label,
    ],
  );
  return id;
}

async function grantRole(
  tenant: IsolatedTenant,
  userId: string,
  permissions: string[],
  outlet: string | null,
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, $5::jsonb)`,
    [
      roleId,
      tenant.tenantId,
      `Push1024 ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([outlet ? "outlet" : "tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, outlet ? "outlet" : "tenant", outlet],
  );
}

/** A real account with a login session (the "tablet") and a role in tenant A. */
async function newOwner(): Promise<Account & { tablet: Client }> {
  const tablet = agent(app);
  const email = `push1024-${randomUUID()}@example.com`;
  const signUp = await tablet
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Owner Push 1024", email, password: PASSWORD });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const userId = (await tablet.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  await grantRole(tenantA, userId, [RESPOND], outletA);
  await verifySessionMfa(email);
  return { userId, email, tablet };
}

/** A second login of the same account (the "phone"). */
async function secondLogin(account: Account): Promise<Client> {
  const phone = agent(app);
  const login = await phone
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: account.email, password: PASSWORD });
  expect(login.status).toBe(200);
  await verifySessionMfa(account.email);
  return phone;
}

const sessionIdOf = async (client: Client) =>
  (await client.get("/api/auth/get-session")).body.session.id as string;

function scopeOf(tenant: IsolatedTenant, outlet: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
  );
}

/** A really enrolled device of tenant A flagged as shared. */
async function sharedDevice(flagged = true) {
  const { device, token } = await enrollDevice(
    scopeOf(tenantA, outletA),
    actor,
    {
      outletId: outletA,
      type: "pos",
      label: `Tablet ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    },
  );
  if (flagged) await flag(device.id);
  return { deviceId: device.id, token };
}

const flag = (deviceId: string) =>
  owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
    deviceId,
  ]);

function subscriptionBody() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
    deviceLabel: null,
  };
}

async function register(
  client: Client,
  tenant: IsolatedTenant,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await client
    .post("/api/notifications/push-subscriptions")
    .set({ Host: tenant.hostname, ...originHeader, ...headers })
    .send(subscriptionBody());
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.id as string;
}

const remove = (
  client: Client,
  id: string,
  tenant: IsolatedTenant = tenantA,
  headers: Record<string, string> = {},
) =>
  client
    .delete(`/api/notifications/push-subscriptions/${encodeURIComponent(id)}`)
    .set({ Host: tenant.hostname, ...originHeader, ...headers });

const exists = async (id: string) =>
  (await owner.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [id]))
    .rowCount === 1;

function expectRefused(response: { status: number; body: unknown }) {
  expect([403, 404], JSON.stringify(response.body)).toContain(response.status);
}

async function purge(tenantId: string) {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`,
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  tenantA = await createIsolatedTenant(`pd-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`pd-b-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet(tenantA, "Outlet push 1024");
  for (const tenant of [tenantA, tenantB]) {
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
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await purge(tenantB.tenantId);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
});

describe("1024 push removal from a marked shared-device session", () => {
  it("removes the tablet's own subscription T but refuses the phone's P, which stays", async () => {
    const account = await newOwner();
    const phone = await secondLogin(account);
    const phoneSub = await register(phone, tenantA);
    const tabletSub = await register(account.tablet, tenantA);
    expect(await exists(phoneSub)).toBe(true);
    expect(await exists(tabletSub)).toBe(true);
    // The tablet login is only now used on a flagged shared device.
    const device = await sharedDevice();
    const tabletSession = await sessionIdOf(account.tablet);
    expect(await markSessionSharedDevice(tabletSession, device.deviceId)).toBe(
      true,
    );

    // No PIN / cashier token on either request.
    expectRefused(await remove(account.tablet, phoneSub));
    expect(await exists(phoneSub)).toBe(true);

    const own = await remove(account.tablet, tabletSub);
    expect(own.status, JSON.stringify(own.body)).toBe(204);
    expect(await exists(tabletSub)).toBe(false);
    expect(await exists(phoneSub)).toBe(true);
  });

  it("a marked cookie cannot remove the owner's subscription in another tenant", async () => {
    const account = await newOwner();
    await grantRole(tenantB, account.userId, [], null);
    const phone = await secondLogin(account);
    const foreignSub = await register(phone, tenantB);
    expect(await exists(foreignSub)).toBe(true);
    const device = await sharedDevice();
    expect(
      await markSessionSharedDevice(
        await sessionIdOf(account.tablet),
        device.deviceId,
      ),
    ).toBe(true);

    // Only the owning tenant's host is meaningful: tenant A's host cannot see
    // tenant B's row at all (row-level security), so it would 404 trivially.
    expectRefused(await remove(account.tablet, foreignSub, tenantB));
    expect(await exists(foreignSub)).toBe(true);
  });

  it("a session whose mark is no longer active (device unflagged) still cannot remove the phone's subscription", async () => {
    const account = await newOwner();
    const phone = await secondLogin(account);
    const phoneSub = await register(phone, tenantA);
    const device = await sharedDevice();
    expect(
      await markSessionSharedDevice(
        await sessionIdOf(account.tablet),
        device.deviceId,
      ),
    ).toBe(true);
    // Control: while flagged the marked tablet is refused.
    expectRefused(await remove(account.tablet, phoneSub));
    expect(await exists(phoneSub)).toBe(true);

    // The admin switches shared mode off; the mark stays on the session.
    await owner.query("UPDATE devices SET shared_mode = false WHERE id = $1", [
      device.deviceId,
    ]);
    // Assumption: a session that served a shared device never turns back into
    // a plain personal one, so the phone's subscription stays protected (a
    // closed session, 401, is also acceptable: the row must remain).
    const response = await remove(account.tablet, phoneSub);
    expect([401, 403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await exists(phoneSub)).toBe(true);
  });

  it("a marked session carrying the flagged device's token may remove a subscription bound to that device", async () => {
    const account = await newOwner();
    // Registered while the device is still personal, so it is bound to it.
    const device = await sharedDevice(false);
    const bound = await register(account.tablet, tenantA, {
      [DEVICE_TOKEN_HEADER]: device.token,
    });
    await flag(device.deviceId);

    // A later login on the same tablet, same device token.
    const later = await secondLogin(account);
    expect(
      await markSessionSharedDevice(await sessionIdOf(later), device.deviceId),
    ).toBe(true);
    const removed = await remove(later, bound, tenantA, {
      [DEVICE_TOKEN_HEADER]: device.token,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await exists(bound)).toBe(false);
  });
});

describe("1024 push removal from personal sessions and devices", () => {
  it("a never-marked session still removes every subscription of the account", async () => {
    const account = await newOwner();
    const phone = await secondLogin(account);
    const fromTablet = await register(account.tablet, tenantA);
    const fromPhone = await register(phone, tenantA);

    const first = await remove(phone, fromTablet);
    expect(first.status, JSON.stringify(first.body)).toBe(204);
    const second = await remove(phone, fromPhone);
    expect(second.status, JSON.stringify(second.body)).toBe(204);
    expect(await exists(fromTablet)).toBe(false);
    expect(await exists(fromPhone)).toBe(false);
  });

  it("a session on a personal (unflagged) device removes the account's other subscription", async () => {
    const account = await newOwner();
    const phone = await secondLogin(account);
    const { device, token } = await enrollDevice(
      scopeOf(tenantA, outletA),
      actor,
      {
        outletId: outletA,
        type: "pos",
        label: `Pribadi ${randomUUID().slice(0, 6)}`,
        stationId: null,
        idempotencyKey: randomUUID(),
      },
    );
    expect(device.id).toBeTruthy();
    const other = await register(phone, tenantA);
    const own = await register(account.tablet, tenantA, {
      [DEVICE_TOKEN_HEADER]: token,
    });

    const removedOther = await remove(account.tablet, other, tenantA, {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect(removedOther.status, JSON.stringify(removedOther.body)).toBe(204);
    const removedOwn = await remove(account.tablet, own, tenantA, {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect(removedOwn.status, JSON.stringify(removedOwn.body)).toBe(204);
    expect(await exists(other)).toBe(false);
    expect(await exists(own)).toBe(false);
  });
});
