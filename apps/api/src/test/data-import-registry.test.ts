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
  "apps/api/src/routes/menu-import.routes.ts":
    "HTTP route only: delegates to menu-import.service.ts, which calls the guard",
};

// Files under apps/api/src/db referenced from scripts/*.mjs that are not
// data importers.
const SCRIPT_NOT_A_WRITER: Record<string, string> = {
  "apps/api/src/db/provision-roles.ts":
    "role provisioning (database roles and grants), writes no application data",
};

// package.json script names matching /seed|import|backfill/ that are not
// importers outside the registry. Empty on purpose: add an entry with a reason.
const SCRIPT_NAME_ALLOWLIST: Record<string, string> = {};

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
      const guard = code.indexOf(`guardDataImport("${id}")`, entry);
      expect(guard).toBeGreaterThanOrEqual(0);
      const write = code.indexOf(source.beforeWrite, entry);
      expect(write).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(write);
    });
  }
});

describe("data import registry: no unregistered import/seed/backfill file", () => {
  const candidates = walk(API_SRC).filter((file) =>
    /import|seed|backfill/i.test(path.posix.basename(file)),
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
            guardDataImport("seed.dev-tenant", deployment(mode, classification)),
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
