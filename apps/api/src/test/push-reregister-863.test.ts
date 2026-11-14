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
let otherTenant: IsolatedTenant;
const userIds: string[] = [];

type Account = { client: ReturnType<typeof agent>; userId: string };

/** A signed-in member of the isolated tenant. */
async function account(inTenant: IsolatedTenant = tenant): Promise<Account> {
  const client = agent(app);
  await signUp(client, "Pengguna Push Lama");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [inTenant.tenantId, userId, inTenant.roleId],
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

const host = (inTenant: IsolatedTenant = tenant) => ({
  Host: inTenant.hostname,
  ...originHeader,
});
const listedIds = async (who: Account) => {
  const response = await who.client.get(LIST).set(host());
  expect(response.status).toBe(200);
  return (response.body.data as { id: string }[]).map((d) => d.id);
};
const register = (
  who: Account,
  subscription: ReturnType<typeof browserSubscription>,
  inTenant: IsolatedTenant = tenant,
) =>
  who.client
    .post(REGISTER)
    .set(host(inTenant))
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
  otherTenant = await createIsolatedTenant(`p863o-${randomUUID().slice(0, 6)}`);
  for (const t of [tenant, otherTenant]) {
    await owner.query(
      `INSERT INTO notification_policies
         (tenant_id, web_push_enabled, email_enabled, whatsapp, max_attempts, retry_backoff_seconds)
       VALUES ($1, true, true, $2::jsonb, 3, '[30,120]'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET web_push_enabled = true`,
      [
        t.tenantId,
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
  await owner.query(
    `DELETE FROM push_subscriptions WHERE tenant_id = ANY($1::uuid[])`,
    [[tenant.tenantId, otherTenant.tenantId]],
  );
  await dropIsolatedTenant(tenant);
  await dropIsolatedTenant(otherTenant);
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

// 863 delta 2: the server guards endpoint ownership. A second account cannot
// take over an endpoint that another account already holds (any tenant).
// ASSUMPTIONS: the error body is `{ error: { code } }` (as elsewhere in the
// push tests); "row intact" = id, registered_at and subscription_ciphertext
// unchanged; the owner's first registration goes through the real endpoint.
describe("legend-xdlxa 863 delta 2 endpoint ownership is guarded by the server", () => {
  type Held = {
    id: string;
    user_id: string;
    registered_at: Date | null;
    subscription_ciphertext: string;
  };
  const holdersOf = async (userId: string) =>
    (
      await owner.query<Held>(
        `SELECT id, user_id, registered_at, subscription_ciphertext
           FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      )
    ).rows;

  it("another user in the same tenant is refused with 409 and the owner's row stays intact", async () => {
    const a = await account();
    const b = await account();
    const subscription = browserSubscription();
    const first = await register(a, subscription);
    expect(first.status).toBe(200);
    const before = await holdersOf(a.userId);
    expect(before).toHaveLength(1);

    const refused = await register(b, subscription);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");

    expect(await holdersOf(a.userId)).toEqual(before);
    expect(await holdersOf(b.userId)).toEqual([]);
  });

  it("a user of another tenant is refused with 409 too and the owner's row stays intact", async () => {
    const a = await account();
    const b = await account(otherTenant);
    const subscription = browserSubscription();
    expect((await register(a, subscription)).status).toBe(200);
    const before = await holdersOf(a.userId);
    expect(before).toHaveLength(1);

    const refused = await register(b, subscription, otherTenant);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");

    expect(await holdersOf(a.userId)).toEqual(before);
    expect(await holdersOf(b.userId)).toEqual([]);
  });

  it("the owner registering the same endpoint again gets 200, the same id and a later registered_at", async () => {
    const a = await account();
    const subscription = browserSubscription();
    const first = await register(a, subscription);
    expect(first.status).toBe(200);
    const [before] = await holdersOf(a.userId);
    expect(before).toBeDefined();
    // Make the later timestamp unambiguous without sleeping.
    await owner.query(
      `UPDATE push_subscriptions SET registered_at = now() - interval '2 days' WHERE id = $1`,
      [before!.id],
    );
    const [aged] = await holdersOf(a.userId);

    const again = await register(a, subscription);
    expect(again.status, again.text).toBe(200);
    expect(again.body.data.id).toBe(before!.id);

    const rows = await holdersOf(a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.registered_at!.getTime()).toBeGreaterThan(
      aged!.registered_at!.getTime(),
    );
  });
});

// 863 delta 2b: the ownership guard only counts rows of OTHER users that are
// still being delivered to (registered_at NOT NULL and younger than 30 days).
// A stale or never-registered row of another user does not block a new owner.
// ASSUMPTIONS: owner A's row is created through the real endpoint (so the
// endpoint hash is the real one) and then aged by UPDATE; "blocked" = 409 with
// code PUSH_SUBSCRIPTION_OWNED_BY_OTHER; for the old-duplicate case B's own
// stale row is forced onto A's endpoint hash by UPDATE (legacy data from before
// the guard), and B's registration must end with one fresh row for B.
describe("legend-xdlxa 863 delta 2b only live rows of other users block an endpoint", () => {
  const DAY = 24 * 3600 * 1000;
  type Held = {
    id: string;
    registered_at: Date | null;
    subscription_ciphertext: string;
    endpoint_hash: string;
  };
  const rowsFor = async (userId: string) =>
    (
      await owner.query<Held>(
        `SELECT id, registered_at, subscription_ciphertext, endpoint_hash
           FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      )
    ).rows;
  /** A registers through the API, then its row gets the given registered_at. */
  async function ownerWith(registeredAt: Date | null) {
    const a = await account();
    const subscription = browserSubscription();
    expect((await register(a, subscription)).status).toBe(200);
    await owner.query(
      `UPDATE push_subscriptions SET registered_at = $2 WHERE user_id = $1`,
      [a.userId, registeredAt],
    );
    return { a, subscription };
  }

  it("a row of another user with registered_at NULL does not block", async () => {
    const { a, subscription } = await ownerWith(null);
    const b = await account();
    const response = await register(b, subscription);
    expect(response.status, response.text).toBe(200);
    expect(await rowsFor(b.userId)).toHaveLength(1);
    expect(await rowsFor(a.userId)).toHaveLength(1);
  });

  it("a row of another user registered 31 days ago does not block", async () => {
    const { a, subscription } = await ownerWith(
      new Date(Date.now() - 31 * DAY),
    );
    const b = await account();
    const response = await register(b, subscription);
    expect(response.status, response.text).toBe(200);
    expect(await rowsFor(b.userId)).toHaveLength(1);
    expect(await rowsFor(a.userId)).toHaveLength(1);
  });

  it("a row of another user registered 29 days ago still blocks and stays intact", async () => {
    const { a, subscription } = await ownerWith(
      new Date(Date.now() - 29 * DAY),
    );
    const before = await rowsFor(a.userId);
    expect(before).toHaveLength(1);

    const b = await account();
    const response = await register(b, subscription);
    expect(response.status, response.text).toBe(409);
    expect(response.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");

    expect(await rowsFor(a.userId)).toEqual(before);
    expect(await rowsFor(b.userId)).toEqual([]);
  });

  it("old duplicate data (A and B on one endpoint, A stale): B can register again", async () => {
    const { a, subscription } = await ownerWith(
      new Date(Date.now() - 40 * DAY),
    );
    const [aRow] = await rowsFor(a.userId);
    expect(aRow).toBeDefined();

    const b = await account();
    await seedRow(b.userId, subscription, new Date(Date.now() - 40 * DAY));
    await owner.query(
      `UPDATE push_subscriptions SET endpoint_hash = $2 WHERE user_id = $1`,
      [b.userId, aRow!.endpoint_hash],
    );

    const response = await register(b, subscription);
    expect(response.status, response.text).toBe(200);

    const rows = await rowsFor(b.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registered_at).toBeInstanceOf(Date);
    expect(Date.now() - rows[0]!.registered_at!.getTime()).toBeLessThan(DAY);
  });
});
