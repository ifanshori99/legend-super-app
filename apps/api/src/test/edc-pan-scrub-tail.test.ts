// legend-lg45: apps/api/scripts/edc-pan-scrub-tail.sql removes the card number
// tail the old write path left at the end of messages that were exactly 200
// long (masked with the single-separator pattern, THEN cut to 200). The script
// is run by hand (not a migration) after 0143. The test inserts the example
// messages as the owner, runs the whole file as one query (as `psql -1` would),
// then checks, per row:
// - the stored message equals the JS read-path result on the original
//   (edcTransactionSchema.message), so SQL and JS stay the same rule;
// - the stored message equals the expected output from the rule table;
// - a second run of the script updates 0 rows and changes nothing.
// Only the message column may change; no stored message is longer than 200.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { edcTransactionSchema } from "@starter/shared/edc";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
} from "./floor-test-helpers.ts";
import type { IsolatedTenant } from "./floor-test-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const scrubSql = readFileSync(
  new URL("../../scripts/edc-pan-scrub-tail.sql", import.meta.url),
  "utf8",
);

const MASK = "[disamarkan]";
/** What the JS read path makes of a stored message. */
const readPath = (message: string) =>
  edcTransactionSchema.shape.message.parse(message);
const cut200 = (text: string) => Array.from(text).slice(0, 200).join("");

/** `x` padding so the message is `length` UTF-16 units long, ending in `tail`. */
const pad = (tail: string, length = 200) =>
  "x".repeat(length - tail.length) + tail;
/** Emoji first: UTF-16 length 200, only 199 characters. */
const padEmoji = (tail: string) => "😀" + "x".repeat(198 - tail.length) + tail;

type Spec = {
  name: string;
  message: string | null;
  /** Expected stored message after the script; absent = unchanged. */
  expect?: string;
};

/** Message that ends in `tail`, padded to 200; `after` replaces the tail. */
const tailCase = (name: string, tail: string, after?: string): Spec => {
  const message = pad(tail);
  const prefix = message.slice(0, message.length - tail.length);
  return {
    name,
    message,
    expect: after === undefined ? undefined : cut200(prefix + after),
  };
};

const specs: Spec[] = [
  // ---- 200 long, tail removed
  tailCase("multi-separator-pan-cut", " 4111  1111  11", ` ${MASK}`),
  tailCase("cut-mask-after-7-digits", " 7777777  [disa", ` ${MASK}`),
  tailCase("cut-mask-bracket-only", " 7777777  [", ` ${MASK}`),
  tailCase("cut-mask-closing-bracket-cut", " 7777777  [disamarkan", ` ${MASK}`),
  tailCase(
    "cut-mask-closing-bracket-cut-tab",
    " 7777777\t[disamarkan",
    ` ${MASK}`,
  ),
  tailCase("digits-after-mask", " [disamarkan] - 111", ` ${MASK}`),
  tailCase("tab-separated-tail", " 4111\t111", ` ${MASK}`),
  tailCase(
    "amount-then-card-tail",
    " Rp 50.000  4111  111",
    ` Rp 50.000  ${MASK}`,
  ),
  {
    name: "emoji-first-utf16-200",
    message: padEmoji(" 4111\t111"),
    expect: cut200(`😀${"x".repeat(198 - 9)} ${MASK}`),
  },
  // ---- 200 long, left alone
  tailCase("four-digits-cut-mask", " 4111  [disa"),
  tailCase("rupiah-amount", " Rp 1.500.000"),
  tailCase("trx-number", " TRX 12345678"),
  tailCase("id-with-dash", " ID P261109-1234"),
  tailCase("timestamp", " 2026-11-09 10:00"),
  tailCase("single-separator-8-digits", " 4111 1111"),
  tailCase("amount-then-6-digits", " Rp 50.000  4111  11"),
  // ---- not exactly 200 long: unchanged
  { name: "multi-separator-pan-199", message: pad(" 4111  1111  11", 199) },
  {
    name: "response-code-after-mask-199",
    message: pad(" [disamarkan] - 51", 199),
  },
  { name: "short-message", message: "Transaksi disetujui" },
  { name: "null-message", message: null },
];

/** Names of rows that must change. */
const dirtySpecs = specs.filter((s) => s.expect !== undefined);

type Fixture = {
  tenantId: string;
  outletId: string;
  terminalId: string;
  ids: Map<string, string>;
  specs: Spec[];
};

const { tenant: seededTenant, outlets: seededOutlets } = cafeLegendFixtures;
let isolated: IsolatedTenant;
let fixA: Fixture;
let fixB: Fixture;
let seq = 0;

/** FORCE RLS is on: every read and write carries the tenant settings. */
async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertRow(
  client: PoolClient,
  row: {
    id: string;
    tenantId: string;
    outletId: string;
    terminalId: string;
    label: string;
    message: string | null;
  },
) {
  seq += 1;
  await client.query(
    `INSERT INTO edc_transactions
       (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
        request_fingerprint, amount_idr, method, status, trace, completed_at,
        message, updated_at, created_at)
     VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-tail', $7, 'card', 'approved', $8,
             '2024-01-02T03:04:05Z', $9,
             '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z')`,
    [
      row.id,
      row.tenantId,
      row.outletId,
      row.terminalId,
      `REF-TAIL-${row.label}-${seq}`,
      randomUUID(),
      10_000 + seq,
      `TT${row.label}${String(seq).padStart(6, "0")}`,
      row.message,
    ],
  );
}

async function makeFixture(
  label: "A" | "B",
  tenantId: string,
  outletId: string,
  subset: Spec[],
): Promise<Fixture> {
  const terminalId = randomUUID();
  const ids = new Map<string, string>();
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-TAIL', 'Test EDC', 'lan',
               ARRAY['card','qris'], 'active')`,
      [terminalId, tenantId, outletId, `TID-${terminalId.slice(0, 8)}`],
    );
    for (const spec of subset) {
      const id = randomUUID();
      await insertRow(client, {
        id,
        tenantId,
        outletId,
        terminalId,
        label,
        message: spec.message,
      });
      ids.set(spec.name, id);
    }
  });
  return { tenantId, outletId, terminalId, ids, specs: subset };
}

type RowJson = Record<string, unknown>;

async function snapshot(fix: Fixture): Promise<Map<string, RowJson>> {
  const rows = await asTenant(fix.tenantId, (client) =>
    client.query<{ id: string; j: RowJson }>(
      "SELECT id, to_jsonb(t) AS j FROM edc_transactions t WHERE id = ANY($1::uuid[])",
      [[...fix.ids.values()]],
    ),
  );
  return new Map(rows.rows.map((r) => [r.id, r.j]));
}

const snapshotAll = async () =>
  new Map([...(await snapshot(fixA)), ...(await snapshot(fixB))]);

/** Rows of edc_transactions updated so far in the current transaction. */
async function updatedInTransaction(client: PoolClient): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT n_tup_upd::int AS n FROM pg_stat_xact_user_tables
     WHERE relid = 'public.edc_transactions'::regclass`,
  );
  return result.rows[0]?.n ?? 0;
}

/** The whole script as ONE query in one transaction; returns rows updated. */
async function runScript(): Promise<number> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const start = await updatedInTransaction(client);
    await client.query(scrubSql);
    const updated = (await updatedInTransaction(client)) - start;
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function forcedRls(): Promise<boolean> {
  const result = await owner.query<{ forced: boolean }>(
    `SELECT relforcerowsecurity AS forced FROM pg_class
     WHERE oid = 'public.edc_transactions'::regclass`,
  );
  return result.rows[0].forced;
}

let before: Map<string, RowJson>;
let afterFirst: Map<string, RowJson>;
let afterSecond: Map<string, RowJson>;
let firstRunUpdated = -1;
let secondRunUpdated = -1;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  isolated = await createIsolatedTenant(`tail-${randomUUID().slice(0, 8)}`);
  // Tenant A: seeded fixture tenant, all specs. Tenant B: isolated tenant,
  // every other spec, so a tenant-scoped bug would show.
  const subsetB = specs.filter((_, i) => i % 2 === 0);
  fixA = await makeFixture("A", seededTenant.id, seededOutlets[0].id, specs);
  fixB = await makeFixture("B", isolated.tenantId, isolated.outletId, subsetB);

  before = await snapshotAll();
  firstRunUpdated = await runScript();
  afterFirst = await snapshotAll();
  secondRunUpdated = await runScript();
  afterSecond = await snapshotAll();
});

afterAll(async () => {
  for (const fix of [fixA, fixB]) {
    if (!fix) continue;
    await asTenant(fix.tenantId, async (client) => {
      await client.query(
        "DELETE FROM edc_transactions WHERE id = ANY($1::uuid[])",
        [[...fix.ids.values()]],
      );
      await client.query("DELETE FROM payment_edc_terminals WHERE id = $1", [
        fix.terminalId,
      ]);
    });
  }
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

const eachRow = (check: (spec: Spec, id: string, label: string) => void) => {
  for (const [label, fix] of [
    ["A", fixA],
    ["B", fixB],
  ] as const) {
    for (const spec of fix.specs) check(spec, fix.ids.get(spec.name)!, label);
  }
};

describe("EDC PAN tail scrub script (legend-lg45)", () => {
  it("fixture holds the 200 long examples (UTF-16)", () => {
    for (const spec of specs) {
      if (spec.message === null) continue;
      if (spec.name.endsWith("-199")) expect(spec.message.length).toBe(199);
      else if (spec.expect !== undefined || spec.name !== "short-message")
        expect(spec.message.length, spec.name).toBe(200);
    }
    expect(dirtySpecs.length).toBeGreaterThanOrEqual(7);
  });

  it("changes every row the rule names, to the expected message", () => {
    eachRow((spec, id, label) => {
      const want = spec.expect ?? spec.message;
      expect(afterFirst.get(id)!.message, `${label}/${spec.name}`).toBe(want);
    });
  });

  it("updated at least the dirty rows on run 1", () => {
    const dirtyRows =
      fixA.specs.filter((s) => s.expect !== undefined).length +
      fixB.specs.filter((s) => s.expect !== undefined).length;
    expect(firstRunUpdated).toBeGreaterThanOrEqual(dirtyRows);
  });

  it("stores what the JS read path makes of the original (SQL and JS are one rule)", () => {
    eachRow((spec, id, label) => {
      if (spec.message === null) return;
      expect(afterFirst.get(id)!.message, `${label}/${spec.name}`).toBe(
        readPath(spec.message),
      );
    });
  });

  it("cut to 200 characters: no stored message is longer than 200", async () => {
    const result = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM edc_transactions WHERE char_length(message) > 200`,
    );
    expect(result.rows[0].n).toBe(0);
    for (const row of afterFirst.values()) {
      const message = row.message as string | null;
      if (message !== null)
        expect(Array.from(message).length).toBeLessThanOrEqual(200);
    }
  });

  it("leaves every column except message untouched, updated_at included", () => {
    for (const [id, prior] of before) {
      const row = afterFirst.get(id)!;
      for (const col of Object.keys(prior)) {
        if (col === "message") continue;
        expect(row[col], `${id} ${col}`).toEqual(prior[col]);
      }
    }
  });

  it("does not touch rows whose message does not change", () => {
    eachRow((spec, id, label) => {
      if (spec.expect !== undefined) return;
      expect(afterFirst.get(id), `${label}/${spec.name}`).toEqual(
        before.get(id),
      );
    });
  });

  it("is idempotent: a second run updates 0 rows and changes nothing", () => {
    expect(secondRunUpdated).toBe(0);
    for (const [id, row] of afterFirst) {
      expect(afterSecond.get(id)).toEqual(row);
    }
  });

  it("leaves a JS second pass on every stored message unchanged", () => {
    for (const row of afterFirst.values()) {
      const message = row.message as string | null;
      if (message === null) continue;
      expect(readPath(message)).toBe(message);
    }
  });

  it("keeps FORCE ROW LEVEL SECURITY on", async () => {
    expect(await forcedRls()).toBe(true);
  });

  it("runs as one DO block that restores FORCE RLS", () => {
    expect(scrubSql.match(/^DO \$scrub\$/gm)?.length).toBe(1);
    expect(scrubSql).toMatch(/NO FORCE ROW LEVEL SECURITY/);
    expect(scrubSql).toMatch(/\bFORCE ROW LEVEL SECURITY;/);
    expect(scrubSql).toMatch(/lock_timeout/);
  });
});
