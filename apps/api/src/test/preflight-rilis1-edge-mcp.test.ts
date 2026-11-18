import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrationHash,
  parsePreflightFile,
  runReleaseGates,
} from "../db/release-gates";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const tenantId = "10000000-0000-4000-8000-000000000001";
const tables = [
  "tenants",
  "platform_packages",
  "mcp_clients",
  "mcp_tokens",
  "edge_nodes",
] as const;
const mcpFile = "rilis1-legend-176r3.sql";
const mcpText = readFileSync(
  new URL(`../../../../scripts/preflight/${mcpFile}`, import.meta.url),
  "utf8",
);
const deployment = readFileSync(
  new URL("../../../../docs/deployment.md", import.meta.url),
  "utf8",
);

type Fixture = {
  client: PoolClient;
  table: (name: (typeof tables)[number]) => string;
  run: () => ReturnType<typeof runReleaseGates>;
};

async function fixture(
  gateText: string,
  run: (fixture: Fixture) => Promise<void>,
) {
  const suffix = randomBytes(6).toString("hex");
  const schema = `rg1122_${suffix}`;
  const table = (name: (typeof tables)[number]) => `public.${name}_${suffix}`;
  const gate = parsePreflightFile("rilis1-fixture.sql", gateText);
  const dir = mkdtempSync(join(tmpdir(), "release-edge-mcp-"));
  const migrationsFolder = join(dir, "drizzle");
  const preflightDir = join(dir, "preflight");
  const baseSql = "SELECT 1;\n";
  mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
  mkdirSync(preflightDir);
  const entries = [
    { idx: 0, tag: "0000_fixture", when: 1_700_000_000_000 },
    ...(gate.before
      ? [{ idx: 1, tag: gate.before, when: 1_700_000_100_000 }]
      : []),
  ];
  writeFileSync(
    join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({ entries }),
  );
  for (const entry of entries)
    writeFileSync(join(migrationsFolder, `${entry.tag}.sql`), baseSql);
  writeFileSync(join(preflightDir, "drift-allow.json"), "[]");
  // Only table identifiers change. The production SELECT and its header remain
  // otherwise unchanged; no production rows or migration history are touched.
  const remapped = gateText.replace(
    /\b(public\.)?(tenants|platform_packages|mcp_clients|mcp_tokens|edge_nodes)\b/g,
    (_match, qualified: string | undefined, name: (typeof tables)[number]) =>
      `${qualified ?? ""}${name}_${suffix}`,
  );
  writeFileSync(join(preflightDir, "rilis1-fixture.sql"), remapped);
  const client = await owner.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(
      `CREATE TABLE ${schema}.__drizzle_migrations (hash text NOT NULL, created_at bigint NOT NULL)`,
    );
    await client.query(
      `INSERT INTO ${schema}.__drizzle_migrations VALUES ($1, $2)`,
      [migrationHash(baseSql), entries[0]!.when],
    );
    await client.query(
      `CREATE TABLE ${table("tenants")} (id uuid PRIMARY KEY, plan text, status text, feature_flags jsonb)`,
    );
    await client.query(
      `CREATE TABLE ${table("platform_packages")} (key text PRIMARY KEY, status text, modules jsonb)`,
    );
    await client.query(
      `CREATE TABLE ${table("mcp_clients")} (tenant_id uuid, status text)`,
    );
    await client.query(
      `CREATE TABLE ${table("mcp_tokens")} (tenant_id uuid, revoked_at timestamptz, expires_at timestamptz)`,
    );
    await client.query(
      `CREATE TABLE ${table("edge_nodes")} (id uuid, tenant_id uuid, outlet_id uuid, role text, status text, version text, last_heartbeat_at timestamptz)`,
    );
    await run({
      client,
      table,
      run: () =>
        runReleaseGates(client, {
          migrationsFolder,
          preflightDir,
          migrationsSchema: schema,
        }),
    });
  } finally {
    for (const name of tables)
      await client.query(`DROP TABLE IF EXISTS ${table(name)}`);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mcpUser(
  { client, table }: Fixture,
  modules: unknown,
  missingPackage = false,
) {
  await client.query(
    `INSERT INTO ${table("tenants")} VALUES ($1, 'basic', 'active', '{"modules":[]}')`,
    [tenantId],
  );
  if (!missingPackage)
    await client.query(
      `INSERT INTO ${table("platform_packages")} VALUES ('basic', 'active', $1::jsonb)`,
      [modules === undefined ? null : JSON.stringify(modules)],
    );
  await client.query(
    `INSERT INTO ${table("mcp_clients")} VALUES ($1, 'approved')`,
    [tenantId],
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});
afterAll(async () => {
  await owner.end();
});

describe("[legend-176r3] actual MCP release gate through the runner", () => {
  it("passes with zero blockers", async () => {
    await fixture(mcpText, async (f) => {
      await mcpUser(f, ["mcp"]);
      expect(await f.run()).toMatchObject({
        status: "ok",
        ran: ["legend-176r3"],
        skipped: [],
      });
    });
  });
  for (const [label, modules, missingPackage] of [
    ["package without mcp", [], false],
    ["SQL null modules", undefined, false],
    ["JSON null modules", null, false],
    ["object with a false mcp key", { mcp: false }, false],
    ["scalar modules", "mcp", false],
    ["unknown package", [], true],
  ] as const) {
    it(`blocks one MCP user with ${label}`, async () => {
      await fixture(mcpText, async (f) => {
        await mcpUser(f, modules, missingPackage);
        await expect(f.run()).rejects.toThrow("legend-176r3 (1 baris)");
      });
    });
  }
  it("blocks an active token without any approved client", async () => {
    await fixture(mcpText, async (f) => {
      await mcpUser(f, []);
      await f.client.query(`DELETE FROM ${f.table("mcp_clients")}`);
      await f.client.query(
        `INSERT INTO ${f.table("mcp_tokens")} VALUES ($1, NULL, '2999-01-01')`,
        [tenantId],
      );
      await expect(f.run()).rejects.toThrow("legend-176r3 (1 baris)");
    });
  });
  it("passes expired and revoked tokens without an approved client", async () => {
    await fixture(mcpText, async (f) => {
      await mcpUser(f, []);
      await f.client.query(`DELETE FROM ${f.table("mcp_clients")}`);
      await f.client.query(
        `INSERT INTO ${f.table("mcp_tokens")} VALUES ($1, NULL, '2000-01-01'), ($1, now(), '2999-01-01')`,
        [tenantId],
      );
      expect(await f.run()).toMatchObject({
        status: "ok",
        ran: ["legend-176r3"],
      });
    });
  });
  for (const status of ["pending", "revoked"]) {
    it(`passes a ${status} client without an active token`, async () => {
      await fixture(mcpText, async (f) => {
        await mcpUser(f, []);
        await f.client.query(
          `UPDATE ${f.table("mcp_clients")} SET status = $1`,
          [status],
        );
        expect(await f.run()).toMatchObject({
          status: "ok",
          ran: ["legend-176r3"],
        });
      });
    });
  }
  it("passes an inactive tenant despite approved MCP use", async () => {
    await fixture(mcpText, async (f) => {
      await mcpUser(f, []);
      await f.client.query(
        `UPDATE ${f.table("tenants")} SET status = 'suspended'`,
      );
      expect(await f.run()).toMatchObject({
        status: "ok",
        ran: ["legend-176r3"],
      });
    });
  });
  it("reports N/A only when a required table is absent", async () => {
    await fixture(mcpText, async (f) => {
      await f.client.query(`DROP TABLE ${f.table("mcp_tokens")}`);
      expect(await f.run()).toMatchObject({
        status: "ok",
        ran: [],
        skipped: [{ gate: "legend-176r3", reason: "requires-missing" }],
      });
    });
  });
  it("blocks when a required column is absent", async () => {
    await fixture(mcpText, async (f) => {
      await f.client.query(
        `ALTER TABLE ${f.table("mcp_tokens")} DROP COLUMN expires_at`,
      );
      await expect(f.run()).rejects.toThrow(
        "Gerbang legend-176r3 gagal dijalankan (SQL error).",
      );
    });
  });
});

// The edge gates are operator gates. These tests execute the documented
// inventory unchanged under the runner's read-only transaction to prove its
// 0/1/missing-table semantics. They do not turn provenance into a version test.
for (const gateId of ["legend-ir8n8", "legend-zn3wl"]) {
  describe(`[${gateId}] documented edge inventory`, () => {
    const inventory = [...deployment.matchAll(/```sql\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((sql) => sql && /\bFROM\s+(?:public\.)?edge_nodes\b/i.test(sql));
    function gateText() {
      if (!inventory)
        throw new Error("Missing documented edge inventory SELECT");
      return `-- gate: ${gateId}\n-- before: none\n-- requires: public.edge_nodes\n-- mode: block\n-- resolve: Verifikasi build edge setiap node sebelum cloud mengirim field baru.\n${inventory}\n`;
    }
    it("passes with no active nodes", async () => {
      expect(inventory, "documented inventory query").toBeDefined();
      await fixture(gateText(), async (f) => {
        expect(await f.run()).toMatchObject({
          status: "ok",
          ran: [gateId],
          skipped: [],
        });
      });
    });
    for (const version of ["unknown", "0.2.0"]) {
      it(`blocks one unresolved offline standby at version ${version}`, async () => {
        await fixture(gateText(), async (f) => {
          await f.client.query(
            `INSERT INTO ${f.table("edge_nodes")} VALUES ($1, $1, $1, 'standby', 'active', $2, NULL)`,
            [tenantId, version],
          );
          await expect(f.run()).rejects.toThrow(`${gateId} (1 baris)`);
        });
      });
    }
    it("skips a revoked node", async () => {
      await fixture(gateText(), async (f) => {
        await f.client.query(
          `INSERT INTO ${f.table("edge_nodes")} VALUES ($1, $1, $1, 'primary', 'revoked', 'unknown', NULL)`,
          [tenantId],
        );
        expect(await f.run()).toMatchObject({ status: "ok", ran: [gateId] });
      });
    });
    it("reports N/A when the inventory table is absent", async () => {
      await fixture(gateText(), async (f) => {
        await f.client.query(`DROP TABLE ${f.table("edge_nodes")}`);
        expect(await f.run()).toMatchObject({
          status: "ok",
          ran: [],
          skipped: [{ gate: gateId, reason: "requires-missing" }],
        });
      });
    });
    it("blocks when the version column is absent", async () => {
      await fixture(gateText(), async (f) => {
        await f.client.query(
          `ALTER TABLE ${f.table("edge_nodes")} DROP COLUMN version`,
        );
        await expect(f.run()).rejects.toThrow(
          `Gerbang ${gateId} gagal dijalankan (SQL error).`,
        );
      });
    });
  });
}
