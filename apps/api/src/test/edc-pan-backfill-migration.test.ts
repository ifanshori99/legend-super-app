// legend-0lrkl: migration 0170_edc_pan_backfill_separators.sql masks card
// numbers that old edc_transactions.message rows hold with the separators the
// write path of legend-deu7r now catches: any whitespace (newline, CRLF, NBSP,
// the other JS `\s` characters), slash and underscore. 0143 matched spaces,
// tabs and dashes only and is already applied on some databases, so it stays
// as it was and 0170 repeats the message scrub with the wider class, in
// batches, touching nothing but `message`.
//
// Checks: the DB pattern masks exactly what packages/shared/src/edc
// `cardNumberLike` masks (every separator character, both ways), the other
// columns and money stay as they were, a run with a colon, comma or dot stays,
// more rows than one batch are all masked, a second run updates no row, FORCE
// RLS is back on, and the journal entry and snapshot chain are in place.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/edc-pan-backfill-migration.test.ts" pnpm test
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

const drizzleFile = (path: string) =>
  new URL(`../../drizzle/${path}`, import.meta.url);
const TAG = "0170_edc_pan_backfill_separators";
const sql0170 = readFileSync(drizzleFile(`${TAG}.sql`), "utf8");
const statements0170 = sql0170
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

/** Every character the JS `\s` class holds, plus slash and underscore. */
const WIDE_SEPARATORS = [
  "\t",
  "\n",
  "\u000b",
  "\u000c",
  "\r",
  " ",
  " ",
  " ",
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  " ",
  " ",
  " ",
  " ",
  "　",
  "﻿",
  "/",
  "_",
  "-",
];
// A colon, comma, dot or letter ends the run, like in the JS pattern.
const NON_SEPARATORS = [":", ",", ".", "x", "|", ";"];
/** prefix + filler + tail, exactly `length` UTF-16 units (like JS `.length`). */
function padded(prefix: string, tail: string, length: number): string {
  const message = `${prefix}${"x".repeat(length - prefix.length - tail.length)}${tail}`;
  if (message.length !== length) throw new Error("bad probe length");
  return message;
}
const pan = (sep: string) => `4111${sep}1111${sep}1111${sep}1111`;
const MASK = "[disamarkan]";

type Probe = { name: string; message: string };
const probes: Probe[] = [
  ...WIDE_SEPARATORS.map((sep, i) => ({
    name: `sep-${i}`,
    message: `kartu ${pan(sep)} ditolak`,
  })),
  { name: "crlf", message: "CARD 4111\r\n1111\r\n1111\r\n1111 end" },
  { name: "mixed", message: "kartu 4111 \n 1111/1111_1111 ditolak" },
  { name: "twelve-digits-slash", message: "ref 4111/1111/1111 ok" },
  ...NON_SEPARATORS.map((sep, i) => ({
    name: `keep-${i}`,
    message: `kartu ${pan(sep)} ditolak`,
  })),
  { name: "keep-date-time", message: "tgl 2026/11/09 12:30:45 ok" },
  { name: "keep-eleven", message: "ref 4111/1111/111 ok" },
  { name: "keep-rupiah", message: "total Rp 1.250.000.000.000 ok" },
  { name: "keep-masked", message: `sudah ${MASK} ok` },
  { name: "keep-null-ish", message: "" },
  // 200 UTF-16 units: the read path also runs the tail rules, so a row 0170
  // shortens must still end up as maskStoredMessage(original) (review K).
  {
    name: "len200-wide-run-and-cut-card-tail",
    message: padded("REF 5500/0000/0000/0004 ", "4111  1111  11", 200),
  },
  {
    name: "len200-wide-run-and-mask-with-short-code",
    message: padded("REF 5500\n0000\n0000\n0004 ", "[disamarkan] - 51", 200),
  },
  {
    name: "len200-astral-chars-count-twice",
    message: padded(
      "\u{1F600}\u{1F600} 5500_0000_0000_0004 ",
      "4111  1111  11",
      200,
    ),
  },
  // legend-stetb: a card cut at 200 and joined by a slash, underscore, line
  // break or NBSP is a remnant the tail rules catch; the row holds no 12-digit
  // run, so 0170 must also pick it by its tail. Stored value = read path.
  ...[
    ["slash-cut-card", " 4111/1111/11"],
    ["underscore-cut-card", " 4111_1111_11"],
    ["crlf-cut-card", " 4111\r\n1111\r\n11"],
    ["nbsp-cut-card", " 4111\u00a01111\u00a011"],
    ["slash-digits-then-cut-mask", " 7777777/[disa"],
    ["underscore-digits-then-cut-mask", " 7777777_[disamarkan"],
    ["digits-after-mask-slash", " [disamarkan]/111"],
    ["digits-after-mask-underscore", " [disamarkan]_111"],
    ["digits-after-mask-newline", " [disamarkan]\n111"],
    ["date-with-slashes-at-end", " 2026/11/09"],
    // stays: 6 digits, a date with time, a colon before the code
    ["keep-six-digits-slash", " 12345/1"],
    ["keep-date-time-slash", " 2026/11/09 10:00"],
    ["keep-colon-code", " [disamarkan]:51"],
  ].map(([name, tail]) => ({
    name: `len200-tail-${name}`,
    message: padded("REF ", tail!, 200),
  })),
  {
    name: "len199-same-tail-stays",
    message: padded("REF ", " 4111/1111/11", 199),
  },
  {
    name: "len199-wide-run-and-card-tail-stays",
    message: padded("REF 5500/0000/0000/0004 ", "4111  1111  11", 199),
  },
];

/** What the JS read path says a stored message becomes. */
const expectedMessage = (message: string) =>
  edcTransactionSchema.shape.message.parse(message);

const BULK = 2_300; // more than two batches of 1000

type RowJson = Record<string, unknown>;
const omit = (value: RowJson, ...keys: string[]): RowJson =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
const { tenant: seededTenant, outlets: seededOutlets } = cafeLegendFixtures;
let isolated: IsolatedTenant;
let terminalA: string;
let terminalB: string;
const ids = new Map<string, string>(); // probe name -> row id (tenant A)
const idsB = new Map<string, string>(); // tenant B copy of every other probe
let bulkTag: string;
let before = new Map<string, RowJson>();
let after = new Map<string, RowJson>();
let firstRunUpdated = -1;
let secondRunUpdated = -1;
let seq = 0;

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
    message: string;
    cols?: Record<string, string>;
  },
) {
  seq += 1;
  await client.query(
    `INSERT INTO edc_transactions
       (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
        request_fingerprint, amount_idr, method, status, trace, completed_at,
        card_type, rrn, invoice_no, batch_no, message, masked_pan,
        updated_at, created_at)
     VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-backfill', $7, 'card', 'approved', $8,
             '2024-01-02T03:04:05Z', $9, $10, $11, $12, $13, $14,
             '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z')`,
    [
      row.id,
      row.tenantId,
      row.outletId,
      row.terminalId,
      `REF-BACKFILL-${seq}`,
      randomUUID(),
      10_000 + seq,
      `TB${String(seq).padStart(6, "0")}`,
      row.cols?.card_type ?? "VISA",
      row.cols?.rrn ?? "123456789012",
      row.cols?.invoice_no ?? "INV1",
      row.cols?.batch_no ?? "B1",
      row.message,
      row.cols?.masked_pan ?? "411111******1111",
    ],
  );
}

async function makeTerminal(
  tenantId: string,
  outletId: string,
): Promise<string> {
  const terminalId = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-BACKFILL', 'Test EDC', 'lan',
               ARRAY['card','qris'], 'active')`,
      [terminalId, tenantId, outletId, `TID-${terminalId.slice(0, 8)}`],
    ),
  );
  return terminalId;
}

async function snapshot(): Promise<Map<string, RowJson>> {
  const out = new Map<string, RowJson>();
  for (const [tenantId, map] of [
    [seededTenant.id, ids],
    [isolated.tenantId, idsB],
  ] as const) {
    const rows = await asTenant(tenantId, (client) =>
      client.query<{ id: string; j: RowJson }>(
        "SELECT id, to_jsonb(t) AS j FROM edc_transactions t WHERE id = ANY($1::uuid[])",
        [[...map.values()]],
      ),
    );
    for (const r of rows.rows) out.set(r.id, r.j);
  }
  return out;
}

async function updatedInTransaction(client: PoolClient): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT n_tup_upd::int AS n FROM pg_stat_xact_user_tables
     WHERE relid = 'public.edc_transactions'::regclass`,
  );
  return result.rows[0]?.n ?? 0;
}

/** The whole migration file in ONE transaction, as the drizzle migrator does. */
async function runMigration(): Promise<number> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const start = await updatedInTransaction(client);
    for (const statement of statements0170) await client.query(statement);
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  isolated = await createIsolatedTenant(`bf-${randomUUID().slice(0, 8)}`);
  terminalA = await makeTerminal(seededTenant.id, seededOutlets[0].id);
  terminalB = await makeTerminal(isolated.tenantId, isolated.outletId);
  await asTenant(seededTenant.id, async (client) => {
    for (const probe of probes) {
      const id = randomUUID();
      await insertRow(client, {
        id,
        tenantId: seededTenant.id,
        outletId: seededOutlets[0].id,
        terminalId: terminalA,
        message: probe.message,
      });
      ids.set(probe.name, id);
    }
    // Reference and card columns that look like a card stay untouched: this
    // migration is about message only.
    const weird = randomUUID();
    await insertRow(client, {
      id: weird,
      tenantId: seededTenant.id,
      outletId: seededOutlets[0].id,
      terminalId: terminalA,
      message: `kartu ${pan("/")}`,
      cols: {
        card_type: "4111/1111/1111/1111",
        rrn: "4111/1111/1111",
        invoice_no: "4111_1111_1111",
        batch_no: "4111\n1111\n1111",
        masked_pan: "4111/1111/1111/1111",
      },
    });
    ids.set("other-columns", weird);
    // Bulk: more rows than two batches, all dirty, for the loop.
    bulkTag = `BULK-${randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace, completed_at,
          card_type, message, updated_at, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'bca', $4 || '-' || g, gen_random_uuid(),
              'fp-backfill', 20000 + g, 'card', 'approved', 'TX' || g || $4,
              '2024-01-02T03:04:05Z', 'VISA',
              E'bulk 4111\\n1111\\n1111\\n1111 end ' || g,
              '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z'
         FROM generate_series(1, $5::int) g`,
      [seededTenant.id, seededOutlets[0].id, terminalA, bulkTag, BULK],
    );
  });
  // Tenant B: a copy of a few probes, so a tenant-scoped bug would show.
  await asTenant(isolated.tenantId, async (client) => {
    for (const probe of probes.filter((_, i) => i % 5 === 0)) {
      const id = randomUUID();
      await insertRow(client, {
        id,
        tenantId: isolated.tenantId,
        outletId: isolated.outletId,
        terminalId: terminalB,
        message: probe.message,
      });
      idsB.set(probe.name, id);
    }
  });

  before = await snapshot();
  firstRunUpdated = await runMigration();
  after = await snapshot();
  secondRunUpdated = await runMigration();
});

afterAll(async () => {
  for (const [tenantId, map, terminal] of [
    [seededTenant.id, ids, terminalA],
    [isolated?.tenantId, idsB, terminalB],
  ] as const) {
    if (!tenantId) continue;
    await asTenant(tenantId, async (client) => {
      await client.query(
        "DELETE FROM edc_transactions WHERE id = ANY($1::uuid[])",
        [[...map.values()]],
      );
      if (tenantId === seededTenant.id && bulkTag)
        await client.query(
          "DELETE FROM edc_transactions WHERE reference LIKE $1",
          [`${bulkTag}-%`],
        );
      if (terminal)
        await client.query("DELETE FROM payment_edc_terminals WHERE id = $1", [
          terminal,
        ]);
    });
  }
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("0170 DB pattern equals the write-path cardNumberLike", () => {
  for (const probe of probes) {
    it(`message ${probe.name}: stored result equals the JS read path`, () => {
      const row = after.get(ids.get(probe.name)!);
      expect(row?.message).toBe(expectedMessage(probe.message));
    });
  }

  it("every wide separator is masked, every non-separator keeps the run", () => {
    for (const [i] of WIDE_SEPARATORS.entries())
      expect(after.get(ids.get(`sep-${i}`)!)?.message).toBe(
        `kartu ${MASK} ditolak`,
      );
    for (const [i, sep] of NON_SEPARATORS.entries())
      expect(after.get(ids.get(`keep-${i}`)!)?.message).toBe(
        `kartu ${pan(sep)} ditolak`,
      );
  });

  it("masks CRLF, mixed and 12-digit slash forms; keeps a date and 11 digits", () => {
    expect(after.get(ids.get("crlf")!)?.message).toBe(`CARD ${MASK} end`);
    expect(after.get(ids.get("mixed")!)?.message).toBe(`kartu ${MASK} ditolak`);
    expect(after.get(ids.get("twelve-digits-slash")!)?.message).toBe(
      `ref ${MASK} ok`,
    );
    expect(after.get(ids.get("keep-date-time")!)?.message).toBe(
      "tgl 2026/11/09 12:30:45 ok",
    );
    expect(after.get(ids.get("keep-eleven")!)?.message).toBe(
      "ref 4111/1111/111 ok",
    );
  });
});

describe("0170 persists the tail masks for slash, underscore, line break and NBSP (legend-stetb)", () => {
  const rewritten = [
    ["slash-cut-card", " 4111/1111/11"],
    ["underscore-cut-card", " 4111_1111_11"],
    ["crlf-cut-card", " 4111\r\n1111\r\n11"],
    ["nbsp-cut-card", " 4111\u00a01111\u00a011"],
    ["slash-digits-then-cut-mask", " 7777777/[disa"],
    ["underscore-digits-then-cut-mask", " 7777777_[disamarkan"],
    ["digits-after-mask-slash", " [disamarkan]/111"],
    ["digits-after-mask-underscore", " [disamarkan]_111"],
    ["digits-after-mask-newline", " [disamarkan]\n111"],
    ["date-with-slashes-at-end", " 2026/11/09"],
  ] as const;
  for (const [name, tail] of rewritten)
    it(`${name}: the tail becomes a mask in the stored row`, () => {
      const original = padded("REF ", tail, 200);
      // The mask can be longer than the tail it replaces: cut to 200 code
      // points like the read path (a date tail of 11 units becomes 13).
      const expected = `${original.slice(0, original.length - tail.length)} ${MASK}`;
      expect(after.get(ids.get(`len200-tail-${name}`)!)?.message).toBe(
        Array.from(expected).slice(0, 200).join(""),
      );
    });

  for (const name of [
    "keep-six-digits-slash",
    "keep-date-time-slash",
    "keep-colon-code",
  ])
    it(`${name}: stays as it was`, () => {
      expect(after.get(ids.get(`len200-tail-${name}`)!)?.message).toBe(
        before.get(ids.get(`len200-tail-${name}`)!)?.message,
      );
    });

  it("the same tail at 199 units stays (the tail rules need exactly 200)", () => {
    expect(after.get(ids.get("len199-same-tail-stays")!)?.message).toBe(
      before.get(ids.get("len199-same-tail-stays")!)?.message,
    );
  });
});

describe("0170 touches message only", () => {
  it("every other column of every row is unchanged (money, references, card columns, updated_at)", () => {
    for (const [id, was] of before) {
      const now = after.get(id)!;
      expect(omit(now, "message")).toEqual(omit(was, "message"));
    }
  });

  it("a row whose reference and card columns look like a card keeps them, only message is masked", () => {
    const row = after.get(ids.get("other-columns")!)!;
    expect(row).toMatchObject({
      card_type: "4111/1111/1111/1111",
      rrn: "4111/1111/1111",
      invoice_no: "4111_1111_1111",
      batch_no: "4111\n1111\n1111",
      masked_pan: "4111/1111/1111/1111",
      message: `kartu ${MASK}`,
    });
  });

  it("tenant B rows are masked the same way", () => {
    for (const [name, id] of idsB) {
      const original = probes.find((p) => p.name === name)!.message;
      expect(after.get(id)?.message).toBe(expectedMessage(original));
    }
  });
});

describe("0170 batches, is idempotent and keeps FORCE RLS", () => {
  it("masks every bulk row (more than two batches)", async () => {
    const left = await asTenant(seededTenant.id, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM edc_transactions
          WHERE reference LIKE $1 AND message ~ '4111'`,
        [`${bulkTag}-%`],
      ),
    );
    expect(left.rows[0]?.n).toBe(0);
    const masked = await asTenant(seededTenant.id, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM edc_transactions
          WHERE reference LIKE $1 AND message ~ '^bulk \\[disamarkan\\] end [0-9]+$'`,
        [`${bulkTag}-%`],
      ),
    );
    expect(masked.rows[0]?.n).toBe(BULK);
  });

  it("the first run updated the dirty rows, a second run updates none", () => {
    expect(firstRunUpdated).toBeGreaterThanOrEqual(BULK + 1);
    expect(secondRunUpdated).toBe(0);
  });

  it("FORCE ROW LEVEL SECURITY is back on edc_transactions", async () => {
    const result = await owner.query<{ forced: boolean }>(
      `SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.edc_transactions'::regclass`,
    );
    expect(result.rows[0]?.forced).toBe(true);
  });

  it("is plain ASCII: separators are written as \\uXXXX escapes, none is a raw invisible character", () => {
    expect([...sql0170].some((ch) => ch.charCodeAt(0) > 0x7f)).toBe(false);
    expect(sql0170).toContain("\\u00a0");
  });

  it("is one statement: NO FORCE, the loop and FORCE commit or fail together", () => {
    expect(statements0170).toHaveLength(1);
    expect(sql0170).toMatch(/NO FORCE ROW LEVEL SECURITY/);
    expect(sql0170).toMatch(/\bFORCE ROW LEVEL SECURITY/);
    expect(sql0170.indexOf("NO FORCE ROW LEVEL SECURITY")).toBeLessThan(
      sql0170.lastIndexOf("FORCE ROW LEVEL SECURITY"),
    );
  });
});

describe("0170 journal and snapshot chain", () => {
  const journal = JSON.parse(
    readFileSync(drizzleFile("meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string; when: number }[] };

  it("is registered as idx 170 with when 1794249000000, after the last entry", () => {
    const entry = journal.entries.find((e) => e.tag === TAG);
    expect(entry).toMatchObject({ idx: 170, when: 1794249000000 });
    const others = journal.entries.filter((e) => e.tag !== TAG);
    expect(Math.max(...others.map((e) => e.when))).toBeLessThan(1794249000000);
  });

  it("its snapshot chains to the previous snapshot and changes no schema", () => {
    const snap = JSON.parse(
      readFileSync(drizzleFile("meta/0170_snapshot.json"), "utf8"),
    ) as Record<string, unknown> & { id: string; prevId: string };
    const prevEntry = [...journal.entries]
      .filter((e) => e.tag !== TAG)
      .sort((a, b) => b.idx - a.idx)[0]!;
    const prevName = `${String(prevEntry.idx).padStart(4, "0")}_snapshot.json`;
    const prev = JSON.parse(
      readFileSync(drizzleFile(`meta/${prevName}`), "utf8"),
    ) as Record<string, unknown> & { id: string };
    expect(snap.prevId).toBe(prev.id);
    expect(snap.id).not.toBe(prev.id);
    expect(omit(snap, "id", "prevId")).toEqual(omit(prev, "id", "prevId"));
  });
});
