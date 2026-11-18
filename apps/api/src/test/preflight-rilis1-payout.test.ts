// Release 1 payout/reconciliation pre-deploy gates (gate card legend-1097).
// Written from the shared brief (scripts/preflight contract), not from the SQL:
//  - legend-0go0p: block, before 0381_payout_pending_settle_return_claims
//  - legend-7hg1q: block, before 0463_payout_990_return_bank_ref
//  - legend-9bfh7: block, before 0395_payout_proof_bindings
//  - legend-ofu02: info,  before none
//  - header test for the four files
//  - migration 0464 (flag fingerprint backfill) run on a pre-0464 shaped flag
//
// Method (convention of preflight-0301.test.ts): each SQL file names its tables
// without a schema, so a TEMP clone of every table the card may read shadows the
// public one for the transaction. The clone is built from the m1 tip shape and
// then pushed back to the pre-`before` shape (columns added by a later
// migration are dropped), so a query that reads a column from the future fails
// here and not on the release database. Constraints are not copied and NOT NULL
// is lifted on the clones: the gate must find legacy rows that today's
// constraints would refuse. Everything ends in ROLLBACK; public tables are
// never written (except migration 0464, itself rolled back).
//
// Output contract of every query: tenant_id uuid, reason text, row_count bigint,
// ids uuid[] (ORDER BY id). Zero rows = clean. Reason codes are not pinned by
// this file (the brief leaves them to the author), only their shape, except
// ofu02 whose reason is fixed by the brief (`missing_without_source`).
// 9bfh7 reasons are `<reason>:<kind>` (kind = the operation table that the id
// belongs to, e.g. `missing_stored_hash:correction`); only the reason names the
// fix brief fixes are pinned there: record_hash_mismatch,
// hash_shared_across_operations, payment_proof_without_record.
//
// Assumptions (spec/brief ambiguity):
//  - Which table's id lands in `ids` is not pinned for 0go0p and 9bfh7 (items,
//    claims, evidence files, proposals or corrections are all fair "problem
//    rows"); those tests require at least one seeded problem row id to appear
//    and that the clean bystander ids never appear. 7hg1q and ofu02 name their
//    row (the open claim / the case), so they assert the exact id set.
//  - A return key shared by two pending returns in ONE batch is one operation
//    (clean); in two batches it is a double claim (flagged).
//  - Per the money rule ("when in doubt, raise a row"), a fully returned item's
//    key reused by a pending return in another batch is flagged.
// PREFLIGHT_SQL_DIR overrides the directory of the four files (fail-first run
// against stub files that select zero rows).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const sqlDir = process.env.PREFLIGHT_SQL_DIR
  ? resolve(process.env.PREFLIGHT_SQL_DIR)
  : resolve(import.meta.dirname, "../../../../scripts/preflight");
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");

const ITEMS = "payroll_disbursement_items";
const CLAIMS = "payroll_payout_return_claims";
const FILES = "payroll_payout_evidence_files";
const PROPOSALS = "payroll_payout_overpaid_proposals";
const CORRECTIONS = "payroll_payout_failed_corrections";
const CASES = "payment_reconciliation_cases";

interface Card {
  id: string;
  file: string;
  before: string;
  mode: "block" | "info";
  /** Tables the query may read; each gets a TEMP clone. */
  tables: string[];
  /** Columns added by a migration at or after `before`: gone before the migration. */
  futureColumns: Record<string, string[]>;
}

const CARDS = {
  "0go0p": {
    id: "legend-0go0p",
    file: "rilis1-legend-0go0p.sql",
    before: "0381_payout_pending_settle_return_claims",
    mode: "block",
    // Claims table is created by 0381 itself: it cannot be read before it.
    tables: [ITEMS],
    futureColumns: { [ITEMS]: ["return_claim_id", "return_bank_ref"] },
  },
  "7hg1q": {
    id: "legend-7hg1q",
    file: "rilis1-legend-7hg1q.sql",
    before: "0463_payout_990_return_bank_ref",
    mode: "block",
    tables: [CLAIMS, ITEMS],
    futureColumns: { [CLAIMS]: ["withdrawn_at"] },
  },
  "9bfh7": {
    id: "legend-9bfh7",
    file: "rilis1-legend-9bfh7.sql",
    before: "0395_payout_proof_bindings",
    mode: "block",
    // The binding and hash tables are created by 0395 itself.
    tables: [FILES, CLAIMS, PROPOSALS, CORRECTIONS, ITEMS],
    futureColumns: {
      [CLAIMS]: ["bank_ref", "withdrawn_at"],
      [ITEMS]: ["return_bank_ref"],
      [PROPOSALS]: ["withdrawn_by", "withdrawn_at"],
      [CORRECTIONS]: ["withdrawn_by", "withdrawn_at"],
    },
  },
  ofu02: {
    id: "legend-ofu02",
    file: "rilis1-legend-ofu02.sql",
    before: "none",
    mode: "info",
    tables: [CASES],
    futureColumns: {},
  },
} satisfies Record<string, Card>;

type CardKey = keyof typeof CARDS;

interface GateRow {
  tenant_id: string;
  reason: string;
  row_count: string;
  ids: string[];
}

const sqlOf = (card: CardKey) =>
  readFileSync(resolve(sqlDir, CARDS[card].file), "utf8");

// ---- fixtures -----------------------------------------------------------------

const uid = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T1 = "b0000000-0000-4000-8000-000000000001";
const T2 = "b0000000-0000-4000-8000-000000000002";
const sha = (seed: string) =>
  seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
const itemSetHash = (seed: string) => sha(seed);

async function seed(
  client: PoolClient,
  table: string,
  row: Record<string, unknown>,
) {
  const cols = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

const item = (o: {
  id: string;
  tenant?: string;
  batch: string;
  status?: string;
  returnedBy?: string | null;
  returnedBy2?: string | null;
  returnKey?: string | null;
  confirmKey?: string | null;
  resolutionKey?: string | null;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  batch_id: o.batch,
  status: o.status ?? "succeeded",
  returned_by: o.returnedBy ?? null,
  returned_by_2: o.returnedBy2 ?? null,
  return_evidence_key: o.returnKey ?? null,
  confirmation_evidence_key: o.confirmKey ?? null,
  resolution_evidence_key: o.resolutionKey ?? null,
});

/** An item whose return waits for its second signer. */
const pendingReturn = (id: string, batch: string, key: string, tenant = T1) =>
  item({
    id,
    tenant,
    batch,
    returnedBy: "finance-one",
    returnedBy2: null,
    returnKey: key,
  });

const claim = (o: {
  id: string;
  tenant?: string;
  batch?: string;
  key?: string;
  status?: string;
  bankRef?: string | null;
  content?: string | null;
  stored?: string | null;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  batch_id: o.batch ?? randomUUID(),
  evidence_key: o.key ?? `claim-key-${o.id}`,
  item_set_hash: itemSetHash(o.id.slice(-2)),
  status: o.status ?? "open",
  created_by: "finance-one",
  consumed_at: o.status === "consumed" ? new Date().toISOString() : null,
  // Only a claim that has a reference writes the column: 9bfh7 runs on a shape
  // where bank_ref (added by 0460) does not exist yet.
  ...(typeof o.bankRef === "string" ? { bank_ref: o.bankRef } : {}),
  content_sha256: o.content ?? null,
  stored_sha256: o.stored ?? null,
});

const file = (o: {
  id: string;
  tenant?: string;
  batch?: string;
  key: string;
  content: string;
  stored: string | null;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  batch_id: o.batch ?? randomUUID(),
  evidence_key: o.key,
  content_sha256: o.content,
  stored_sha256: o.stored,
  created_by: "finance-one",
});

const proposal = (o: {
  id: string;
  tenant?: string;
  batch?: string;
  key: string;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  batch_id: o.batch ?? randomUUID(),
  item_id: randomUUID(),
  evidence_key: o.key,
  note: "overpaid",
  status: "proposed",
  proposed_by: "finance-one",
});

const correction = (o: {
  id: string;
  tenant?: string;
  batch?: string;
  key: string;
  content: string;
  stored: string;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  batch_id: o.batch ?? randomUUID(),
  item_id: randomUUID(),
  // A failed-item correction is its own operation: operation_id = id.
  operation_id: o.id,
  evidence_key: o.key,
  content_sha256: o.content,
  stored_sha256: o.stored,
  note: "correction",
  status: "proposed",
  proposed_by: "finance-one",
});

const reconCase = (o: {
  id: string;
  tenant?: string;
  line?: string | null;
  source?: string | null;
}) => ({
  id: o.id,
  tenant_id: o.tenant ?? T1,
  outlet_id: randomUUID(),
  settlement_id: randomUUID(),
  settlement_line_id: o.line ?? null,
  source_transaction_id: o.source ?? null,
  source: "gateway",
  provider: "provider-x",
  reference: `ref-${o.id.slice(-4)}`,
  period_start: "2026-01-01",
  period_end: "2026-01-31",
  expected_idr: 100000,
  received_idr: 0,
  variance_idr: -100000,
  reason: "missing_settlement",
  status: "open",
});

// ---- harness ------------------------------------------------------------------

async function columnsOf(client: PoolClient, table: string) {
  const { rows } = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`pg_temp.${table}`],
  );
  return rows.map((r) => r.attname);
}

/** Runs `run` on TEMP clones in the shape that exists just before the card's migration. */
async function inPreShape(
  card: CardKey,
  run: (client: PoolClient) => Promise<void>,
) {
  const def: Card = CARDS[card];
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    for (const table of def.tables) {
      await client.query(
        `CREATE TEMP TABLE ${table}
           (LIKE public.${table} INCLUDING DEFAULTS EXCLUDING CONSTRAINTS EXCLUDING INDEXES)
           ON COMMIT DROP`,
      );
      // Legacy rows predate today's NOT NULL columns: lift them on the clone.
      await client.query(
        `DO $relax$
         DECLARE c record;
         BEGIN
           FOR c IN SELECT a.attname FROM pg_attribute a
                     WHERE a.attrelid = to_regclass('pg_temp.${table}')
                       AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
           LOOP
             EXECUTE format('ALTER TABLE pg_temp.%I ALTER COLUMN %I DROP NOT NULL',
                            '${table}', c.attname);
           END LOOP;
         END $relax$`,
      );
      for (const column of def.futureColumns[table] ?? [])
        await client.query(
          `ALTER TABLE pg_temp.${table} DROP COLUMN IF EXISTS "${column}"`,
        );
      const left = await columnsOf(client, table);
      for (const column of def.futureColumns[table] ?? [])
        expect(
          left,
          `${table}.${column} is a post-${def.before} column`,
        ).not.toContain(column);
    }
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Runs the card's SQL; checks the shared output contract; returns the rows. */
async function gate(client: PoolClient, card: CardKey): Promise<GateRow[]> {
  const sql = sqlOf(card);
  const requires = /^-- requires: (.+)$/m
    .exec(sql)?.[1]
    ?.split(",")
    .map((t) => t.trim().replace(/^public\./, ""));
  expect(requires, "requires header present").toBeDefined();
  for (const table of requires ?? [])
    expect(
      CARDS[card].tables,
      `${table} is read by the gate: it must exist before ${CARDS[card].before}`,
    ).toContain(table);
  const result = await client.query<GateRow>(sql);
  expect(Array.isArray(result), "one statement only").toBe(false);
  expect(result.fields.map((f) => f.name)).toEqual([
    "tenant_id",
    "reason",
    "row_count",
    "ids",
  ]);
  for (const row of result.rows) {
    // 9bfh7 mixes four tables in `ids`: its reason carries the kind after a colon.
    expect(row.reason).toMatch(
      card === "9bfh7"
        ? /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
        : /^[a-z][a-z0-9_]*$/,
    );
    expect(row.row_count).toMatch(/^[1-9][0-9]*$/);
    expect(row.ids.length).toBeGreaterThan(0);
    expect(row.ids, "ids ORDER BY id").toEqual([...row.ids].sort());
    for (const id of row.ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
  }
  return result.rows;
}

const idsOf = (rows: GateRow[], tenant: string) =>
  rows
    .filter((r) => r.tenant_id === tenant)
    .flatMap((r) => r.ids)
    .sort();
const tenantsOf = (rows: GateRow[]) =>
  [...new Set(rows.map((r) => r.tenant_id))].sort();

function expectFlagsAny(rows: GateRow[], tenant: string, problem: string[]) {
  const flagged = idsOf(rows, tenant);
  expect(
    flagged.some((id) => problem.includes(id)),
    `tenant ${tenant}: one of ${problem.join(", ")} must be listed, got ${JSON.stringify(rows)}`,
  ).toBe(true);
}

/** A row of `tenant` whose reason starts with `prefix` and lists one of `problem`. */
function expectReason(
  rows: GateRow[],
  tenant: string,
  problem: string[],
  prefix: string,
) {
  expect(
    rows.some(
      (r) =>
        r.tenant_id === tenant &&
        r.reason.startsWith(prefix) &&
        r.ids.some((id) => problem.includes(id)),
    ),
    `tenant ${tenant}: a ${prefix}* row listing one of ${problem.join(", ")} expected, got ${JSON.stringify(rows)}`,
  ).toBe(true);
}

function expectNoLeak(rows: GateRow[], secrets: string[]) {
  const text = JSON.stringify(rows);
  for (const secret of secrets)
    expect(text, "output carries ids and counts only").not.toContain(secret);
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

// ---- header -------------------------------------------------------------------

describe("[legend-1097] rilis 1 payout preflight files: header and read-only shape", () => {
  for (const key of Object.keys(CARDS) as CardKey[]) {
    const card = CARDS[key];
    it(`[${card.id}] ${card.file} has the five header lines in order and one read-only SELECT`, () => {
      const lines = sqlOf(key).split("\n");
      expect(lines[0]).toBe(`-- gate: ${card.id}`);
      expect(lines[1]).toBe(`-- before: ${card.before}`);
      expect(lines[2]).toMatch(
        /^-- requires: public\.[a-z0-9_]+(, public\.[a-z0-9_]+)*$/,
      );
      expect(lines[3]).toBe(`-- mode: ${card.mode}`);
      expect(lines[4]).toMatch(/^-- resolve: \S.*$/);
      if (card.before !== "none")
        expect(
          existsSync(resolve(drizzleDir, `${card.before}.sql`)),
          `${card.before} is a migration tag of this release`,
        ).toBe(true);

      const body = lines
        .slice(5)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      expect(body).toMatch(/^(select|with)\b/i);
      // One statement: at most the closing semicolon.
      expect(body.replace(/;\s*$/, "")).not.toContain(";");
      expect(body, "psql meta command").not.toMatch(/^\\/m);
      expect(body, "tables carry no schema").not.toMatch(/\bpublic\./i);
      expect(body, "read-only").not.toMatch(
        /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i,
      );
    });
  }
});

// ---- legend-0go0p -------------------------------------------------------------

describe("[legend-0go0p] return proof reuse before 0381 (block)", () => {
  const B1 = uid(0x101);
  const B2 = uid(0x102);

  it("[legend-0go0p] flags a pending return whose proof is also pending in another batch", async () => {
    await inPreShape("0go0p", async (client) => {
      await seed(
        client,
        ITEMS,
        pendingReturn(uid(1), B1, "SECRET-RETURN-KEY-A"),
      );
      await seed(
        client,
        ITEMS,
        pendingReturn(uid(2), B2, "SECRET-RETURN-KEY-A"),
      );
      await seed(client, ITEMS, pendingReturn(uid(3), B1, "unique-return-key"));
      const rows = await gate(client, "0go0p");
      expectFlagsAny(rows, T1, [uid(1), uid(2)]);
      expect(idsOf(rows, T1)).not.toContain(uid(3));
      expectNoLeak(rows, ["SECRET-RETURN-KEY-A", "finance-one"]);
    });
  });

  it("[legend-0go0p] flags a pending return proof that a payment confirmation also uses", async () => {
    await inPreShape("0go0p", async (client) => {
      await seed(
        client,
        ITEMS,
        pendingReturn(uid(4), B1, "shared-with-confirm"),
      );
      await seed(
        client,
        ITEMS,
        item({ id: uid(5), batch: B2, confirmKey: "shared-with-confirm" }),
      );
      await seed(client, ITEMS, pendingReturn(uid(6), B1, "alone"));
      const rows = await gate(client, "0go0p");
      expectFlagsAny(rows, T1, [uid(4), uid(5)]);
      expect(idsOf(rows, T1)).not.toContain(uid(6));
    });
  });

  it("[legend-0go0p] flags a pending return proof that a failure resolution also uses", async () => {
    await inPreShape("0go0p", async (client) => {
      await seed(
        client,
        ITEMS,
        pendingReturn(uid(7), B1, "shared-with-resolution"),
      );
      await seed(
        client,
        ITEMS,
        item({
          id: uid(8),
          batch: B1,
          status: "failed",
          resolutionKey: "shared-with-resolution",
        }),
      );
      const rows = await gate(client, "0go0p");
      expectFlagsAny(rows, T1, [uid(7), uid(8)]);
    });
  });

  it("[legend-0go0p] flags a pending return that reuses the proof of a fully returned item in another batch", async () => {
    await inPreShape("0go0p", async (client) => {
      await seed(
        client,
        ITEMS,
        item({
          id: uid(9),
          batch: B1,
          status: "returned",
          returnedBy: "finance-one",
          returnedBy2: "finance-two",
          returnKey: "reused-after-return",
        }),
      );
      await seed(
        client,
        ITEMS,
        pendingReturn(uid(10), B2, "reused-after-return"),
      );
      const rows = await gate(client, "0go0p");
      expectFlagsAny(rows, T1, [uid(9), uid(10)]);
    });
  });

  it("[legend-0go0p] reports each tenant on its own", async () => {
    await inPreShape("0go0p", async (client) => {
      await seed(client, ITEMS, pendingReturn(uid(11), B1, "dup-t1"));
      await seed(client, ITEMS, pendingReturn(uid(12), B2, "dup-t1"));
      await seed(client, ITEMS, pendingReturn(uid(13), B1, "dup-t2", T2));
      await seed(client, ITEMS, pendingReturn(uid(14), B2, "dup-t2", T2));
      const rows = await gate(client, "0go0p");
      expect(tenantsOf(rows)).toEqual([T1, T2]);
    });
  });

  it("[legend-0go0p] passes clean data: no items, unique proofs, one operation in one batch, other tenants", async () => {
    await inPreShape("0go0p", async (client) => {
      expect(await gate(client, "0go0p"), "empty tables").toEqual([]);
      // Two items of ONE return operation share its proof inside one batch.
      await seed(client, ITEMS, pendingReturn(uid(21), B1, "one-operation"));
      await seed(client, ITEMS, pendingReturn(uid(22), B1, "one-operation"));
      // Other pending returns, each with its own proof.
      await seed(client, ITEMS, pendingReturn(uid(23), B1, "own-key-1"));
      await seed(client, ITEMS, pendingReturn(uid(24), B2, "own-key-2"));
      // Fully returned items, each with its own proof.
      await seed(
        client,
        ITEMS,
        item({
          id: uid(25),
          batch: B2,
          status: "returned",
          returnedBy: "finance-one",
          returnedBy2: "finance-two",
          returnKey: "returned-key",
        }),
      );
      // Items with no return at all, confirmation and resolution keys unique.
      await seed(
        client,
        ITEMS,
        item({ id: uid(26), batch: B1, confirmKey: "confirm-1" }),
      );
      await seed(
        client,
        ITEMS,
        item({ id: uid(27), batch: B2, resolutionKey: "resolve-1" }),
      );
      // The same key text in another tenant is another tenant's proof.
      await seed(client, ITEMS, pendingReturn(uid(28), B1, "own-key-1", T2));
      expect(await gate(client, "0go0p")).toEqual([]);
    });
  });
});

// ---- legend-7hg1q -------------------------------------------------------------

describe("[legend-7hg1q] open return claims without a bank reference before 0463 (block)", () => {
  it("[legend-7hg1q] lists each open claim without bank_ref, per tenant, and nothing else", async () => {
    await inPreShape("7hg1q", async (client) => {
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(1), key: "SECRET-CLAIM-KEY" }),
      );
      await seed(client, CLAIMS, claim({ id: uid(2) }));
      await seed(client, CLAIMS, claim({ id: uid(3), tenant: T2 }));
      // Bystanders: not blocked by the 0463 rule.
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(4), bankRef: "BANKREF-0001" }),
      );
      await seed(client, CLAIMS, claim({ id: uid(5), status: "consumed" }));
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(6), status: "consumed", bankRef: "BANKREF-0002" }),
      );
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(7), tenant: T2, bankRef: "BANKREF-0003" }),
      );
      const rows = await gate(client, "7hg1q");
      expect(tenantsOf(rows)).toEqual([T1, T2]);
      expect(idsOf(rows, T1)).toEqual([uid(1), uid(2)]);
      expect(idsOf(rows, T2)).toEqual([uid(3)]);
      expect(
        rows
          .filter((r) => r.tenant_id === T1)
          .reduce((n, r) => n + Number(r.row_count), 0),
      ).toBe(2);
      expectNoLeak(rows, ["SECRET-CLAIM-KEY", "BANKREF-0001", "finance-one"]);
    });
  });

  it("[legend-7hg1q] passes when every open claim carries a bank reference", async () => {
    await inPreShape("7hg1q", async (client) => {
      expect(await gate(client, "7hg1q"), "no claims at all").toEqual([]);
      await seed(client, CLAIMS, claim({ id: uid(11), bankRef: "REF-A" }));
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(12), tenant: T2, bankRef: "REF-B" }),
      );
      // A claim already consumed is not blocked even without a reference.
      await seed(client, CLAIMS, claim({ id: uid(13), status: "consumed" }));
      expect(await gate(client, "7hg1q")).toEqual([]);
    });
  });
});

// ---- legend-9bfh7 -------------------------------------------------------------

describe("[legend-9bfh7] proofs that would stall the binding backfill before 0395 (block)", () => {
  /** A clean operation: own key, own file, own hashes. Never reported. */
  async function bystander(client: PoolClient, n: number, tenant = T1) {
    const key = `clean-key-${n}`;
    await seed(
      client,
      FILES,
      file({
        id: uid(0x900 + n),
        tenant,
        key,
        content: sha(`c${n}`),
        stored: sha(`d${n}`),
      }),
    );
    await seed(
      client,
      CLAIMS,
      claim({
        id: uid(0x800 + n),
        tenant,
        key,
        status: "consumed",
        content: sha(`c${n}`),
        stored: sha(`d${n}`),
      }),
    );
    return [uid(0x900 + n), uid(0x800 + n)];
  }

  it("[legend-9bfh7] flags one content hash backing two operations of the same tenant", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 1);
      const same = sha("e");
      await seed(
        client,
        FILES,
        file({
          id: uid(1),
          key: "SECRET-PROOF-1",
          content: same,
          stored: sha("1"),
        }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(2),
          key: "SECRET-PROOF-2",
          content: same,
          stored: sha("2"),
        }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(3),
          key: "SECRET-PROOF-1",
          status: "consumed",
          content: same,
          stored: sha("1"),
        }),
      );
      await seed(
        client,
        PROPOSALS,
        proposal({ id: uid(4), key: "SECRET-PROOF-2" }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(1), uid(2), uid(3), uid(4)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
      expectNoLeak(rows, ["SECRET-PROOF-1", "SECRET-PROOF-2", same]);
    });
  });

  it("[legend-9bfh7] flags one stored hash shared by a return and a failed-item correction", async () => {
    await inPreShape("9bfh7", async (client) => {
      const stored = sha("f");
      await seed(
        client,
        FILES,
        file({ id: uid(11), key: "proof-r", content: sha("3"), stored }),
      );
      await seed(
        client,
        FILES,
        file({ id: uid(12), key: "proof-c", content: sha("4"), stored }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(13),
          key: "proof-r",
          status: "consumed",
          content: sha("3"),
          stored,
        }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({ id: uid(14), key: "proof-c", content: sha("4"), stored }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(11), uid(12), uid(13), uid(14)]);
    });
  });

  it("[legend-9bfh7] flags one hash backing operations of two different tenants, in both", async () => {
    await inPreShape("9bfh7", async (client) => {
      const same = sha("a1");
      await seed(
        client,
        FILES,
        file({
          id: uid(21),
          tenant: T1,
          key: "t1-proof",
          content: same,
          stored: sha("5"),
        }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(22),
          tenant: T2,
          key: "t2-proof",
          content: same,
          stored: sha("6"),
        }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(23),
          tenant: T1,
          key: "t1-proof",
          status: "consumed",
          content: same,
          stored: sha("5"),
        }),
      );
      await seed(
        client,
        PROPOSALS,
        proposal({ id: uid(24), tenant: T2, key: "t2-proof" }),
      );
      const rows = await gate(client, "9bfh7");
      expect(tenantsOf(rows)).toEqual([T1, T2]);
      expectFlagsAny(rows, T1, [uid(21), uid(23)]);
      expectFlagsAny(rows, T2, [uid(22), uid(24)]);
    });
  });

  it("[legend-9bfh7] flags a proof whose upload record has no stored hash (unreadable)", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 2);
      await seed(
        client,
        FILES,
        file({
          id: uid(31),
          key: "unreadable",
          content: sha("7"),
          stored: null,
        }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(32),
          key: "unreadable",
          status: "consumed",
          content: sha("7"),
          stored: null,
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(31), uid(32)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  it("[legend-9bfh7] flags a return proof key that has no upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 3);
      await seed(
        client,
        CLAIMS,
        claim({ id: uid(41), key: "no-file-for-this-key", status: "consumed" }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(41)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  it("[legend-9bfh7] flags an overpaid proposal whose proof key has no upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 7);
      await seed(
        client,
        PROPOSALS,
        proposal({ id: uid(51), key: "overpaid-no-file" }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(51)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  it("[legend-9bfh7] flags a failed-item correction whose proof key has no upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 8);
      await seed(
        client,
        CORRECTIONS,
        correction({
          id: uid(52),
          key: "correction-no-file",
          content: sha("8"),
          stored: sha("9"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(52)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  // A correction carries its own hashes; the 0395 binding demands an upload
  // record with the same content and stored hash, else PAYOUT-35 and a
  // permanent stall.
  it("[legend-9bfh7] flags a correction whose upload record has another content hash", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 9);
      await seed(
        client,
        FILES,
        file({
          id: uid(53),
          key: "corr-content",
          content: sha("c1"),
          stored: sha("c2"),
        }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({
          id: uid(54),
          key: "corr-content",
          content: sha("c3"),
          stored: sha("c2"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(rows, T1, [uid(53), uid(54)], "record_hash_mismatch");
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  it("[legend-9bfh7] flags a correction whose upload record has another stored hash", async () => {
    await inPreShape("9bfh7", async (client) => {
      await seed(
        client,
        FILES,
        file({
          id: uid(55),
          key: "corr-stored",
          content: sha("c4"),
          stored: sha("c5"),
        }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({
          id: uid(56),
          key: "corr-stored",
          content: sha("c4"),
          stored: sha("c6"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(rows, T1, [uid(55), uid(56)], "record_hash_mismatch");
    });
  });

  it("[legend-9bfh7] flags a correction whose upload record has no stored hash", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 10);
      await seed(
        client,
        FILES,
        file({
          id: uid(57),
          key: "corr-null-stored",
          content: sha("c7"),
          stored: null,
        }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({
          id: uid(58),
          key: "corr-null-stored",
          content: sha("c7"),
          stored: sha("c8"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(57), uid(58)]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
    });
  });

  it("[legend-9bfh7] flags a return claim whose own hash differs from its upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      await seed(
        client,
        FILES,
        file({
          id: uid(59),
          key: "claim-mismatch",
          content: sha("d1"),
          stored: sha("d2"),
        }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(60),
          key: "claim-mismatch",
          status: "consumed",
          content: sha("d3"),
          stored: sha("d2"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(rows, T1, [uid(59), uid(60)], "record_hash_mismatch");
    });
  });

  // Same file content under another key: a payment confirmation proof reused
  // as a return / overpaid / correction proof pays twice on the same paper.
  it("[legend-9bfh7] flags a return proof that has the same content as a payment confirmation proof under another key", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 11);
      const same = sha("e1");
      await seed(
        client,
        FILES,
        file({
          id: uid(71),
          key: "pay-confirm-key",
          content: same,
          stored: sha("e2"),
        }),
      );
      await seed(
        client,
        ITEMS,
        item({
          id: uid(72),
          batch: randomUUID(),
          confirmKey: "pay-confirm-key",
        }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(73),
          key: "return-key",
          content: same,
          stored: sha("e3"),
        }),
      );
      await seed(
        client,
        CLAIMS,
        claim({
          id: uid(74),
          key: "return-key",
          status: "consumed",
          content: same,
          stored: sha("e3"),
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(
        rows,
        T1,
        [uid(71), uid(72), uid(73), uid(74)],
        "hash_shared_across_operations",
      );
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
      expectNoLeak(rows, ["pay-confirm-key", "return-key", same]);
    });
  });

  it("[legend-9bfh7] flags an overpaid proof that has the same content as a resolution proof under another key", async () => {
    await inPreShape("9bfh7", async (client) => {
      const same = sha("e4");
      await seed(
        client,
        FILES,
        file({
          id: uid(75),
          key: "resolution-key",
          content: same,
          stored: sha("e5"),
        }),
      );
      await seed(
        client,
        ITEMS,
        item({
          id: uid(76),
          batch: randomUUID(),
          resolutionKey: "resolution-key",
        }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(77),
          key: "overpaid-key",
          content: same,
          stored: sha("e6"),
        }),
      );
      await seed(
        client,
        PROPOSALS,
        proposal({ id: uid(78), key: "overpaid-key" }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(
        rows,
        T1,
        [uid(75), uid(76), uid(77), uid(78)],
        "hash_shared_across_operations",
      );
    });
  });

  it("[legend-9bfh7] flags a correction that has the same content as a payment confirmation proof under another key", async () => {
    await inPreShape("9bfh7", async (client) => {
      const same = sha("e7");
      const stored = sha("e8");
      await seed(
        client,
        FILES,
        file({
          id: uid(79),
          key: "pay-confirm-2",
          content: same,
          stored: sha("e9"),
        }),
      );
      await seed(
        client,
        ITEMS,
        item({ id: uid(80), batch: randomUUID(), confirmKey: "pay-confirm-2" }),
      );
      await seed(
        client,
        FILES,
        file({ id: uid(81), key: "corr-reuse", content: same, stored }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({ id: uid(82), key: "corr-reuse", content: same, stored }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(
        rows,
        T1,
        [uid(79), uid(80), uid(81), uid(82)],
        "hash_shared_across_operations",
      );
    });
  });

  // A confirmation / resolution key with no upload record blocks the 0399 gate.
  // The key's item is not itself a return/overpaid operation: it must be
  // reported as payment_proof_without_record, never as a missing_* operation.
  it("[legend-9bfh7] flags a payment confirmation key that has no upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 12);
      await seed(
        client,
        ITEMS,
        item({
          id: uid(91),
          batch: randomUUID(),
          confirmKey: "confirm-no-file",
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(91)]);
      expectReason(rows, T1, [uid(91)], "payment_proof_without_record");
      expect(
        rows.filter(
          (r) => r.reason.startsWith("missing_") && r.ids.includes(uid(91)),
        ),
        "the item is not a missing_* operation itself",
      ).toEqual([]);
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
      expectNoLeak(rows, ["confirm-no-file"]);
    });
  });

  // The stored copy of a payment proof can be re-uploaded as a return proof once
  // the backfill fills in the missing stored hash: the item would be paid twice.
  it("[legend-9bfh7] flags a payment confirmation proof whose upload record has no stored hash", async () => {
    await inPreShape("9bfh7", async (client) => {
      const clean = await bystander(client, 13);
      await seed(
        client,
        FILES,
        file({
          id: uid(95),
          key: "confirm-unstored",
          content: sha("c"),
          stored: null,
        }),
      );
      await seed(
        client,
        ITEMS,
        item({
          id: uid(96),
          batch: randomUUID(),
          confirmKey: "confirm-unstored",
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectFlagsAny(rows, T1, [uid(96)]);
      expectReason(rows, T1, [uid(96)], "missing_stored_hash");
      for (const id of clean) expect(idsOf(rows, T1)).not.toContain(id);
      expectNoLeak(rows, ["confirm-unstored"]);
    });
  });

  it("[legend-9bfh7] flags a resolution key that has no upload record", async () => {
    await inPreShape("9bfh7", async (client) => {
      await seed(
        client,
        ITEMS,
        item({
          id: uid(92),
          batch: randomUUID(),
          resolutionKey: "resolution-no-file",
        }),
      );
      const rows = await gate(client, "9bfh7");
      expectReason(rows, T1, [uid(92)], "payment_proof_without_record");
    });
  });

  it("[legend-9bfh7] passes when every operation has its own readable proof", async () => {
    await inPreShape("9bfh7", async (client) => {
      expect(await gate(client, "9bfh7"), "no operations at all").toEqual([]);
      await bystander(client, 4);
      await bystander(client, 5);
      await bystander(client, 6, T2);
      await seed(
        client,
        FILES,
        file({
          id: uid(61),
          key: "ok-overpaid",
          content: sha("b1"),
          stored: sha("b2"),
        }),
      );
      await seed(
        client,
        PROPOSALS,
        proposal({ id: uid(62), key: "ok-overpaid" }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(63),
          key: "ok-correction",
          content: sha("b3"),
          stored: sha("b4"),
        }),
      );
      await seed(
        client,
        CORRECTIONS,
        correction({
          id: uid(64),
          key: "ok-correction",
          content: sha("b3"),
          stored: sha("b4"),
        }),
      );
      // Payment confirmation and resolution proofs with their own records and
      // own hashes are clean too.
      await seed(
        client,
        FILES,
        file({
          id: uid(65),
          key: "ok-confirm",
          content: sha("b5"),
          stored: sha("b6"),
        }),
      );
      await seed(
        client,
        FILES,
        file({
          id: uid(66),
          key: "ok-resolution",
          content: sha("b7"),
          stored: sha("b8"),
        }),
      );
      await seed(
        client,
        ITEMS,
        item({
          id: uid(67),
          batch: randomUUID(),
          confirmKey: "ok-confirm",
          resolutionKey: "ok-resolution",
        }),
      );
      expect(await gate(client, "9bfh7")).toEqual([]);
    });
  });
});

// ---- legend-ofu02 -------------------------------------------------------------

describe("[legend-ofu02] reconciliation cases without any source (info)", () => {
  it("[legend-ofu02] counts cases with neither settlement line nor source transaction, per tenant", async () => {
    await inPreShape("ofu02", async (client) => {
      await seed(client, CASES, reconCase({ id: uid(1) }));
      await seed(client, CASES, reconCase({ id: uid(2) }));
      await seed(client, CASES, reconCase({ id: uid(3), tenant: T2 }));
      // Cases with a source are not reported.
      await seed(client, CASES, reconCase({ id: uid(4), line: randomUUID() }));
      await seed(
        client,
        CASES,
        reconCase({ id: uid(5), source: randomUUID() }),
      );
      await seed(
        client,
        CASES,
        reconCase({
          id: uid(6),
          line: randomUUID(),
          source: randomUUID(),
          tenant: T2,
        }),
      );
      const rows = await gate(client, "ofu02");
      expect(rows.map((r) => r.reason)).toEqual(
        Array(rows.length).fill("missing_without_source"),
      );
      expect(tenantsOf(rows)).toEqual([T1, T2]);
      expect(idsOf(rows, T1)).toEqual([uid(1), uid(2)]);
      expect(idsOf(rows, T2)).toEqual([uid(3)]);
      expect(
        rows
          .filter((r) => r.tenant_id === T1)
          .reduce((n, r) => n + Number(r.row_count), 0),
      ).toBe(2);
      expectNoLeak(rows, ["provider-x", "100000"]);
    });
  });

  it("[legend-ofu02] returns no rows when every case has a source or there are no cases", async () => {
    await inPreShape("ofu02", async (client) => {
      expect(await gate(client, "ofu02"), "no cases at all").toEqual([]);
      await seed(client, CASES, reconCase({ id: uid(11), line: randomUUID() }));
      await seed(
        client,
        CASES,
        reconCase({ id: uid(12), source: randomUUID() }),
      );
      await seed(
        client,
        CASES,
        reconCase({ id: uid(13), tenant: T2, line: randomUUID() }),
      );
      expect(await gate(client, "ofu02")).toEqual([]);
    });
  });
});

// ---- migration 0464 on a pre-0464 shaped flag ---------------------------------

describe("[legend-hklnq] migration 0464 backfills one fingerprint per existing recon flag", () => {
  const migration = readFileSync(
    resolve(drizzleDir, "0464_payout_990_flag_fingerprint.sql"),
    "utf8",
  ).replace(/--> statement-breakpoint/g, "");
  const tenant = cafeLegendPlatformFixtures.tenant.id;
  const HEX64 = /^[0-9a-f]{64}$/;

  /** Pushes the tip back to the pre-0464 shape: no sightings, no fingerprint column. */
  async function revertTo0463(client: PoolClient) {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DROP TABLE public.payroll_payout_recon_flag_sightings");
    for (const fn of [
      "app.payout_recon_flag_fingerprint(uuid, uuid)",
      "app.payout_recon_flag_see(uuid, uuid)",
      "app.payroll_payout_recon_flag_sightings_guard()",
    ])
      await client.query(`DROP FUNCTION ${fn} CASCADE`);
    // Clearances of other tests: gone for this transaction (rolled back).
    await client.query("DELETE FROM public.payroll_payout_recon_clearances");
    await client.query(
      `ALTER TABLE public.payroll_payout_recon_clearances DROP COLUMN flag_sha256`,
    );
    await client.query(
      `ALTER TABLE public.payroll_payout_recon_clearances
         ADD CONSTRAINT payroll_payout_recon_clearances_exception_key
         UNIQUE (tenant_id, exception_id)`,
    );
  }

  it("[legend-hklnq] gives every flag one sighting equal to its live fingerprint, keeps a cleared flag cleared and a held flag held", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await revertTo0463(client);
      const columns = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'payroll_payout_recon_clearances'
            AND column_name = 'flag_sha256'`,
      );
      expect(
        columns.rows,
        "premise: pre-0464 clearances have no fingerprint",
      ).toEqual([]);

      const clearedFlag = randomUUID();
      const heldFlag = randomUUID();
      const clearedSlip = randomUUID();
      const heldSlip = randomUUID();
      for (const [id, slip, reason] of [
        [clearedFlag, clearedSlip, "return reconciliation mismatch cleared"],
        [heldFlag, heldSlip, "return reconciliation mismatch held"],
      ] as const)
        await client.query(
          `INSERT INTO public.payroll_payout_recon_exceptions
             (id, tenant_id, kind, operation_id, item_id, payslip_id, reason)
           VALUES ($1, $2, 'return', $3, $4, $5, $6)`,
          [id, tenant, randomUUID(), randomUUID(), slip, reason],
        );
      const clearanceId = randomUUID();
      await client.query(
        `INSERT INTO public.payroll_payout_recon_clearances
           (id, tenant_id, exception_id, reason, proposed_by, proposed_session_id,
            proposed_grant_id, approved_by, approved_session_id, approved_grant_id, approved_at)
         VALUES ($1, $2, $3, 'checked by hand, journal and bank agree', 'finance-one', 'session-one',
                 $4, 'finance-two', 'session-two', $5, now())`,
        [clearanceId, tenant, clearedFlag, randomUUID(), randomUUID()],
      );

      // The seeded clearance carries made-up grant ids (the grants table is not
      // part of this fixture): its FK rows stay unchecked while the backfill
      // rewrites the row, so the migration runs under replica and origin is
      // restored after, before the held-slip functions are read.
      await client.query(migration);
      await client.query("SET LOCAL session_replication_role = origin");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant,
      ]);

      const sightings = await client.query<{
        exception_id: string;
        flag_sha256: string;
        same: boolean;
      }>(
        `SELECT s.exception_id, s.flag_sha256,
                s.flag_sha256 = app.payout_recon_flag_fingerprint(s.tenant_id, s.exception_id) AS same
           FROM public.payroll_payout_recon_flag_sightings s
          WHERE s.tenant_id = $1 AND s.exception_id = ANY($2::uuid[])
          ORDER BY s.exception_id`,
        [tenant, [clearedFlag, heldFlag]],
      );
      expect(sightings.rows.map((r) => r.exception_id).sort()).toEqual(
        [clearedFlag, heldFlag].sort(),
      );
      for (const row of sightings.rows) {
        expect(row.flag_sha256).toMatch(HEX64);
        expect(row.same, "the sighting is the live fingerprint").toBe(true);
      }

      // No flag without a sighting, none with two.
      const missing = await client.query(
        `SELECT e.id FROM public.payroll_payout_recon_exceptions e
          WHERE NOT EXISTS (SELECT 1 FROM public.payroll_payout_recon_flag_sightings s
                             WHERE s.tenant_id = e.tenant_id AND s.exception_id = e.id)`,
      );
      expect(missing.rows, "every flag has a sighting").toEqual([]);
      const doubled = await client.query(
        `SELECT exception_id, count(*) FROM public.payroll_payout_recon_flag_sightings
          GROUP BY tenant_id, exception_id HAVING count(*) > 1`,
      );
      expect(doubled.rows, "no flag is sighted twice").toEqual([]);

      // The clearance now carries the fingerprint of its flag; the column is required.
      const cleared = await client.query<{ flag_sha256: string }>(
        `SELECT flag_sha256 FROM public.payroll_payout_recon_clearances WHERE id = $1`,
        [clearanceId],
      );
      const clearedSighting = sightings.rows.find(
        (r) => r.exception_id === clearedFlag,
      );
      expect(cleared.rows[0]?.flag_sha256).toBe(clearedSighting?.flag_sha256);
      const nullable = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'payroll_payout_recon_clearances'
            AND column_name = 'flag_sha256'`,
      );
      expect(nullable.rows[0]?.is_nullable).toBe("NO");

      // Nobody is released by the backfill: the cleared flag stays cleared, the other holds.
      const held = (slip: string) =>
        client
          .query<{ held: boolean }>(
            `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
            [tenant, slip],
          )
          .then((r) => r.rows[0]?.held);
      expect(
        await held(clearedSlip),
        "approved clearance of the live data",
      ).toBe(false);
      expect(
        await held(heldSlip),
        "flag without clearance keeps its slip held",
      ).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("[legend-hklnq] runs on a database with no flag at all and leaves no sighting", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await revertTo0463(client);
      await client.query("DELETE FROM public.payroll_payout_recon_exceptions");
      await client.query("SET LOCAL session_replication_role = origin");
      await client.query(migration);
      const count = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.payroll_payout_recon_flag_sightings`,
      );
      expect(count.rows[0]?.n).toBe("0");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
