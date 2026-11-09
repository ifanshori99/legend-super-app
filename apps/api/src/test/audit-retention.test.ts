// Audit retention purge (legend-usyi). The purge runs as a dedicated
// NOLOGIN group `legend_maintenance` that holds EXECUTE on two SECURITY DEFINER
// functions and nothing else: no table, sequence or RLS bypass. These tests run
// the real migration against the disposable PostgreSQL server.
//
// Assumptions: the migration owner (MIGRATION_DATABASE_URL) owns `audit_logs`.
// Rows are backdated in a transaction where the owner switches the
// `audit_logs_creation_time` trigger off; the purge itself never does. Every
// test uses its own fresh tenants, so counts never depend on test order.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEventListQuerySchema,
  auditEventSchema,
} from "@starter/shared/audit";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { listAuditEvents } from "../services/audit-events.service";

const adminUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
const PURGE_ACTION = "audit.retention_purged";
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const app = new Pool({ connectionString: appUrl, max: 2 });

function loginUrl(user: string, password: string): string {
  const url = new URL(String(adminUrl));
  url.username = user;
  url.password = password;
  return url.toString();
}

const suffix = randomBytes(8).toString("hex");
const maintUser = `legend_maint_${suffix}`;
const workerUser = `legend_worker_${suffix}`;
const maintPassword = randomBytes(24).toString("hex");
const workerPassword = randomBytes(24).toString("hex");
let maintenance: Pool;
let worker: Pool;
const tenants: string[] = [];

async function newTenant(status: "active" | "archived" = "active") {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Audit retention tenant', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `audit-ret-${id.slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  if (status === "archived")
    await owner.query(
      `UPDATE tenants SET status = 'archived', status_before_archive = 'active', archived_at = now() WHERE id = $1`,
      [id],
    );
  tenants.push(id);
  return id;
}

/** Inserts audit rows `age` old (a PostgreSQL interval) as the table owner. */
async function seed(
  tenantId: string,
  count: number,
  age: string,
): Promise<string[]> {
  const ids: string[] = [];
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    await client.query(
      "ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_creation_time",
    );
    for (let index = 0; index < count; index += 1) {
      const ulid = createUlid(Date.now() + index);
      const event = {
        id: ulid,
        tenantId,
        outletId: null,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "settings.updated",
        objectType: "retention_seed",
        objectId: null,
        reason: null,
        maskedChanges: { before: null, after: null },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO public.audit_logs (tenant_id, id, outlet_id, event, retention_class, created_at)
         VALUES ($1, $2, NULL, $3, 'audit_2y', now() - $4::interval)`,
        [tenantId, ulidToUuid(ulid), JSON.stringify(event), age],
      );
      ids.push(ulidToUuid(ulid));
    }
    await client.query(
      "ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_creation_time",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

const EXPIRED = "2 years";
const EXPIRED_OLDER = "2 years 1 day";
const YOUNG = "2 years - 1 day";

async function purge(
  tenantId: string,
  batch: number,
  pool: Pool | PoolClient = maintenance,
): Promise<number> {
  const result = await pool.query(
    "SELECT app.purge_audit_retention_batch($1::uuid, $2::int) AS count",
    [tenantId, batch],
  );
  return Number(result.rows[0].count);
}

async function count(tenantId: string, where = "TRUE"): Promise<number> {
  const result = await owner.query(
    `SELECT count(*)::int AS count FROM public.audit_logs WHERE tenant_id = $1 AND ${where}`,
    [tenantId],
  );
  return result.rows[0].count;
}
const seeded = "event->>'objectType' = 'retention_seed'";
const summaries = `event->>'action' = '${PURGE_ACTION}'`;

async function summaryRows(tenantId: string) {
  const result = await owner.query(
    `SELECT id, event, retention_class, outlet_id, created_at FROM public.audit_logs
     WHERE tenant_id = $1 AND ${summaries} ORDER BY id`,
    [tenantId],
  );
  return result.rows as Array<{
    id: string;
    event: Record<string, unknown> & {
      maskedChanges: { before: unknown; after: Record<string, unknown> };
    };
    retention_class: string;
    outlet_id: string | null;
    created_at: Date;
  }>;
}

async function sqlCode(run: Promise<unknown>): Promise<string | undefined> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as { code?: string }).code;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `CREATE ROLE "${maintUser}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT IN ROLE legend_maintenance PASSWORD '${maintPassword}'`,
  );
  await owner.query(
    `CREATE ROLE "${workerUser}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${workerPassword}'`,
  );
  await owner.query(`GRANT USAGE ON SCHEMA app TO "${workerUser}"`);
  maintenance = new Pool({
    connectionString: loginUrl(maintUser, maintPassword),
    max: 3,
  });
  worker = new Pool({
    connectionString: loginUrl(workerUser, workerPassword),
    max: 1,
  });
});

afterAll(async () => {
  await maintenance?.end();
  await worker?.end();
  await app.end();
  for (const id of tenants)
    await owner.query("DELETE FROM tenants WHERE id = $1", [id]);
  await owner.query(`REVOKE USAGE ON SCHEMA app FROM "${workerUser}"`);
  await owner.query(`DROP ROLE IF EXISTS "${maintUser}"`);
  await owner.query(`DROP ROLE IF EXISTS "${workerUser}"`);
  await owner.end();
});

describe("audit retention purge", () => {
  it("denies the application and worker logins on both functions", async () => {
    const tenantId = await newTenant();
    for (const pool of [app, worker]) {
      expect(
        await sqlCode(
          pool.query("SELECT * FROM app.audit_retention_due_tenants()"),
        ),
      ).toBe("42501");
      expect(await sqlCode(purge(tenantId, 10, pool))).toBe("42501");
    }
  });

  it("gives the maintenance login no right on audit_logs, tenants or sequences", async () => {
    const tenantId = await newTenant();
    for (const statement of [
      "SELECT 1 FROM public.audit_logs LIMIT 1",
      "SELECT 1 FROM public.tenants LIMIT 1",
      "DELETE FROM public.audit_logs",
      "UPDATE public.tenants SET name = name",
    ])
      expect(await sqlCode(maintenance.query(statement)), statement).toBe(
        "42501",
      );
    const rights = await owner.query(
      `SELECT
         has_table_privilege($1, 'public.audit_logs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS audit,
         has_table_privilege($1, 'public.tenants', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS tenants,
         (SELECT count(*)::int FROM pg_class c WHERE CASE WHEN c.relkind = 'S'
            THEN has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) AS sequences,
         pg_has_role($1, 'legend_app', 'MEMBER') AS app_member,
         pg_has_role($1, 'legend_maintenance', 'USAGE') AS maintenance_member,
         (SELECT count(*)::int FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS owned,
         (SELECT array_agg(rolname::text ORDER BY rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
            WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS memberships`,
      [maintUser],
    );
    expect(rights.rows[0]).toEqual({
      audit: false,
      tenants: false,
      sequences: 0,
      app_member: false,
      maintenance_member: true,
      owned: 0,
      memberships: ["legend_maintenance"],
    });
    const role = await owner.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_roles WHERE rolname = 'legend_maintenance'`,
    );
    expect(role.rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
    // The group and its members reach the purge through the functions only.
    expect(await count(tenantId)).toBe(0);
  });

  it("deletes rows aged two years or more, keeps younger rows and other tenants", async () => {
    const tenantId = await newTenant();
    const other = await newTenant();
    await seed(tenantId, 2, EXPIRED);
    await seed(tenantId, 1, EXPIRED_OLDER);
    const young = await seed(tenantId, 2, YOUNG);
    await seed(tenantId, 1, "1 minute");
    await seed(other, 3, EXPIRED_OLDER);
    expect(await purge(tenantId, 100)).toBe(3);
    expect(await count(tenantId, seeded)).toBe(3);
    const left = await owner.query(
      `SELECT id FROM public.audit_logs WHERE tenant_id = $1 AND ${seeded} AND created_at < now() - interval '1 hour'`,
      [tenantId],
    );
    expect(left.rows.map((row) => row.id).sort()).toEqual([...young].sort());
    expect(await count(other, seeded)).toBe(3);
    expect(await count(other, summaries)).toBe(0);
  });

  it("limits each call to the batch size and ends the loop when a batch comes back short", async () => {
    const tenantId = await newTenant();
    await seed(tenantId, 8, EXPIRED_OLDER);
    const results: number[] = [];
    for (let calls = 0; calls < 10; calls += 1) {
      const deleted = await purge(tenantId, 3);
      results.push(deleted);
      if (deleted < 3) break;
    }
    expect(results).toEqual([3, 3, 2]);
    expect(await count(tenantId, seeded)).toBe(0);
    const rows = await summaryRows(tenantId);
    expect(
      rows.map((row) => row.event.maskedChanges.after.deletedCount),
    ).toEqual(expect.arrayContaining([3, 3, 2]));
    expect(rows).toHaveLength(3);
  });

  it("rejects a missing tenant and a batch size outside 1..5000", async () => {
    const tenantId = await newTenant();
    await seed(tenantId, 1, EXPIRED_OLDER);
    for (const [tenant, batch] of [
      [null, 10],
      [tenantId, 0],
      [tenantId, -1],
      [tenantId, 5001],
      [tenantId, null],
    ] as const)
      expect(await sqlCode(purge(tenant as string, batch as number))).toBe(
        "22023",
      );
    expect(await count(tenantId, seeded)).toBe(1);
    expect(await purge(tenantId, 5000)).toBe(1);
  });

  it("writes exactly one summary per non-empty batch with the exact count", async () => {
    const tenantId = await newTenant();
    await seed(tenantId, 4, EXPIRED_OLDER);
    expect(await purge(tenantId, 100)).toBe(4);
    const rows = await summaryRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.maskedChanges).toEqual({
      before: null,
      after: {
        deletedCount: 4,
        cutoff: expect.any(String),
        retentionClass: "audit_2y",
      },
    });
    const cutoff = new Date(String(rows[0]?.event.maskedChanges.after.cutoff));
    expect(
      Math.abs(Date.now() - 2 * 365.25 * 86_400_000 - cutoff.getTime()),
    ).toBeLessThan(3 * 86_400_000);
  });

  it("writes no summary for an empty run and a rerun changes nothing", async () => {
    const tenantId = await newTenant();
    await seed(tenantId, 2, YOUNG);
    expect(await purge(tenantId, 100)).toBe(0);
    expect(await count(tenantId, summaries)).toBe(0);
    expect(await count(tenantId)).toBe(2);
    await seed(tenantId, 2, EXPIRED_OLDER);
    expect(await purge(tenantId, 100)).toBe(2);
    const before = await owner.query(
      "SELECT id, event, created_at FROM public.audit_logs WHERE tenant_id = $1 ORDER BY id",
      [tenantId],
    );
    expect(await purge(tenantId, 100)).toBe(0);
    const after = await owner.query(
      "SELECT id, event, created_at FROM public.audit_logs WHERE tenant_id = $1 ORDER BY id",
      [tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("builds a summary that passes the audit contract, shows in the viewer and survives the next run", async () => {
    const tenantId = await newTenant();
    const deleted = await seed(tenantId, 3, EXPIRED_OLDER);
    expect(await purge(tenantId, 100)).toBe(3);
    const [row] = await summaryRows(tenantId);
    if (!row) throw new Error("Expected a summary row");
    const event = auditEventSchema.parse(row.event);
    expect(event).toMatchObject({
      tenantId,
      outletId: null,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: PURGE_ACTION,
      objectType: "audit_log",
      objectId: null,
      reason: null,
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
    });
    expect(row.retention_class).toBe("audit_2y");
    expect(row.outlet_id).toBeNull();
    expect(event.id).toBe(uuidToUlid(row.id));
    expect(ulidToUuid(event.id)).toBe(row.id);
    // Time-ordered id: the 48-bit prefix is the creation time in milliseconds.
    expect(
      Math.abs(Date.parse(event.createdAt) - row.created_at.getTime()),
    ).toBeLessThan(1000);
    // Only the count: no id, actor or content of the deleted rows.
    const text = JSON.stringify(row.event);
    for (const id of deleted) expect(text).not.toContain(id);
    expect(text).not.toContain("retention_seed");

    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantId),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    const page = await listAuditEvents(
      context,
      randomUUID(),
      auditEventListQuerySchema.parse({ action: PURGE_ACTION, limit: 20 }),
    );
    expect(page.data.map((view) => view.event.id)).toEqual([event.id]);

    // A later run does not touch it, even once more old rows are purged.
    await seed(tenantId, 1, EXPIRED_OLDER);
    expect(await purge(tenantId, 100)).toBe(1);
    expect(await purge(tenantId, 100)).toBe(0);
    const rows = await summaryRows(tenantId);
    expect(rows.map((entry) => entry.id)).toContain(row.id);
    expect(rows).toHaveLength(2);
  });

  it("lists every tenant with an expired row, archived ones too, and no other", async () => {
    const due = await newTenant();
    const archived = await newTenant("archived");
    const fresh = await newTenant();
    const empty = await newTenant();
    await seed(due, 1, EXPIRED_OLDER);
    await seed(archived, 1, EXPIRED);
    await seed(fresh, 2, YOUNG);
    const result = await maintenance.query(
      "SELECT * FROM app.audit_retention_due_tenants() AS tenant_id",
    );
    const ids = result.rows.map((row) => row.tenant_id);
    expect(ids).toContain(due);
    expect(ids).toContain(archived);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(empty);
    // The archived tenant is purged like any other.
    expect(await purge(archived, 100)).toBe(1);
  });

  it("keeps the summary count equal to the deleted rows when two sessions purge together", async () => {
    const tenantId = await newTenant();
    await seed(tenantId, 9, EXPIRED_OLDER);
    const session = async () => {
      const client = await maintenance.connect();
      try {
        let total = 0;
        for (let calls = 0; calls < 20; calls += 1) {
          const deleted = await purge(tenantId, 2, client);
          total += deleted;
          if (deleted < 2) break;
        }
        return total;
      } finally {
        client.release();
      }
    };
    const [first, second] = await Promise.all([session(), session()]);
    // A locked row is skipped, so a session may stop early; finish the rest.
    const rest = await purge(tenantId, 100);
    expect(first + second + rest).toBe(9);
    expect(await count(tenantId, seeded)).toBe(0);
    const summed = (await summaryRows(tenantId)).reduce(
      (total, row) =>
        total + Number(row.event.maskedChanges.after.deletedCount),
      0,
    );
    expect(summed).toBe(9);
  });

  it("still refuses a direct DELETE on a new row for the application and the table owner", async () => {
    const tenantId = await newTenant();
    const [id] = await seed(tenantId, 1, "1 second");
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      expect(
        await sqlCode(
          client.query("DELETE FROM public.audit_logs WHERE id = $1", [id]),
        ),
      ).toBe("42501");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    await expect(
      owner.query("DELETE FROM public.audit_logs WHERE tenant_id = $1", [
        tenantId,
      ]),
    ).rejects.toThrow(/append-only/);
    expect(await count(tenantId)).toBe(1);
  });

  it("registers both functions as safe SECURITY DEFINER code owned by the table owner", async () => {
    const result = await owner.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile,
              p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'public.audit_logs'::regclass) AS owned_by_table_owner,
              has_function_privilege('legend_maintenance', p.oid, 'EXECUTE') AS maintenance_execute,
              has_function_privilege('legend_app', p.oid, 'EXECUTE') AS app_execute,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('audit_retention_due_tenants', 'purge_audit_retention_batch', 'audit_ulid_text', 'new_audit_uuid')
        ORDER BY p.proname`,
    );
    const byName = Object.fromEntries(
      result.rows.map((row) => [row.proname, row]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "audit_retention_due_tenants",
      "audit_ulid_text",
      "new_audit_uuid",
      "purge_audit_retention_batch",
    ]);
    for (const name of [
      "audit_retention_due_tenants",
      "purge_audit_retention_batch",
    ]) {
      expect(byName[name]).toMatchObject({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, pg_temp"],
        owned_by_table_owner: true,
        maintenance_execute: true,
        app_execute: false,
        public_execute: false,
      });
    }
    for (const name of ["audit_ulid_text", "new_audit_uuid"])
      expect(byName[name]).toMatchObject({
        owned_by_table_owner: true,
        public_execute: false,
        app_execute: false,
      });
    expect(byName.audit_ulid_text.provolatile).toBe("i");
    // The old owner-only hook is gone, and the append-only guard is unchanged.
    const old = await owner.query(
      "SELECT to_regprocedure('app.purge_expired_audit_logs(uuid)') AS old",
    );
    expect(old.rows[0].old).toBeNull();
    const guard = await owner.query(
      "SELECT pg_get_functiondef('app.guard_audit_log()'::regprocedure) AS def",
    );
    expect(guard.rows[0].def).toContain("Audit records are append-only");
  });

  it("encodes ids in the same Crockford form as uuidToUlid", async () => {
    const samples = [
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ulidToUuid(createUlid()),
      randomUUID(),
    ];
    for (const sample of samples) {
      const result = await owner.query(
        "SELECT app.audit_ulid_text($1::uuid) AS ulid",
        [sample],
      );
      expect(result.rows[0].ulid).toBe(uuidToUlid(sample));
    }
    const made = await owner.query("SELECT app.new_audit_uuid() AS id");
    expect(ulidToUuid(uuidToUlid(made.rows[0].id))).toBe(made.rows[0].id);
    const millis = parseInt(
      String(made.rows[0].id).replaceAll("-", "").slice(0, 12),
      16,
    );
    expect(Math.abs(millis - Date.now())).toBeLessThan(5000);
  });
});
