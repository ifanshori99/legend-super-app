// legend-1100: guards on the real migration journal and on the checked-in
// release-gate SQL files (scripts/preflight/rilis1-*.sql).
//
// Assumption: the real journal's `idx` is NOT gapless (466 entries, numbers
// skipped), so the test asserts idx strictly increasing and idx equal to the
// numeric tag prefix instead of idx === position.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePreflightFile, readJournal } from "../db/release-gates";

const drizzleDir = new URL("../../drizzle/", import.meta.url);
const preflightDir = new URL("../../../../scripts/preflight/", import.meta.url);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

// fileURLToPath, not .pathname: the repo path contains spaces.
const journal = readJournal(fileURLToPath(drizzleDir));

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-1100] real migration journal", () => {
  it("[legend-1100] has entries", () => {
    expect(journal.length).toBeGreaterThan(400);
  });

  it("[legend-1100] every tag has a .sql file", () => {
    const missing = journal
      .filter((e) => !existsSync(new URL(`${e.tag}.sql`, drizzleDir)))
      .map((e) => e.tag);
    expect(missing).toEqual([]);
  });

  it("[legend-1100] idx is strictly increasing and equals the tag number prefix", () => {
    const bad = journal
      .filter(
        (e, i) =>
          e.idx !== Number.parseInt(e.tag.slice(0, 4), 10) ||
          (i > 0 && e.idx <= journal[i - 1]!.idx),
      )
      .map((e) => e.tag);
    expect(bad).toEqual([]);
  });

  it("[legend-1100] tags are unique", () => {
    expect(new Set(journal.map((e) => e.tag)).size).toBe(journal.length);
  });

  it("[legend-1100] no two entries share the same when", () => {
    const seen = new Map<number, string>();
    const dupes: string[] = [];
    for (const e of journal) {
      const prev = seen.get(e.when);
      if (prev) dupes.push(`${prev} = ${e.tag}`);
      seen.set(e.when, e.tag);
    }
    expect(dupes).toEqual([]);
  });

  it("[legend-1100] when is strictly increasing from idx 4 on (0003 is the known exception)", () => {
    // legend-ir8n8: 0003_outstanding_ultragirl has a `when` lower than 0002's.
    // It is excluded explicitly; the drizzle migrator already applied it on
    // every live database, so the journal must not be rewritten.
    expect(journal.find((e) => e.idx === 3)?.tag).toBe(
      "0003_outstanding_ultragirl",
    );
    const bad = journal
      .filter((e) => e.idx >= 4)
      .filter((e) => {
        const prev = journal[journal.indexOf(e) - 1]!;
        return e.when <= prev.when;
      })
      .map((e) => e.tag);
    expect(bad).toEqual([]);
  });
});

describe("[legend-1100] checked-in rilis1 preflight files", () => {
  const files = readdirSync(preflightDir)
    .filter((f) => /^rilis1-.*\.sql$/.test(f))
    .sort();
  const tags = new Set(journal.map((e) => e.tag));

  it("[legend-1100] file names match their gate id", () => {
    for (const file of files) {
      const gate = parsePreflightFile(
        file,
        readFileSync(new URL(file, preflightDir), "utf8"),
      );
      expect(file).toBe(`rilis1-${gate.gate}.sql`);
    }
  });

  for (const file of files) {
    it(`[legend-1100] ${file} has a valid header, a journal tag and existing tables`, async () => {
      const gate = parsePreflightFile(
        file,
        readFileSync(new URL(file, preflightDir), "utf8"),
      );
      expect(["block", "info"]).toContain(gate.mode);
      expect(gate.resolve.length).toBeGreaterThan(0);
      if (gate.before !== null) expect(tags.has(gate.before)).toBe(true);
      for (const table of gate.requires) {
        expect(table).toMatch(/^public\.[a-z_][a-z0-9_]*$/);
        const result = await owner.query(
          "SELECT to_regclass($1) IS NOT NULL AS present",
          [table],
        );
        expect(result.rows[0].present, `${table} missing in test DB`).toBe(
          true,
        );
      }
    });
  }
});
