// 864 / founder Q6 (15 Nov 2026): data migration 0378 switches on the
// `ai_assistant` module for tenants whose package includes it AND that already
// use AI, so a tenant that was using AI keeps working once the module becomes a
// real switch. Written fail-first from docs/briefs/864-sub-backfill.md and the
// pattern of cash-movement-mapping-backfill-migration.test.ts, not from the SQL.
//
// Rules under test (conservative: when in doubt, do not switch on):
// - A tenant gets the module only when ALL hold: tenants.status = 'active';
//   tenants.plan is the key of a platform_packages row with status 'active'
//   whose modules contain 'ai_assistant'; and it already used AI: an
//   ai_usage_events row with status 'ok' and channel 'tanya_ai' or 'mcp', OR an
//   ai_messages row with role 'user'.
// - Not evidence: usage on channel 'job', usage with status 'error' or
//   'blocked', assistant/tool messages.
// - Never: no package row, a retired package, a package without the module, an
//   archived or suspended tenant.
// - Only feature_flags.modules changes (module appended, others kept);
//   limits, plan and integrationProviders are untouched.
// - A tenant that already has the module is skipped: no change, no new audit.
// - One audit_logs row per changed tenant: actor system (no actor id), action
//   tenant.module_auto_enabled, object type tenant, object id the tenant.
// - Idempotent; tenants are independent of each other.
//
// Assumptions:
// - Migration file is `apps/api/drizzle/0378_ai_assistant_auto_enable.sql`,
//   replayed per tenant through helpers/migration-replay.ts (statement by
//   statement, as the runtime role with app.tenant_id set; FORCE RLS statements
//   are skipped by the helper). So the replay only ever sees the fixture tenant.
// - Audit rows are read from audit_logs.event (jsonb AuditEvent: actorType,
//   actorId, action, objectType, objectId, reason).
// - The reason text only has to mention "founder Q6"; the brief fixes the rest.
// - Fixtures (tenants, packages, users, usage rows) are left in place, like the
//   other data-migration tests.
// - ai_settings / provider / ChatGPT config rows being "not evidence" is stated
//   in the brief but not tested here (those tables need provider fixtures that
//   are out of this file's scope).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

const MIGRATION_FILE = "0378_ai_assistant_auto_enable.sql";
const migrationSql = () =>
  readFileSync(
    resolve(import.meta.dirname, "../../drizzle", MIGRATION_FILE),
    "utf8",
  );

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

type PackageKind = "ai" | "no_ai" | "retired_ai";

async function newPackage(kind: PackageKind): Promise<string> {
  const key = `p864${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await owner.query(
    `INSERT INTO platform_packages (key, name, modules, default_limits, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      key,
      `Paket uji 864 ${kind}`,
      JSON.stringify(
        kind === "no_ai"
          ? ["accounting", "inventory"]
          : ["accounting", "inventory", "ai_assistant"],
      ),
      JSON.stringify(LIMITS),
      kind === "retired_ai" ? "retired" : "active",
    ],
  );
  return key;
}

type TenantOptions = {
  plan: string;
  status?: "active" | "suspended" | "archived";
  modules?: string[];
};

async function newTenant(options: TenantOptions): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? "active";
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by, archived_at, status_before_archive)
     VALUES ($1, $2, 'Uji Auto AI', $3, $4, 'shared', $5, $6, $7, $8, $9)`,
    [
      id,
      `uji-ai864-${id.slice(0, 8)}`,
      options.plan,
      status,
      JSON.stringify({
        modules: options.modules ?? ["accounting", "inventory"],
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
    [id, "Pemakai AI 864", `${id}@example.com`],
  );
  return id;
}

async function addUsage(
  tenantId: string,
  channel: "tanya_ai" | "mcp" | "job",
  status: "ok" | "error" | "blocked",
): Promise<void> {
  const userId = await newUser();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO ai_usage_events (tenant_id, user_id, feature, channel, provider, model, status)
       VALUES ($1, $2, 'AI-01', $3, 'uji', 'uji-model', $4)`,
      [tenantId, userId, channel, status],
    ),
  );
}

async function addMessage(
  tenantId: string,
  role: "user" | "assistant" | "tool",
): Promise<void> {
  const userId = await newUser();
  await asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ai_conversations (tenant_id, owner_user_id, feature, title)
       VALUES ($1, $2, 'AI-01', 'Percakapan uji 864') RETURNING id`,
      [tenantId, userId],
    );
    await client.query(
      `INSERT INTO ai_messages (tenant_id, conversation_id, role, content, ai_assisted)
       VALUES ($1, $2, $3, 'isi uji', $4)`,
      [tenantId, rows[0]!.id, role, role === "assistant"],
    );
  });
}

type TenantRow = {
  plan: string;
  status: string;
  modules: string[];
  integrationProviders: string[];
  limits: unknown;
  featureFlags: unknown;
};

async function tenantOf(tenantId: string): Promise<TenantRow> {
  const { rows } = await owner.query<{
    plan: string;
    status: string;
    feature_flags: { modules: string[]; integrationProviders: string[] };
    limits: unknown;
  }>("SELECT plan, status, feature_flags, limits FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  const row = rows[0]!;
  return {
    plan: row.plan,
    status: row.status,
    modules: row.feature_flags.modules,
    integrationProviders: row.feature_flags.integrationProviders,
    limits: row.limits,
    featureFlags: row.feature_flags,
  };
}

type AuditEventRow = {
  actorType: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  reason: string | null;
};

async function autoEnableAudits(tenantId: string): Promise<AuditEventRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ event: AuditEventRow }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'tenant.module_auto_enabled'`,
      [tenantId],
    );
    return rows.map((row) => row.event);
  });
}

const count = (modules: string[], key: string) =>
  modules.filter((m) => m === key).length;

/** Asserts the tenant is exactly as seeded: nothing switched on, no audit. */
async function expectUntouched(tenantId: string, plan: string): Promise<void> {
  const tenant = await tenantOf(tenantId);
  expect(tenant.modules).toEqual(["accounting", "inventory"]);
  expect(tenant.plan).toBe(plan);
  expect(tenant.limits).toEqual(LIMITS);
  expect(tenant.integrationProviders).toEqual(PROVIDERS);
  expect(await autoEnableAudits(tenantId)).toHaveLength(0);
}

describe("864 migration 0378 ai_assistant auto enable", () => {
  beforeAll(() => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
  });

  afterAll(async () => {
    await owner.end();
  });

  it("MIG-01 an AI-package tenant with an ok Tanya AI call gets the module, keeps its other modules, limits, plan and providers, and gets one system audit row", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan });
    await addUsage(tenantId, "tanya_ai", "ok");

    await migrate(tenantId);

    const tenant = await tenantOf(tenantId);
    expect(tenant.modules).toEqual(["accounting", "inventory", "ai_assistant"]);
    expect(tenant.plan).toBe(plan);
    expect(tenant.status).toBe("active");
    expect(tenant.limits).toEqual(LIMITS);
    expect(tenant.integrationProviders).toEqual(PROVIDERS);
    expect(Object.keys(tenant.featureFlags as object).sort()).toEqual([
      "integrationProviders",
      "modules",
    ]);

    const audits = await autoEnableAudits(tenantId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      action: "tenant.module_auto_enabled",
      objectType: "tenant",
      objectId: tenantId,
    });
    expect(audits[0]!.reason).toContain("founder Q6");

    // The raw-SQL row must be a valid AuditEvent, its id the ULID text of the
    // audit_logs.id column, and the masked change must show the module list.
    const parsed = auditEventSchema.parse(audits[0]);
    const { rows } = await asTenant(tenantId, (client) =>
      client.query<{ id: string }>(
        "SELECT id FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'tenant.module_auto_enabled'",
        [tenantId],
      ),
    );
    expect(uuidToUlid(rows[0]!.id)).toBe(parsed.id);
    expect(parsed.maskedChanges).toEqual({
      before: { modules: ["accounting", "inventory"] },
      after: { modules: ["accounting", "inventory", "ai_assistant"] },
    });
  });

  it("MIG-11 run as the migration owner over several tenants, each qualifying tenant gets its own distinct audit id", async () => {
    const plan = await newPackage("ai");
    const first = await newTenant({ plan });
    const second = await newTenant({ plan });
    await addUsage(first, "tanya_ai", "ok");
    await addUsage(second, "mcp", "ok");

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE public.tenants IN SHARE MODE");
      for (const statement of migrationSql().split(
        "--> statement-breakpoint",
      )) {
        if (statement.replace(/--.*$/gm, "").trim())
          await client.query(statement);
      }
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        event: unknown;
      }>(
        `SELECT id, tenant_id, event FROM audit_logs
          WHERE tenant_id = ANY($1) AND event->>'action' = 'tenant.module_auto_enabled'`,
        [[first, second]],
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
      for (const row of rows) {
        const parsed = auditEventSchema.parse(row.event);
        expect(parsed.tenantId).toBe(row.tenant_id);
        expect(uuidToUlid(row.id)).toBe(parsed.id);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("MIG-01b an ok MCP call counts as use", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan, modules: [] });
    await addUsage(tenantId, "mcp", "ok");

    await migrate(tenantId);

    expect((await tenantOf(tenantId)).modules).toEqual(["ai_assistant"]);
    expect(await autoEnableAudits(tenantId)).toHaveLength(1);
  });

  it("MIG-01c a user message in a conversation counts as use, with no usage event at all", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan });
    await addMessage(tenantId, "user");

    await migrate(tenantId);

    expect((await tenantOf(tenantId)).modules).toEqual([
      "accounting",
      "inventory",
      "ai_assistant",
    ]);
    expect(await autoEnableAudits(tenantId)).toHaveLength(1);
  });

  it("MIG-02 an AI-package tenant that never used AI stays as it is", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan });

    await migrate(tenantId);

    await expectUntouched(tenantId, plan);
  });

  it("MIG-02b only assistant or tool messages are not use", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan });
    await addMessage(tenantId, "assistant");
    await addMessage(tenantId, "tool");

    await migrate(tenantId);

    await expectUntouched(tenantId, plan);
  });

  it("MIG-03 a tenant that used AI but whose package has no ai_assistant stays as it is", async () => {
    const plan = await newPackage("no_ai");
    const tenantId = await newTenant({ plan });
    await addUsage(tenantId, "tanya_ai", "ok");
    await addMessage(tenantId, "user");

    await migrate(tenantId);

    await expectUntouched(tenantId, plan);
  });

  it("MIG-03b a tenant whose plan matches no package row stays as it is", async () => {
    const plan = `x864${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const tenantId = await newTenant({ plan });
    await addUsage(tenantId, "tanya_ai", "ok");

    await migrate(tenantId);

    await expectUntouched(tenantId, plan);
  });

  it.each([
    ["a background job call", "job", "ok"],
    ["a failed Tanya AI call", "tanya_ai", "error"],
    ["a blocked Tanya AI call", "tanya_ai", "blocked"],
    ["a failed MCP call", "mcp", "error"],
    ["a blocked MCP call", "mcp", "blocked"],
  ] as const)(
    "MIG-04 %s is not use: the tenant stays as it is",
    async (_label, channel, status) => {
      const plan = await newPackage("ai");
      const tenantId = await newTenant({ plan });
      await addUsage(tenantId, channel, status);

      await migrate(tenantId);

      await expectUntouched(tenantId, plan);
    },
  );

  it("MIG-05 a retired package does not switch the module on, even for a tenant that used AI", async () => {
    const plan = await newPackage("retired_ai");
    const tenantId = await newTenant({ plan });
    await addUsage(tenantId, "tanya_ai", "ok");

    await migrate(tenantId);

    await expectUntouched(tenantId, plan);
  });

  it.each(["archived", "suspended"] as const)(
    "MIG-06 a %s tenant that used AI stays as it is",
    async (status) => {
      const plan = await newPackage("ai");
      const tenantId = await newTenant({ plan, status });
      await addUsage(tenantId, "tanya_ai", "ok");

      await migrate(tenantId);

      const tenant = await tenantOf(tenantId);
      expect(tenant.status).toBe(status);
      expect(tenant.modules).toEqual(["accounting", "inventory"]);
      expect(await autoEnableAudits(tenantId)).toHaveLength(0);
    },
  );

  it("MIG-07 a tenant that already has the module is skipped: flags unchanged, no new audit", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({
      plan,
      modules: ["ai_assistant", "accounting"],
    });
    await addUsage(tenantId, "tanya_ai", "ok");

    await migrate(tenantId);

    const tenant = await tenantOf(tenantId);
    expect(tenant.modules).toEqual(["ai_assistant", "accounting"]);
    expect(tenant.integrationProviders).toEqual(PROVIDERS);
    expect(tenant.limits).toEqual(LIMITS);
    expect(await autoEnableAudits(tenantId)).toHaveLength(0);
  });

  it("MIG-08 is idempotent: running it twice leaves one module entry and one audit row", async () => {
    const plan = await newPackage("ai");
    const tenantId = await newTenant({ plan });
    await addUsage(tenantId, "tanya_ai", "ok");

    await migrate(tenantId);
    const once = await tenantOf(tenantId);
    await migrate(tenantId);
    await migrate(tenantId);

    const twice = await tenantOf(tenantId);
    expect(count(twice.modules, "ai_assistant")).toBe(1);
    expect(twice.featureFlags).toEqual(once.featureFlags);
    expect(await autoEnableAudits(tenantId)).toHaveLength(1);
  });

  it("MIG-09 tenants are independent: the tenant that used AI is switched on, a same-package tenant that did not is not", async () => {
    const plan = await newPackage("ai");
    const user = await newTenant({ plan });
    const idle = await newTenant({ plan });
    await addUsage(user, "tanya_ai", "ok");

    await migrate(user);
    await migrate(idle);

    expect(count((await tenantOf(user)).modules, "ai_assistant")).toBe(1);
    expect(await autoEnableAudits(user)).toHaveLength(1);
    await expectUntouched(idle, plan);
  });

  it("MIG-09b usage of another tenant is never counted for this tenant", async () => {
    const plan = await newPackage("ai");
    const user = await newTenant({ plan });
    const idle = await newTenant({ plan });
    await addUsage(user, "mcp", "ok");
    await addMessage(user, "user");

    await migrate(idle);

    await expectUntouched(idle, plan);
  });

  it("MIG-10 FORCE row level security stays on for the tables the migration reads or writes, and the file lifts and restores it", async () => {
    const tables = ["audit_logs", "ai_usage_events", "ai_messages"];
    const { rows } = await owner.query<{
      relname: string;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace`,
      [tables],
    );
    expect(rows).toHaveLength(tables.length);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);

    // The migration lifts FORCE to read these tables as the migration owner and
    // must put it back (pattern 0360): per table the last FORCE statement is the
    // restoring one, never NO FORCE.
    const sql = migrationSql();
    for (const table of tables) {
      const statements = [
        ...sql.matchAll(
          new RegExp(
            `ALTER\\s+TABLE\\s+(?:public\\.)?"?${table}"?\\s+(NO\\s+FORCE|FORCE)\\s+ROW\\s+LEVEL\\s+SECURITY`,
            "gi",
          ),
        ),
      ].map((match) => match[1]!.replace(/\s+/g, " ").toUpperCase());
      expect(statements.length, `${table} lifted and restored`).toBeGreaterThan(
        0,
      );
      expect(statements.at(-1), `${table} ends FORCE`).toBe("FORCE");
    }
  });
});
