import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prints one line ready for LEGEND_TEST_FILES, so a failure shows up in
// minutes instead of at the full-suite gate:
//   node scripts/affected-tests.mjs --base <ref> [--max N]
// Order (also the order kept when --max cuts the list):
//   1. tests changed in the diff
//   2. API tests importing a changed service/route/lib, and root tests that
//      mention a changed non-API file
//   4. always: src/test/*single-path*, src/test/*registry*
//   3. tests that mention a function/table from a changed migration
// API tests print as src/test/..., root tests as tests/....

const API_TEST_DIR = "apps/api/src/test";
const API_SRC_DIR = "apps/api/src";
const ROOT_TEST_DIR = "tests";
const MIN_NAME_LENGTH = 5;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const ALWAYS = [/single-path/, /registry/];

function walk(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

// Function, view, table, trigger and type names a migration creates or alters.
export function sqlObjectNames(sql) {
  const names = new Set();
  const name = String.raw`(?:"?[A-Za-z_][\w$]*"?\.)?"?([A-Za-z_][\w$]*)"?`;
  const patterns = [
    new RegExp(
      String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:FUNCTION|VIEW|TRIGGER|TYPE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?${name}`,
      "gi",
    ),
    new RegExp(
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${name}`,
      "gi",
    ),
    new RegExp(
      String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+${name}`,
      "gi",
    ),
  ];
  for (const pattern of patterns)
    for (const match of stripSqlComments(sql).matchAll(pattern))
      if (match[1].length >= MIN_NAME_LENGTH) names.add(match[1]);
  return [...names];
}

function importSpecifiers(source) {
  const found = [];
  const pattern =
    /(?:from\s*|import\s*\(\s*|import\s+|vi\.(?:mock|doMock|importActual)\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

const stem = (path) => path.replace(/\.[cm]?[jt]sx?$/, "");

// Pure and filesystem-only so a tmp-dir fixture can exercise it.
export function affectedTests({ root, changed, max = 120 }) {
  const exists = (path) => existsSync(join(root, path));
  const present = changed.filter(exists);
  const apiTests = walk(join(root, API_TEST_DIR)).map((path) =>
    relative(root, path).split("\\").join("/"),
  );
  const rootTests = walk(join(root, ROOT_TEST_DIR)).map((path) =>
    relative(root, path).split("\\").join("/"),
  );
  const display = (path) =>
    path.startsWith(`${API_TEST_DIR}/`) ? path.slice("apps/api/".length) : path;
  const source = new Map();
  const read = (path) => {
    if (!source.has(path))
      source.set(path, readFileSync(join(root, path), "utf8"));
    return source.get(path);
  };

  const ordered = new Set();
  const add = (paths) => paths.forEach((path) => ordered.add(display(path)));

  // 1. Tests changed in the diff.
  add(
    present.filter(
      (path) =>
        TEST_FILE.test(path) &&
        (apiTests.includes(path) || rootTests.includes(path)),
    ),
  );

  // 2. API tests importing a changed API source file; root tests naming a
  // changed file outside the API.
  const changedSrc = new Set(
    present
      .filter(
        (path) =>
          path.startsWith(`${API_SRC_DIR}/`) &&
          !path.startsWith(`${API_TEST_DIR}/`) &&
          /\.[cm]?[jt]sx?$/.test(path),
      )
      .map(stem),
  );
  if (changedSrc.size) {
    for (const test of apiTests) {
      const hit = importSpecifiers(read(test)).some((spec) => {
        if (!spec.startsWith(".")) return false;
        const target = stem(
          posix.normalize(posix.join(posix.dirname(test), spec)),
        );
        return changedSrc.has(target) || changedSrc.has(`${target}/index`);
      });
      if (hit) add([test]);
    }
  }
  const changedOther = present.filter(
    (path) =>
      !path.startsWith(`${API_SRC_DIR}/`) &&
      !path.endsWith(".sql") &&
      !TEST_FILE.test(path) &&
      /\.[cm]?[jt]sx?$/.test(path),
  );
  for (const test of rootTests)
    if (
      changedOther.some(
        (path) =>
          read(test).includes(path) ||
          read(test).includes(`/${posix.basename(path)}`),
      )
    )
      add([test]);

  // 4. Always.
  add(
    apiTests.filter((path) =>
      ALWAYS.some((pattern) => pattern.test(posix.basename(path))),
    ),
  );

  // 3. Tests naming an object from a changed migration.
  const names = new Set();
  for (const path of present)
    if (/^apps\/api\/drizzle\/[^/]+\.sql$/.test(path))
      for (const name of sqlObjectNames(read(path))) names.add(name);
  if (names.size) {
    const pattern = new RegExp(String.raw`\b(?:${[...names].join("|")})\b`);
    add([...apiTests, ...rootTests].filter((test) => pattern.test(read(test))));
  }

  const all = [...ordered];
  return { files: all.slice(0, max), total: all.length };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

export function changedFiles(root, base) {
  return [
    ...new Set([
      ...git(root, ["diff", "--name-only", base, "--"]),
      ...git(root, ["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : args[index + 1];
  };
  const max = Number(option("--max", "120"));
  if (!Number.isInteger(max) || max < 1) {
    console.error("--max must be a positive integer.");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, total } = affectedTests({
    root,
    changed: changedFiles(root, option("--base", "milestone/m1")),
    max,
  });
  if (total > files.length)
    console.error(`Cut to ${files.length} of ${total} tests (--max ${max}).`);
  console.log(files.join(" "));
}
