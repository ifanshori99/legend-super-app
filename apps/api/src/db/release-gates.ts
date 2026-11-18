// Release gate 1 runner (legend-1100) and migration drift check (legend-fgg1h).
// Runs from predeploy-check, before migrations, against the live database.
//
// Reads only: one READ ONLY transaction that is always rolled back. Every
// failure message names gates and counts, never a URL, a password, a tenant id
// or the content of a row. Anything malformed fails closed.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientBase } from "pg";

/** An operator-facing gate failure. Its message never holds data from a row. */
export class ReleaseGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseGateError";
  }
}

export type JournalEntry = { idx: number; tag: string; when: number };

export type PreflightGate = {
  file: string;
  gate: string;
  before: string | null;
  requires: string[];
  mode: "block" | "info";
  resolve: string;
  sql: string;
};

export type ReleaseGateOptions = {
  migrationsFolder: string;
  preflightDir: string;
  /** Schema of drizzle's __drizzle_migrations table. Default "drizzle". */
  migrationsSchema?: string;
  /**
   * Table whose presence proves an app schema exists. An empty or missing
   * migrations table with this table present fails closed. Default
   * "public.tenants".
   */
  appSchemaProbe?: string;
  /** Drift allow-list. Default `<preflightDir>/drift-allow.json`. */
  driftAllowFile?: string;
  log?: (line: string) => void;
};

export type ReleaseGateReport =
  | { status: "n/a" }
  | {
      status: "ok";
      applied: number;
      ran: string[];
      skipped: {
        gate: string;
        reason: "before-applied" | "requires-missing";
      }[];
      info: { gate: string; rows: number }[];
    };

const DOC_POINTER = "Lihat docs/deployment.md#gerbang-rilis-1";
const PREFLIGHT_FILE = /^rilis1-.*\.sql$/;

export type DriftAllowEntry = {
  tag: string;
  hash: string;
  bead: string;
  reason: string;
};

/** Reads meta/_journal.json. Fails closed on a missing or malformed journal. */
export function readJournal(migrationsFolder: string): JournalEntry[] {
  const path = join(migrationsFolder, "meta", "_journal.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ReleaseGateError(
      "Jurnal migrasi (meta/_journal.json) tidak bisa dibaca.",
    );
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries))
    throw new ReleaseGateError("Jurnal migrasi tidak punya daftar entries.");
  return entries.map((raw: unknown) => {
    const entry = raw as { idx?: unknown; tag?: unknown; when?: unknown };
    if (
      typeof entry?.idx !== "number" ||
      typeof entry.tag !== "string" ||
      entry.tag === "" ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when)
    )
      throw new ReleaseGateError("Jurnal migrasi punya entri yang rusak.");
    return { idx: entry.idx, tag: entry.tag, when: entry.when };
  });
}

/** The same value drizzle's migrator stores: sha256 hex of the whole file. */
export function migrationHash(sqlText: string): string {
  return createHash("sha256").update(sqlText).digest("hex");
}

/**
 * Replaces comments and literals with blanks so keyword checks cannot be
 * fooled by text inside them. Returns null on an unterminated comment,
 * string or quoted identifier. Quoted identifiers keep their quotes.
 */
function stripSqlNoise(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.slice(i).search(/[\r\n]/);
      i = end === -1 ? sql.length : i + end;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) return null;
      out += " ";
    } else if (c === "'") {
      // E'...' strings treat a backslash as an escape; plain ones do not.
      const prev = sql[i - 1] ?? "";
      const before = sql[i - 2] ?? "";
      const escapes = /[eE]/.test(prev) && !/[A-Za-z0-9_$]/.test(before);
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          closed = true;
          i += 1;
          break;
        } else i += 1;
      }
      if (!closed) return null;
      out += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) return null;
      out += '""';
      i = end + 1;
    } else if (c === "$") {
      // Dollar quotes and `$` inside identifiers are ambiguous to a lexical
      // check; gate SQL has no use for them, so reject.
      return null;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|into|copy|call|do|set|create|alter|drop|truncate|grant|revoke|execute)\b/i;
const LOCKING_READ = /\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b/i;
const FUNCTION_CALL = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
const SAFE_PG_FUNCTIONS = new Set(["pg_typeof"]);
const SIDE_EFFECT_FUNCTIONS =
  /^(set_config|nextval|setval|currval|lastval|pg_.*|lo_.*|lo|dblink.*|txid_.*|ts_stat|ts_rewrite|query_to_xml.*|cursor_to_xml.*|table_to_xml.*|schema_to_xml.*|database_to_xml.*|brin_.*|gin_.*|pgstat.*)$/i;

/**
 * Gate SQL must be exactly one SELECT (or WITH ... SELECT): no other statement
 * kind, no writing CTE, no SELECT INTO, no locking read, no side-effect
 * function. Checked before anything runs, because READ ONLY and ROLLBACK do
 * not undo external effects such as COPY ... TO PROGRAM. Unsure means reject.
 * Returns the reason (never the SQL) or null when the SQL is acceptable.
 */
function readOnlySelectViolation(sql: string): string | null {
  const stripped = stripSqlNoise(sql);
  if (stripped === null)
    return "SQL punya komentar atau kutipan tak tertutup, atau memuat $";
  const body = stripped.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return "hanya satu statement yang boleh";
  if (!/^(select|with)\b/i.test(body)) return "hanya SELECT yang boleh";
  if (WRITE_KEYWORDS.test(body)) return "SQL memuat kata kunci non-SELECT";
  if (LOCKING_READ.test(body)) return "SELECT dengan kunci baris tidak boleh";
  if (/"\s*\(/.test(body)) return "nama fungsi berkutip tidak boleh";
  for (const match of body.matchAll(FUNCTION_CALL)) {
    const name = match[1] as string;
    if (
      SIDE_EFFECT_FUNCTIONS.test(name) &&
      !SAFE_PG_FUNCTIONS.has(name.toLowerCase())
    )
      return "fungsi berefek samping tidak boleh";
  }
  return null;
}

/**
 * Parses one rilis1-*.sql file. Header order is fixed (brief 1097):
 * gate, before, requires, mode, resolve, then one read-only SELECT.
 */
export function parsePreflightFile(file: string, text: string): PreflightGate {
  const bad = (why: string): never => {
    throw new ReleaseGateError(`Berkas gerbang ${file} rusak: ${why}.`);
  };
  const lines = text.split(/\r?\n/);
  const field = (index: number, name: string) => {
    const match = new RegExp(`^-- ${name}: (.+)$`).exec(lines[index] ?? "");
    return match ? (match[1] as string).trim() : bad(`baris ${name} salah`);
  };
  const gate = field(0, "gate");
  if (!/^legend-[a-z0-9]+$/.test(gate)) bad("id gate tidak sah");
  const beforeRaw = field(1, "before");
  if (!/^[A-Za-z0-9_]+$/.test(beforeRaw)) bad("nilai before tidak sah");
  const requires = field(2, "requires")
    .split(/\s*,\s*/)
    .map((table) => table.trim());
  for (const table of requires)
    if (!/^public\.[a-z_][a-z0-9_]*$/.test(table))
      bad("nilai requires tidak sah");
  const mode = field(3, "mode");
  if (mode !== "block" && mode !== "info") bad("mode tidak sah");
  const resolve = field(4, "resolve");
  const sql = lines.slice(5).join("\n").trim();
  if (sql === "") bad("tidak ada SQL");
  if (lines.slice(5).some((line) => line.trimStart().startsWith("\\")))
    bad("meta psql tidak boleh");
  const violation = readOnlySelectViolation(sql);
  if (violation) bad(violation);
  return {
    file,
    gate,
    before: beforeRaw === "none" ? null : beforeRaw,
    requires,
    mode: mode as "block" | "info",
    resolve,
    sql,
  };
}

function quotedSchema(schema: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))
    throw new ReleaseGateError("Nama skema migrasi tidak sah.");
  return `"${schema}"`;
}

async function relationExists(client: ClientBase, name: string) {
  const result = await client.query("SELECT to_regclass($1) AS rel", [name]);
  return result.rows[0]?.rel !== null;
}

type AppliedRow = { hash: string; created_at: string };

async function appliedMigrations(client: ClientBase, schema: string) {
  const result = await client.query(
    `SELECT hash, created_at::text AS created_at FROM ${quotedSchema(schema)}.__drizzle_migrations`,
  );
  return result.rows as AppliedRow[];
}

function journalByWhen(migrationsFolder: string) {
  const byWhen = new Map<string, JournalEntry>();
  const journal = readJournal(migrationsFolder);
  for (const entry of journal) {
    const key = String(entry.when);
    if (byWhen.has(key))
      throw new ReleaseGateError(
        `Jurnal migrasi punya when ganda (${entry.tag}).`,
      );
    byWhen.set(key, entry);
  }
  return { journal, byWhen };
}

/**
 * Reads the drift allow-list. Fail closed: a missing file, bad JSON, a bad
 * shape, a tag the journal does not know or a hash that is not 64 hex chars
 * all throw. Only an exact (tag, hash) pair is ever accepted.
 */
export function readDriftAllow(
  file: string,
  journal: JournalEntry[],
): Map<string, DriftAllowEntry[]> {
  const bad = (why: string): never => {
    throw new ReleaseGateError(`Daftar drift-allow rusak: ${why}.`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return bad("berkas tidak ada atau bukan JSON");
  }
  if (!Array.isArray(parsed)) return bad("bukan array");
  const tags = new Set(journal.map((entry) => entry.tag));
  const allow = new Map<string, DriftAllowEntry[]>();
  for (const raw of parsed as unknown[]) {
    const entry = raw as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return bad("entri bukan objek");
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "bead,hash,reason,tag") return bad("field entri salah");
    const { tag, hash, bead, reason } = entry;
    if (typeof tag !== "string" || !tags.has(tag))
      return bad("tag tidak ada di jurnal");
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
      return bad("hash bukan 64 hex");
    if (typeof bead !== "string" || !/^legend-[a-z0-9]+$/.test(bead))
      return bad("bead tidak sah");
    if (typeof reason !== "string" || reason.trim() === "")
      return bad("reason kosong");
    allow.set(tag, [...(allow.get(tag) ?? []), { tag, hash, bead, reason }]);
  }
  return allow;
}

function driftAllowPath(opts: ReleaseGateOptions) {
  return opts.driftAllowFile ?? join(opts.preflightDir, "drift-allow.json");
}

function driftOf(
  rows: AppliedRow[],
  opts: ReleaseGateOptions,
  journal: JournalEntry[],
  byWhen: Map<string, JournalEntry>,
  allow: Map<string, DriftAllowEntry[]>,
) {
  const log = opts.log ?? (() => undefined);
  const drifted: string[] = [];
  const appliedAt = new Set<string>();
  let newest = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const key = String(row.created_at);
    appliedAt.add(key);
    newest = Math.max(newest, Number(key));
    const entry = byWhen.get(key);
    if (!entry) {
      drifted.push(`unknown@${key}`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(
        join(opts.migrationsFolder, `${entry.tag}.sql`),
        "utf8",
      );
    } catch {
      throw new ReleaseGateError(`Berkas migrasi ${entry.tag}.sql tidak ada.`);
    }
    if (migrationHash(text) === row.hash) continue;
    const allowed = allow
      .get(entry.tag)
      ?.find((candidate) => candidate.hash === row.hash);
    if (allowed) log(`drift diizinkan: ${entry.tag} (${allowed.bead})`);
    else drifted.push(entry.tag);
  }
  // Drizzle only runs a journal entry newer than the newest applied one, so an
  // older entry with no row would never run. That is drift too.
  for (const entry of journal)
    if (entry.when < newest && !appliedAt.has(String(entry.when)))
      drifted.push(`missing:${entry.tag}`);
  if (drifted.length > 0)
    throw new ReleaseGateError(
      `drift migrasi (legend-fgg1h): ${drifted.join(", ")}`,
    );
}

/**
 * Compares every applied migration with the journal and the file on disk.
 * A different hash, a created_at the journal does not know, or a journal entry
 * older than the newest applied one that has no row is drift. An exact
 * (tag, hash) pair in the allow-list is accepted.
 */
export async function checkMigrationDrift(
  client: ClientBase,
  opts: ReleaseGateOptions,
): Promise<{ applied: number }> {
  const schema = opts.migrationsSchema ?? "drizzle";
  const table = `${quotedSchema(schema)}.__drizzle_migrations`;
  if (!(await relationExists(client, table))) return { applied: 0 };
  const rows = await appliedMigrations(client, schema);
  const { journal, byWhen } = journalByWhen(opts.migrationsFolder);
  const allow = readDriftAllow(driftAllowPath(opts), journal);
  driftOf(rows, opts, journal, byWhen, allow);
  return { applied: rows.length };
}

/** Runs the drift check and every rilis1-*.sql gate. Rolls back always. */
export async function runReleaseGates(
  client: ClientBase,
  opts: ReleaseGateOptions,
): Promise<ReleaseGateReport> {
  const log = opts.log ?? (() => undefined);
  const schema = opts.migrationsSchema ?? "drizzle";
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL row_security = off");
    await client.query("SET LOCAL search_path = public");
    await client.query("SET LOCAL statement_timeout = '120s'");
    // The gate SQL check reads a plain '...' string as having no escapes.
    await client.query("SET LOCAL standard_conforming_strings = on");

    const tableName = `${quotedSchema(schema)}.__drizzle_migrations`;
    const rows = (await relationExists(client, tableName))
      ? await appliedMigrations(client, schema)
      : [];
    if (rows.length === 0) {
      // N/A only for a truly new database. Empty or missing migrations table
      // beside an existing app schema means the history was lost: fail closed.
      const probe = opts.appSchemaProbe ?? "public.tenants";
      if (await relationExists(client, probe))
        throw new ReleaseGateError(
          "tabel migrasi drizzle tidak ada/kosong padahal skema aplikasi ada",
        );
      log("gerbang data rilis 1: N/A (DB baru)");
      return { status: "n/a" };
    }

    const { journal, byWhen } = journalByWhen(opts.migrationsFolder);
    const allow = readDriftAllow(driftAllowPath(opts), journal);
    driftOf(rows, opts, journal, byWhen, allow);
    const appliedAt = new Set(rows.map((row) => String(row.created_at)));

    if (!existsSync(opts.preflightDir))
      throw new ReleaseGateError(
        "Folder gerbang rilis 1 (scripts/preflight) tidak ada di image.",
      );
    const gates = readdirSync(opts.preflightDir)
      .filter((name) => PREFLIGHT_FILE.test(name))
      .sort()
      .map((name) =>
        parsePreflightFile(
          name,
          readFileSync(join(opts.preflightDir, name), "utf8"),
        ),
      );
    const tags = new Map(journal.map((entry) => [entry.tag, entry]));
    for (const gate of gates)
      if (gate.before !== null && !tags.has(gate.before))
        throw new ReleaseGateError(
          `Gerbang ${gate.gate} menyebut migrasi before yang tidak ada di jurnal.`,
        );

    const ran: string[] = [];
    const skipped: {
      gate: string;
      reason: "before-applied" | "requires-missing";
    }[] = [];
    const info: { gate: string; rows: number }[] = [];
    const failed: string[] = [];

    for (const gate of gates) {
      const before = gate.before === null ? undefined : tags.get(gate.before);
      if (before && appliedAt.has(String(before.when))) {
        skipped.push({ gate: gate.gate, reason: "before-applied" });
        log(`gerbang ${gate.gate} dilewati (before-applied)`);
        continue;
      }
      let missing = false;
      for (const table of gate.requires)
        if (!(await relationExists(client, table))) missing = true;
      if (missing) {
        skipped.push({ gate: gate.gate, reason: "requires-missing" });
        log(`gerbang ${gate.gate} dilewati (requires-missing)`);
        continue;
      }

      await client.query("SAVEPOINT release_gate");
      let count: number;
      try {
        // Extended protocol: a file with more than one statement is an error.
        const config = { text: gate.sql, queryMode: "extended" as const };
        const result = await client.query(config);
        count = result.rowCount ?? result.rows.length;
      } catch {
        await client
          .query("ROLLBACK TO SAVEPOINT release_gate")
          .catch(() => undefined);
        throw new ReleaseGateError(
          `Gerbang ${gate.gate} gagal dijalankan (SQL error).`,
        );
      }
      await client.query("RELEASE SAVEPOINT release_gate");
      ran.push(gate.gate);
      if (gate.mode === "info") {
        info.push({ gate: gate.gate, rows: count });
        log(`gerbang ${gate.gate} (info): ${count} baris`);
      } else if (count > 0) {
        failed.push(`${gate.gate} (${count} baris)`);
      }
    }

    if (failed.length > 0)
      throw new ReleaseGateError(
        `gerbang data rilis 1 gagal: ${failed.join(", ")}. ${DOC_POINTER}`,
      );
    return { status: "ok", applied: rows.length, ran, skipped, info };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}
