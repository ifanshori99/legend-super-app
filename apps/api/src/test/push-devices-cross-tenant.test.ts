// legend-fonnr: alarm devices are an account-level list. A phone the user
// registered in ANOTHER tenant must be listed and revocable from any tenant
// host (and from a login without tenant/domain), while another user's phones
// are never visible or revocable. Written from the brief (brief-fonnr.md), not
// from the implementation.
//
// ASSUMPTIONS (brief leaves open):
//  - Same endpoints as push-devices-revoke.test.ts:
//      GET /api/identity/push-devices -> 200 { data: PushDevice[] }
//      DELETE /api/identity/push-devices/:id -> 204, 404 for unknown / not mine.
//  - "Sesi tanpa tenant + tanpa domain": request sent to the default supertest
//    host, which maps to no tenant domain.
//  - Users hold a tenant-scope role assignment in both tenants ("anggota").
import { createECDH, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const BASE = "/api/identity/push-devices";
const app = createApp();
// Direct calls to the SQL functions run as the application role.
const appRole = new Pool({ connectionString: process.env.APP_DATABASE_URL });

let t1: IsolatedTenant;
let t2: IsolatedTenant;
const userIds: string[] = [];

type Account = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
  sessionId: string;
};

const sessionIdOf = async (client: ReturnType<typeof agent>) =>
  (await client.get("/api/auth/get-session")).body.session.id as string;

/** A signed-in user who is a member (role assignment) of both tenants. */
async function account(): Promise<Account> {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Lintas Tenant");
  const body = (await client.get("/api/auth/get-session")).body;
  const userId = body.user.id as string;
  userIds.push(userId);
  for (const tenant of [t1, t2]) {
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, tenant.roleId],
    );
  }
  return { client, userId, email, sessionId: body.session.id as string };
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

/** A registered alarm device (v2 registration) of `userId` inside `tenant`. */
async function seedDevice(
  tenant: IsolatedTenant,
  userId: string,
  sessionId: string | null,
  label = "HP uji",
  binding: { deviceId: string; tokenIssuedAt: Date } | null = null,
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
    tenant.tenantId,
    userId,
  );
  const id = randomUUID();
  const now = new Date();
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_label, session_id, created_at, registered_at,
        device_id, device_token_issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)`,
    [
      tenant.tenantId,
      id,
      userId,
      sealed.endpointHash,
      sealed.ciphertext,
      sealed.keyVersion,
      tenant.outletId,
      label,
      sessionId,
      now,
      binding?.deviceId ?? null,
      binding?.tokenIssuedAt ?? null,
    ],
  );
  return id;
}

/**
 * A POS device row in `tenant` plus an alarm registration bound to it. A
 * deliverable one has push.device_token_issued_at == devices.token_issued_at.
 */
async function seedBoundDevice(
  tenant: IsolatedTenant,
  userId: string,
  label: string,
  state: {
    status?: string;
    revoked?: boolean;
    reissued?: boolean;
  } = {},
): Promise<string> {
  const deviceId = randomUUID();
  const issuedAt = new Date(Date.now() - 60_000);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status, revoked_at, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, $5, $6, $7)`,
    [
      deviceId,
      tenant.tenantId,
      tenant.outletId,
      label,
      state.status ?? "active",
      state.revoked ? new Date() : null,
      // Reissued token: the device row carries a newer issue time than the
      // one the registration was made with.
      state.reissued ? new Date() : issuedAt,
    ],
  );
  return seedDevice(tenant, userId, null, label, {
    deviceId,
    tokenIssuedAt: issuedAt,
  });
}

const onHost = (tenant: IsolatedTenant | null) =>
  tenant ? { Host: tenant.hostname, ...originHeader } : { ...originHeader };
const list = (who: Account, tenant: IsolatedTenant | null) =>
  who.client.get(BASE).set(onHost(tenant));
const revoke = (who: Account, id: string, tenant: IsolatedTenant | null) =>
  who.client.delete(`${BASE}/${id}`).set(onHost(tenant));
const listedIds = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((d) => d.id);
const rowCount = async (id: string) =>
  (await owner.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [id]))
    .rowCount;
const sessionState = async (sessionId: string) =>
  (
    await owner.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM "session" WHERE id = $1`,
      [sessionId],
    )
  ).rows[0];

beforeAll(async () => {
  t1 = await createIsolatedTenant(`pxa-${randomUUID().slice(0, 6)}`);
  t2 = await createIsolatedTenant(`pxb-${randomUUID().slice(0, 6)}`);
}, 90_000);

afterAll(async () => {
  for (const tenant of [t1, t2]) {
    await owner.query(`DELETE FROM push_subscriptions WHERE tenant_id = $1`, [
      tenant.tenantId,
    ]);
    await owner.query(`DELETE FROM devices WHERE tenant_id = $1`, [
      tenant.tenantId,
    ]);
    await dropIsolatedTenant(tenant);
  }
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
  await appRole.end();
});

describe("legend-fonnr alarm devices across tenants", () => {
  it("lists the user's devices of every tenant from a session on tenant 1's host", async () => {
    const a = await account();
    const inT1 = await seedDevice(t1, a.userId, null, "HP di T1");
    const inT2 = await seedDevice(t2, a.userId, null, "HP di T2");

    const response = await list(a, t1);
    expect(response.status).toBe(200);
    const ids = listedIds(response);
    expect(ids).toContain(inT1);
    expect(ids).toContain(inT2);
    // Still never leaks endpoint / keys / ciphertext.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toMatch(/endpoint|ciphertext|p256dh|fcm\.googleapis/i);
  });

  it("never shows or revokes another user's device, in any tenant", async () => {
    const a = await account();
    const b = await account();
    const bInT1 = await seedDevice(t1, b.userId, null, "HP B di T1");
    const bInT2 = await seedDevice(t2, b.userId, null, "HP B di T2");
    const aOwn = await seedDevice(t2, a.userId, null, "HP A di T2");

    const ids = listedIds(await list(a, t1));
    expect(ids).toContain(aOwn);
    expect(ids).not.toContain(bInT1);
    expect(ids).not.toContain(bInT2);

    for (const id of [bInT1, bInT2]) {
      const response = await revoke(a, id, t1);
      expect(response.status).toBe(404);
      expect(await rowCount(id)).toBe(1);
    }
    expect(await rowCount(aOwn)).toBe(1);
  });

  it("revokes a device registered in another tenant and ends the session that registered it", async () => {
    const a = await account();
    const phone = await secondLogin(a);
    const inT2 = await seedDevice(t2, a.userId, phone.sessionId, "HP di T2");

    const response = await revoke(a, inT2, t1);
    expect(response.status).toBe(204);

    expect(await rowCount(inT2)).toBe(0);
    expect(await sessionState(phone.sessionId)).toMatchObject({
      revoked: true,
    });
    // Caller's own session is untouched.
    expect(await sessionState(a.sessionId)).toMatchObject({ revoked: false });
    expect(listedIds(await list(a, t1))).not.toContain(inT2);
  });

  it("a session without tenant or domain still sees the user's own devices", async () => {
    const a = await account();
    const inT1 = await seedDevice(t1, a.userId, null, "HP di T1");
    const inT2 = await seedDevice(t2, a.userId, null, "HP di T2");

    const response = await list(a, null);
    expect(response.status).toBe(200);
    const ids = listedIds(response);
    expect(ids).toContain(inT1);
    expect(ids).toContain(inT2);
  });

  // ASSUMPTION: "not deliverable" mirrors what the alarm can actually reach:
  // a revoked device (revoked_at set and/or status not active) or a device
  // whose token was reissued after the registration cannot ring, so the list
  // hides it. Brief: hidden from GET, a sibling deliverable device stays.
  it("hides devices that are revoked or whose token was reissued, keeps a deliverable sibling", async () => {
    const a = await account();
    const sibling = await seedBoundDevice(t1, a.userId, "HP sehat");
    const revoked = await seedBoundDevice(t2, a.userId, "HP dicabut", {
      status: "revoked",
      revoked: true,
    });
    const reissued = await seedBoundDevice(t1, a.userId, "HP token baru", {
      reissued: true,
    });

    for (const tenant of [t1, t2, null]) {
      const response = await list(a, tenant);
      expect(response.status).toBe(200);
      const ids = listedIds(response);
      expect(ids).toContain(sibling);
      for (const hidden of [revoked, reissued]) {
        expect(ids).not.toContain(hidden);
      }
    }
  });
});

// Signatures per the coordinator: list_own_push_devices(text, timestamptz),
// delete_own_push_device(text, uuid, timestamptz).
describe("legend-fonnr SQL functions app.list_own_push_devices / app.delete_own_push_device", () => {
  it("are SECURITY DEFINER with a pinned search_path, executable by legend_app and not PUBLIC", async () => {
    const result = await owner.query<{
      proname: string;
      args: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      app_execute: boolean;
      public_execute: boolean;
    }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
              p.prosecdef, p.proconfig,
              has_function_privilege('legend_app', p.oid, 'EXECUTE') AS app_execute,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('list_own_push_devices', 'delete_own_push_device')`,
    );
    const byName = new Map(result.rows.map((row) => [row.proname, row]));
    expect([...byName.keys()].sort()).toEqual([
      "delete_own_push_device",
      "list_own_push_devices",
    ]);
    expect(byName.get("list_own_push_devices")!.args).toMatch(
      /^p_session text, p_now timestamp with time zone$/,
    );
    expect(byName.get("delete_own_push_device")!.args).toMatch(
      /^p_session text, p_id uuid, p_now timestamp with time zone$/,
    );
    for (const fn of result.rows) {
      expect(fn.prosecdef).toBe(true);
      expect(
        fn.proconfig?.some((entry) => entry.startsWith("search_path=")),
      ).toBe(true);
      expect(fn.app_execute).toBe(true);
      expect(fn.public_execute).toBe(false);
    }
  });

  it("a dead (revoked or expired) or unknown session id lists 0 rows and deletes nothing; a live one works", async () => {
    const a = await account();
    const deviceA = await seedDevice(t2, a.userId, null, "HP di T2");
    const deadSession = async (kind: "revoked" | "expired") => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO "session" (id, expires_at, token, user_id, revoked_at)
         VALUES ($1, now() + $2::interval, $3, $4, $5)`,
        [
          id,
          kind === "expired" ? "-1 hour" : "7 days",
          randomUUID(),
          a.userId,
          kind === "revoked" ? new Date() : null,
        ],
      );
      return id;
    };
    const listFn = (session: string) =>
      appRole.query(
        `SELECT id FROM app.list_own_push_devices($1::text, now())`,
        [session],
      );
    const deleteFn = (session: string, id: string) =>
      appRole.query<{ n: number }>(
        `SELECT app.delete_own_push_device($1::text, $2::uuid, now()) AS n`,
        [session, id],
      );

    // Live session (control): sees the cross-tenant device.
    const live = await listFn(a.sessionId);
    expect(live.rows.map((row) => row.id)).toContain(deviceA);

    for (const session of [
      await deadSession("revoked"),
      await deadSession("expired"),
      randomUUID(),
    ]) {
      expect((await listFn(session)).rowCount).toBe(0);
      const deleted = await deleteFn(session, deviceA);
      expect(Number(deleted.rows[0]!.n)).toBe(0);
      expect(await rowCount(deviceA)).toBe(1);
    }

    // Live session deletes it (control) and reports 1.
    const removed = await deleteFn(a.sessionId, deviceA);
    expect(Number(removed.rows[0]!.n)).toBe(1);
    expect(await rowCount(deviceA)).toBe(0);
  });

  it("a live session cannot delete another user's subscription through delete_own_push_device", async () => {
    const a = await account();
    const b = await account();
    const bDevice = await seedDevice(t2, b.userId, null, "HP B di T2");
    const aDevice = await seedDevice(t2, a.userId, null, "HP A di T2");

    // A's live session id, B's subscription id: nothing is removed.
    const result = await appRole.query<{ n: number }>(
      `SELECT app.delete_own_push_device($1::text, $2::uuid, now()) AS n`,
      [a.sessionId, bDevice],
    );
    expect(Number(result.rows[0]!.n)).toBe(0);
    expect(await rowCount(bDevice)).toBe(1);
    expect(await rowCount(aDevice)).toBe(1);

    // Control: the same call on A's own subscription works.
    const own = await appRole.query<{ n: number }>(
      `SELECT app.delete_own_push_device($1::text, $2::uuid, now()) AS n`,
      [a.sessionId, aDevice],
    );
    expect(Number(own.rows[0]!.n)).toBe(1);
    expect(await rowCount(aDevice)).toBe(0);
    expect(await rowCount(bDevice)).toBe(1);
  });
});
