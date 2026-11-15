// legend-ofq4f D2: web push subscription registration over HTTP (alarm panik).
// Written from docs/briefs/ofq4f-push-registration.md and the shared contract
// (packages/shared/src/notification/endpoints.ts, schemas.ts), never from the
// implementation. The whole real app runs against the disposable PostgreSQL.
//
// ASSUMPTIONS where the brief is silent:
//  - "Device invalid / revoked / foreign tenant" -> any of 401/403 is accepted
//    for revoked and foreign-tenant devices (brief only fixes 401 for an
//    invalid token); no row may be stored in all of them.
//  - DELETE of a subscription id that does not exist answers 404 like another
//    user's id (the brief fixes 404 for someone else's).
//  - A successful DELETE answers 204 (the contract has no response schema).
//  - Registering again with the same endpoint refreshes the same row
//    (one row per tenant+user+endpoint) and moves registered_at forward.
//  - Design v2 (architect round): a subscription is revoked by an EXPLICIT end
//    of its login session (sign-out, revoking the session), never by the
//    session merely expiring: deleting an expired session row (no Better Auth
//    hook) keeps the subscription and clears session_id (ON DELETE SET NULL).
//  - Registering from another tenant's outlet: any 403/404 is accepted, and
//    nothing may be stored (the brief fixes only "ditolak").
//  - DB-level composite foreign keys (tenant, outlet) / (tenant, outlet,
//    device) are asserted by inserting rows directly as the table owner.
//  - Not covered here: revocation on PIN change (the brief gives no trigger
//    contract to test against).
import { createECDH, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  requestSupportWriteAccessInputSchema,
} from "@starter/shared/platform";
import { pushPublicKeySchema } from "@starter/shared/notification";

// config/env.ts reads process.env once at import, so the push configuration
// must exist before the app module graph loads.
const vapid = await vi.hoisted(async () => {
  const { createECDH } = await import("node:crypto");
  const key = createECDH("prime256v1");
  key.generateKeys();
  const publicKey = key.getPublicKey().toString("base64url");
  process.env.NOTIFICATION_PUSH_PROVIDER = "web_push";
  process.env.VAPID_PUBLIC_KEY = publicKey;
  process.env.VAPID_PRIVATE_KEY = key.getPrivateKey().toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:push@example.test";
  return { publicKey };
});

import { createApp } from "../app.ts";
import { enrollDevice, revokeDevice } from "../services/device.service.ts";
import {
  approveSupportAccessRequest,
  requestSupportWriteAccess,
  SUPPORT_ACCESS_WRITE_MAX_MINUTES,
} from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers";

const RESPOND = "facility.emergency.respond";
const app = createApp();
const actor = randomUUID();

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA: string;
let outletA2: string;
const userIds: string[] = [];
const supportAdminIds: string[] = [];
const hostA = () => ({ Host: tenantA.hostname });

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
      `PR-${id.slice(0, 8)}`.toUpperCase(),
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

/** A real signed-in account with one custom role in one scope of a tenant. */
async function member(
  tenant: IsolatedTenant,
  options: { permissions: string[]; outlet?: string | null },
): Promise<Member> {
  const client = agent(app);
  const email = `push-${randomUUID()}@example.com`;
  const signUp = await client
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Petugas Push", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  const roleId = randomUUID();
  const outlet = options.outlet ?? null;
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, false, $5::jsonb)`,
    [
      roleId,
      tenant.tenantId,
      `Push ${roleId.slice(0, 8)}`,
      JSON.stringify(options.permissions),
      JSON.stringify([outlet ? "outlet" : "tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, outlet ? "outlet" : "tenant", outlet],
  );
  await verifySessionMfa(email);
  return { client, userId, email };
}

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

const post = (
  who: Member,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  who.client
    .post("/api/notifications/push-subscriptions")
    .set({ ...hostA(), ...originHeader, ...headers })
    .send(body as object);

type Row = {
  id: string;
  user_id: string;
  tenant_id: string;
  outlet_id: string | null;
  device_id: string | null;
  session_id: string | null;
  registered_at: Date;
  subscription_ciphertext: string;
};
const rowsOf = async (userId: string) =>
  (
    await owner.query<Row>(
      `SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    )
  ).rows;
const sessionIdsOf = async (userId: string) =>
  (
    await owner.query<{ id: string }>(
      `SELECT id FROM "session" WHERE user_id = $1`,
      [userId],
    )
  ).rows.map((row) => row.id);

const scopeOf = (tenant: IsolatedTenant, outlet: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
  );
const scopedTenantOf = (tenant: IsolatedTenant): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
async function enroll(tenant: IsolatedTenant, outlet: string) {
  return enrollDevice(scopeOf(tenant, outlet), actor, {
    outletId: outlet,
    type: "pos",
    label: `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
}

async function setWebPushPolicy(enabled: boolean) {
  await owner.query(
    `INSERT INTO notification_policies
       (tenant_id, web_push_enabled, email_enabled, whatsapp, max_attempts, retry_backoff_seconds)
     VALUES ($1, $2, true, $3::jsonb, 3, '[30,120]'::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET web_push_enabled = EXCLUDED.web_push_enabled`,
    [
      tenantA.tenantId,
      enabled,
      JSON.stringify({
        enabled: false,
        allowedCategories: [],
        monthlyCap: 0,
        costPerMessageIdr: 0,
      }),
    ],
  );
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
  tenantA = await createIsolatedTenant(`pr-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`pr-b-${randomUUID().slice(0, 6)}`);
  outletA = await seedOutlet(tenantA, "Outlet push A");
  outletA2 = await seedOutlet(tenantA, "Outlet push A2");
}, 90_000);

afterAll(async () => {
  await purge(tenantA.tenantId);
  await purge(tenantB.tenantId);
  await owner.query(
    `DELETE FROM platform_admins WHERE user_id = ANY($1::text[])`,
    [supportAdminIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    [...userIds, ...supportAdminIds],
  ]);
  await owner.end();
});

describe("legend-ofq4f GET /api/notifications/push-key", () => {
  it("serves the VAPID public key to a signed-in member when web push is on", async () => {
    await setWebPushPolicy(true);
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const response = await staff.client
      .get("/api/notifications/push-key")
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(200);
    expect(pushPublicKeySchema.parse(response.body.data)).toEqual({
      vapidPublicKey: vapid.publicKey,
    });
    // The private key never travels.
    expect(JSON.stringify(response.body)).not.toContain(
      process.env.VAPID_PRIVATE_KEY!,
    );
  });

  it("answers null when the tenant policy turns web push off", async () => {
    await setWebPushPolicy(false);
    try {
      const staff = await member(tenantA, {
        permissions: [RESPOND],
        outlet: outletA,
      });
      const response = await staff.client
        .get("/api/notifications/push-key")
        .set({ ...hostA(), ...originHeader });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ vapidPublicKey: null });
    } finally {
      await setWebPushPolicy(true);
    }
  });

  it("answers null when NOTIFICATION_PUSH_PROVIDER is disabled", async () => {
    await setWebPushPolicy(true);
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    vi.resetModules();
    const saved = process.env.NOTIFICATION_PUSH_PROVIDER;
    process.env.NOTIFICATION_PUSH_PROVIDER = "disabled";
    try {
      // A second app instance booted with the provider off; sign in again.
      const { createApp: createDisabledApp } = await import("../app.ts");
      const client = request.agent(createDisabledApp());
      const login = await client
        .post("/api/auth/sign-in/email")
        .set(originHeader)
        .send({ email: staff.email, password: "Test-password-123!" });
      expect(login.status).toBe(200);
      await verifySessionMfa(staff.email);
      const response = await client
        .get("/api/notifications/push-key")
        .set({ ...hostA(), ...originHeader });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ vapidPublicKey: null });
    } finally {
      process.env.NOTIFICATION_PUSH_PROVIDER = saved;
    }
  });

  it("requires a signed-in account", async () => {
    const response = await request(app)
      .get("/api/notifications/push-key")
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(401);
  });
});

describe("legend-ofq4f POST /api/notifications/push-subscriptions", () => {
  it("rejects an anonymous caller (401) and an untrusted origin (403) before storing anything", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const anonymous = await request(app)
      .post("/api/notifications/push-subscriptions")
      .set({ ...hostA(), ...originHeader })
      .send(subscriptionBody());
    expect(anonymous.status).toBe(401);
    const evil = await staff.client
      .post("/api/notifications/push-subscriptions")
      .set({ ...hostA(), Origin: "https://evil.example" })
      .send(subscriptionBody());
    expect(evil.status).toBe(403);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("binds the subscription to the session user, the tenant and the current session, and never returns endpoint or keys", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const body = subscriptionBody({ deviceLabel: "HP petugas" });
    const response = await post(staff, body);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      tenantId: tenantA.tenantId,
      deviceLabel: "HP petugas",
    });
    expect(response.body.data.userId).toBe(staff.userId);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(body.endpoint);
    expect(text).not.toContain(body.keys.p256dh);
    expect(text).not.toContain(body.keys.auth);

    const rows = await rowsOf(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: response.body.data.id,
      user_id: staff.userId,
      tenant_id: tenantA.tenantId,
    });
    expect(await sessionIdsOf(staff.userId)).toContain(rows[0]!.session_id);
    // Sealed at rest.
    expect(rows[0]!.subscription_ciphertext).not.toContain(body.endpoint);
  });

  it("refuses a body that names its own tenant or user", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    for (const extra of [
      { tenantId: tenantB.tenantId },
      { userId: randomUUID() },
    ]) {
      const response = await post(staff, subscriptionBody(extra));
      expect(response.status).toBe(422);
    }
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("stores no outlet or device when the caller names neither (non-panic notifications only)", async () => {
    const staff = await member(tenantA, { permissions: [] });
    const response = await post(staff, subscriptionBody());
    expect(response.status).toBe(200);
    const [row] = await rowsOf(staff.userId);
    expect(row).toMatchObject({ outlet_id: null, device_id: null });
  });

  it("a body outletId needs facility.emergency.respond at that outlet", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const allowed = await post(staff, subscriptionBody({ outletId: outletA }));
    expect(allowed.status).toBe(200);
    expect((await rowsOf(staff.userId))[0]!.outlet_id).toBe(outletA);

    const otherOutlet = await post(
      staff,
      subscriptionBody({ outletId: outletA2 }),
    );
    expect(otherOutlet.status).toBe(403);

    const without = await member(tenantA, { permissions: [] });
    const denied = await post(without, subscriptionBody({ outletId: outletA }));
    expect(denied.status).toBe(403);
    expect(await rowsOf(without.userId)).toEqual([]);
    expect(await rowsOf(staff.userId)).toHaveLength(1);
  });

  it("a valid X-Device-Token binds the device and its outlet", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const { device, token } = await enroll(tenantA, outletA);
    const response = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect(response.status).toBe(200);
    const [row] = await rowsOf(staff.userId);
    expect(row).toMatchObject({ device_id: device.id, outlet_id: outletA });
  });

  it("a body outletId that agrees with the device outlet is accepted, a different one is 403", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const { token } = await enroll(tenantA, outletA);
    const same = await post(staff, subscriptionBody({ outletId: outletA }), {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect(same.status).toBe(200);
    const other = await post(staff, subscriptionBody({ outletId: outletA2 }), {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect(other.status).toBe(403);
    expect(await rowsOf(staff.userId)).toHaveLength(1);
  });

  it("an invalid X-Device-Token is 401 and stores nothing", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    for (const token of ["garbage", `${randomUUID()}.${randomUUID()}`]) {
      const response = await post(staff, subscriptionBody(), {
        [DEVICE_TOKEN_HEADER]: token,
      });
      expect(response.status).toBe(401);
    }
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("a revoked device is refused and stores nothing", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const { device, token } = await enroll(tenantA, outletA);
    await revokeDevice(scopeOf(tenantA, outletA), actor, {
      deviceId: device.id,
      reason: "hilang",
    });
    const response = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: token,
    });
    expect([401, 403]).toContain(response.status);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("a device token of another tenant is refused and stores nothing", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const foreign = await enroll(tenantB, tenantB.outletId);
    const response = await post(staff, subscriptionBody(), {
      [DEVICE_TOKEN_HEADER]: foreign.token,
    });
    expect([401, 403]).toContain(response.status);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("registering the same endpoint again refreshes one row (outlet, registered_at)", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect((await post(staff, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    const [first] = await rowsOf(staff.userId);
    expect(first!.outlet_id).toBeNull();

    const again = await post(
      staff,
      subscriptionBody({ outletId: outletA }, endpoint),
    );
    expect(again.status).toBe(200);
    const rows = await rowsOf(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outlet_id).toBe(outletA);
    expect(rows[0]!.registered_at.getTime()).toBeGreaterThan(
      first!.registered_at.getTime(),
    );
  });

  it("the same browser endpoint registered by another account is refused (409) and the first account's row stays untouched", async () => {
    const first = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const second = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect((await post(first, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    const before = await rowsOf(first.userId);
    expect(before).toHaveLength(1);

    const refused = await post(second, subscriptionBody({}, endpoint));
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe("PUSH_SUBSCRIPTION_OWNED_BY_OTHER");
    expect(await rowsOf(first.userId)).toEqual(before);
    expect(await rowsOf(second.userId)).toEqual([]);
  });

  it("the subscription goes away with the login session (signing out)", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    expect((await post(staff, subscriptionBody())).status).toBe(200);
    expect(await rowsOf(staff.userId)).toHaveLength(1);

    const out = await staff.client
      .post("/api/auth/sign-out")
      .set({ ...hostA(), ...originHeader })
      .send({});
    expect(out.status).toBe(200);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("an expired session row being deleted keeps the subscription (session_id becomes NULL)", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    expect((await post(staff, subscriptionBody())).status).toBe(200);
    const [row] = await rowsOf(staff.userId);
    expect(row!.registered_at).toBeInstanceOf(Date);
    // Expired by idle time (not revoked), then cleaned up.
    await owner.query(
      `UPDATE "session" SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [row!.session_id],
    );
    await owner.query(`DELETE FROM "session" WHERE id = $1`, [row!.session_id]);
    const after = await rowsOf(staff.userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row!.id, session_id: null });
    expect(after[0]!.registered_at).toEqual(row!.registered_at);
  });

  // legend-ofq4f round 3 B1. Several product paths revoke a login session by
  // UPDATE (revoked_at set, row kept). When that row later expires and is
  // cleaned up, the subscription must not survive as session_id NULL: a
  // revoked login is an explicit end, unlike a session that merely expired.
  // Assumption: "not deliverable" is asserted as "no row left for the user".
  it("B1 a session revoked by UPDATE and deleted afterwards leaves no subscription behind", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    expect((await post(staff, subscriptionBody())).status).toBe(200);
    const [row] = await rowsOf(staff.userId);
    expect(row!.session_id).not.toBeNull();
    await owner.query(
      `UPDATE "session" SET revoked_at = now(), expires_at = now() - interval '1 hour' WHERE id = $1`,
      [row!.session_id],
    );
    await owner.query(`DELETE FROM "session" WHERE id = $1`, [row!.session_id]);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  // legend-ofq4f round 3 B2. A support session impersonating a user must not
  // register push for that user (it would deliver the user's panic alarms to
  // the support person's browser). Real flow: a platform admin gets an
  // owner-approved read-write support grant and impersonates the receiver
  // (read-write so a refusal cannot be a plain read-only block). A normal
  // registration by the receiver right before is the control.
  it("B2 an impersonated session cannot register a push subscription (403)", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    // Only a tenant Owner can approve the read-write support grant.
    const approver = await member(tenantA, { permissions: [] });
    const ownerRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Owner', true, 'owner', '[]'::jsonb, false, '["tenant"]'::jsonb)`,
      [ownerRole, tenantA.tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantA.tenantId, approver.userId, ownerRole],
    );
    expect((await post(staff, subscriptionBody())).status).toBe(200);
    expect(await rowsOf(staff.userId)).toHaveLength(1);

    const support = agent(app);
    const supportEmail = await signUp(support, "Support push");
    await setRole(supportEmail, "admin");
    const supportId = (await support.get("/api/auth/get-session")).body.user
      .id as string;
    supportAdminIds.push(supportId);
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      supportId,
    ]);
    const now = new Date();
    const requested = await requestSupportWriteAccess({
      tenantId: tenantA.tenantId,
      actorUserId: supportId,
      request: requestSupportWriteAccessInputSchema.parse({
        reason: "Memeriksa pendaftaran notifikasi petugas dengan persetujuan.",
        mfaCode: "123456",
        durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
      }),
      mfaVerifiedAt: now.toISOString(),
      now,
    });
    const approved = await approveSupportAccessRequest(
      scopedTenantOf(tenantA),
      { userId: approver.userId },
      requested.id,
      now,
    );
    expect(approved.status).toBe("approved");
    const impersonated = await support
      .post("/api/auth/admin/impersonate-user")
      .set({ ...hostA(), ...originHeader })
      .send({ userId: staff.userId });
    expect(impersonated.status, impersonated.text).toBe(200);
    await verifySessionMfa(staff.email);
    const me = await support.get("/api/auth/get-session").set(hostA());
    expect(me.body.user.id).toBe(staff.userId);
    expect(me.body.session.impersonatedBy).toBe(supportId);

    // NOTE: today this 403 may come from the generic support-session
    // read-only gate (SUPPORT_ACCESS_READ_ONLY) before registerPush runs, so
    // this HTTP test cannot go red for B2 on its own; it pins the contract.
    const refused = await post(
      { client: support, userId: staff.userId, email: staff.email },
      subscriptionBody(),
    );
    expect(refused.status, refused.text).toBe(403);
    expect(await rowsOf(staff.userId)).toHaveLength(1);
  });

  it("revoking the login session removes only that session's subscriptions", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    // A second login of the same account, e.g. another phone.
    const other = agent(app);
    const signIn = await other
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email: staff.email, password: "Test-password-123!" });
    expect(signIn.status).toBe(200);
    await verifySessionMfa(staff.email);
    const otherSession = (await other.get("/api/auth/get-session")).body.session
      .id as string;
    const mine = (await staff.client.get("/api/auth/get-session")).body.session
      .id as string;
    expect(otherSession).not.toBe(mine);

    expect((await post(staff, subscriptionBody())).status).toBe(200);
    const theirs = { client: other, userId: staff.userId, email: staff.email };
    expect((await post(theirs, subscriptionBody())).status).toBe(200);
    expect(await rowsOf(staff.userId)).toHaveLength(2);

    const revoked = await staff.client
      .delete(`/api/auth/sessions/${otherSession}`)
      .set(originHeader);
    expect(revoked.status).toBe(204);

    const left = await rowsOf(staff.userId);
    expect(left).toHaveLength(1);
    expect(left[0]!.session_id).toBe(mine);
  });

  it("signing out removes only the signed-out session's subscriptions", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const other = agent(app);
    expect(
      (
        await other
          .post("/api/auth/sign-in/email")
          .set(originHeader)
          .send({ email: staff.email, password: "Test-password-123!" })
      ).status,
    ).toBe(200);
    await verifySessionMfa(staff.email);
    const mine = (await staff.client.get("/api/auth/get-session")).body.session
      .id as string;
    expect((await post(staff, subscriptionBody())).status).toBe(200);
    expect(
      (
        await post(
          { client: other, userId: staff.userId, email: staff.email },
          subscriptionBody(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await other
          .post("/api/auth/sign-out")
          .set({ ...hostA(), ...originHeader })
          .send({})
      ).status,
    ).toBe(200);
    const left = await rowsOf(staff.userId);
    expect(left).toHaveLength(1);
    expect(left[0]!.session_id).toBe(mine);
  });

  it("registering again without an outlet keeps the outlet of the earlier registration", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect(
      (await post(staff, subscriptionBody({ outletId: outletA }, endpoint)))
        .status,
    ).toBe(200);
    // e.g. the notification panel, which knows no outlet.
    expect((await post(staff, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    const rows = await rowsOf(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outlet_id).toBe(outletA);
  });

  it("registering again without a device keeps the device of the earlier registration", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const enrolled = await enroll(tenantA, outletA);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    expect(
      (
        await post(staff, subscriptionBody({}, endpoint), {
          [DEVICE_TOKEN_HEADER]: enrolled.token,
        })
      ).status,
    ).toBe(200);
    const [first] = await rowsOf(staff.userId);
    expect(first!.device_id).not.toBeNull();
    expect((await post(staff, subscriptionBody({}, endpoint))).status).toBe(
      200,
    );
    const rows = await rowsOf(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      device_id: first!.device_id,
      outlet_id: outletA,
    });
  });

  it("refuses an outletId that belongs to another tenant and stores nothing", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const foreignOutlet = await seedOutlet(tenantB, "Outlet tenant lain");
    const response = await post(
      staff,
      subscriptionBody({ outletId: foreignOutlet }),
    );
    expect([403, 404]).toContain(response.status);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("the database itself refuses an outlet of another tenant or a device that is not at that outlet", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const foreignOutlet = await seedOutlet(tenantB, "Outlet tenant lain DB");
    const insert = (outlet: string | null, device: string | null) =>
      owner.query(
        `INSERT INTO push_subscriptions
           (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
            outlet_id, device_id, registered_at)
         VALUES ($1, $2, $3, $4, 'cipher', 'v1', $5, $6, now())`,
        [
          tenantA.tenantId,
          randomUUID(),
          staff.userId,
          `hash-${randomUUID()}`,
          outlet,
          device,
        ],
      );
    await expect(insert(foreignOutlet, null)).rejects.toMatchObject({
      code: "23503",
    });
    const enrolled = await enroll(tenantA, outletA);
    await expect(insert(outletA2, enrolled.device.id)).rejects.toMatchObject({
      code: "23503",
    });
    // The consistent pair is accepted, so the refusals above are about the key.
    await expect(insert(outletA, enrolled.device.id)).resolves.toBeDefined();
  });
});

describe("legend-ofq4f DELETE /api/notifications/push-subscriptions/:id", () => {
  it("removes the caller's own subscription", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const created = await post(staff, subscriptionBody());
    const id = created.body.data.id as string;
    const response = await staff.client
      .delete(`/api/notifications/push-subscriptions/${id}`)
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(204);
    expect(await rowsOf(staff.userId)).toEqual([]);
  });

  it("answers 404 for another user's subscription and leaves it in place", async () => {
    const owner1 = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const intruder = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const created = await post(owner1, subscriptionBody());
    const id = created.body.data.id as string;
    const response = await intruder.client
      .delete(`/api/notifications/push-subscriptions/${id}`)
      .set({ ...hostA(), ...originHeader });
    expect(response.status).toBe(404);
    expect(await rowsOf(owner1.userId)).toHaveLength(1);
  });

  it("answers 404 for an unknown id and requires a trusted origin", async () => {
    const staff = await member(tenantA, {
      permissions: [RESPOND],
      outlet: outletA,
    });
    const unknown = await staff.client
      .delete(`/api/notifications/push-subscriptions/${randomUUID()}`)
      .set({ ...hostA(), ...originHeader });
    expect(unknown.status).toBe(404);
    const created = await post(staff, subscriptionBody());
    const evil = await staff.client
      .delete(
        `/api/notifications/push-subscriptions/${created.body.data.id as string}`,
      )
      .set({ ...hostA(), Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await rowsOf(staff.userId)).toHaveLength(1);
  });
});
