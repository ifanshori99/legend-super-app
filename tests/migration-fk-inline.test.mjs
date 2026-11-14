import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = join(root, "apps/api/drizzle");
const fixtureDir = join(root, "tests/fixtures/migration-fk-inline");

// 0349 is the last migration on milestone/m1 when this guard was introduced.
// Applied migrations are immutable; only later migrations are checked.
const baseline = 349;
const identifier = String.raw`(?:"(?:[^"]|"")+"|[a-zA-Z_][\w$]*)`;
const tableName = String.raw`${identifier}(?:\s*\.\s*${identifier})?`;

function canonicalTable(name) {
  const parts = name
    .match(new RegExp(identifier, "g"))
    .map((part) =>
      part.startsWith('"')
        ? part.slice(1, -1).replaceAll('""', '"')
        : part.toLowerCase(),
    );
  return parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
}

function inspectMigration(sql, filename) {
  // Ignore SQL comments and string literals, including dollar-quoted function bodies.
  // Quoted identifiers remain intact for table and constraint name matching.
  const code = sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$([a-zA-Z_][\w]*|)\$[\s\S]*?\$\1\$/g,
    " ",
  );
  const created = new Set(
    [
      ...code.matchAll(
        new RegExp(
          String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${tableName})`,
          "gi",
        ),
      ),
    ].map((match) => canonicalTable(match[1])),
  );
  const alter = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${tableName})\s+([^;]*)`,
    "gi",
  );
  const foreignKey = new RegExp(
    String.raw`\bADD\s+(?:CONSTRAINT\s+(${identifier})\s+)?FOREIGN\s+KEY\b([\s\S]*?)(?=,\s*(?:ADD|DROP|ALTER|RENAME)\b|$)`,
    "gi",
  );
  const errors = [];
  const warnings = [];
  for (const match of code.matchAll(alter)) {
    const table = canonicalTable(match[1]);
    for (const fk of match[2].matchAll(foreignKey)) {
      const name = fk[1] ?? "(unnamed)";
      if (created.has(table)) {
        errors.push(
          `${filename}: FK ${name} on new table ${table} must be inline in CREATE TABLE`,
        );
      } else if (!/\bNOT\s+VALID\b/i.test(fk[0])) {
        warnings.push(
          `${filename}: FK ${name} on existing table ${table} lacks NOT VALID; FORCE RLS can prevent validation`,
        );
      }
    }
  }
  return { errors, warnings };
}

test("separate foreign keys on new tables are rejected", () => {
  const sql = readFileSync(join(fixtureDir, "bad.sql"), "utf8");
  const { errors } = inspectMigration(sql, "bad.sql");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /new_child.*inline/);
});

test("inline foreign keys and NOT VALID on existing tables are accepted", () => {
  const sql = readFileSync(join(fixtureDir, "good.sql"), "utf8");
  assert.deepEqual(inspectMigration(sql, "good.sql"), {
    errors: [],
    warnings: [],
  });
});

test("a separate validated foreign key on an existing table only warns", () => {
  const sql =
    'ALTER TABLE "existing_child" ADD CONSTRAINT "parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parent"("id");';
  const { errors, warnings } = inspectMigration(sql, "existing.sql");
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /existing_child.*NOT VALID/);
});

test("unnamed and multiple foreign keys in one ALTER TABLE are checked independently", () => {
  const sql = `
    CREATE TABLE public.new_child (id text, parent_id text);
    ALTER TABLE "public"."new_child"
      ADD COLUMN other_id text,
      ADD FOREIGN KEY (parent_id) REFERENCES parent(id),
      ADD CONSTRAINT second_fk FOREIGN KEY (other_id) REFERENCES parent(id) NOT VALID;
    ALTER TABLE old_child
      ADD FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID,
      ADD FOREIGN KEY (other_id) REFERENCES parent(id);
  `;
  const { errors, warnings } = inspectMigration(sql, "multiple.sql");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /\(unnamed\)/);
  assert.match(errors[1], /second_fk/);
  assert.equal(warnings.length, 1);
});

test("new migrations keep foreign keys on new tables inline", () => {
  const errors = [];
  for (const filename of readdirSync(migrationDir).sort()) {
    const match = /^(\d+)_.*\.sql$/.exec(filename);
    if (!match || Number(match[1]) <= baseline) continue;
    const result = inspectMigration(
      readFileSync(join(migrationDir, filename), "utf8"),
      filename,
    );
    errors.push(...result.errors);
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  }
  assert.deepEqual(errors, [], errors.join("\n"));
});
