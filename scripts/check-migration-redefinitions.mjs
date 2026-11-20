// Catches a migration that redefines a function, view, trigger or policy and
// silently drops lines the previous definition had (root cause of the 0504
// bug in batch98: a stale rewrite of a function a later migration had grown).
//
//   node scripts/check-migration-redefinitions.mjs [--base <ref>]
//        [--dir <drizzle dir>] [--files <a.sql,b.sql>]
//
// For every migration added in HEAD versus the base (default `milestone/m1`),
// each CREATE [OR REPLACE] FUNCTION / VIEW and each CREATE TRIGGER / POLICY is
// compared with the latest earlier definition of the same object (journal
// order, `apps/api/drizzle/meta/_journal.json`). Lines (trimmed, whitespace
// collapsed, comments and blanks ignored, `OR REPLACE` ignored) that the
// old definition has and the new one lacks are reported as LOST. Exit 1 when
// any are found, unless a `-- redefine-drops: <reason>` comment sits in the new
// definition's block (its leading comments or its body).
//
// Object identity: functions and procedures by name and argument count,
// triggers and policies by name and table, views by name. Names are compared
// unquoted and lowercase; an unqualified name equals `public.<name>`, other
// schemas stay distinct (`app.x` is not `x`). Lines are compared as a multiset,
// so a line the old definition had twice and the new one has once is LOST.
// New files come from `git diff --no-renames`, so a renumbered migration is
// checked like any added one. Not covered: objects defined outside
// apps/api/drizzle/*.sql (seed scripts, application code, manual DDL).
// `--files` replaces the git diff with an explicit list (used by tests). Uses
// only node: built-ins.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = "apps/api/drizzle";
const ANNOTATION = /--\s*redefine-drops:\s*\S/i;

/** Split SQL into statements with comment-stripped lines and raw text. */
export function splitStatements(sql) {
  const statements = [];
  let cur = { raw: "", lines: [], startLine: null };
  let line = 1;
  let buf = "";
  let bufLine = 1;
  let dollar = null;
  let quoted = false;
  const flushLine = () => {
    if (buf.trim() !== "") {
      if (cur.startLine === null) cur.startLine = bufLine;
      cur.lines.push({ line: bufLine, text: buf });
    }
    buf = "";
  };
  const endStatement = () => {
    flushLine();
    if (cur.lines.length > 0) statements.push(cur);
    cur = { raw: "", lines: [], startLine: null };
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (!quoted && ch === "-" && next === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      cur.raw += sql.slice(i, j) + "\n";
      i = j - 1;
      continue;
    }
    if (!quoted && ch === "/" && next === "*") {
      let j = sql.indexOf("*/", i + 2);
      j = j === -1 ? sql.length : j + 2;
      for (const c of sql.slice(i, j)) if (c === "\n") line++;
      cur.raw += sql.slice(i, j) + "\n";
      i = j - 1;
      continue;
    }
    if (ch === "\n") {
      flushLine();
      cur.raw += "\n";
      line++;
      bufLine = line;
      continue;
    }
    if (buf === "") bufLine = line;
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "$") {
      if (dollar !== null && sql.startsWith(dollar, i)) {
        buf += dollar;
        cur.raw += dollar;
        i += dollar.length - 1;
        dollar = null;
        continue;
      }
      if (dollar === null) {
        const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
        if (m) {
          dollar = m[0];
          buf += dollar;
          cur.raw += dollar;
          i += dollar.length - 1;
          continue;
        }
      }
    }
    buf += ch;
    cur.raw += ch;
    if (!quoted && dollar === null && ch === ";") endStatement();
  }
  endStatement();
  return statements;
}

const unquote = (s) => s.replace(/"/g, "").toLowerCase();
// Unqualified names live in `public`; `public.x` and `x` are one object.
const ident = (s) => unquote(s).replace(/^public\./, "");
const norm = (s) => s.replace(/\s+/g, " ").trim();

function argCount(text, openIdx) {
  let depth = 0;
  let commas = 0;
  let any = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      if (c === ",") commas++;
      else if (!/\s/.test(c)) any = true;
    }
  }
  return any ? commas + 1 : 0;
}

/** Identify the object a statement defines, or null. */
export function objectOf(stmt) {
  const text = stmt.lines
    .map((l) => l.text)
    .join("\n")
    .trim();
  let m =
    /^create\s+(?:or\s+replace\s+)?(function|procedure)\s+([\w."]+)\s*\(/i.exec(
      text,
    );
  if (m) {
    const n = argCount(text, text.indexOf("(", m[0].length - 1));
    const kind = m[1].toLowerCase();
    return {
      kind: kind.toUpperCase(),
      key: `${kind} ${ident(m[2])}/${n}`,
    };
  }
  m =
    /^create\s+(?:or\s+replace\s+)?(?:(?:materialized|recursive|temp|temporary)\s+)*view\s+([\w."]+)/i.exec(
      text,
    );
  if (m) return { kind: "VIEW", key: `view ${ident(m[1])}` };
  m =
    /^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("[^"]+"|\w+)[\s\S]*?\bon\s+([\w."]+)/i.exec(
      text,
    );
  if (m) {
    return {
      kind: "TRIGGER",
      key: `trigger ${unquote(m[1])} on ${ident(m[2])}`,
    };
  }
  m = /^create\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)/i.exec(text);
  if (m) {
    return {
      kind: "POLICY",
      key: `policy ${unquote(m[1])} on ${ident(m[2])}`,
    };
  }
  return null;
}

/** Last definition per object in one migration's SQL. */
export function definitionsOf(sql) {
  const defs = new Map();
  for (const stmt of splitStatements(sql)) {
    const obj = objectOf(stmt);
    if (!obj) continue;
    const lines = stmt.lines
      .map((l) => ({ line: l.line, text: norm(l.text) }))
      .filter((l) => l.text !== "")
      .map((l, i) =>
        i === 0
          ? {
              ...l,
              text: l.text
                .replace(/^create or replace /i, "create ")
                .toLowerCase(),
            }
          : l,
      );
    defs.set(obj.key, {
      ...obj,
      startLine: stmt.startLine,
      lines,
      annotated: ANNOTATION.test(stmt.raw),
    });
  }
  return defs;
}

/**
 * @param {{dir: string, newFiles: string[]}} opts
 * @returns {{file: string, line: number, object: string, from: string, lost: string}[]}
 */
export function findLost({ dir, newFiles }) {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  );
  const order = journal.entries.map((e) => `${e.tag}.sql`);
  const cache = new Map();
  const defsFor = (file) => {
    if (!cache.has(file)) {
      cache.set(file, definitionsOf(readFileSync(join(dir, file), "utf8")));
    }
    return cache.get(file);
  };
  const lost = [];
  for (const file of newFiles) {
    const idx = order.indexOf(file);
    if (idx === -1) throw new Error(`${file} is not in the journal`);
    for (const [key, def] of defsFor(file)) {
      if (def.annotated) continue;
      let old = null;
      let oldFile = null;
      for (let j = idx - 1; j >= 0 && !old; j--) {
        if (!existsSync(join(dir, order[j]))) continue;
        const prev = defsFor(order[j]).get(key);
        if (prev) {
          old = prev;
          oldFile = order[j];
        }
      }
      if (!old) continue;
      const have = new Map();
      for (const l of def.lines) have.set(l.text, (have.get(l.text) ?? 0) + 1);
      for (const l of old.lines) {
        const left = have.get(l.text) ?? 0;
        if (left > 0) {
          have.set(l.text, left - 1);
          continue;
        }
        lost.push({
          file,
          line: def.startLine,
          object: def.key,
          from: `${oldFile}:${l.line}`,
          lost: l.text,
        });
      }
    }
  }
  return lost;
}

function parseArgs(argv) {
  const opts = { base: "milestone/m1", dir: DEFAULT_DIR, files: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--files") opts.files = argv[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.base || !opts.dir) throw new Error("missing option value");
    if (!opts.files) {
      const r = spawnSync(
        "git",
        [
          "diff",
          "--name-only",
          "--diff-filter=A",
          "--no-renames",
          "--relative",
          `${opts.base}...HEAD`,
          "--",
          ".",
        ],
        { cwd: opts.dir, encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(
          `git diff against ${opts.base} failed: ${r.stderr.trim()}`,
        );
      }
      opts.files = r.stdout
        .split("\n")
        .filter((f) => f.endsWith(".sql") && !f.includes("/"))
        .map((f) => basename(f))
        .sort();
    }
  } catch (err) {
    console.error(`check-migration-redefinitions: ${err.message}`);
    process.exit(2);
  }
  let lost;
  try {
    lost = findLost({ dir: opts.dir, newFiles: opts.files });
  } catch (err) {
    console.error(`check-migration-redefinitions: ${err.message}`);
    process.exit(2);
  }
  if (lost.length === 0) {
    console.log(
      `check-migration-redefinitions: ok (${opts.files.length} new migration(s))`,
    );
    return;
  }
  for (const l of lost) {
    console.error(
      `LOST ${l.file}:${l.line} ${l.object}\n  from ${l.from}: ${l.lost}`,
    );
  }
  console.error(
    `\n${lost.length} line(s) lost. If intentional, add "-- redefine-drops: <reason>" inside the new definition.`,
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
