// Tenant setting for WhatsApp login replies (AUTH-03; PRD §3 F6; bead
// legend-dn4): default off, opt-in, free monthly quota the tenant may only
// lower. Written from docs/briefs/dn4-wa-login-replies.md, before the code.
// Real Express app, Better Auth and PostgreSQL; two throwaway tenants are
// resolved through their verified domain (Host header).
//
// Assumptions (also reported):
//  - The routes live under the org router: /api/org/whatsapp/login-replies.
//  - Only `tenant_admin` holds `org.settings.manage` (shared role templates);
//    a signed-in user with no role, and a `finance` user, are refused with 403.
//  - Strict body violations answer 422, like the other org routes.
//  - A PUT that leaves enabled and quota as they already are (including the
//    first `{enabled:false}` on a tenant with no row) is a no-op: no audit.
//  - Omitting `freeMonthlyQuota` keeps the stored quota.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { usageMonth } from "../services/platform-usage.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const PATH = "/api/org/whatsapp/login-replies";
const AUDIT_ACTION = "wa_login_reply.settings_updated";
const unique = () => randomBytes(4).toString("hex");

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 0,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 0,
  emailCostCapIdr: 0,
};

type Member = {
  userId: string;
  get: (url: string) => Test;
  put: (url: string) => Test;
};
type TenantFixture = {
  tenantId: string;
  hostname: string;
  admin: Member;
  finance: Member;
  outsider: Member;
  anonymous: Member;
};

function memberOf(
  client: ReturnType<typeof agent>,
  hostname: string,
  userId: string,
): Member {
  return {
    userId,
    get: (url) => client.get(url).set("Host", hostname).set(originHeader),
    put: (url) => client.put(url).set("Host", hostname).set(originHeader),
  };
}

/** Signs a user up and, when `template` is given, gives it that tenant role with MFA. */
async function member(
  tenantId: string,
  hostname: string,
  template: "tenant_admin" | "finance" | null,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, `Uji ${template ?? "tanpa peran"}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  if (template) {
    const assigned = await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
        WHERE tenant_id = $1 AND template_key = $3`,
      [tenantId, userId, template],
    );
    if (assigned.rowCount !== 1) throw new Error(`No ${template} role`);
    await verifySessionMfa(email);
  }
  return memberOf(client, hostname, userId);
}

async function createTenant(label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const hostname = `wr-${label}-${unique()}.contoh.example`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["whatsapp"]}', $4, $5)`,
    [
      tenantId,
      `wr-${label}-${unique()}`,
      `Tenant ${label} setelan`,
      JSON.stringify(limits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand WR')",
    [brandId, tenantId, `wr-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  // The tenant's own copies of the seeded role templates.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key IN ('tenant_admin', 'finance')`,
    [tenantId, seededTenantId],
  );
  return {
    tenantId,
    hostname,
    admin: await member(tenantId, hostname, "tenant_admin"),
    finance: await member(tenantId, hostname, "finance"),
    outsider: await member(tenantId, hostname, null),
    anonymous: memberOf(agent(app), hostname, ""),
  };
}

let a: TenantFixture;
let b: TenantFixture;

const policyRow = async (tenantId: string) =>
  (
    await owner.query<{
      enabled: boolean;
      free_monthly_quota: number;
      replies_month: string | null;
      replies_this_month: number;
    }>("SELECT * FROM wa_login_reply_policies WHERE tenant_id = $1", [tenantId])
  ).rows[0] ?? null;

const audits = async (tenantId: string) =>
  (
    await owner.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2
        ORDER BY created_at, id`,
      [tenantId, AUDIT_ACTION],
    )
  ).rows.map((row) => row.event);

const month = () => usageMonth(new Date()).month;

beforeAll(async () => {
  [a, b] = await Promise.all([createTenant("a"), createTenant("b")]);
});

afterAll(async () => {
  const ids = [a.tenantId, b.tenantId];
  await owner.query(
    "DELETE FROM wa_login_reply_policies WHERE tenant_id = ANY($1)",
    [ids],
  );
  for (const table of ["role_assignments", "roles", "tenant_domains", "brands"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [ids]);
  await owner.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
  await owner.end();
});

describe("who may read and change the setting", () => {
  it("AUTH-03 refuses anonymous visitors with 401", async () => {
    expect((await a.anonymous.get(PATH)).status).toBe(401);
    expect((await a.anonymous.put(PATH).send({ enabled: true })).status).toBe(
      401,
    );
    expect(await policyRow(a.tenantId)).toBeNull();
  });

  it("AUTH-03 refuses a signed-in user with no role or without org.settings.manage with 403", async () => {
    for (const user of [a.outsider, a.finance]) {
      expect((await user.get(PATH)).status).toBe(403);
      const refused = await user.put(PATH).send({ enabled: true });
      expect(refused.status).toBe(403);
    }
    expect(await policyRow(a.tenantId)).toBeNull();
    expect(await audits(a.tenantId)).toHaveLength(0);
  });
});

describe("reading the setting", () => {
  it("AUTH-03 reports off, the full 1.000 quota and zero used for a tenant that never opted in", async () => {
    const response = await a.admin.get(PATH);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({
      enabled: false,
      freeMonthlyQuota: 1000,
      repliesThisMonth: 0,
      month: month(),
    });
  });

  it("AUTH-03 reads the usage count only for the current month", async () => {
    await owner.query(
      `INSERT INTO wa_login_reply_policies (tenant_id, enabled, free_monthly_quota, replies_month, replies_this_month)
       VALUES ($1, true, 500, '2000-01', 7)
       ON CONFLICT (tenant_id) DO UPDATE SET replies_month = '2000-01', replies_this_month = 7`,
      [b.tenantId],
    );
    const stale = await b.admin.get(PATH);
    expect(stale.body.data).toMatchObject({
      enabled: true,
      freeMonthlyQuota: 500,
      repliesThisMonth: 0,
      month: month(),
    });

    await owner.query(
      "UPDATE wa_login_reply_policies SET replies_month = $2, replies_this_month = 7 WHERE tenant_id = $1",
      [b.tenantId, month()],
    );
    const fresh = await b.admin.get(PATH);
    expect(fresh.body.data.repliesThisMonth).toBe(7);

    await owner.query(
      "DELETE FROM wa_login_reply_policies WHERE tenant_id = $1",
      [b.tenantId],
    );
  });
});

describe("changing the setting", () => {
  it("AUTH-03 opts in, lowers the quota, and writes one audit entry per real change", async () => {
    const enabled = await a.admin.put(PATH).send({ enabled: true });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.data).toMatchObject({
      enabled: true,
      freeMonthlyQuota: 1000,
      repliesThisMonth: 0,
      month: month(),
    });
    expect(await policyRow(a.tenantId)).toMatchObject({
      enabled: true,
      free_monthly_quota: 1000,
    });
    let trail = await audits(a.tenantId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: AUDIT_ACTION,
      actorId: a.admin.userId,
    });

    const lowered = await a.admin
      .put(PATH)
      .send({ enabled: true, freeMonthlyQuota: 300 });
    expect(lowered.status).toBe(200);
    expect(lowered.body.data.freeMonthlyQuota).toBe(300);
    trail = await audits(a.tenantId);
    expect(trail).toHaveLength(2);
    expect(JSON.stringify(trail[1])).toContain("300");
    expect(trail[1]).toMatchObject({ actorId: a.admin.userId });

    const reread = await a.admin.get(PATH);
    expect(reread.body.data).toMatchObject({
      enabled: true,
      freeMonthlyQuota: 300,
    });
  });

  it("AUTH-03 writes no audit entry when nothing changes", async () => {
    const before = (await audits(a.tenantId)).length;
    const same = await a.admin
      .put(PATH)
      .send({ enabled: true, freeMonthlyQuota: 300 });
    expect(same.status).toBe(200);
    expect(same.body.data).toMatchObject({
      enabled: true,
      freeMonthlyQuota: 300,
    });
    // Leaving the quota out also keeps it, and changes nothing.
    const omitted = await a.admin.put(PATH).send({ enabled: true });
    expect(omitted.status).toBe(200);
    expect(omitted.body.data.freeMonthlyQuota).toBe(300);
    expect(await audits(a.tenantId)).toHaveLength(before);
  });

  it("AUTH-03 turning it off keeps the quota and audits the change", async () => {
    const before = (await audits(a.tenantId)).length;
    const off = await a.admin.put(PATH).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({
      enabled: false,
      freeMonthlyQuota: 300,
    });
    expect(await audits(a.tenantId)).toHaveLength(before + 1);
    expect((await policyRow(a.tenantId))?.enabled).toBe(false);
  });

  it("AUTH-03 a first {enabled:false} on a tenant with no row changes nothing and is not audited", async () => {
    const response = await b.admin.put(PATH).send({ enabled: false });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      enabled: false,
      freeMonthlyQuota: 1000,
    });
    expect(await audits(b.tenantId)).toHaveLength(0);
  });

  it("AUTH-03 accepts the quota bounds 0 and 1000", async () => {
    for (const freeMonthlyQuota of [0, 1000]) {
      const response = await a.admin
        .put(PATH)
        .send({ enabled: true, freeMonthlyQuota });
      expect(response.status, String(freeMonthlyQuota)).toBe(200);
      expect(response.body.data.freeMonthlyQuota).toBe(freeMonthlyQuota);
    }
  });

  it("AUTH-03 refuses a body that is not strict, and keeps the stored setting", async () => {
    await a.admin.put(PATH).send({ enabled: true, freeMonthlyQuota: 250 });
    const before = await policyRow(a.tenantId);
    const trailBefore = (await audits(a.tenantId)).length;
    const refused: unknown[] = [
      {},
      { freeMonthlyQuota: 10 },
      { enabled: "yes" },
      { enabled: 1 },
      { enabled: true, freeMonthlyQuota: 1001 },
      { enabled: true, freeMonthlyQuota: -1 },
      { enabled: true, freeMonthlyQuota: 1.5 },
      { enabled: true, freeMonthlyQuota: "10" },
      { enabled: true, extra: "x" },
      { enabled: true, tenantId: b.tenantId },
    ];
    for (const body of refused) {
      const response = await a.admin.put(PATH).send(body as object);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await policyRow(a.tenantId)).toEqual(before);
    expect(await audits(a.tenantId)).toHaveLength(trailBefore);
  });
});

describe("tenant isolation", () => {
  it("AUTH-03 one tenant's change never shows up for another tenant", async () => {
    await a.admin.put(PATH).send({ enabled: true, freeMonthlyQuota: 123 });
    const other = await b.admin.get(PATH);
    expect(other.body.data).toMatchObject({
      enabled: false,
      freeMonthlyQuota: 1000,
    });
    // B keeps default values (a default row may exist from B's no-op PUT).
    expect(await policyRow(b.tenantId)).toMatchObject({
      enabled: false,
      free_monthly_quota: 1000,
    });
    expect(await audits(b.tenantId)).toHaveLength(0);

    // B's admin has no say over A's host.
    const crossed = await b.admin.get(PATH).set("Host", a.hostname);
    expect(crossed.status).toBe(403);
    const crossedWrite = await b.admin
      .put(PATH)
      .set("Host", a.hostname)
      .send({ enabled: false });
    expect(crossedWrite.status).toBe(403);
    expect((await a.admin.get(PATH)).body.data).toMatchObject({
      enabled: true,
      freeMonthlyQuota: 123,
    });
  });
});
