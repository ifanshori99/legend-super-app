// legend-806 T2: second-opinion fixes for web push registration (alarm panik).
// Written from docs/briefs/806-panic-second-opinion-fix.md (Desain, P1-1,
// P1-2 registration, P1-3 server) and the shared contract, never from the
// implementation. HTTP + database rows only, the whole real app runs against
// the disposable PostgreSQL. Must run (and fail for the right reason) on the
// base commit e241e9476 too: nothing here imports a symbol that only exists
// after the fix, the new database objects are never touched directly.
//
// ASSUMPTIONS where the brief is silent:
//  - "Explicit end" of a session = POST /api/auth/sign-out, POST
//    /api/auth/revoke-sessions, POST /api/auth/revoke-other-sessions (Better
//    Auth endpoints). The status of sign-out on an already expired session is
//    not fixed by the brief, so it is only required not to be a 5xx.
//  - "Orphan" subscription = a row whose login session row is gone (expired,
//    then deleted) so session_id is NULL, but that still belongs to the user.
//  - The error body is `{ error: { code } }`; DEVICE_TOKEN_INVALID is the
//    code the brief fixes for a token older than the device generation.
//  - Of two parallel registrations of the same endpoint by different users
//    (864 / delta 2), one wins (200) and the other is refused (409
//    PUSH_SUBSCRIPTION_OWNED_BY_OTHER); only "no 5xx, exactly one row" is
//    asserted.
//  - Reissue goes through the service function issueDeviceToken (the same
//    entry other tests use), with the old token minted 60 s in the past and
//    the device floor placed before it, so no second-boundary timing matters.
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
import { signDeviceToken } from "../lib/device-token.ts";
import { enrollDevice, issueDeviceToken } from "../services/device.service.ts";
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
      `P8-${id.slice(0, 8)}`.toUpperCase(),
      label,
    ],
  );
  return id;
}

type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

/** A real signed-in account with the panic-respond permission in one outlet. */
async function member(tenant: IsolatedTenant, outlet: string): Promise<Member> {
  const client = agent(app);
  const email = `push806-${randomUUID()}@example.com`;
  const signUp = await client
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Petugas Push 806", email, password: PASSWORD });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, '["outlet"]'::jsonb)`,
    [
      roleId,
      tenant.tenantId,
      `Push806 ${roleId.slice(0, 8)}`,
      JSON.stringify([RESPOND]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, outlet],
  );
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** The same account also holds the panic-respond permission in a second tenant. */
async function joinTenant(who: Member, tenant: IsolatedTenant, outlet: string) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, '["outlet"]'::jsonb)`,
    [
      roleId,
      tenant.tenantId,
      `Push806 ${roleId.slice(0, 8)}`,
      JSON.stringify([RESPOND]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, who.userId, roleId, outlet],
  );
}

/** Another login (second phone) of the same account. */
async function login(who: Member): Promise<Member> {
  const client = agent(app);
  const response = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: who.email, password: PASSWORD });
  expect(response.status).toBe(200);
  await verifySessionMfa(who.email);
  return { client, userId: who.userId, email: who.email };
}

const sessionIdOf = async (who: Member) =>
  (await who.client.get("/api/auth/get-session")).body.session.id as string;

function subscriptionBody(
  extra: Record<string, unknown> = {},
  endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
    deviceLabel: null,
    ...extra,
  };
}

const postAs = (
  tenant: IsolatedTenant,
  who: Member,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  who.client
    .post("/api/notifications/push-subscriptions")
    .set({ Host: tenant.hostname, ...originHeader, ...headers })
    .send(body as object);
const post = (
  who: Member,
  body: unknown,
  headers: Record<string, string> = {},
) => postAs(tenantA, who, body, headers);

type Row = {
  id: string;
  user_id: string;
  tenant_id: string;
  device_id: string | null;
  session_id: string | null;
  endpoint_hash: string;
};
const rowsOf = async (userId: string) =>
  (
    await owner.query<Row>(
      `SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    )
  ).rows;
const rowsOfHash = async (hash: string) =>
  (
    await owner.query<Row>(
      `SELECT * FROM push_subscriptions WHERE endpoint_hash = $1`,
      [hash],
    )
  ).rows;

/** Registers one subscription and returns its stored row. */
async function register(who: Member, headers: Record<string, string> = {}) {
  const response = await post(who, subscriptionBody(), headers);
  expect(response.status, response.text).toBe(200);
  const row = (await rowsOf(who.userId)).find(
    (candidate) => candidate.id === response.body.data.id,
  );
  expect(row).toBeDefined();
  return row!;
}

const scopeOf = (tenant: IsolatedTenant, outlet: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
  );

async function enroll() {
  return enrollDevice(scopeOf(tenantA, outletA), actor, {
    outletId: outletA,
    type: "pos",
    label: `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
}

async function asTenantA(sql: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantA.tenantId],
    );
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setWebPushPolicy(tenant: IsolatedTenant) {
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

/** The session has run out of time but its row is still there. */
const expireSession = (sessionId: string) =>
  owner.query(
    `UPDATE "session" SET expires_at = now() - interval '1 hour' WHERE id = $1`,
    [sessionId],
  );

/** Expiry cleanup: the row disappears without any explicit end. */
async function expireAndCleanUp(sessionId: string) {
  await expireSession(sessionId);
  await owner.query(`DELETE FROM "session" WHERE id = $1`, [sessionId]);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

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
  tenantA = await createIsolatedTenant(`p8-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`p8-b-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet(tenantA, "Outlet push 806 A");
  await setWebPushPolicy(tenantA);
  await setWebPushPolicy(tenantB);
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await purge(tenantB.tenantId);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  await owner.end();
});

describe("legend-806 P1-1 an explicit end of a login removes its push", () => {
  it("signing out after the session expired still removes the subscription", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    expect(row.session_id).not.toBeNull();
    await expireSession(row.session_id!);

    const out = await staff.client
      .post("/api/auth/sign-out")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(out.status).toBeLessThan(500);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("signing out of a live session removes it as before", async () => {
    const staff = await member(tenantA, outletA);
    await register(staff);
    const out = await staff.client
      .post("/api/auth/sign-out")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(out.status).toBe(200);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("revoking all sessions from a new login also removes an orphan subscription of the user", async () => {
    const staff = await member(tenantA, outletA);
    const orphan = await register(staff);
    await expireAndCleanUp(orphan.session_id!);
    // Pure expiry keeps the subscription, now without a session.
    const kept = await rowsOf(staff.userId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: orphan.id, session_id: null });

    const fresh = await login(staff);
    const revoked = await fresh.client
      .post("/api/auth/revoke-sessions")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(revoked.status, revoked.text).toBe(200);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("revoking the other sessions removes an orphan but keeps the current login's subscription", async () => {
    const staff = await member(tenantA, outletA);
    const orphan = await register(staff);
    await expireAndCleanUp(orphan.session_id!);

    const fresh = await login(staff);
    const current = await register(fresh);
    const revoked = await fresh.client
      .post("/api/auth/revoke-other-sessions")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(revoked.status, revoked.text).toBe(200);

    const left = await rowsOf(staff.userId);
    expect(left.map((row) => row.id)).toEqual([current.id]);
    expect(left[0]!.session_id).toBe(await sessionIdOf(fresh));
  });

  // T-A1: Better Auth only deletes other sessions that are still alive, so
  // the orphan sweep must not depend on a session delete happening.
  it("revoking the other sessions removes an orphan even when another expired session row is still there", async () => {
    const staff = await member(tenantA, outletA);
    const orphan = await register(staff);
    await expireAndCleanUp(orphan.session_id!);
    // A second old login, expired but its row (and push) are still present.
    const stale = await login(staff);
    const staleRow = await register(stale);
    await expireSession(staleRow.session_id!);

    const fresh = await login(staff);
    const current = await register(fresh);
    const revoked = await fresh.client
      .post("/api/auth/revoke-other-sessions")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(revoked.status, revoked.text).toBe(200);

    const left = await rowsOf(staff.userId);
    expect(left.map((row) => row.id)).toEqual([current.id]);
    expect(left[0]!.session_id).toBe(await sessionIdOf(fresh));
  });

  it("revoking the other sessions with no other session at all still removes the orphans", async () => {
    const staff = await member(tenantA, outletA);
    const first = await register(staff);
    await expireAndCleanUp(first.session_id!);
    const second = await login(staff);
    const secondRow = await register(second);
    await expireAndCleanUp(secondRow.session_id!);
    expect(await rowsOf(staff.userId)).toHaveLength(2);

    const fresh = await login(staff);
    const current = await register(fresh);
    const revoked = await fresh.client
      .post("/api/auth/revoke-other-sessions")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({});
    expect(revoked.status, revoked.text).toBe(200);
    expect((await rowsOf(staff.userId)).map((row) => row.id)).toEqual([
      current.id,
    ]);
  });

  // T-A2: only a deliberate end of a login may remove push. Any other
  // endpoint met with an expired cookie is not an explicit end.
  it("an expired session used on a non-logout endpoint (list-sessions) keeps the subscription", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    await expireSession(row.session_id!);

    const listed = await staff.client
      .get("/api/auth/list-sessions")
      .set({ Host: tenantA.hostname });
    expect(listed.status).toBeLessThan(500);

    const after = await rowsOf(staff.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(row.id);
    expect([null, row.session_id]).toContain(after[0]!.session_id);
  });

  it("an expired session used on update-user keeps the subscription", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    await expireSession(row.session_id!);

    const updated = await staff.client
      .post("/api/auth/update-user")
      .set({ Host: tenantA.hostname, ...originHeader })
      .send({ name: "Petugas Push 806 Baru" });
    expect(updated.status).toBeLessThan(500);

    const after = await rowsOf(staff.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(row.id);
    expect([null, row.session_id]).toContain(after[0]!.session_id);
  });

  it("a session that only expires keeps its subscription (session_id becomes NULL)", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    await expireAndCleanUp(row.session_id!);
    const after = await rowsOf(staff.userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row.id, session_id: null });
  });

  it("an expired session cleaned up by a read of the session keeps the subscription", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    await expireSession(row.session_id!);
    // Not an explicit end: asking for the session just finds it expired.
    const me = await staff.client
      .get("/api/auth/get-session")
      .set({ Host: tenantA.hostname });
    expect(me.status).toBeLessThan(500);
    const after = await rowsOf(staff.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(row.id);
  });

  it("a session revoked (revoked_at) and deleted afterwards leaves no subscription behind", async () => {
    const staff = await member(tenantA, outletA);
    const row = await register(staff);
    await owner.query(
      `UPDATE "session" SET revoked_at = now(), expires_at = now() - interval '1 hour' WHERE id = $1`,
      [row.session_id],
    );
    await owner.query(`DELETE FROM "session" WHERE id = $1`, [row.session_id]);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });
});

describe("legend-806 P1-2 registration with a device token", () => {
  /**
   * A device whose registry generation is five minutes old, and a token of it
   * minted one minute ago: valid until a reissue moves the generation.
   */
  async function deviceWithOldToken() {
    const { device } = await enroll();
    await asTenantA(
      `UPDATE devices SET token_issued_at = now() - interval '5 minutes' WHERE id = $1 AND tenant_id = $2`,
      [device.id, tenantA.tenantId],
    );
    const oldToken = signDeviceToken({
      version: 1,
      tenantId: tenantA.tenantId,
      brandId: null,
      deviceId: device.id,
      issuedAt: nowSeconds() - 60,
    });
    return { device, oldToken };
  }
  const reissue = (deviceId: string) =>
    issueDeviceToken(scopeOf(tenantA, outletA), actor, { deviceId });

  it("after a reissue the old token is refused with 401 DEVICE_TOKEN_INVALID and stores nothing; the new token registers", async () => {
    const staff = await member(tenantA, outletA);
    const { device, oldToken } = await deviceWithOldToken();

    // Before the reissue the old token is still the current one.
    const before = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: oldToken,
    });
    expect(before.status, before.text).toBe(200);
    await owner.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [
      staff.userId,
    ]);

    const reissued = await reissue(device.id);

    const stale = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: oldToken,
    });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("DEVICE_TOKEN_INVALID");
    expect(await rowsOf(staff.userId)).toEqual([]);

    const fresh = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: reissued.token,
    });
    expect(fresh.status, fresh.text).toBe(200);
    const rows = await rowsOf(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_id).toBe(device.id);
  });

  it("a reissue removes the subscriptions that were registered under the older token", async () => {
    const staff = await member(tenantA, outletA);
    const { device, oldToken } = await deviceWithOldToken();
    const registered = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: oldToken,
    });
    expect(registered.status, registered.text).toBe(200);
    expect(await rowsOf(staff.userId)).toHaveLength(1);

    await reissue(device.id);

    expect(await rowsOf(staff.userId)).toEqual([]);
  });
});

describe("legend-806 P1-3 one endpoint, one owner", () => {
  it("the same endpoint registered from another tenant is refused (409) and the first owner's row stays", async () => {
    const inA = await member(tenantA, outletA);
    const inB = await member(tenantB, tenantB.outletId);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

    const first = await postAs(tenantA, inA, subscriptionBody({}, endpoint));
    expect(first.status, first.text).toBe(200);
    const before = await rowsOf(inA.userId);
    expect(before).toHaveLength(1);

    const second = await postAs(tenantB, inB, subscriptionBody({}, endpoint));
    expect(second.status, second.text).toBe(409);
    expect(second.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");

    const holders = await rowsOfHash(before[0]!.endpoint_hash);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({
      user_id: inA.userId,
      tenant_id: tenantA.tenantId,
    });
    expect(await rowsOf(inB.userId)).toEqual([]);
  });

  it("the second tenant's user is refused both ways: the first owner keeps the endpoint", async () => {
    const inA = await member(tenantA, outletA);
    const inB = await member(tenantB, tenantB.outletId);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect(
      (await postAs(tenantB, inB, subscriptionBody({}, endpoint))).status,
    ).toBe(200);
    const [bRow] = await rowsOf(inB.userId);
    const refused = await postAs(tenantA, inA, subscriptionBody({}, endpoint));
    expect(refused.status, refused.text).toBe(409);

    const holders = await rowsOfHash(bRow!.endpoint_hash);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.user_id).toBe(inB.userId);
    expect(await rowsOf(inA.userId)).toEqual([]);
  });

  it("the same user re-registering the same endpoint keeps one row and is not removed by the claim", async () => {
    const staff = await member(tenantA, outletA);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect((await post(staff, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    expect((await post(staff, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    expect(await rowsOf(staff.userId)).toHaveLength(1);
  });

  // T-A4 (changed by 863 delta 2): another account can no longer take the
  // endpoint; the owner's rows in all tenants stay, the other account gets 409.
  it("one account in two tenants keeps one row per tenant for the same endpoint; another account trying to take the endpoint is refused and both rows stay", async () => {
    const dual = await member(tenantA, outletA);
    await joinTenant(dual, tenantB, tenantB.outletId);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

    const inA = await postAs(tenantA, dual, subscriptionBody({}, endpoint));
    expect(inA.status, inA.text).toBe(200);
    const inB = await postAs(tenantB, dual, subscriptionBody({}, endpoint));
    expect(inB.status, inB.text).toBe(200);

    const rows = await rowsOf(dual.userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tenant_id).sort()).toEqual(
      [tenantA.tenantId, tenantB.tenantId].sort(),
    );
    expect(await rowsOfHash(rows[0]!.endpoint_hash)).toHaveLength(2);

    const other = await member(tenantA, outletA);
    const taken = await postAs(tenantA, other, subscriptionBody({}, endpoint));
    expect(taken.status, taken.text).toBe(409);
    expect(taken.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");

    expect(await rowsOf(dual.userId)).toEqual(rows);
    const holders = await rowsOfHash(rows[0]!.endpoint_hash);
    expect(holders).toHaveLength(2);
    expect(holders.every((row) => row.user_id === dual.userId)).toBe(true);
    expect(await rowsOf(other.userId)).toEqual([]);
  });

  it("two users of one tenant registering the same endpoint in parallel end with exactly one row", async () => {
    const one = await member(tenantA, outletA);
    const two = await member(tenantA, outletA);
    // Several rounds, each with its own endpoint, so a lost race shows up.
    for (let round = 0; round < 5; round += 1) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
      const [a, b] = await Promise.all([
        post(one, subscriptionBody({}, endpoint)),
        post(two, subscriptionBody({}, endpoint)),
      ]);
      expect(a.status, a.text).toBeLessThan(500);
      expect(b.status, b.text).toBeLessThan(500);

      // Only this round's endpoint exists for the two users: one row in all.
      const left = [
        ...(await rowsOf(one.userId)),
        ...(await rowsOf(two.userId)),
      ];
      expect(left).toHaveLength(1);
      expect(await rowsOfHash(left[0]!.endpoint_hash)).toHaveLength(1);
      // Clean up so the next round starts from nothing.
      await owner.query(
        `DELETE FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
        [[one.userId, two.userId]],
      );
    }
  });
});
