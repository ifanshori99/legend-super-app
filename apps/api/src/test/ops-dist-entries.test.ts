// Operator commands that docs/deployment.md runs from the production image as
// `node dist/<name>.js` (legend-1265 G1). The image has no tsx or pnpm, so each
// command must be a tsup entry that always runs, and a wrong argument must
// exit non-zero with a usage line instead of silently exiting 0.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsupConfig from "../../tsup.config.ts";

const apiDir = resolve(import.meta.dirname, "../..");
const entries = (
  (Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig) as {
    entry: Record<string, string>;
  }
).entry;

const COMMANDS = [
  "payroll-pph21-receivable-backfill",
  "backfill-ptkp-history",
  "backfill-tenant-defaults",
  "metrics-daily-backfill",
  "backfill-employee-managers",
  "rotate-data-key",
  "set-role",
  "purchase-return-variance-check",
  "repair-supplier-invoice-npwp",
];

describe("operator commands in dist", () => {
  it.each(COMMANDS)("%s is a tsup entry whose source exists", (name) => {
    expect(entries[name], name).toBeTypeOf("string");
    expect(existsSync(resolve(apiDir, entries[name]!)), name).toBe(true);
  });

  it.each(COMMANDS)(
    "%s has no entry-file guard that can swallow the run",
    (name) => {
      const source = readFileSync(resolve(apiDir, entries[name]!), "utf8");
      expect(source).not.toMatch(/process\.argv\[1\]/);
      expect(source).not.toMatch(/import\.meta\.url\s*===/);
    },
  );

  it.each([
    "src/scripts/payroll-pph21-receivable-backfill.ts",
    "src/scripts/metrics-daily-backfill.ts",
    "src/scripts/purchase-return-variance-check.ts",
    "src/db/backfill-employee-managers.ts",
    "src/db/rotate-data-key.ts",
  ])("%s keeps no entry-file guard of its own", (file) => {
    expect(readFileSync(resolve(apiDir, file), "utf8")).not.toMatch(
      /process\.argv\[1\]/,
    );
  });

  // Needs `heavy pnpm --filter @starter/api build` first; skipped on a tree
  // without dist/. Arguments are rejected before any database connection.
  const built = COMMANDS.every((name) =>
    existsSync(resolve(apiDir, "dist", `${name}.js`)),
  );
  describe.skipIf(!built)("built dist/<name>.js", () => {
    const BAD: Record<string, string[]> = {
      "set-role": [],
      "repair-supplier-invoice-npwp": ["--bogus"],
    };
    it.each(COMMANDS)("%s rejects a wrong argument", (name) => {
      const result = spawnSync(
        process.execPath,
        [resolve(apiDir, "dist", `${name}.js`), ...(BAD[name] ?? ["--bogus"])],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "production",
            DATABASE_URL: "postgres://nobody:nopass@127.0.0.1:1/none",
            MIGRATION_DATABASE_URL: "postgres://nobody:nopass@127.0.0.1:1/none",
          },
        },
      );
      expect(result.status, name).not.toBe(0);
      expect(result.status, name).not.toBeNull();
      expect(`${result.stdout}${result.stderr}`.trim(), name).not.toBe("");
    });
  });
});
