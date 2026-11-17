// 981 follow-up item 4 + round 2 B/C (docs/briefs/981-followup.md): data
// migration 0546_mcp_flag_backfill.sql switches on the `mcp` module for tenants
// that already use MCP, so they keep working now that `mcp` is a real module
// switch (legend-hbuq3). Written fail-first from the brief, the shared
// featureFlags contract (packages/shared platform/modules.ts), the table
// definitions and the pattern of ai-module-auto-enable-migration.test.ts (0378),
// not from the SQL under test.
//
// Rules under test:
// - A tenant gets `mcp` in feature_flags.modules only when ALL hold: it is
//   status 'active'; its package (platform_packages.key = tenants.plan) contains
//   the `mcp` module (a module the package does not pay for must never be
//   switched on: setTenantPackage refuses MODULE_NOT_IN_PACKAGE); and it
//   already uses MCP.
// - Uses MCP = an APPROVED client (mcp_clients.status = 'approved') OR an active
//   token (revoked_at IS NULL AND expires_at > now()). The real client statuses
//   are 'pending' | 'approved' | 'revoked' (mcp_clients_status_check). A
//   'pending' client is NOT counted (stricter decision, brief item 4): nobody
//   approved it, so it has not used MCP. A revoked client is not counted either.
// - Other modules and integrationProviders are kept; limits, plan, status are
//   untouched; `mcp` is added once (never duplicated).
// - A tenant that already has `mcp` is unchanged (no audit either).
// - Tenants that do not qualify (no MCP use, only revoked client / revoked or
//   expired tokens, approved client but package without mcp, suspended or
//   archived tenant) are not touched at all and get no audit row.
// - One audit_logs row per CHANGED tenant, actor system, object the tenant, a
//   valid AuditEvent whose maskedChanges show the module list before and after;
//   zero rows for every other tenant.
// - Idempotent: a second run changes nothing and writes no further audit row.
// - Data only: no DDL in the file; journal idx 546 and snapshot exist.
// - Production path: run as the migration owner over every tenant with no
//   app.tenant_id set; the block sets the tenant context per tenant itself and
//   restores the previous value.
//
// Assumptions:
// - The brief says "mcp = true, ... mcp:false explicit from admin is not
//   overwritten". The real shape of tenants.feature_flags is
//   { modules: ModuleKey[], integrationProviders: [...] } (strict schema: an
//   extra `mcp` key would make the whole flag set invalid, fail closed), so
//   there is no stored "false": off means absent from `modules`. The "admin
//   switched it off" case is therefore indistinguishable from "never had it" and
//   is covered by the no-MCP-usage tenants (untouched). The "already true" case
//   is tested as no duplicate, no change and no audit.
// - The brief says only "like 0378" for the audit row, so the action name is not
//   asserted (0378 uses tenant.module_auto_enabled); the audit rows are found by
//   tenant_id alone, which is safe because every fixture tenant is created by
//   this file and nothing else writes audit rows for it.
// - The package fixtures are 'active'. Whether a retired package that lists
//   `mcp` counts is not specified by the brief (0378 requires an active
//   package) and is not tested here.
// - Migration file is `apps/api/drizzle/0546_mcp_flag_backfill.sql`. Most cases
//   replay it per tenant through helpers/migration-replay.ts (runtime role with
//   app.tenant_id set, so only the fixture tenant is seen); each tenant is
//   replayed on its own, so the "untouched" tenants are replayed too. The
//   production path has its own cases that run as the owner (MCPBF-14/15).
// - Fixtures are left in place, like the other data-migration tests.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { auditEventSchema } from "@starter/shared/audit";
import { uuidToUlid } from "@starter/shared/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayMigrationForTenant } from "./helpers/migration-replay.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const DRIZZLE_DIR = resolve(import.meta.dirname, "../../drizzle");
const MIGRATION_TAG = "0546_mcp_flag_backfill";
const MIGRATION_FILE = `${MIGRATION_TAG}.sql`;

const migrationSql = () =>
  readFileSync(resolve(DRIZZLE_DIR, MIGRATION_FILE), "utf8");

const migrate = (tenantId: string): Promise<void> =>
  replayMigrationForTenant(owner, migrationSql(), tenantId);

const LIMITS = {
  maxOutlets: 7,
  maxActiveEmployees: 11,
  maxDevices: 5,
  aiRequestsPerMonth: 123,
  whatsappCostCapIdr: 1000,
  aiCostCapIdr: 2000,
  emailCostCapIdr: 3000,
};
const PROVIDERS = ["midtrans", "xendit"];
const BASE_MODULES = ["accounting", "inventory"];

type PackageKind = "mcp" | "no_mcp";

async function newPackage(kind: PackageKind): Promise<string> {
  const key = `p981${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await owner.query(
    `INSERT INTO platform_packages (key, name, modules, default_limits, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [
      key,
      `Paket uji 981 ${kind}`,
      JSON.stringify(
        kind === "no_mcp"
          ? ["accounting", "inventory"]
          : ["accounting", "inventory", "mcp"],
      ),
      JSON.stringify(LIMITS),
    ],
  );
  return key;
}

let mcpPackage = "";
let noMcpPackage = "";

type TenantOptions = {
  modules?: string[];
  plan?: string;
  status?: "active" | "suspended" | "archived";
};

async function newTenant(options: TenantOptions = {}): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? "active";
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by, archived_at, status_before_archive)
     VALUES ($1, $2, 'Uji Backfill MCP', $3, $4, 'shared', $5, $6, $7, $8, $9)`,
    [
      id,
      `uji-mcpbf-${id.slice(0, 8)}`,
      options.plan ?? mcpPackage,
      status,
      JSON.stringify({
        modules: options.modules ?? BASE_MODULES,
        integrationProviders: PROVIDERS,
      }),
      JSON.stringify(LIMITS),
      randomUUID(),
      status === "archived" ? new Date().toISOString() : null,
      status === "archived" ? "active" : null,
    ],
  );
  return id;
}

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, "Pemakai MCP backfill", `${id}@example.com`],
  );
  return id;
}

type ClientStatus = "pending" | "approved" | "revoked";

async function addClient(
  tenantId: string,
  status: ClientStatus,
): Promise<string> {
  const approver = status === "approved" ? await newUser() : null;
  const now = new Date().toISOString();
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO mcp_clients
         (tenant_id, name, client_id, redirect_uris, allowed_scopes, status,
          registered_via, approved_by, approved_at, revoked_at)
       VALUES ($1, 'Klien uji backfill', $2, ARRAY['https://example.com/cb'],
               ARRAY['mcp:sales:read'], $3, 'admin', $4, $5::timestamptz,
               $6::timestamptz)
       RETURNING id`,
      [
        tenantId,
        `cid-${randomUUID()}`,
        status,
        approver,
        approver ? now : null,
        status === "revoked" ? now : null,
      ],
    );
    return rows[0]!.id;
  });
}

type TokenKind = "active" | "revoked" | "expired";

async function addToken(
  tenantId: string,
  mcpClientId: string,
  kind: TokenKind,
): Promise<void> {
  const userId = await newUser();
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const prefix = `mcp_${hash.slice(0, 8)}`;
  // mcp_tokens_ttl_check: expires_at in (created_at, created_at + 24h].
  const createdAgo = kind === "expired" ? "3 hours" : "1 hour";
  const expiresIn = kind === "expired" ? "-2 hours" : "2 hours";
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO mcp_tokens
         (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes,
          created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, ARRAY['mcp:sales:read'],
               now() - $6::interval, now() + $7::interval, $8::timestamptz)`,
      [
        tenantId,
        mcpClientId,
        userId,
        hash,
        prefix,
        createdAgo,
        expiresIn,
        kind === "revoked" ? new Date().toISOString() : null,
      ],
    ),
  );
}

type TenantRow = {
  plan: string;
  status: string;
  limits: unknown;
  featureFlags: { modules: string[]; integrationProviders: string[] };
};

async function tenantOf(tenantId: string): Promise<TenantRow> {
  const { rows } = await owner.query<{
    plan: string;
    status: string;
    limits: unknown;
    feature_flags: TenantRow["featureFlags"];
  }>("SELECT plan, status, limits, feature_flags FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  const row = rows[0]!;
  return {
    plan: row.plan,
    status: row.status,
    limits: row.limits,
    featureFlags: row.feature_flags,
  };
}

const sorted = (values: string[]) => [...values].sort();
const count = (modules: string[], key: string) =>
  modules.filter((m) => m === key).length;

type AuditEventRow = {
  actorType: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  maskedChanges: unknown;
};

async function auditsOf(tenantId: string): Promise<AuditEventRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ event: AuditEventRow }>(
      "SELECT event FROM audit_logs WHERE tenant_id = $1",
      [tenantId],
    );
    return rows.map((row) => row.event);
  });
}

/** Asserts exactly one valid system audit row that shows the module change. */
async function expectOneAudit(
  tenantId: string,
  before: string[],
): Promise<void> {
  const audits = await auditsOf(tenantId);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actorType: "system",
    actorId: null,
    objectType: "tenant",
    objectId: tenantId,
  });
  const parsed = auditEventSchema.parse(audits[0]);
  expect(parsed.tenantId).toBe(tenantId);
  expect(parsed.maskedChanges).toEqual({
    before: { modules: before },
    after: { modules: [...before, "mcp"] },
  });
  const { rows } = await asTenant(tenantId, (client) =>
    client.query<{ id: string }>(
      "SELECT id FROM audit_logs WHERE tenant_id = $1",
      [tenantId],
    ),
  );
  expect(uuidToUlid(rows[0]!.id)).toBe(parsed.id);
}

/** Asserts the flags gained exactly `mcp`, once, nothing else changed, one audit. */
async function expectGainedMcp(
  tenantId: string,
  before: string[],
  plan: string = mcpPackage,
): Promise<void> {
  const tenant = await tenantOf(tenantId);
  expect(count(tenant.featureFlags.modules, "mcp")).toBe(1);
  expect(sorted(tenant.featureFlags.modules)).toEqual(
    sorted([...before, "mcp"]),
  );
  expect(tenant.featureFlags.integrationProviders).toEqual(PROVIDERS);
  expect(tenant.limits).toEqual(LIMITS);
  expect(tenant.plan).toBe(plan);
  expect(tenant.status).toBe("active");
  await expectOneAudit(tenantId, before);
}

/** Asserts the tenant is exactly as seeded and has no audit row. */
async function expectUntouched(
  tenantId: string,
  options: {
    modules?: string[];
    plan?: string;
    status?: "active" | "suspended" | "archived";
  } = {},
): Promise<void> {
  const tenant = await tenantOf(tenantId);
  expect(tenant.featureFlags).toEqual({
    modules: options.modules ?? BASE_MODULES,
    integrationProviders: PROVIDERS,
  });
  expect(tenant.limits).toEqual(LIMITS);
  expect(tenant.plan).toBe(options.plan ?? mcpPackage);
  expect(tenant.status).toBe(options.status ?? "active");
  expect(await auditsOf(tenantId)).toHaveLength(0);
}

describe("981 migration 0546 mcp flag backfill", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    mcpPackage = await newPackage("mcp");
    noMcpPackage = await newPackage("no_mcp");
  });

  afterAll(async () => {
    await owner.end();
  });

  it("MCPBF-00 the migration file exists, is data only (no DDL), and has journal idx 546 and a snapshot", () => {
    expect(existsSync(resolve(DRIZZLE_DIR, MIGRATION_FILE))).toBe(true);
    const code = migrationSql().replace(/--.*$/gm, "");
    expect(code).not.toMatch(
      /(^|;)\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s/i,
    );
    const journal = JSON.parse(
      readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 546, tag: MIGRATION_TAG }),
    );
    expect(existsSync(resolve(DRIZZLE_DIR, "meta/0546_snapshot.json"))).toBe(
      true,
    );
  });

  it("MCPBF-01 a tenant with an approved client gets mcp; other modules, providers, limits and plan are kept", async () => {
    const tenantId = await newTenant();
    await addClient(tenantId, "approved");
    await migrate(tenantId);
    await expectGainedMcp(tenantId, BASE_MODULES);
  });

  it("MCPBF-02 a tenant with only a pending (never approved) client is not touched", async () => {
    const tenantId = await newTenant();
    await addClient(tenantId, "pending");
    await migrate(tenantId);
    await expectUntouched(tenantId);
  });

  it("MCPBF-03 a tenant with an active token (not revoked, not expired) gets mcp even when its client is revoked", async () => {
    const tenantId = await newTenant();
    const clientId = await addClient(tenantId, "revoked");
    await addToken(tenantId, clientId, "active");
    await migrate(tenantId);
    await expectGainedMcp(tenantId, BASE_MODULES);
  });

  it("MCPBF-04 a tenant without any MCP client or token is not touched", async () => {
    const tenantId = await newTenant();
    await migrate(tenantId);
    await expectUntouched(tenantId);
  });

  it("MCPBF-05 a tenant with only a revoked client, a revoked token and an expired token is not touched", async () => {
    const tenantId = await newTenant();
    const clientId = await addClient(tenantId, "revoked");
    await addToken(tenantId, clientId, "revoked");
    await addToken(tenantId, clientId, "expired");
    await migrate(tenantId);
    await expectUntouched(tenantId);
  });

  it("MCPBF-06 a tenant that already has mcp keeps it once: no duplicate, nothing else changes", async () => {
    const modules = ["accounting", "mcp", "inventory"];
    const tenantId = await newTenant({ modules });
    await addClient(tenantId, "approved");
    await migrate(tenantId);
    await expectUntouched(tenantId, { modules });
  });

  it("MCPBF-07 a tenant with other modules on keeps every one of them and gains mcp", async () => {
    const modules = ["pos", "hris", "ai_assistant", "accounting"];
    const tenantId = await newTenant({ modules });
    await addClient(tenantId, "approved");
    await migrate(tenantId);
    await expectGainedMcp(tenantId, modules);
  });

  it("MCPBF-08 running the migration twice gives the same result as once, for flagged and untouched tenants alike", async () => {
    const flagged = await newTenant();
    await addClient(flagged, "approved");
    const viaToken = await newTenant();
    const revokedClient = await addClient(viaToken, "revoked");
    await addToken(viaToken, revokedClient, "active");
    const plain = await newTenant();

    for (const id of [flagged, viaToken, plain]) await migrate(id);
    const afterFirst = await Promise.all(
      [flagged, viaToken, plain].map(tenantOf),
    );
    for (const id of [flagged, viaToken, plain]) await migrate(id);
    const afterSecond = await Promise.all(
      [flagged, viaToken, plain].map(tenantOf),
    );

    expect(afterSecond).toEqual(afterFirst);
    expect(count(afterSecond[0]!.featureFlags.modules, "mcp")).toBe(1);
    expect(count(afterSecond[1]!.featureFlags.modules, "mcp")).toBe(1);
    expect(afterSecond[2]!.featureFlags.modules).toEqual(BASE_MODULES);
    // The second run writes no further audit row.
    expect(await auditsOf(flagged)).toHaveLength(1);
    expect(await auditsOf(viaToken)).toHaveLength(1);
    expect(await auditsOf(plain)).toHaveLength(0);
  });

  it("MCPBF-09 a tenant with an approved client but a package without mcp is not touched and gets no audit", async () => {
    const tenantId = await newTenant({ plan: noMcpPackage });
    await addClient(tenantId, "approved");
    await migrate(tenantId);
    await expectUntouched(tenantId, { plan: noMcpPackage });
  });

  it("MCPBF-10 a tenant with an active token but a package without mcp is not touched and gets no audit", async () => {
    const tenantId = await newTenant({ plan: noMcpPackage });
    const clientId = await addClient(tenantId, "revoked");
    await addToken(tenantId, clientId, "active");
    await migrate(tenantId);
    await expectUntouched(tenantId, { plan: noMcpPackage });
  });

  it("MCPBF-11 a tenant whose plan matches no package row is not touched", async () => {
    const tenantId = await newTenant({
      plan: `p981-none-${randomUUID().slice(0, 12)}`,
    });
    await addClient(tenantId, "approved");
    await migrate(tenantId);
    const tenant = await tenantOf(tenantId);
    expect(tenant.featureFlags.modules).toEqual(BASE_MODULES);
    expect(await auditsOf(tenantId)).toHaveLength(0);
  });

  it("MCPBF-12 a suspended tenant and an archived tenant that use MCP are not touched and get no audit", async () => {
    const suspended = await newTenant({ status: "suspended" });
    await addClient(suspended, "approved");
    const archived = await newTenant({ status: "archived" });
    const archivedClient = await addClient(archived, "approved");
    await addToken(archived, archivedClient, "active");

    await migrate(suspended);
    await migrate(archived);

    await expectUntouched(suspended, { status: "suspended" });
    await expectUntouched(archived, { status: "archived" });
  });

  it("MCPBF-13 one audit row for each changed tenant and none for tenants that do not change, also after a second run", async () => {
    const changed = await newTenant();
    await addClient(changed, "approved");
    const already = await newTenant({ modules: ["mcp", "accounting"] });
    await addClient(already, "approved");
    const idle = await newTenant();

    for (const id of [changed, already, idle]) await migrate(id);
    expect(await auditsOf(changed)).toHaveLength(1);
    expect(await auditsOf(already)).toHaveLength(0);
    expect(await auditsOf(idle)).toHaveLength(0);

    for (const id of [changed, already, idle]) await migrate(id);
    expect(await auditsOf(changed)).toHaveLength(1);
    expect(await auditsOf(already)).toHaveLength(0);
    expect(await auditsOf(idle)).toHaveLength(0);
  });

  // Production path: the migrator runs as the owner over every tenant, with no
  // app.tenant_id set. Everything runs in one transaction that is rolled back,
  // so no other test file's tenant is changed for good. The shared test database
  // may hold other tenants: only the fixture tenants are asserted.
  async function runAsOwner(
    check: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query("LOCK TABLE public.tenants IN SHARE MODE");
      const run = async () => {
        for (const statement of migrationSql().split(
          "--> statement-breakpoint",
        )) {
          if (statement.replace(/--.*$/gm, "").trim())
            await client.query(statement);
        }
        // The block must leave app.tenant_id as it found it (unset).
        const { rows } = await client.query<{ v: string }>(
          "SELECT coalesce(current_setting('app.tenant_id', true), '') AS v",
        );
        expect(rows[0]!.v).toBe("");
      };
      await run();
      await check(client);
      await run();
      await check(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function ownerView(client: PoolClient, tenantId: string) {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    const tenant = await client.query<{
      feature_flags: TenantRow["featureFlags"];
    }>("SELECT feature_flags FROM tenants WHERE id = $1", [tenantId]);
    const audits = await client.query<{
      id: string;
      tenant_id: string;
      event: unknown;
    }>("SELECT id, tenant_id, event FROM audit_logs WHERE tenant_id = $1", [
      tenantId,
    ]);
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    return {
      modules: tenant.rows[0]!.feature_flags.modules,
      audits: audits.rows,
    };
  }

  it("MCPBF-14 production path: as the owner over all tenants with no tenant context, qualifying tenants gain mcp with their own audit row and the rest stay untouched", async () => {
    const viaClient = await newTenant();
    await addClient(viaClient, "approved");
    const viaToken = await newTenant();
    const revokedClient = await addClient(viaToken, "revoked");
    await addToken(viaToken, revokedClient, "active");
    const otherPackage = await newTenant({ plan: noMcpPackage });
    await addClient(otherPackage, "approved");
    const suspended = await newTenant({ status: "suspended" });
    await addClient(suspended, "approved");
    const pending = await newTenant();
    await addClient(pending, "pending");
    const idle = await newTenant();
    const already = await newTenant({ modules: ["mcp", "accounting"] });
    await addClient(already, "approved");

    await runAsOwner(async (client) => {
      for (const id of [viaClient, viaToken]) {
        const view = await ownerView(client, id);
        expect(sorted(view.modules)).toEqual(sorted([...BASE_MODULES, "mcp"]));
        expect(count(view.modules, "mcp")).toBe(1);
        expect(view.audits).toHaveLength(1);
        const parsed = auditEventSchema.parse(view.audits[0]!.event);
        expect(parsed.tenantId).toBe(id);
        expect(parsed.actorType).toBe("system");
        expect(uuidToUlid(view.audits[0]!.id)).toBe(parsed.id);
      }
      for (const id of [otherPackage, suspended, pending, idle]) {
        const view = await ownerView(client, id);
        expect(view.modules).toEqual(BASE_MODULES);
        expect(view.audits).toHaveLength(0);
      }
      const view = await ownerView(client, already);
      expect(view.modules).toEqual(["mcp", "accounting"]);
      expect(view.audits).toHaveLength(0);
    });
  });

  it("MCPBF-15 production path: every changed tenant gets a distinct audit id", async () => {
    const first = await newTenant();
    await addClient(first, "approved");
    const second = await newTenant();
    await addClient(second, "approved");

    await runAsOwner(async (client) => {
      const a = await ownerView(client, first);
      const b = await ownerView(client, second);
      expect(a.audits).toHaveLength(1);
      expect(b.audits).toHaveLength(1);
      expect(a.audits[0]!.id).not.toBe(b.audits[0]!.id);
      expect(a.audits[0]!.tenant_id).toBe(first);
      expect(b.audits[0]!.tenant_id).toBe(second);
    });
  });
});
