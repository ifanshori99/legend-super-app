// legend-gchkf round 2 (brief 820, items A-C): revoking an alarm device must
// really stop the pushes. A device bound to another still-active login session
// takes that session down with it (otherwise the phone registers itself again);
// the caller's own session is never touched; a support (impersonated) session
// may not revoke devices; devices the worker no longer delivers to are not
// listed; the list marks which device belongs to the current session.
import { createECDH, randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { enforceSupportSession } from "../middleware/support-session.ts";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const BASE = "/api/identity/push-devices";
const app = createApp();
const DAY = 86_400_000;

let tenantA: IsolatedTenant;
let outletA: string;
const userIds: string[] = [];
const hostA = () => ({ Host: tenantA.hostname });

type Account = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
  sessionId: string;
};

const sessionIdOf = async (client: ReturnType<typeof agent>) =>
  (await client.get("/api/auth/get-session")).body.session.id as string;

async function account(): Promise<Account> {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Perangkat");
  const body = (await client.get("/api/auth/get-session")).body;
  userIds.push(body.user.id as string);
  return {
    client,
    userId: body.user.id as string,
    email,
    sessionId: body.session.id as string,
  };
}

/** A second real login (another phone) of the same user. */
async function secondLogin(me: Account): Promise<Account> {
  const client = agent(app);
  const response = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: me.email, password: "Test-password-123!" });
  expect(response.status).toBe(200);
  const sessionId = await sessionIdOf(client);
  expect(sessionId).not.toBe(me.sessionId);
  return { ...me, client, sessionId };
}

/** A registered alarm device (v2 registration) bound to `sessionId`. */
async function seedDevice(
  userId: string,
  sessionId: string | null,
  options: { ageMs?: number; unverified?: boolean } = {},
): Promise<string> {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const sealed = await createPushSubscriptionProtector().seal(
    {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    },
    tenantA.tenantId,
    userId,
  );
  const id = randomUUID();
  const registeredAt = new Date(Date.now() - (options.ageMs ?? 0));
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_label, session_id, created_at, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'HP uji', $8, $9, $10)`,
    [
      tenantA.tenantId,
      id,
      userId,
      sealed.endpointHash,
      sealed.ciphertext,
      sealed.keyVersion,
      outletA,
      sessionId,
      registeredAt,
      options.unverified ? null : registeredAt,
    ],
  );
  return id;
}

const list = (who: Account) =>
  who.client.get(BASE).set({ ...hostA(), ...originHeader });
const revoke = (who: Account, id: string) =>
  who.client.delete(`${BASE}/${id}`).set({ ...hostA(), ...originHeader });
const rowCount = async (id: string) =>
  (await owner.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [id]))
    .rowCount;
const sessionState = async (sessionId: string) =>
  (
    await owner.query<{ revoked: boolean; expired: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked, expires_at <= now() AS expired
         FROM "session" WHERE id = $1`,
      [sessionId],
    )
  ).rows[0];

beforeAll(async () => {
  tenantA = await createIsolatedTenant(`pds-${randomUUID().slice(0, 6)}`);
  outletA = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet perangkat', 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      outletA,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      `PS-${outletA.slice(0, 8)}`.toUpperCase(),
    ],
  );
}, 90_000);

afterAll(async () => {
  await owner.query(`DELETE FROM push_subscriptions WHERE tenant_id = $1`, [
    tenantA.tenantId,
  ]);
  await dropIsolatedTenant(tenantA);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
});

describe("legend-gchkf revoke takes the registering session down", () => {
  it("revoking a device bound to another active session revokes that session, which can no longer register", async () => {
    const me = await account();
    const phone = await secondLogin(me);
    const deviceId = await seedDevice(me.userId, phone.sessionId);

    const response = await revoke(me, deviceId);
    expect(response.status).toBe(204);

    expect(await rowCount(deviceId)).toBe(0);
    expect(await sessionState(phone.sessionId)).toMatchObject({
      revoked: true,
      expired: true,
    });
    // The phone's cookie is dead: it cannot register itself again.
    const again = await phone.client
      .post("/api/notifications/push-subscriptions")
      .set({ ...hostA(), ...originHeader })
      .send({});
    expect(again.status).toBe(401);
    // The caller's own session is untouched.
    expect((await list(me)).status).toBe(200);
    expect(await sessionState(me.sessionId)).toMatchObject({ revoked: false });
  });

  it("revoking the current session's device keeps the caller signed in", async () => {
    const me = await account();
    const deviceId = await seedDevice(me.userId, me.sessionId);

    const response = await revoke(me, deviceId);
    expect(response.status).toBe(204);

    expect(await rowCount(deviceId)).toBe(0);
    expect(await sessionState(me.sessionId)).toMatchObject({
      revoked: false,
      expired: false,
    });
    expect((await list(me)).status).toBe(200);
  });

  it("revoking a device whose session already expired deletes only the device", async () => {
    const me = await account();
    const deviceId = await seedDevice(me.userId, null);
    const other = await secondLogin(me);

    expect((await revoke(me, deviceId)).status).toBe(204);
    expect(await rowCount(deviceId)).toBe(0);
    expect(await sessionState(other.sessionId)).toMatchObject({
      revoked: false,
    });
  });
});

describe("legend-gchkf list: current flag and undeliverable rows", () => {
  it("marks only the device of the current session as current", async () => {
    const me = await account();
    const phone = await secondLogin(me);
    const mine = await seedDevice(me.userId, me.sessionId);
    const theirs = await seedDevice(me.userId, phone.sessionId);
    const orphan = await seedDevice(me.userId, null);

    const response = await list(me);
    expect(response.status).toBe(200);
    const byId = new Map(
      (response.body.data as { id: string; current: boolean }[]).map((d) => [
        d.id,
        d,
      ]),
    );
    expect(byId.get(mine)?.current).toBe(true);
    expect(byId.get(theirs)?.current).toBe(false);
    expect(byId.get(orphan)?.current).toBe(false);
  });

  it("hides devices that no longer receive alarms (unverified, older than 30 days)", async () => {
    const me = await account();
    const fresh = await seedDevice(me.userId, null);
    const unverified = await seedDevice(me.userId, null, { unverified: true });
    const stale = await seedDevice(me.userId, null, { ageMs: 31 * DAY });

    const ids = ((await list(me)).body.data as { id: string }[]).map(
      (d) => d.id,
    );
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(unverified);
    expect(ids).not.toContain(stale);
  });
});

describe("legend-gchkf support sessions", () => {
  const supportRequest = (method: string, path: string) =>
    ({
      method,
      originalUrl: path,
      auth: { session: { impersonatedBy: randomUUID() } },
    }) as unknown as Request;

  it("refuses DELETE of a push device from an impersonated session", async () => {
    await expect(
      enforceSupportSession(
        supportRequest("DELETE", `${BASE}/${randomUUID()}`),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_READ_ONLY" });
  });

  it("does not refuse the same call from a normal session", async () => {
    const normal = {
      method: "DELETE",
      originalUrl: `${BASE}/${randomUUID()}`,
      auth: { session: { impersonatedBy: null } },
    } as unknown as Request;
    await expect(enforceSupportSession(normal)).resolves.toBeUndefined();
  });
});
