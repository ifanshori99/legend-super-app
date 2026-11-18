// legend-1100: release gate 1 runner (apps/api/src/db/release-gates.ts).
// Everything runs against throwaway fixtures: a unique schema holding a fake
// __drizzle_migrations table, a temp migrations folder (fake journal + .sql)
// and a temp preflight dir. The real migration state is never touched.
//
// Assumptions (spec is silent):
//  - `ran` lists gate ids (same vocabulary as `skipped[].gate`).
//  - With a missing/empty migrations table the runner returns n/a before it
//    parses any preflight file (brief step 1 comes before step 3).
//  - Per runner-fix brief: `appSchemaProbe` (default "public.tenants") decides
//    whether an empty migrations table means a fresh DB. N/A tests pass a
//    probe that does not exist; the "app schema present" test passes a real one.
//  - Drift allow-list defaults to `<preflightDir>/drift-allow.json`; beforeEach
//    writes `[]` there. `checkMigrationDrift` is not used for allow-list tests;
//    they go through `runReleaseGates` (the allow-list is read when gates run).
//  - A gate table is a real table in `public` with a unique name; gate SQL uses
//    the bare name (the runner sets search_path = public).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  checkMigrationDrift,
  migrationHash,
  parsePreflightFile,
  ReleaseGateError,
  readJournal,
  runReleaseGates,
} from "../db/release-gates";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

const suffix = randomBytes(4).toString("hex");
const schema = `rg_${suffix}`;
const gateTable = `rg_items_${suffix}`;
const otherTable = `rg_other_${suffix}`;
const secretTenant = "tenant-sekret-0a1b2c";
const secretNote = "isi-baris-rahasia-9z8y7x";

const TAGS = ["0000_alpha", "0001_beta", "0002_gamma"] as const;
const WHENS = [1_700_000_000_000, 1_700_000_100_000, 1_700_000_200_000];

interface GateFile {
  name: string;
  gate: string;
  before?: string;
  requires?: string[];
  mode?: "block" | "info";
  resolve?: string;
  sql?: string;
}

let client: PoolClient;
let root: string;
let migrationsFolder: string;
let preflightDir: string;
let sqlTexts: string[];
let logs: string[];

function sqlFor(tag: string) {
  return `-- ${tag}\nSELECT 1;\n`;
}

function writeJournal(entries: { idx: number; tag: string; when: number }[]) {
  writeFileSync(
    join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((e) => ({ ...e, version: "7", breakpoints: true })),
    }),
  );
}

function writeGate(g: GateFile) {
  const text = [
    `-- gate: ${g.gate}`,
    `-- before: ${g.before ?? TAGS[2]}`,
    `-- requires: ${(g.requires ?? [`public.${gateTable}`]).join(", ")}`,
    `-- mode: ${g.mode ?? "block"}`,
    `-- resolve: ${g.resolve ?? "Perbaiki data lalu jalankan ulang."}`,
    g.sql ?? `SELECT id FROM ${gateTable}`,
    "",
  ].join("\n");
  writeFileSync(join(preflightDir, g.name), text);
}

async function insertApplied(indexes: number[]) {
  for (const i of indexes) {
    await client.query(
      `INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [createHash("sha256").update(sqlTexts[i]!).digest("hex"), WHENS[i]],
    );
  }
}

async function insertGateRows(n: number) {
  for (let i = 0; i < n; i += 1) {
    await client.query(
      `INSERT INTO public.${gateTable} (tenant_id, note) VALUES ($1, $2)`,
      [secretTenant, secretNote],
    );
  }
}

function opts() {
  return {
    migrationsFolder,
    preflightDir,
    migrationsSchema: schema,
    log: (line: string) => logs.push(line),
  };
}

const missingProbe = `public.rg_no_such_table_${suffix}`;
const oldHash = "a".repeat(64);

function naOpts() {
  return { ...opts(), appSchemaProbe: missingProbe };
}

function writeAllow(entries: unknown) {
  writeFileSync(
    join(preflightDir, "drift-allow.json"),
    typeof entries === "string" ? entries : JSON.stringify(entries),
  );
}

async function insertRow(hash: string, createdAt: number) {
  await client.query(
    `INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
    [hash, createdAt],
  );
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseGateError);
    return (error as Error).message;
  }
  throw new Error("expected ReleaseGateError, but the call resolved");
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

beforeEach(async () => {
  client = await owner.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(
    `CREATE TABLE ${schema}.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  await client.query(
    `CREATE TABLE public.${gateTable} (id serial PRIMARY KEY, tenant_id text NOT NULL, note text NOT NULL)`,
  );
  root = mkdtempSync(join(tmpdir(), "release-gates-"));
  migrationsFolder = join(root, "drizzle");
  preflightDir = join(root, "preflight");
  mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
  mkdirSync(preflightDir);
  sqlTexts = TAGS.map(sqlFor);
  TAGS.forEach((tag, i) =>
    writeFileSync(join(migrationsFolder, `${tag}.sql`), sqlTexts[i]!),
  );
  writeJournal(TAGS.map((tag, idx) => ({ idx, tag, when: WHENS[idx]! })));
  writeFileSync(join(preflightDir, "drift-allow.json"), "[]");
  logs = [];
});

afterEach(async () => {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS public.${gateTable}`);
  await client.query(`DROP TABLE IF EXISTS public.${otherTable}`);
  client.release();
  rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-1100] migration hash and journal helpers", () => {
  it("[legend-1100] migrationHash is the sha256 hex of the whole file, like the drizzle migrator", () => {
    const text =
      "CREATE TABLE a (id int);\n--> statement-breakpoint\nSELECT 1;\n";
    expect(migrationHash(text)).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(migrationHash(`${text} `)).not.toBe(migrationHash(text));
  });

  it("[legend-1100] readJournal returns idx, tag and when for each entry", () => {
    expect(readJournal(migrationsFolder)).toEqual(
      TAGS.map((tag, idx) => ({ idx, tag, when: WHENS[idx] })),
    );
  });
});

describe("[legend-1100] parsePreflightFile", () => {
  const good = [
    "-- gate: legend-abc12",
    "-- before: 0002_gamma",
    "-- requires: public.tabel_a, public.tabel_b",
    "-- mode: info",
    "-- resolve: Satu kalimat.",
    "SELECT 1 AS n",
    "",
  ].join("\n");

  it("[legend-1100] parses a well-formed header", () => {
    const gate = parsePreflightFile("rilis1-legend-abc12.sql", good);
    expect(gate).toMatchObject({
      file: "rilis1-legend-abc12.sql",
      gate: "legend-abc12",
      before: "0002_gamma",
      requires: ["public.tabel_a", "public.tabel_b"],
      mode: "info",
      resolve: "Satu kalimat.",
    });
    expect(gate.sql).toContain("SELECT 1 AS n");
  });

  it("[legend-1100] before: none means no migration anchor", () => {
    const gate = parsePreflightFile(
      "rilis1-legend-abc12.sql",
      good.replace("before: 0002_gamma", "before: none"),
    );
    expect(gate.before).toBeNull();
  });

  it("[legend-1100] rejects a bad mode, swapped header order and a missing header line", () => {
    const bad = [
      good.replace("mode: info", "mode: warn"),
      good.replace(
        "-- mode: info\n-- resolve: Satu kalimat.",
        "-- resolve: Satu kalimat.\n-- mode: info",
      ),
      good.replace("-- resolve: Satu kalimat.\n", ""),
      good.replace("-- gate: legend-abc12\n", ""),
      "SELECT 1\n",
    ];
    for (const text of bad)
      expect(() => parsePreflightFile("rilis1-legend-abc12.sql", text)).toThrow(
        ReleaseGateError,
      );
  });
});

describe("[legend-1100] runReleaseGates: fresh database", () => {
  it("[legend-1100] returns n/a and logs N/A when __drizzle_migrations does not exist", async () => {
    await client.query(`DROP TABLE ${schema}.__drizzle_migrations`);
    const report = await runReleaseGates(client, naOpts());
    expect(report).toEqual({ status: "n/a" });
    expect(logs.join("\n")).toContain("gerbang data rilis 1: N/A (DB baru)");
  });

  it("[legend-1100] returns n/a when __drizzle_migrations has zero rows", async () => {
    writeGate({ name: "rilis1-legend-aaaaa.sql", gate: "legend-aaaaa" });
    await insertGateRows(2);
    const report = await runReleaseGates(client, naOpts());
    expect(report).toEqual({ status: "n/a" });
    expect(logs.join("\n")).toContain("gerbang data rilis 1: N/A (DB baru)");
  });

  it("[legend-1100] a fresh database skips drift and does not parse gate files", async () => {
    // Journal has a duplicate `when` (would be fail-closed on a live DB).
    writeJournal([
      { idx: 0, tag: TAGS[0], when: WHENS[0]! },
      { idx: 1, tag: TAGS[1], when: WHENS[0]! },
    ]);
    writeFileSync(join(preflightDir, "rilis1-legend-broken.sql"), "garbage");
    await expect(runReleaseGates(client, naOpts())).resolves.toEqual({
      status: "n/a",
    });
  });

  it("[legend-1100] fails when the migrations table is missing but the app schema exists", async () => {
    await client.query(`CREATE TABLE public.${otherTable} (id int)`);
    await client.query(`DROP TABLE ${schema}.__drizzle_migrations`);
    const message = await messageOf(
      runReleaseGates(client, {
        ...opts(),
        appSchemaProbe: `public.${otherTable}`,
      }),
    );
    expect(message).toContain(
      "tabel migrasi drizzle tidak ada/kosong padahal skema aplikasi ada",
    );
  });

  it("[legend-1100] fails when the migrations table is empty but the app schema exists", async () => {
    await client.query(`CREATE TABLE public.${otherTable} (id int)`);
    await expect(
      runReleaseGates(client, {
        ...opts(),
        appSchemaProbe: `public.${otherTable}`,
      }),
    ).rejects.toBeInstanceOf(ReleaseGateError);
  });
});

describe("[legend-1100] runReleaseGates: skipping", () => {
  it("[legend-1100] skips a gate whose before migration is already applied", async () => {
    await insertApplied([0, 1, 2]);
    await insertGateRows(3);
    writeGate({
      name: "rilis1-legend-bapp1.sql",
      gate: "legend-bapp1",
      before: TAGS[2],
    });
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({
      status: "ok",
      applied: 3,
      ran: [],
      skipped: [{ gate: "legend-bapp1", reason: "before-applied" }],
      info: [],
    });
    expect(logs.join("\n")).toContain(
      "gerbang legend-bapp1 dilewati (before-applied)",
    );
  });

  it("[legend-1100] skips a gate whose required table is missing", async () => {
    await insertApplied([0, 1]);
    writeGate({
      name: "rilis1-legend-rmis1.sql",
      gate: "legend-rmis1",
      requires: [`public.${gateTable}`, `public.${otherTable}`],
      sql: `SELECT id FROM ${gateTable}`,
    });
    await insertGateRows(2);
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({
      status: "ok",
      ran: [],
      skipped: [{ gate: "legend-rmis1", reason: "requires-missing" }],
    });
    expect(logs.join("\n")).toContain(
      "gerbang legend-rmis1 dilewati (requires-missing)",
    );
  });

  it("[legend-1100] only reads rilis1-*.sql: other files in the preflight dir are ignored", async () => {
    await insertApplied([0, 1]);
    writeFileSync(
      join(preflightDir, "0301-duplicate-subscriptions.sql"),
      "this is not a gate header",
    );
    writeFileSync(join(preflightDir, "README.md"), "not sql");
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({ status: "ok", ran: [], skipped: [] });
  });
});

describe("[legend-1100] runReleaseGates: block mode", () => {
  it("[legend-1100] fails with the gate id and the row count, without row contents", async () => {
    await insertApplied([0, 1]);
    await insertGateRows(3);
    writeGate({ name: "rilis1-legend-blk01.sql", gate: "legend-blk01" });
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("gerbang data rilis 1 gagal");
    expect(message).toContain("legend-blk01 (3 baris)");
    expect(message).toContain("docs/deployment.md#gerbang-rilis-1");
    expect(message).not.toContain(secretTenant);
    expect(message).not.toContain(secretNote);
  });

  it("[legend-1100] collects every failing gate before failing", async () => {
    await insertApplied([0, 1]);
    await insertGateRows(2);
    writeGate({ name: "rilis1-legend-blk01.sql", gate: "legend-blk01" });
    writeGate({
      name: "rilis1-legend-blk02.sql",
      gate: "legend-blk02",
      sql: `SELECT id FROM ${gateTable} LIMIT 1`,
    });
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("legend-blk01 (2 baris)");
    expect(message).toContain("legend-blk02 (1 baris)");
  });

  it("[legend-1100] passes when the block gate returns zero rows", async () => {
    await insertApplied([0, 1]);
    writeGate({ name: "rilis1-legend-blk01.sql", gate: "legend-blk01" });
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({
      status: "ok",
      applied: 2,
      ran: ["legend-blk01"],
      skipped: [],
      info: [],
    });
  });

  it("[legend-1100] leaves no data written and the connection usable after a failure", async () => {
    await insertApplied([0, 1]);
    await insertGateRows(1);
    writeGate({ name: "rilis1-legend-blk01.sql", gate: "legend-blk01" });
    await messageOf(runReleaseGates(client, opts()));
    const count = await client.query(
      `SELECT count(*)::int AS n FROM public.${gateTable}`,
    );
    expect(count.rows[0].n).toBe(1);
    // No transaction left open or aborted: a fresh BEGIN/ROLLBACK must work.
    await client.query("BEGIN");
    await client.query("ROLLBACK");
  });
});

describe("[legend-1100] runReleaseGates: info mode", () => {
  it("[legend-1100] logs the info row count and does not fail", async () => {
    await insertApplied([0, 1]);
    await insertGateRows(2);
    writeGate({
      name: "rilis1-legend-inf01.sql",
      gate: "legend-inf01",
      mode: "info",
    });
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({
      status: "ok",
      ran: ["legend-inf01"],
      info: [{ gate: "legend-inf01", rows: 2 }],
    });
    expect(logs.join("\n")).toContain("gerbang legend-inf01 (info): 2 baris");
  });
});

describe("[legend-1100] runReleaseGates: fail-closed", () => {
  it("[legend-1100] fails on a broken gate header", async () => {
    await insertApplied([0, 1]);
    writeFileSync(
      join(preflightDir, "rilis1-legend-bad01.sql"),
      "-- gate: legend-bad01\n-- mode: block\nSELECT 1\n",
    );
    await expect(runReleaseGates(client, opts())).rejects.toBeInstanceOf(
      ReleaseGateError,
    );
  });

  it("[legend-1100] fails when the before tag is not in the journal", async () => {
    await insertApplied([0, 1]);
    writeGate({
      name: "rilis1-legend-nob01.sql",
      gate: "legend-nob01",
      before: "9999_tidak_ada",
    });
    await expect(runReleaseGates(client, opts())).rejects.toBeInstanceOf(
      ReleaseGateError,
    );
  });

  it("[legend-1100] fails with the gate id only when the gate SQL errors", async () => {
    await insertApplied([0, 1]);
    writeGate({
      name: "rilis1-legend-sql01.sql",
      gate: "legend-sql01",
      sql: `SELECT 1 / (count(*) - count(*)) FROM ${gateTable}`,
    });
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("legend-sql01");
    expect(message).not.toMatch(/division by zero/i);
    expect(message).not.toContain(gateTable);
  });

  it("[legend-1100] fails with the gate id when the gate file holds more than one statement", async () => {
    await insertApplied([0, 1]);
    writeGate({
      name: "rilis1-legend-mul01.sql",
      gate: "legend-mul01",
      sql: "SELECT 1; SELECT 2",
    });
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("legend-mul01");
  });

  it("[legend-1100] fails when the gate tries to write (runs read-only)", async () => {
    await insertApplied([0, 1]);
    writeGate({
      name: "rilis1-legend-wrt01.sql",
      gate: "legend-wrt01",
      sql: `WITH w AS (INSERT INTO ${gateTable} (tenant_id, note) VALUES ('x', 'y') RETURNING id) SELECT id FROM w`,
    });
    await expect(runReleaseGates(client, opts())).rejects.toBeInstanceOf(
      ReleaseGateError,
    );
    const count = await client.query(
      `SELECT count(*)::int AS n FROM public.${gateTable}`,
    );
    expect(count.rows[0].n).toBe(0);
  });
});

describe("[legend-1100] migration drift (legend-fgg1h)", () => {
  it("[legend-1100] passes when every applied hash matches its journal entry", async () => {
    await insertApplied([0, 1, 2]);
    await expect(checkMigrationDrift(client, opts())).resolves.toEqual({
      applied: 3,
    });
    await expect(runReleaseGates(client, opts())).resolves.toMatchObject({
      status: "ok",
      applied: 3,
    });
  });

  it("[legend-1100] fails naming the tag whose hash differs", async () => {
    await insertApplied([0, 1]);
    await client.query(
      `INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [
        createHash("sha256").update("edited after apply").digest("hex"),
        WHENS[2],
      ],
    );
    const message = await messageOf(checkMigrationDrift(client, opts()));
    expect(message).toContain("drift migrasi (legend-fgg1h)");
    expect(message).toContain(TAGS[2]);
    expect(message).not.toContain(TAGS[0]);
    expect(message).not.toContain(TAGS[1]);
  });

  it("[legend-1100] fails with unknown@<created_at> when the journal does not know the row", async () => {
    await insertApplied([0, 1]);
    await client.query(
      `INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [migrationHash(sqlTexts[2]!), 1_699_999_999_999],
    );
    const message = await messageOf(checkMigrationDrift(client, opts()));
    expect(message).toContain("drift migrasi (legend-fgg1h)");
    expect(message).toContain("unknown@1699999999999");
  });

  it("[legend-1100] drift fails the whole run even when the gates would pass", async () => {
    await insertApplied([0]);
    await client.query(
      `INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      ["deadbeef", WHENS[1]],
    );
    writeGate({ name: "rilis1-legend-ok001.sql", gate: "legend-ok001" });
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("drift migrasi (legend-fgg1h)");
    expect(message).toContain(TAGS[1]);
  });

  it("[legend-1100] fails closed when the journal has a duplicate when", async () => {
    await insertApplied([0, 1]);
    writeJournal([
      { idx: 0, tag: TAGS[0], when: WHENS[0]! },
      { idx: 1, tag: TAGS[1], when: WHENS[0]! },
      { idx: 2, tag: TAGS[2], when: WHENS[2]! },
    ]);
    await expect(checkMigrationDrift(client, opts())).rejects.toBeInstanceOf(
      ReleaseGateError,
    );
  });
});

describe("[legend-1100] migration drift: missing rows", () => {
  it("[legend-1100] fails with missing:<tag> for a journal entry older than the newest applied row but absent from the DB", async () => {
    // 0001_beta (when below the newest applied created_at) was never applied:
    // drizzle would skip it forever.
    await insertApplied([0, 2]);
    const message = await messageOf(checkMigrationDrift(client, opts()));
    expect(message).toContain("drift migrasi (legend-fgg1h)");
    expect(message).toContain(`missing:${TAGS[1]}`);
    expect(message).not.toContain(`missing:${TAGS[0]}`);
    expect(message).not.toContain(`missing:${TAGS[2]}`);
  });

  it("[legend-1100] a journal entry newer than every applied row is pending, not missing", async () => {
    await insertApplied([0, 1]);
    await expect(checkMigrationDrift(client, opts())).resolves.toEqual({
      applied: 2,
    });
  });

  it("[legend-1100] missing:<tag> also fails the whole run", async () => {
    await insertApplied([0, 2]);
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain(`missing:${TAGS[1]}`);
  });
});

describe("[legend-1100] migration drift: allow-list", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    tag: TAGS[2],
    hash: oldHash,
    bead: "legend-abc12",
    reason: "hash lama dari edit sebelum rilis, sudah dikoreksi",
    ...over,
  });

  async function applyWithOldHash(hash = oldHash) {
    await insertApplied([0, 1]);
    await insertRow(hash, WHENS[2]!);
  }

  it("[legend-1100] accepts a row whose created_at and hash exactly match an allow-list entry, and logs it", async () => {
    await applyWithOldHash();
    writeAllow([entry()]);
    const report = await runReleaseGates(client, opts());
    expect(report).toMatchObject({ status: "ok", applied: 3 });
    expect(logs.join("\n")).toContain(
      `drift diizinkan: ${TAGS[2]} (legend-abc12)`,
    );
  });

  it("[legend-1100] still fails when the DB hash differs from the allow-listed hash", async () => {
    await applyWithOldHash("b".repeat(64));
    writeAllow([entry()]);
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("drift migrasi (legend-fgg1h)");
    expect(message).toContain(TAGS[2]);
  });

  it("[legend-1100] without an entry the same drift fails (empty allow-list)", async () => {
    await applyWithOldHash();
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain(TAGS[2]);
  });

  it("[legend-1100] an allow-list entry does not cover unknown@<created_at> rows", async () => {
    await insertApplied([0, 1]);
    await insertRow(oldHash, 1_699_999_999_999);
    writeAllow([entry()]);
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain("unknown@1699999999999");
  });

  it("[legend-1100] an allow-list entry does not cover missing:<tag>", async () => {
    await insertApplied([0, 2]);
    writeAllow([entry({ tag: TAGS[1] })]);
    const message = await messageOf(runReleaseGates(client, opts()));
    expect(message).toContain(`missing:${TAGS[1]}`);
  });

  it("[legend-1100] reads the allow-list from driftAllowFile when given", async () => {
    await applyWithOldHash();
    const custom = join(root, "elsewhere.json");
    writeFileSync(custom, JSON.stringify([entry()]));
    const report = await runReleaseGates(client, {
      ...opts(),
      driftAllowFile: custom,
    });
    expect(report).toMatchObject({ status: "ok", applied: 3 });
  });

  it("[legend-1100] fails closed when the allow-list file is missing and gates run", async () => {
    await insertApplied([0, 1]);
    rmSync(join(preflightDir, "drift-allow.json"));
    await expect(runReleaseGates(client, opts())).rejects.toBeInstanceOf(
      ReleaseGateError,
    );
  });

  it("[legend-1100] a fresh database does not need the allow-list file", async () => {
    rmSync(join(preflightDir, "drift-allow.json"));
    await expect(runReleaseGates(client, naOpts())).resolves.toEqual({
      status: "n/a",
    });
  });

  it("[legend-1100] fails closed on invalid JSON, wrong shape, unknown tag and non-hex hash", async () => {
    await insertApplied([0, 1]);
    const bad: unknown[] = [
      "{ not json",
      { tag: TAGS[2] },
      [entry({ bead: undefined })],
      [entry({ tag: "9999_tidak_ada" })],
      [entry({ hash: "z".repeat(64) })],
      [entry({ hash: "abc123" })],
      [entry({ hash: "*" })],
    ];
    for (const content of bad) {
      writeAllow(content as string);
      await expect(runReleaseGates(client, opts())).rejects.toBeInstanceOf(
        ReleaseGateError,
      );
    }
  });
});
