// legend-xdlxa / 863: a legacy web-push subscription (registered_at NULL, or
// older than 30 days) cannot receive alarms, so the account-level device list
// must NOT show it as a working device, and registering the same browser
// endpoint again must revive that very row (same id) so it shows up again.
// Written from the brief and design (no implementation read), following
// push-registration.test.ts and push-devices-cross-tenant.test.ts.
//
// ASSUMPTIONS where the brief is silent:
//  - "Deliverable" = registered_at NOT NULL and younger than 30 days (design.md).
//    Both a NULL row and a 31-day-old row are hidden from
//    GET /api/identity/push-devices (200 { data: [{ id, ... }] }).
//  - POST /api/notifications/push-subscriptions with the SAME endpoint as the
//    legacy row answers 200 with data.id equal to the legacy row id (one row
//    per tenant+user+endpoint, so no second row is created).
//  - The legacy row is seeded directly as the table owner with the endpoint
//    sealed by the real protector, so the endpoint hash matches the one POST
//    computes for the same tenant+user.
//  - If these tests are green right away, the behavior already exists (the
//    brief says that is legitimate): the real gap is on the web side.
import { createECDH, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// config/env.ts reads process.env once at import, so web push must be
// configured before the app module graph loads.
await vi.hoisted(async () => {
  const { createECDH } = await import("node:crypto");
  const key = createECDH("prime256v1");
  key.generateKeys();
  process.env.NOTIFICATION_PUSH_PROVIDER = "web_push";
  process.env.VAPID_PUBLIC_KEY = key.getPublicKey().toString("base64url");
  process.env.VAPID_PRIVATE_KEY = key.getPrivateKey().toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:push@example.test";
});

import { createApp } from "../app.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const LIST = "/api/identity/push-devices";
const REGISTER = "/api/notifications/push-subscriptions";
const app = createApp();

let tenant: IsolatedTenant;
const userIds: string[] = [];

type Account = { client: ReturnType<typeof agent>; userId: string };

/** A signed-in member of the isolated tenant. */
async function account(): Promise<Account> {
  const client = agent(app);
  await signUp(client, "Pengguna Push Lama");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, tenant.roleId],
  );
  return { client, userId };
}

function browserSubscription() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
  };
}

/** Seed a subscription row for `userId` with an explicit registered_at. */
async function seedRow(
  userId: string,
  subscription: ReturnType<typeof browserSubscription>,
  registeredAt: Date | null,
): Promise<string> {
  const sealed = await createPushSubscriptionProtector().seal(
    subscription,
    tenant.tenantId,
    userId,
  );
  const id = randomUUID();
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        device_label, created_at, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'HP lama', now() - interval '60 days', $7)`,
    [
      tenant.tenantId,
      id,
      userId,
      sealed.endpointHash,
      sealed.ciphertext,
      sealed.keyVersion,
      registeredAt,
    ],
  );
  return id;
}

const host = () => ({ Host: tenant.hostname, ...originHeader });
const listedIds = async (who: Account) => {
  const response = await who.client.get(LIST).set(host());
  expect(response.status).toBe(200);
  return (response.body.data as { id: string }[]).map((d) => d.id);
};
const register = (
  who: Account,
  subscription: ReturnType<typeof browserSubscription>,
) =>
  who.client
    .post(REGISTER)
    .set(host())
    .send({ ...subscription, deviceLabel: "HP lama" });
const rowsOf = async (userId: string) =>
  (
    await owner.query<{ id: string; registered_at: Date | null }>(
      `SELECT id, registered_at FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    )
  ).rows;

beforeAll(async () => {
  tenant = await createIsolatedTenant(`p863-${randomUUID().slice(0, 6)}`);
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
}, 90_000);

afterAll(async () => {
  await owner.query(`DELETE FROM push_subscriptions WHERE tenant_id = $1`, [
    tenant.tenantId,
  ]);
  await dropIsolatedTenant(tenant);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
});

describe("legend-xdlxa 863 device list counts only deliverable subscriptions", () => {
  it("lists a fresh registration (control)", async () => {
    const me = await account();
    const fresh = await seedRow(me.userId, browserSubscription(), new Date());
    expect(await listedIds(me)).toContain(fresh);
  });

  it("does not list a subscription whose registered_at is NULL", async () => {
    const me = await account();
    const legacy = await seedRow(me.userId, browserSubscription(), null);
    expect(await listedIds(me)).not.toContain(legacy);
  });

  it("does not list a subscription registered more than 30 days ago", async () => {
    const me = await account();
    const stale = await seedRow(
      me.userId,
      browserSubscription(),
      new Date(Date.now() - 31 * 24 * 3600 * 1000),
    );
    expect(await listedIds(me)).not.toContain(stale);
  });

  it("keeps listing a subscription registered 29 days ago", async () => {
    const me = await account();
    const aging = await seedRow(
      me.userId,
      browserSubscription(),
      new Date(Date.now() - 29 * 24 * 3600 * 1000),
    );
    expect(await listedIds(me)).toContain(aging);
  });
});

describe("legend-xdlxa 863 registering the same endpoint again revives the row", () => {
  it("a NULL registered_at row comes back with the same id and shows in the list", async () => {
    const me = await account();
    const subscription = browserSubscription();
    const legacy = await seedRow(me.userId, subscription, null);
    expect(await listedIds(me)).not.toContain(legacy);

    const response = await register(me, subscription);
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(legacy);

    const rows = await rowsOf(me.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registered_at).toBeInstanceOf(Date);
    expect(await listedIds(me)).toContain(legacy);
  });

  it("a row older than 30 days comes back with the same id and shows in the list", async () => {
    const me = await account();
    const subscription = browserSubscription();
    const stale = await seedRow(
      me.userId,
      subscription,
      new Date(Date.now() - 45 * 24 * 3600 * 1000),
    );
    expect(await listedIds(me)).not.toContain(stale);

    const response = await register(me, subscription);
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(stale);

    expect(await rowsOf(me.userId)).toHaveLength(1);
    expect(await listedIds(me)).toContain(stale);
  });

  it("another user's legacy row never appears for the caller", async () => {
    const me = await account();
    const other = await account();
    const theirs = await seedRow(other.userId, browserSubscription(), null);
    expect(await listedIds(me)).not.toContain(theirs);
    expect(await listedIds(other)).not.toContain(theirs);
  });
});
