// Data-import guard registry checks (bead legend-v4ld; PRD v1.7 §3 and §7).
// Pure filesystem and function checks, no database.
//
// 1. Every registered import source calls guardDataImport("<its id>").
// 2. No unregistered import/seed/backfill file exists under apps/api/src.
// 3. No script or package.json script reaches an unregistered importer.
// 4. guardDataImport allows and blocks the right deployment/classification pairs.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DataClassification,
  DeploymentMode,
  DeploymentSettings,
} from "@starter/shared/env";
import {
  DATA_IMPORT_SOURCES,
  DataImportBlockedError,
  guardDataImport,
  type DataImportSourceId,
} from "../config/data-import.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const API_SRC = path.join(REPO_ROOT, "apps/api/src");

const toPosix = (p: string) => p.split(path.sep).join("/");
const readRepoFile = (repoRelative: string) =>
  readFileSync(path.join(REPO_ROOT, repoRelative), "utf8");

const sources = Object.entries(DATA_IMPORT_SOURCES) as [
  DataImportSourceId,
  { file: string; entry?: string; beforeWrite: string },
][];
const registeredFiles = new Set<string>(sources.map(([, s]) => s.file));

// Files whose name looks like an importer but that never write imported data.
// Each entry needs a reason; adding a real writer here defeats the guard.
const NOT_A_WRITER: Record<string, string> = {
  "apps/api/src/services/menu-import-parse.ts":
    "pure spreadsheet/CSV parser: returns rows, performs no database write",
  "apps/api/src/config/data-import.ts":
    "the guard registry itself: decides whether an import may run",
  "apps/api/src/routes/edge-bootstrap.routes.ts":
    "HTTP route serving the signed bundle: only calls the read-only export service",
  "apps/api/src/services/edge-bootstrap.service.ts":
    "cloud-side export: only reads and signs the bundle that edge/bootstrap.ts writes",
  "apps/api/src/routes/menu-import.routes.ts":
    "HTTP route only: delegates to menu-import.service.ts, which calls the guard",
};

// Files under apps/api/src/db referenced from scripts/*.mjs that are not
// data importers.
const SCRIPT_NOT_A_WRITER: Record<string, string> = {
  "apps/api/src/db/provision-roles.ts":
    "role provisioning (database roles and grants), writes no application data",
};

// SQL migrations that contain INSERT/UPDATE statements. They are schema
// upgrades of existing data, never imports. A new data statement in a
// migration must be added here with a reason, so it gets looked at.
const MIGRATION_DATA_STATEMENTS: Record<string, string> = {
  "0013_outbox_dispatch_recovery.sql":
    "sets a lease on already queued outbox rows",
  "0027_accounting_invariants.sql":
    "trigger body that seals journal entries at runtime",
  "0042_safe_hydra.sql":
    "backfills paid_idr on existing promotion applications",
  "0065_edge_received_events.sql":
    "copies existing edge inbound events into the renamed table",
  "0090_pos_day_close_permission.sql":
    "adds a permission string to each tenant's existing roles",
  "0096_menu_station_type_backfill.sql":
    "derives station_type of existing menu items from stations",
  "0104_edc_standalone_permission.sql":
    "adds a permission string to each tenant's existing roles",
  "0115_ai_role_templates_data.sql":
    "adds the ai.ask and ai.action.propose permission strings to existing role templates",
  "0116_ai_approval_policies_data.sql":
    "inserts default approval policies for each tenant's existing roles",
  "0120_ws03_roles_zone_manage.sql":
    "adds a permission string to each tenant's existing roles",
  "0126_ws08_delivery_store_index_rls.sql":
    "trigger body and backfill of the delivery store index from existing delivery channels",
};

// Entrypoints that open a database pool but import no data.
const POOL_OPENERS_NOT_IMPORTERS: Record<string, string> = {
  "apps/api/src/migrate.ts": "applies DDL migrations only",
  "apps/api/src/set-role.ts": "single admin UPDATE of one user's role",
  "apps/api/src/db/reset-preswitch-refund-payouts.ts":
    "one-off repair of refunds already in the database (UPDATE of payout state, dry-run by default), imports nothing",
  "apps/api/src/worker-main.ts":
    "job runner: delivery state of its own tenant's work, no imports",
  "apps/api/src/db/role.ts": "runtime role helper, no data writes",
  "scripts/doctor.mjs": "read-only health query",
  "scripts/test-setup.mjs":
    "writes a marker table into a disposable test database only",
};

// package.json script names matching /seed|import|backfill/ that are not
// importers outside the registry. Empty on purpose: add an entry with a reason.
const SCRIPT_NAME_ALLOWLIST: Record<string, string> = {
  "package.json#db:backfill-defaults":
    "runs the registered, guarded source backfill.tenant-defaults (root alias)",
  "apps/api/package.json#db:backfill-defaults":
    "runs the registered, guarded source backfill.tenant-defaults",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.relative(API_SRC, full));
    if (entry.isDirectory()) {
      if (
        entry.name === "test" ||
        entry.name === "node_modules" ||
        rel === "db/schema"
      )
        continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(`apps/api/src/${rel}`);
    }
  }
  return out;
}

describe("data import registry: registered sources call the guard", () => {
  it("registers at least one source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const [id, source] of sources) {
    it(`[${id}] ${source.file} calls guardDataImport("${id}") before its first write`, () => {
      // Comments are stripped so a commented-out call cannot satisfy the test.
      const code = readRepoFile(source.file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const entry = source.entry === undefined ? 0 : code.indexOf(source.entry);
      expect(entry).toBeGreaterThanOrEqual(0);
      const call = new RegExp(`guardDataImport\\(\\s*"${id}"`).exec(
        code.slice(entry),
      );
      const guard = call ? entry + call.index : -1;
      expect(guard).toBeGreaterThanOrEqual(0);
      const write = code.indexOf(source.beforeWrite, entry);
      expect(write).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(write);
    });
  }
});

describe("data import registry: no unregistered import/seed/backfill file", () => {
  const candidates = walk(API_SRC).filter((file) =>
    /import|seed|backfill|bootstrap/i.test(path.posix.basename(file)),
  );

  it("finds the registered importer files while walking apps/api/src", () => {
    for (const file of registeredFiles) expect(candidates).toContain(file);
  });

  it("every import/seed/backfill-named file is registered or explained", () => {
    const unexplained = candidates.filter(
      (file) => !registeredFiles.has(file) && !(file in NOT_A_WRITER),
    );
    expect(
      unexplained,
      "register these in DATA_IMPORT_SOURCES (and call guardDataImport) or add them to NOT_A_WRITER with a reason",
    ).toEqual([]);
  });

  it("every NOT_A_WRITER entry still exists and has a reason", () => {
    for (const [file, reason] of Object.entries(NOT_A_WRITER)) {
      expect(candidates, file).toContain(file);
      expect(reason.length, file).toBeGreaterThan(10);
      expect(registeredFiles.has(file), `${file} is also registered`).toBe(
        false,
      );
    }
  });

  it("routes/menu-import.routes.ts only calls the service: no direct database access", () => {
    const route = readRepoFile("apps/api/src/routes/menu-import.routes.ts");
    expect(route).toContain("../services/menu-import.service.ts");
    expect(route).not.toMatch(/from\s+["'][^"']*\/db\//);
    expect(route).not.toMatch(/from\s+["']drizzle-orm/);
    expect(route).not.toMatch(/\b(?:db|tx)\.(?:insert|update|delete)\(/);
  });
});

describe("data import registry: scripts and package scripts", () => {
  const scriptsDir = path.join(REPO_ROOT, "scripts");
  const mjsFiles = readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"));

  it("every src/db/<x>.ts referenced from scripts/*.mjs is registered or explained", () => {
    const referenced = new Set<string>();
    for (const file of mjsFiles) {
      const text = readFileSync(path.join(scriptsDir, file), "utf8");
      for (const match of text.matchAll(/src\/db\/([\w.-]+\.ts)/g))
        referenced.add(`apps/api/src/db/${match[1]}`);
    }
    // Sanity: the walk sees the seed script that scripts/ runs.
    expect([...referenced]).toContain("apps/api/src/db/seed-dev-tenant.ts");

    const unexplained = [...referenced].filter(
      (file) => !registeredFiles.has(file) && !(file in SCRIPT_NOT_A_WRITER),
    );
    expect(
      unexplained,
      "register these in DATA_IMPORT_SOURCES or add them to SCRIPT_NOT_A_WRITER with a reason",
    ).toEqual([]);
  });

  it("every package.json script named seed/import/backfill is allowlisted", () => {
    const names: string[] = [];
    for (const pkg of ["package.json", "apps/api/package.json"]) {
      const json = JSON.parse(readRepoFile(pkg)) as {
        scripts?: Record<string, string>;
      };
      for (const name of Object.keys(json.scripts ?? {}))
        if (/seed|import|backfill/.test(name)) names.push(`${pkg}#${name}`);
    }
    const unexplained = names.filter((n) => !(n in SCRIPT_NAME_ALLOWLIST));
    expect(
      unexplained,
      "route these through a registered, guarded source, then allowlist with a reason",
    ).toEqual([]);
  });
});

describe("data import registry: migrations, pools and bootstrap", () => {
  it("every SQL migration with INSERT/UPDATE statements is acknowledged", () => {
    const dir = path.join(REPO_ROOT, "apps/api/drizzle");
    const withData = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /^\s*(INSERT\s+INTO|UPDATE\s)/im.test(
          readFileSync(path.join(dir, f), "utf8"),
        ),
      );
    const unexplained = withData.filter(
      (f) => !(f in MIGRATION_DATA_STATEMENTS),
    );
    expect(
      unexplained,
      "a migration writes rows: explain it in MIGRATION_DATA_STATEMENTS (backfills only, never imports)",
    ).toEqual([]);
    for (const f of Object.keys(MIGRATION_DATA_STATEMENTS))
      expect(withData, f).toContain(f);
  });

  it("every non-test file that opens a Pool is registered or explained", () => {
    const files = [
      ...walk(API_SRC),
      ...readdirSync(path.join(REPO_ROOT, "scripts"))
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => `scripts/${f}`),
    ].filter((file) => file !== "apps/api/src/config/data-import.ts");
    const openers = files.filter((file) =>
      /new\s+(?:pg\.)?Pool\(/.test(
        readRepoFile(file)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      ),
    );
    const unexplained = openers.filter(
      (file) =>
        !registeredFiles.has(file) && !(file in POOL_OPENERS_NOT_IMPORTERS),
    );
    expect(
      unexplained,
      "register in DATA_IMPORT_SOURCES or add to POOL_OPENERS_NOT_IMPORTERS with a reason",
    ).toEqual([]);
    for (const file of Object.keys(POOL_OPENERS_NOT_IMPORTERS))
      expect(openers, file).toContain(file);
  });
});

describe("seed.dev-tenant fails closed without an explicit deployment mode", () => {
  const deployment = (
    DEPLOYMENT_MODE: DeploymentMode,
    DATA_CLASSIFICATION: DataClassification,
  ) =>
    ({
      DEPLOYMENT_MODE,
      EDGE_MODE: false,
      DATA_CLASSIFICATION,
    }) as DeploymentSettings;
  const dev = {
    DEPLOYMENT_MODE: "development",
    EDGE_MODE: false,
    DATA_CLASSIFICATION: "synthetic",
  } as DeploymentSettings;

  it("refuses a remote database when DEPLOYMENT_MODE is unset", () => {
    for (const databaseUrl of [
      "postgres://u:p@db.prod.example.com:5432/legend",
      "postgres://u:p@10.0.0.5/legend",
      undefined,
      "not a url",
    ])
      expect(
        () => guardDataImport("seed.dev-tenant", dev, { databaseUrl, env: {} }),
        String(databaseUrl),
      ).toThrow(DataImportBlockedError);
  });

  it("is not fooled by host tricks in the URL", () => {
    for (const databaseUrl of [
      "postgres://u:p@localhost/db?host=db.prod.example.com",
      "postgres://u:p@localhost/db?hostaddr=10.0.0.5",
      "postgres://u:p@localhost/db?service=prod",
      "postgres://localhost@evil.example.com/db",
      "postgres://u:p@localhost.example.com/db",
      "postgres://u:p@localhost./db",
      "postgres:///db",
    ])
      expect(
        () => guardDataImport("seed.dev-tenant", dev, { databaseUrl, env: {} }),
        databaseUrl,
      ).toThrow(DataImportBlockedError);
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@LOCALHOST:5432/db",
        env: {},
      }),
    ).not.toThrow();
  });

  it("seed-dev-tenant hands the guard the URL its pool will use", () => {
    const code = readRepoFile("apps/api/src/db/seed-dev-tenant.ts");
    expect(code).toMatch(
      /process\.env\.MIGRATION_DATABASE_URL\s*\?\?\s*process\.env\.DATABASE_URL/,
    );
  });

  it("treats a blank DEPLOYMENT_MODE as unset", () => {
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@db.example.com/legend",
        env: { DEPLOYMENT_MODE: "  " },
      }),
    ).toThrow(DataImportBlockedError);
  });

  it("allows a local database when DEPLOYMENT_MODE is unset", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "db.localhost"])
      expect(() =>
        guardDataImport("seed.dev-tenant", dev, {
          databaseUrl: `postgres://u:p@${host}:5433/legend`,
          env: {},
        }),
      ).not.toThrow();
  });

  it("allows any host once DEPLOYMENT_MODE is explicit development", () => {
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@db.example.com/legend",
        env: { DEPLOYMENT_MODE: "development" },
      }),
    ).not.toThrow();
  });

  it("explicit staging or production is still blocked for the seed", () => {
    for (const mode of ["staging", "production"] as const)
      expect(() =>
        guardDataImport("seed.dev-tenant", deployment(mode, "synthetic"), {
          databaseUrl: "postgres://u:p@localhost/legend",
          env: { DEPLOYMENT_MODE: mode },
        }),
      ).toThrow(DataImportBlockedError);
  });
});

describe("edge.bootstrap follows the node's own deployment policy", () => {
  const edge = (mode: DeploymentMode, cls: DataClassification) =>
    ({
      DEPLOYMENT_MODE: mode,
      EDGE_MODE: true,
      DATA_CLASSIFICATION: cls,
    }) as DeploymentSettings;

  it("passes for synthetic data anywhere and real data in production", () => {
    for (const mode of ["development", "staging", "production"] as const)
      expect(() =>
        guardDataImport("edge.bootstrap", edge(mode, "synthetic")),
      ).not.toThrow();
    expect(() =>
      guardDataImport("edge.bootstrap", edge("production", "real")),
    ).not.toThrow();
  });

  it("blocks real data outside production", () => {
    for (const mode of ["development", "staging"] as const)
      expect(() =>
        guardDataImport("edge.bootstrap", edge(mode, "real")),
      ).toThrow(DataImportBlockedError);
  });
});

describe("guardDataImport behaviour", () => {
  const modes: DeploymentMode[] = ["development", "staging", "production"];
  const classifications: DataClassification[] = ["synthetic", "real"];

  const deployment = (
    DEPLOYMENT_MODE: DeploymentMode,
    DATA_CLASSIFICATION: DataClassification,
  ): DeploymentSettings =>
    ({
      DEPLOYMENT_MODE,
      EDGE_MODE: false,
      DATA_CLASSIFICATION,
    }) as DeploymentSettings;

  describe("seed.dev-tenant (synthetic, development only)", () => {
    for (const classification of classifications) {
      it(`passes in development with ${classification} classification`, () => {
        expect(() =>
          guardDataImport(
            "seed.dev-tenant",
            deployment("development", classification),
          ),
        ).not.toThrow();
      });
    }

    for (const mode of modes.filter((m) => m !== "development"))
      for (const classification of classifications)
        it(`is blocked in ${mode} with ${classification} classification`, () => {
          expect(() =>
            guardDataImport(
              "seed.dev-tenant",
              deployment(mode, classification),
            ),
          ).toThrow(DataImportBlockedError);
        });
  });

  describe("menu-import.commit (classification follows the deployment)", () => {
    const allowed: [DeploymentMode, DataClassification][] = [
      ["development", "synthetic"],
      ["staging", "synthetic"],
      ["production", "real"],
      ["production", "synthetic"],
    ];
    const blocked: [DeploymentMode, DataClassification][] = [
      ["staging", "real"],
      ["development", "real"],
    ];

    for (const [mode, classification] of allowed)
      it(`passes in ${mode} with ${classification} data`, () => {
        expect(() =>
          guardDataImport(
            "menu-import.commit",
            deployment(mode, classification),
          ),
        ).not.toThrow();
      });

    for (const [mode, classification] of blocked)
      it(`throws DataImportBlockedError in ${mode} with ${classification} data`, () => {
        const attempt = () =>
          guardDataImport(
            "menu-import.commit",
            deployment(mode, classification),
          );
        expect(attempt).toThrow(DataImportBlockedError);
        expect(attempt).toThrow(/production/);
      });
  });

  it("throws DataImportBlockedError carrying the source id", () => {
    try {
      guardDataImport("menu-import.commit", deployment("staging", "real"));
      expect.unreachable("guard should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DataImportBlockedError);
      expect((error as DataImportBlockedError).sourceId).toBe(
        "menu-import.commit",
      );
    }
  });

  it("blocks an unregistered source id", () => {
    expect(() =>
      guardDataImport(
        "not.registered" as DataImportSourceId,
        deployment("production", "real"),
      ),
    ).toThrow(DataImportBlockedError);
  });
});
