// Tenant PPh 21 policy versions against PostgreSQL with the restricted app
// role (bead legend-y4wp; PRD v1.7 §3 D.30 "PPh 21", R15, R20, R21): create,
// list, resolve by date, default when none, conflict codes, permission,
// audit row, append-only and tenant isolation (RLS ENABLE + FORCE proven at
// SQL level). Services are called directly with server-minted contexts and
// real users holding real role assignments, so every decision goes through the
// RBAC resolver.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  businessDateSchema,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type BusinessDate,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  DEFAULT_PPH21_POLICY,
  type Pph21PolicyParameters,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { payrollPph21Policies } from "../db/schema/payroll-pph21-policy.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createPph21PolicyVersion,
  getPph21PolicyInForce,
  listPph21PolicyVersions,
  resolvePph21PolicyFor,
} from "../services/payroll-pph21-policy.service.ts";

// Own tenant (+ one outlet): policy versions are numbered per tenant, so sharing
// the fixture tenant with payroll-run-pph21-db.test.ts under 2 workers made
// both files collide (PAYROLL_PPH21_POLICY_CONFLICT, wrong version counts;
// bead legend-gx3i4). The fixture tenant is only the template for the rows.
const fixtureTenant = cafeLegendPlatformFixtures.tenant;
const tenantId = randomUUID();
const outletA = randomUUID();
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'PPh21 policy DB', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `PPh21 policy test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
  return userId;
}

async function clearPolicies() {
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, (client) =>
      client.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
        tenant,
      ]),
    );
}

/** PostgreSQL 42501 (insufficient_privilege), also under a drizzle wrapper. */
const permissionDenied = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { code?: unknown }).code === "42501" ||
    permissionDenied((error as { cause?: unknown }).cause));

const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
/** Business date `days` after `from` (calendar arithmetic, no time zone). */
function plusDays(from: BusinessDate, days: number): BusinessDate {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return businessDateSchema.parse(date.toISOString().slice(0, 10));
}

const CONSULTANT: Pph21PolicyParameters = {
  occupationalCostCap: "full_annual",
  noTaxIdSurcharge: "annual_only",
  combinedSpouseStatus: "reject",
  mixedSchemeAllocation: "gross_first",
  roundingMode: "down",
};

// Actors (assigned in beforeAll).
let admin: string; // tenant-wide payroll.view + payroll.run
let viewer: string; // tenant-wide payroll.view only
let outletAdmin: string; // payroll.view + payroll.run at one outlet only
let stranger: string; // no payroll code
let adminOther: string; // payroll admin of the other tenant

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'PPh21 policy tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `pph21-pol-${tenantId.slice(0, 8)}`, fixtureTenant.id],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'PPh21 policy RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `pph21-rls-${otherTenant.slice(0, 8)}`, fixtureTenant.id],
  );
  // The outlet-scoped actor needs a real outlet of this tenant.
  const brandId = randomUUID();
  const entityId = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'pph21-pol', 'PPh21 policy brand')`,
    [brandId, tenantId],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PPh21 policy entity', false)`,
    [entityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'PPH21-POL', 'PPh21 policy outlet', 'Jl. Uji', 'Asia/Jakarta', $5, 'active')`,
    [
      outletA,
      tenantId,
      brandId,
      entityId,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0].openingHours),
    ],
  );
  await clearPolicies();
  admin = await actor(["payroll.view", "payroll.run"], { type: "tenant" });
  viewer = await actor(["payroll.view"], { type: "tenant" });
  outletAdmin = await actor(["payroll.view", "payroll.run"], {
    type: "outlet",
    id: outletA,
  });
  stranger = await actor(["hr.employee.view"], { type: "tenant" });
  adminOther = await actor(
    ["payroll.view", "payroll.run"],
    { type: "tenant" },
    otherTenant,
  );
});

afterAll(async () => {
  await clearPolicies();
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  // Audit rows are append-only (trigger): suspend it for one purge so both
  // tenants can really be removed; a failure here must be visible.
  const purge = await owner.connect();
  try {
    await purge.query("BEGIN");
    await purge.query(
      "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
    );
    await purge.query("DELETE FROM audit_logs WHERE tenant_id = ANY($1)", [
      [tenantId, otherTenant],
    ]);
    await purge.query(
      "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
    );
    await purge.query("COMMIT");
  } catch (error) {
    await purge.query("ROLLBACK");
    throw error;
  } finally {
    purge.release();
  }
  for (const statement of [
    "DELETE FROM outlets WHERE tenant_id = $1",
    "DELETE FROM legal_entities WHERE tenant_id = $1",
    "DELETE FROM brands WHERE tenant_id = $1",
    "DELETE FROM tenants WHERE id = $1",
  ])
    for (const tenant of [tenantId, otherTenant])
      await owner.query(statement, [tenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("PPh 21 policy: default, create, list, resolve", () => {
  it("answers the default policy while the tenant has no version", async () => {
    expect(await listPph21PolicyVersions(tenantScope(), admin)).toEqual([]);
    const none = {
      parameters: DEFAULT_PPH21_POLICY,
      source: "default",
      version: null,
      effectiveFrom: null,
      versionId: null,
    };
    expect(await resolvePph21PolicyFor(tenantScope(), today)).toEqual(none);
    expect(await getPph21PolicyInForce(tenantScope(), viewer, today)).toEqual(
      none,
    );
  });

  it("creates versions 1 and 2, lists them oldest first and resolves by date", async () => {
    const v1Date = plusDays(today, 10);
    const v2Date = plusDays(today, 40);
    const first = await createPph21PolicyVersion(tenantScope(), admin, {
      effectiveFrom: v1Date,
      parameters: CONSULTANT,
      reason: "Saran konsultan pajak 2026",
    });
    expect(first).toMatchObject({
      tenantId,
      version: 1,
      effectiveFrom: v1Date,
      parameters: CONSULTANT,
      reason: "Saran konsultan pajak 2026",
      createdBy: admin,
    });
    const second = await createPph21PolicyVersion(tenantScope(), admin, {
      effectiveFrom: v2Date,
      parameters: { ...CONSULTANT, roundingMode: "half_up" },
      reason: "Coretax mulai berlaku",
    });
    expect(second.version).toBe(2);

    // A viewer (payroll.view only) reads.
    const list = await listPph21PolicyVersions(tenantScope(), viewer);
    expect(list.map((row) => row.version)).toEqual([1, 2]);
    expect(list.map((row) => row.id)).toEqual([first.id, second.id]);

    // Before v1: default. From v1: v1. From v2: v2.
    expect(
      (await resolvePph21PolicyFor(tenantScope(), today)).parameters,
    ).toEqual(DEFAULT_PPH21_POLICY);
    // The resolved policy carries the id of the version, for pinning in a run.
    expect(await resolvePph21PolicyFor(tenantScope(), v1Date)).toEqual({
      parameters: CONSULTANT,
      source: "version",
      version: 1,
      effectiveFrom: v1Date,
      versionId: first.id,
    });
    expect(
      (await resolvePph21PolicyFor(tenantScope(), plusDays(v2Date, -1)))
        .versionId,
    ).toBe(first.id);
    expect(await resolvePph21PolicyFor(tenantScope(), v2Date)).toEqual({
      parameters: { ...CONSULTANT, roundingMode: "half_up" },
      source: "version",
      version: 2,
      effectiveFrom: v2Date,
      versionId: second.id,
    });
    expect(await getPph21PolicyInForce(tenantScope(), viewer, v2Date)).toEqual({
      parameters: { ...CONSULTANT, roundingMode: "half_up" },
      source: "version",
      version: 2,
      effectiveFrom: v2Date,
      versionId: second.id,
    });
    expect(
      (await getPph21PolicyInForce(tenantScope(), viewer, v1Date)).version,
    ).toBe(1);
  });

  it("allows a version effective today and a version dated between two others", async () => {
    const todays = await createPph21PolicyVersion(tenantScope(), admin, {
      effectiveFrom: today,
      parameters: DEFAULT_PPH21_POLICY,
      reason: "Kembali ke bawaan hari ini",
    });
    expect(todays.version).toBe(3);
    // Version numbers follow creation order, not the date order.
    const between = await createPph21PolicyVersion(tenantScope(), admin, {
      effectiveFrom: plusDays(today, 20),
      parameters: { ...DEFAULT_PPH21_POLICY, roundingMode: "down" },
      reason: "Sisipan di antara dua versi",
    });
    expect(between.version).toBe(4);
    const list = await listPph21PolicyVersions(tenantScope(), admin);
    expect(
      list
        .map((row) => [row.version, row.effectiveFrom] as const)
        .sort((a, b) => (a[1] < b[1] ? -1 : 1))
        .map(([version]) => version),
    ).toEqual([3, 1, 4, 2]);
    expect(
      (await getPph21PolicyInForce(tenantScope(), admin, plusDays(today, 25)))
        .version,
    ).toBe(4);
  });

  it("validates the parameters on write (strict, enum values only)", async () => {
    const bad = (parameters: unknown) =>
      failure(
        createPph21PolicyVersionUnsafe({
          effectiveFrom: plusDays(today, 90),
          parameters,
          reason: "Uji validasi",
        }),
      );
    expect(
      (await bad({ ...DEFAULT_PPH21_POLICY, roundingMode: "up" })).error,
    ).toBeTruthy();
    expect(
      (await bad({ ...DEFAULT_PPH21_POLICY, extra: true })).error,
    ).toBeTruthy();
    const incomplete: Record<string, unknown> = { ...DEFAULT_PPH21_POLICY };
    delete incomplete.roundingMode;
    expect((await bad(incomplete)).error).toBeTruthy();
    expect((await listPph21PolicyVersions(tenantScope(), admin)).length).toBe(
      4,
    );
  });

  it("reads a stored row that no longer fits the schema as an error, not a tax", async () => {
    const date = plusDays(today, 120);
    await asOwner(tenantId, (client) =>
      client.query(
        `INSERT INTO payroll_pph21_policies
           (tenant_id, version, effective_from, parameters, reason, created_by)
         VALUES ($1, 99, $2, '{"roundingMode":"banker"}', 'Baris rusak', $3)`,
        [tenantId, date, admin],
      ),
    );
    try {
      await expect(
        resolvePph21PolicyFor(tenantScope(), date),
      ).rejects.toThrow();
      await expect(
        listPph21PolicyVersions(tenantScope(), admin),
      ).rejects.toThrow();
    } finally {
      await asOwner(tenantId, (client) =>
        client.query(
          "DELETE FROM payroll_pph21_policies WHERE tenant_id = $1 AND version = 99",
          [tenantId],
        ),
      );
    }
  });
});

/** Bypasses the TypeScript input type so malformed input reaches the service. */
function createPph21PolicyVersionUnsafe(input: unknown) {
  return createPph21PolicyVersion(
    tenantScope(),
    admin,
    input as Parameters<typeof createPph21PolicyVersion>[2],
  );
}

describe("PPh 21 policy: conflicts", () => {
  it("refuses an effective date before today with PAYROLL_PPH21_POLICY_CONFLICT", async () => {
    const result = await failure(
      createPph21PolicyVersion(tenantScope(), admin, {
        effectiveFrom: plusDays(today, -1),
        parameters: DEFAULT_PPH21_POLICY,
        reason: "Berlaku surut",
      }),
    );
    expect(result.code).toBe("PAYROLL_PPH21_POLICY_CONFLICT");
    expect(result.status).toBe(409);
  });

  it("measures 'today' with the injected clock", async () => {
    const future = plusDays(today, 400);
    const created = await createPph21PolicyVersion(
      tenantScope(),
      admin,
      {
        effectiveFrom: future,
        parameters: DEFAULT_PPH21_POLICY,
        reason: "Jam disuntik",
      },
      new Date(`${future}T05:00:00Z`),
    );
    expect(created.effectiveFrom).toBe(future);
    const late = await failure(
      createPph21PolicyVersion(
        tenantScope(),
        admin,
        {
          effectiveFrom: plusDays(future, 5),
          parameters: DEFAULT_PPH21_POLICY,
          reason: "Sudah lewat menurut jam suntikan",
        },
        new Date(`${plusDays(future, 6)}T05:00:00Z`),
      ),
    );
    expect(late.code).toBe("PAYROLL_PPH21_POLICY_CONFLICT");
  });

  it("refuses a second version on the same effective date", async () => {
    const date = plusDays(today, 10); // version 1 already sits here
    const result = await failure(
      createPph21PolicyVersion(tenantScope(), admin, {
        effectiveFrom: date,
        parameters: DEFAULT_PPH21_POLICY,
        reason: "Tanggal sama",
      }),
    );
    expect(result.code).toBe("PAYROLL_PPH21_POLICY_CONFLICT");
    expect(result.status).toBe(409);
  });

  it("lets only one of two concurrent publishers win, the other gets the conflict code", async () => {
    const date = plusDays(today, 200);
    const results = await Promise.allSettled(
      [CONSULTANT, DEFAULT_PPH21_POLICY].map((parameters) =>
        createPph21PolicyVersion(tenantScope(), admin, {
          effectiveFrom: date,
          parameters,
          reason: "Balapan dua penerbit",
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(
      "PAYROLL_PPH21_POLICY_CONFLICT",
    );
    const versions = (await listPph21PolicyVersions(tenantScope(), admin)).map(
      (row) => row.version,
    );
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("PPh 21 policy: permission", () => {
  const input = () => ({
    effectiveFrom: plusDays(today, 300),
    parameters: DEFAULT_PPH21_POLICY,
    reason: "Tanpa hak",
  });

  it("denies publishing to a viewer, an outlet-scoped admin and a stranger", async () => {
    for (const user of [viewer, outletAdmin, stranger]) {
      const result = await failure(
        createPph21PolicyVersion(tenantScope(), user, input()),
      );
      expect(result.status).toBe(403);
    }
    // An outlet-scoped context cannot publish a tenant-wide setting either.
    const narrow = establishScopedTenantContext(base(), {
      kind: "outlets",
      outletIds: [outletA as never],
    });
    expect(
      (await failure(createPph21PolicyVersion(narrow, admin, input()))).status,
    ).toBe(403);
  });

  it("denies reading to a user without payroll.view or without tenant reach", async () => {
    for (const user of [stranger, outletAdmin]) {
      expect(
        (await failure(listPph21PolicyVersions(tenantScope(), user))).status,
      ).toBe(403);
      expect(
        (await failure(getPph21PolicyInForce(tenantScope(), user, today)))
          .status,
      ).toBe(403);
    }
  });

  it("stored nothing for the denied attempts", async () => {
    const rows = await listPph21PolicyVersions(tenantScope(), admin);
    expect(rows.some((row) => row.reason === "Tanpa hak")).toBe(false);
  });
});

describe("PPh 21 policy: audit", () => {
  it("writes one audit row with old and new parameters and the reason", async () => {
    const parameters: Pph21PolicyParameters = {
      ...CONSULTANT,
      occupationalCostCap: "pro_rata_months",
    };
    const date = plusDays(today, 500);
    const before = (await resolvePph21PolicyFor(tenantScope(), date))
      .parameters;
    const created = await createPph21PolicyVersion(tenantScope(), admin, {
      effectiveFrom: date,
      parameters,
      reason: "Audit uji: konsultan menyetujui",
    });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenantId, created.id],
      ),
    );
    expect(rows).toHaveLength(1);
    const event = rows[0]!.event as {
      action: string;
      objectType: string;
      actorId: string;
      outletId: string | null;
      reason: string;
      maskedChanges: {
        before: { previousVersion: number | null; parameters: unknown };
        after: { version: number; effectiveFrom: string; parameters: unknown };
      };
    };
    expect(event).toMatchObject({
      action: "payroll.pph21_policy.created",
      objectType: "payroll_pph21_policy",
      actorId: admin,
      outletId: null,
      reason: "Audit uji: konsultan menyetujui",
    });
    // Old parameters = the policy in force on that date before this version.
    expect(event.maskedChanges.before.parameters).toEqual(before);
    expect(event.maskedChanges.after).toEqual({
      version: created.version,
      effectiveFrom: date,
      parameters,
    });
  });

  it("writes no audit row for a refused version", async () => {
    const reason = `Ditolak ${randomUUID()}`;
    await failure(
      createPph21PolicyVersion(tenantScope(), admin, {
        effectiveFrom: plusDays(today, -3),
        parameters: DEFAULT_PPH21_POLICY,
        reason,
      }),
    );
    const { rowCount } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'reason' = $2`,
        [tenantId, reason],
      ),
    );
    expect(rowCount).toBe(0);
  });
});

describe("PPh 21 policy: append-only and tenant isolation", () => {
  it("[R21] the app role cannot update or delete a published version", async () => {
    const [row] = await listPph21PolicyVersions(tenantScope(), admin);
    expect(row).toBeDefined();
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx
          .update(payrollPph21Policies)
          .set({ reason: "Diubah diam-diam" })
          .where(eq(payrollPph21Policies.id, row!.id)),
      ),
    ).rejects.toSatisfy(permissionDenied);
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx
          .delete(payrollPph21Policies)
          .where(eq(payrollPph21Policies.id, row!.id)),
      ),
    ).rejects.toSatisfy(permissionDenied);
    const again = await listPph21PolicyVersions(tenantScope(), admin);
    expect(again.find((item) => item.id === row!.id)?.reason).toBe(row!.reason);
  });

  it("[TEN-01] RLS is enabled and forced with the restrictive tenant policy", async () => {
    const table = await owner.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'public.payroll_pph21_policies'::regclass`,
    );
    expect(table.rows[0]).toEqual({ rls: true, forced: true });
    const policies = await owner.query<{
      policyname: string;
      permissive: string;
    }>(
      `SELECT policyname, permissive FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'payroll_pph21_policies'
        ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { policyname: "tenant_access", permissive: "PERMISSIVE" },
      { policyname: "tenant_isolation", permissive: "RESTRICTIVE" },
    ]);
  });

  it("[TEN-01] another tenant sees none of this tenant's versions and resolves the default", async () => {
    expect(
      (await listPph21PolicyVersions(tenantScope(), admin)).length,
    ).toBeGreaterThan(0);
    expect(
      await listPph21PolicyVersions(tenantScope(otherTenant), adminOther),
    ).toEqual([]);
    expect(
      await resolvePph21PolicyFor(
        tenantScope(otherTenant),
        plusDays(today, 600),
      ),
    ).toMatchObject({
      parameters: DEFAULT_PPH21_POLICY,
      source: "default",
      versionId: null,
    });
    const rows = await withTenant(db, tenantScope(otherTenant), (tx) =>
      tx
        .select()
        .from(payrollPph21Policies)
        .where(eq(payrollPph21Policies.tenantId, tenantId)),
    );
    expect(rows).toEqual([]);
  });

  it("[TEN-02] RLS refuses a row for another tenant, and an unscoped session sees nothing", async () => {
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(payrollPph21Policies).values({
          tenantId: tenantId as never,
          version: 500,
          effectiveFrom: plusDays(today, 700),
          parameters: DEFAULT_PPH21_POLICY,
          reason: "Bocor lintas tenant",
          createdBy: adminOther as never,
        }),
      ),
    ).rejects.toThrow();
    // No tenant set on the session: the policy function refuses outright.
    await expect(db.select().from(payrollPph21Policies)).rejects.toThrow();
  });

  it("[TEN-01] the other tenant numbers its own versions from 1 and cannot touch ours", async () => {
    const mine = await createPph21PolicyVersion(
      tenantScope(otherTenant),
      adminOther,
      {
        // Tenant A already has a version on this date: not a conflict for B.
        effectiveFrom: plusDays(today, 10),
        parameters: CONSULTANT,
        reason: "Tenant B punya urutan sendiri",
      },
    );
    expect(mine.version).toBe(1);
    expect(mine.tenantId).toBe(otherTenant);
    // Tenant A's admin holds nothing in tenant B and vice versa.
    expect(
      (
        await failure(
          createPph21PolicyVersion(tenantScope(otherTenant), admin, {
            effectiveFrom: plusDays(today, 16),
            parameters: DEFAULT_PPH21_POLICY,
            reason: "Admin tenant A di tenant B",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await listPph21PolicyVersions(tenantScope(), admin)).some(
        (row) => row.id === mine.id,
      ),
    ).toBe(false);
  });
});
