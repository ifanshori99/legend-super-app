// Shared fixtures for the WS-03 floor tests (legend-irw). Not a test file:
// vitest only picks up `*.test.ts`.
//
// Tests run against the disposable PostgreSQL server `pnpm test` creates and
// seeds. Staff users are real Better Auth accounts with a stored role
// assignment (the RBAC engine reads role_assignments, not the global role).

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Express } from "express";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { agent, originHeader, setRole, signUp } from "./helpers";

export const fixtures = cafeLegendPlatformFixtures;
export const seededTenantId = fixtures.tenant.id as string;
export const seededOutletA = fixtures.outlets[0].id as string;
export const seededOutletB = fixtures.outlets[1].id as string;
export const seededHostname = fixtures.domains[0].hostname as string;

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

export type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

/** Sign up a real account and grant one seeded role template in a scope. */
export async function staffWithRole(
  app: Express,
  input: {
    template: "owner" | "outlet_manager" | "supervisor" | "cashier" | "waiter";
    tenantId?: string;
    scopeType?: "tenant" | "outlet";
    scopeId?: string | null;
    label?: string;
  },
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, input.label ?? "Floor Staff");
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const tenantId = input.tenantId ?? seededTenantId;
  const scopeType = input.scopeType ?? "tenant";
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, input.template],
  );
  const roleId = rows[0]?.id;
  if (!roleId) throw new Error(`No role template ${input.template}`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scopeType,
      scopeType === "tenant" ? null : (input.scopeId ?? null),
    ],
  );
  return { client, userId, email };
}

export type IsolatedTenant = {
  tenantId: string;
  brandId: string;
  legalEntityId: string;
  outletId: string;
  roleId: string;
  hostname: string;
};

/**
 * A second tenant with one brand/outlet, a floor-capable custom role and a
 * verified hostname. Used for cross-tenant isolation: data created here must
 * never leak into the seeded tenant and vice versa.
 */
export async function createIsolatedTenant(
  slugSuffix: string,
): Promise<IsolatedTenant> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  const roleId = randomUUID();
  const domainId = randomUUID();
  const hostname = `tenant-${slugSuffix}.legend.test`;
  const limits = fixtures.tenant.limits;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantId,
      `tenant-${slugSuffix}`,
      `Tenant ${slugSuffix}`,
      JSON.stringify({ modules: ["qr_order"], integrationProviders: [] }),
      JSON.stringify(limits),
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [brandId, tenantId, `brand-${slugSuffix}`, `Brand ${slugSuffix}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
    [legalEntityId, tenantId, `Entity ${slugSuffix}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      outletId,
      tenantId,
      brandId,
      legalEntityId,
      `OUT-${slugSuffix}`.slice(0, 20).toUpperCase(),
      `Outlet ${slugSuffix}`,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Floor Owner', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenantId,
      JSON.stringify([
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [domainId, tenantId, brandId, hostname],
  );
  return { tenantId, brandId, legalEntityId, outletId, roleId, hostname };
}

/** Grant an isolated tenant's custom role through a real staff account. */
export async function staffOfIsolatedTenant(
  app: Express,
  tenant: IsolatedTenant,
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, "Tenant Two Owner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, tenant.roleId],
  );
  return { client, userId, email };
}

export async function dropIsolatedTenant(tenant: IsolatedTenant) {
  await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM session_participants WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM table_sessions WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM tables WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM floor_zones WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
}

/** Track floor rows a test created, and remove them in FK order. */
export async function dropFloorRows(input: {
  tenantId: string;
  zoneIds?: readonly string[];
  tableIds?: readonly string[];
}) {
  const { tenantId } = input;
  const zoneIds = input.zoneIds ?? [];
  const tableIds = input.tableIds ?? [];
  // FK order: participants -> sessions -> tables -> zones. Tables are selected
  // by id as well as by zone, so a table a test forgot to track cannot block
  // the zone cleanup.
  if (zoneIds.length > 0 && tableIds.length > 0) {
    await owner.query(
      `DELETE FROM session_participants
       WHERE tenant_id = $1
         AND table_session_id IN (
           SELECT id FROM table_sessions
           WHERE tenant_id = $1
             AND table_id IN (SELECT id FROM tables WHERE tenant_id = $1 AND (id = ANY($2) OR zone_id = ANY($3)))
         )`,
      [tenantId, tableIds, zoneIds],
    );
    await owner.query(
      `DELETE FROM table_sessions
       WHERE tenant_id = $1
         AND table_id IN (SELECT id FROM tables WHERE tenant_id = $1 AND (id = ANY($2) OR zone_id = ANY($3)))`,
      [tenantId, tableIds, zoneIds],
    );
    await owner.query(
      "DELETE FROM tables WHERE tenant_id = $1 AND (id = ANY($2) OR zone_id = ANY($3))",
      [tenantId, tableIds, zoneIds],
    );
  } else if (tableIds.length > 0) {
    await owner.query(
      `DELETE FROM session_participants
       WHERE tenant_id = $1
         AND table_session_id IN (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2))`,
      [tenantId, tableIds],
    );
    await owner.query(
      "DELETE FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2)",
      [tenantId, tableIds],
    );
    await owner.query(
      "DELETE FROM tables WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, tableIds],
    );
  }
  if (zoneIds.length > 0)
    await owner.query(
      "DELETE FROM floor_zones WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, zoneIds],
    );
}

/** Create a zone through the API and return its id. */
export async function createZone(
  client: ReturnType<typeof agent>,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await client
    .post("/api/floor/zones")
    .set(originHeader)
    .set(headers)
    .send({
      name: `Zona Uji ${randomUUID().slice(0, 8)}`,
      paymentMode: "pay_first",
      serviceChargeBp: 500,
      minimumSpendIdr: 0,
      hours: [
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
      ],
      ...body,
    });
  if (response.status !== 201)
    throw new Error(
      `Zone create failed ${response.status}: ${JSON.stringify(response.body)}`,
    );
  return response.body.data;
}

/** Create a table through the API and return its id. */
export async function createTable(
  client: ReturnType<typeof agent>,
  input: { zoneId: string; code?: string },
  headers: Record<string, string> = {},
) {
  const response = await client
    .post("/api/floor/tables")
    .set(originHeader)
    .set(headers)
    .send({
      zoneId: input.zoneId,
      code: input.code ?? `T-${randomUUID().slice(0, 6)}`.toUpperCase(),
      capacity: 4,
      type: "regular",
      layout: {
        x: 10,
        y: 10,
        width: 60,
        height: 60,
        rotation: 0,
        shape: "rect",
      },
    });
  if (response.status !== 201)
    throw new Error(
      `Table create failed ${response.status}: ${JSON.stringify(response.body)}`,
    );
  return response.body.data;
}

/** Issue the signed QR for a table through the API. */
export async function issueQr(
  client: ReturnType<typeof agent>,
  tableId: string,
  headers: Record<string, string> = {},
) {
  const response = await client
    .post(`/api/tables/${tableId}/qr`)
    .set(originHeader)
    .set(headers);
  if (response.status !== 200)
    throw new Error(
      `QR issue failed ${response.status}: ${JSON.stringify(response.body)}`,
    );
  return response.body.data as { token: string; url: string };
}

/** Scan a table QR as a guest on the tenant host. */
export async function scan(
  app: Express,
  input: {
    token: string;
    pax?: number;
    deviceHash?: string;
    hostname?: string;
  },
) {
  return agent(app)
    .post("/api/qr/sessions")
    .set("Host", input.hostname ?? seededHostname)
    .send({
      qrToken: input.token,
      pax: input.pax ?? 2,
      deviceHash: input.deviceHash ?? `device-${randomUUID()}`,
    });
}

/**
 * Polls pg_stat_activity until `min` backends are waiting on a lock in this
 * database. The serialization regression tests hold a row lock first and
 * release it only once the competing requests are queued, so the outcome
 * never depends on sleep timing or on which request wins the lock.
 */
export async function waitForLockWaiters(min: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.count ?? 0) >= min) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const { rows: waiters } = await owner.query<{
    pid: number;
    blockers: number[];
    query: string;
  }>(
    `SELECT pid, pg_blocking_pids(pid) AS blockers, left(query, 80) AS query
     FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  throw new Error(
    `Timed out waiting for ${min} lock waiters: ${JSON.stringify(waiters)}`,
  );
}
