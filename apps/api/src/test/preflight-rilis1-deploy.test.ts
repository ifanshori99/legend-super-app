// legend-1100: rilis 1 data gates for legend-176r3 (MCP users on a package
// without mcp) and legend-oh2a5 (tenants that 0378 will switch on). Each gate
// runs unchanged against temporary shadow tables that carry only the columns
// the gate reads, so the pre-migration state is reproduced without touching
// public data. A separate test proves those columns exist in the real schema.
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function gateSql(name: string) {
  return readFileSync(
    new URL(`../../../../scripts/preflight/${name}`, import.meta.url),
    "utf8",
  );
}

const mcpSql = gateSql("rilis1-legend-176r3.sql");
const aiSql = gateSql("rilis1-legend-oh2a5.sql");
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "10000000-0000-4000-8000-000000000002";
const tenantC = "10000000-0000-4000-8000-000000000003";

async function shadowed(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE tenants (
        id uuid PRIMARY KEY, plan text NOT NULL, status text NOT NULL,
        feature_flags jsonb NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE platform_packages (
        key text PRIMARY KEY, status text NOT NULL, modules jsonb NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE mcp_clients (
        id serial PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE mcp_tokens (
        id serial PRIMARY KEY, tenant_id uuid NOT NULL,
        revoked_at timestamptz, expires_at timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE ai_usage_events (
        id serial PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL,
        channel text NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE ai_messages (
        id serial PRIMARY KEY, tenant_id uuid NOT NULL, role text NOT NULL
      ) ON COMMIT DROP;
    `);
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function addPackage(
  client: PoolClient,
  key: string,
  modules: string[],
  status = "active",
) {
  await client.query(
    "INSERT INTO platform_packages (key, status, modules) VALUES ($1, $2, $3)",
    [key, status, JSON.stringify(modules)],
  );
}

async function addTenant(
  client: PoolClient,
  id: string,
  plan: string,
  opts: { status?: string; modules?: unknown } = {},
) {
  await client.query(
    "INSERT INTO tenants (id, plan, status, feature_flags) VALUES ($1, $2, $3, $4)",
    [
      id,
      plan,
      opts.status ?? "active",
      JSON.stringify({ modules: opts.modules ?? [], integrationProviders: [] }),
    ],
  );
}

const addClient = (client: PoolClient, tenantId: string, status: string) =>
  client.query("INSERT INTO mcp_clients (tenant_id, status) VALUES ($1, $2)", [
    tenantId,
    status,
  ]);

const addToken = (
  client: PoolClient,
  tenantId: string,
  opts: { revoked?: boolean; expires?: string } = {},
) =>
  client.query(
    `INSERT INTO mcp_tokens (tenant_id, revoked_at, expires_at)
     VALUES ($1, CASE WHEN $2::boolean THEN now() END, $3::timestamptz)`,
    [tenantId, opts.revoked ?? false, opts.expires ?? "2999-01-01T00:00:00Z"],
  );

const addUsage = (
  client: PoolClient,
  tenantId: string,
  status: string,
  channel: string,
) =>
  client.query(
    "INSERT INTO ai_usage_events (tenant_id, status, channel) VALUES ($1, $2, $3)",
    [tenantId, status, channel],
  );

const addMessage = (client: PoolClient, tenantId: string, role: string) =>
  client.query("INSERT INTO ai_messages (tenant_id, role) VALUES ($1, $2)", [
    tenantId,
    role,
  ]);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-176r3] MCP users on a package without mcp", () => {
  it("[legend-176r3] lists an active tenant with an approved client or an active token", async () => {
    await shadowed(async (client) => {
      await addPackage(client, "basic", ["pos"]);
      await addTenant(client, tenantA, "basic");
      await addTenant(client, tenantB, "basic");
      await addClient(client, tenantA, "approved");
      await addClient(client, tenantA, "approved");
      await addToken(client, tenantB);
      const rows = (await client.query(mcpSql)).rows;
      expect(rows).toEqual([
        {
          tenant_id: tenantA,
          approved_client_count: "2",
          active_token_count: "0",
        },
        {
          tenant_id: tenantB,
          approved_client_count: "0",
          active_token_count: "1",
        },
      ]);
    });
  });

  it("[legend-176r3] lists a tenant whose package row is missing", async () => {
    await shadowed(async (client) => {
      await addTenant(client, tenantA, "gone");
      await addClient(client, tenantA, "approved");
      const rows = (await client.query(mcpSql)).rows;
      expect(rows.map((row) => row.tenant_id)).toEqual([tenantA]);
    });
  });

  it("[legend-176r3] returns no rows for clean data", async () => {
    await shadowed(async (client) => {
      await addPackage(client, "basic", ["pos"]);
      await addPackage(client, "pro", ["pos", "mcp"]);
      // package with mcp: 0456 turns the flag on, so nothing is lost.
      await addTenant(client, tenantA, "pro");
      await addClient(client, tenantA, "approved");
      // no MCP use, pending or revoked client, revoked or expired token.
      await addTenant(client, tenantB, "basic");
      await addClient(client, tenantB, "pending");
      await addClient(client, tenantB, "revoked");
      await addToken(client, tenantB, { revoked: true });
      await addToken(client, tenantB, { expires: "2000-01-01T00:00:00Z" });
      // inactive tenant with MCP use is not a release concern.
      await addTenant(client, tenantC, "basic", { status: "suspended" });
      await addClient(client, tenantC, "approved");
      expect((await client.query(mcpSql)).rows).toEqual([]);
    });
  });

  it("[legend-176r3] output carries ids and counts only", async () => {
    await shadowed(async (client) => {
      await addPackage(client, "basic", ["pos"]);
      await addTenant(client, tenantA, "basic");
      await addClient(client, tenantA, "approved");
      const result = await client.query(mcpSql);
      expect(result.fields.map((field) => field.name)).toEqual([
        "tenant_id",
        "approved_client_count",
        "active_token_count",
      ]);
    });
  });
});

describe("[legend-oh2a5] tenants that migration 0378 will switch on", () => {
  it("[legend-oh2a5] counts only tenants the 0378 predicate selects", async () => {
    await shadowed(async (client) => {
      await addPackage(client, "ai", ["ai_assistant"]);
      await addPackage(client, "retired-ai", ["ai_assistant"], "retired");
      await addPackage(client, "basic", ["pos"]);
      // eligible: ok usage on tanya_ai.
      await addTenant(client, tenantA, "ai");
      await addUsage(client, tenantA, "ok", "tanya_ai");
      // eligible: user message only.
      await addTenant(client, tenantB, "ai");
      await addMessage(client, tenantB, "user");
      // eligible: ok usage on mcp.
      await addTenant(client, tenantC, "ai");
      await addUsage(client, tenantC, "ok", "mcp");
      const rows = (await client.query(aiSql)).rows;
      expect(rows).toEqual([
        { tenant_id: tenantA },
        { tenant_id: tenantB },
        { tenant_id: tenantC },
      ]);
    });
  });

  it("[legend-oh2a5] skips every tenant 0378 leaves alone", async () => {
    await shadowed(async (client) => {
      await addPackage(client, "ai", ["ai_assistant"]);
      await addPackage(client, "retired-ai", ["ai_assistant"], "retired");
      await addPackage(client, "basic", ["pos"]);
      const ids = [
        "10000000-0000-4000-8000-000000000011",
        "10000000-0000-4000-8000-000000000012",
        "10000000-0000-4000-8000-000000000013",
        "10000000-0000-4000-8000-000000000014",
        "10000000-0000-4000-8000-000000000015",
        "10000000-0000-4000-8000-000000000016",
        "10000000-0000-4000-8000-000000000017",
      ];
      // inactive tenant.
      await addTenant(client, ids[0]!, "ai", { status: "suspended" });
      await addUsage(client, ids[0]!, "ok", "tanya_ai");
      // retired package.
      await addTenant(client, ids[1]!, "retired-ai");
      await addUsage(client, ids[1]!, "ok", "tanya_ai");
      // package without ai_assistant.
      await addTenant(client, ids[2]!, "basic");
      await addUsage(client, ids[2]!, "ok", "tanya_ai");
      // module already on.
      await addTenant(client, ids[3]!, "ai", { modules: ["ai_assistant"] });
      await addUsage(client, ids[3]!, "ok", "tanya_ai");
      // usage that is not real use: job channel, error, blocked.
      await addTenant(client, ids[4]!, "ai");
      await addUsage(client, ids[4]!, "ok", "job");
      await addUsage(client, ids[4]!, "error", "tanya_ai");
      await addUsage(client, ids[4]!, "blocked", "mcp");
      // only an assistant message, no user message.
      await addTenant(client, ids[5]!, "ai");
      await addMessage(client, ids[5]!, "assistant");
      // modules is not an array.
      await addTenant(client, ids[6]!, "ai", { modules: {} });
      await addUsage(client, ids[6]!, "ok", "tanya_ai");
      expect((await client.query(aiSql)).rows).toEqual([]);
    });
  });

  it("[legend-oh2a5] returns no rows and only the tenant id column", async () => {
    await shadowed(async (client) => {
      const result = await client.query(aiSql);
      expect(result.rows).toEqual([]);
      expect(result.fields.map((field) => field.name)).toEqual(["tenant_id"]);
    });
  });
});

describe("[legend-1100] rilis 1 gate headers and columns", () => {
  it("[legend-1100] gate files carry the 1100 header order", () => {
    for (const [name, gate, before, mode] of [
      [
        "rilis1-legend-176r3.sql",
        "legend-176r3",
        "0456_mcp_flag_backfill",
        "block",
      ],
      [
        "rilis1-legend-oh2a5.sql",
        "legend-oh2a5",
        "0378_ai_assistant_auto_enable",
        "info",
      ],
    ] as const) {
      const lines = gateSql(name).split("\n");
      expect(lines[0]).toBe(`-- gate: ${gate}`);
      expect(lines[1]).toBe(`-- before: ${before}`);
      expect(lines[2]).toMatch(/^-- requires: public\.\w+(, public\.\w+)*$/);
      expect(lines[3]).toBe(`-- mode: ${mode}`);
      expect(lines[4]).toMatch(/^-- resolve: .+/);
    }
  });

  it("[legend-1100] columns the gates read exist in the migrated schema", async () => {
    const wanted: Record<string, string[]> = {
      tenants: ["id", "plan", "status", "feature_flags"],
      platform_packages: ["key", "status", "modules"],
      mcp_clients: ["tenant_id", "status"],
      mcp_tokens: ["tenant_id", "revoked_at", "expires_at"],
      ai_usage_events: ["tenant_id", "status", "channel"],
      ai_messages: ["tenant_id", "role"],
    };
    const result = await owner.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [Object.keys(wanted)],
    );
    for (const [table, columns] of Object.entries(wanted)) {
      const present = result.rows
        .filter((row) => row.table_name === table)
        .map((row) => row.column_name);
      expect(present, table).toEqual(expect.arrayContaining(columns));
    }
  });
});
