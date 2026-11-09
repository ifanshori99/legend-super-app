// legend-5gub Part A: migration 0113_edc_pan_scrub.sql masks card numbers left
// in old edc_transactions rows. The test inserts dirty and clean rows in two
// tenants as the owner, runs the migration file twice in one transaction and
// checks the result column by column.
//
// Assumptions (recorded in the report):
// - "Card-like" = 13+ digits with an optional single space or dash between
//   digits (brief); 12 digit values are clean.
// - A masked_pan holding only a 13-19 digit number, plain or split by spaces
//   or dashes, is masked to first 6 + '*' + last 4; anything else card-like
//   becomes NULL.
// - Rows are compared by id, so rows other test files leave behind do not
//   matter; the UPDATE rowcount is asserted as ">= dirty rows" on run 1 and
//   exactly 0 on run 2.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { maskedPanSchema } from "@starter/shared/edc";
import { createIsolatedTenant, dropIsolatedTenant } from "./floor-test-helpers.ts";
import type { IsolatedTenant } from "./floor-test-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const migrationSql = readFileSync(
  new URL("../../drizzle/0113_edc_pan_scrub.sql", import.meta.url),
  "utf8",
);
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const CARD_LIKE = /\d([ -]?\d){12,}/;
const PAN = "4111111111111111";
const PAN_SPACED = "4111 1111 1111 1111";
const PAN_DASHED = "4111-1111-1111-1111";
const SCRUBBED = "[disamarkan]";

type Cols = {
  card_type: string | null;
  rrn: string | null;
  invoice_no: string | null;
  batch_no: string | null;
  dispatch_batch_no: string | null;
  message: string | null;
  masked_pan: string | null;
};
const SCRUB_COLUMNS = [
  "card_type",
  "rrn",
  "invoice_no",
  "batch_no",
  "dispatch_batch_no",
  "message",
  "masked_pan",
] as const;

type Spec = {
  name: string;
  status?: "approved" | "pending" | "declined";
  cols: Partial<Cols>;
  /** Expected scrubbed columns; absent key = unchanged. */
  expect?: Partial<Cols>;
  /** Several acceptable results (ambiguous case). */
  expectOneOf?: Partial<Cols>[];
};

const cleanCols: Partial<Cols> = {
  card_type: "VISA",
  rrn: "123456789012",
  invoice_no: "000123",
  batch_no: "000045",
  dispatch_batch_no: "000044",
  message: "Transaksi disetujui",
  masked_pan: "411111******1111",
};

const specs: Spec[] = [
  // ---- clean rows: must stay byte-identical
  { name: "clean-full", cols: cleanCols },
  { name: "clean-12-digit-rrn", cols: { rrn: "123456789012" } },
  { name: "clean-nulls", cols: {} },
  {
    name: "clean-11-digits-spaced-in-message",
    status: "declined",
    cols: { message: "Ref 1234 5678 901 ditolak, kode 51" },
  },
  // 12-digit runs: masked in card_type, message and masked_pan like the write
  // path (a 12-digit card number exists), kept in the reference columns.
  {
    name: "message-12-digits-spaced",
    status: "declined",
    cols: { message: "Ref 1234 5678 9012 ditolak, kode 51" },
    expect: { message: "Ref [disamarkan] ditolak, kode 51" },
  },
  { name: "card-type-12-digits", cols: { card_type: "4111 1111 1111" }, expect: { card_type: "UNKNOWN" } },
  { name: "masked-pan-12-digits", cols: { masked_pan: "411111111111" }, expect: { masked_pan: null } },
  { name: "clean-masked-x", cols: { masked_pan: "4111XXXXXX1111" } },
  // ---- PAN in each column separately
  { name: "card-type-plain", cols: { card_type: PAN }, expect: { card_type: "UNKNOWN" } },
  { name: "card-type-spaced", cols: { card_type: PAN_SPACED }, expect: { card_type: "UNKNOWN" } },
  { name: "card-type-dashed", cols: { card_type: PAN_DASHED }, expect: { card_type: "UNKNOWN" } },
  { name: "rrn-plain", cols: { rrn: PAN }, expect: { rrn: null } },
  { name: "rrn-spaced", cols: { rrn: PAN_SPACED }, expect: { rrn: null } },
  { name: "rrn-dashed", cols: { rrn: PAN_DASHED }, expect: { rrn: null } },
  { name: "invoice-plain", cols: { invoice_no: PAN }, expect: { invoice_no: null } },
  { name: "invoice-dashed", cols: { invoice_no: PAN_DASHED }, expect: { invoice_no: null } },
  { name: "batch-plain", cols: { batch_no: PAN }, expect: { batch_no: null } },
  { name: "batch-spaced", cols: { batch_no: PAN_SPACED }, expect: { batch_no: null } },
  {
    name: "dispatch-batch-plain",
    cols: { dispatch_batch_no: PAN },
    expect: { dispatch_batch_no: null },
  },
  {
    name: "dispatch-batch-dashed",
    cols: { dispatch_batch_no: PAN_DASHED },
    expect: { dispatch_batch_no: null },
  },
  // ---- PAN inside message text
  {
    name: "message-plain",
    cols: { message: `Kartu ${PAN} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-spaced",
    cols: { message: `Kartu ${PAN_SPACED} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-dashed",
    cols: { message: `Kartu ${PAN_DASHED} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-two-pans",
    // The trailing 12-digit run is masked too: message uses the 12+ threshold.
    cols: { message: `A ${PAN} | B 5500-0000-0000-0004 | juga 123456789012` },
    expect: { message: `A ${SCRUBBED} | B ${SCRUBBED} | juga ${SCRUBBED}` },
  },
  {
    name: "message-only-pan",
    cols: { message: PAN },
    expect: { message: SCRUBBED },
  },
  // ---- masked_pan
  {
    name: "masked-pan-16",
    cols: { masked_pan: PAN },
    expect: { masked_pan: "411111******1111" },
  },
  {
    name: "masked-pan-13",
    cols: { masked_pan: "4111111111222" },
    expect: { masked_pan: "411111***1222" },
  },
  {
    name: "masked-pan-19",
    cols: { masked_pan: "4111111111111111222" },
    expect: { masked_pan: "411111*********1222" },
  },
  {
    name: "masked-pan-20-digits-not-a-pan-shape",
    cols: { masked_pan: "41111111111111112222" },
    expect: { masked_pan: null },
  },
  {
    name: "masked-pan-card-number-with-letters",
    cols: { masked_pan: "4111111111111111xx" },
    expect: { masked_pan: null },
  },
  {
    name: "masked-pan-spaced",
    status: "pending",
    cols: { masked_pan: PAN_SPACED },
    expect: { masked_pan: "411111******1111" },
  },
  {
    name: "masked-pan-dashed",
    cols: { masked_pan: PAN_DASHED },
    expect: { masked_pan: "411111******1111" },
  },
  // ---- every column dirty at once, non-approved status
  {
    name: "all-columns-dirty-approved",
    cols: {
      card_type: PAN,
      rrn: PAN_SPACED,
      invoice_no: PAN_DASHED,
      batch_no: PAN,
      dispatch_batch_no: PAN_SPACED,
      message: `PAN ${PAN} / ${PAN_DASHED}`,
      masked_pan: PAN,
    },
    expect: {
      card_type: "UNKNOWN",
      rrn: null,
      invoice_no: null,
      batch_no: null,
      dispatch_batch_no: null,
      message: `PAN ${SCRUBBED} / ${SCRUBBED}`,
      masked_pan: "411111******1111",
    },
  },
  {
    name: "all-columns-dirty-pending",
    status: "pending",
    cols: {
      card_type: PAN_DASHED,
      rrn: PAN,
      message: `x ${PAN_SPACED}`,
      masked_pan: PAN,
    },
    expect: {
      card_type: "UNKNOWN",
      rrn: null,
      message: `x ${SCRUBBED}`,
      masked_pan: "411111******1111",
    },
  },
  // ---- a dirty column next to clean ones: clean columns stay
  {
    name: "one-dirty-keeps-clean-columns",
    cols: { ...cleanCols, rrn: PAN },
    expect: { rrn: null },
  },
];

type Fixture = {
  label: "A" | "B";
  tenantId: string;
  outletId: string;
  terminalId: string;
  /** spec.name -> row id */
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
       VALUES ($1, $2, $3, 'bca', $4, 'MID-SCRUB', 'Test EDC', 'lan',
               ARRAY['card','qris'], 'active')`,
      [terminalId, tenantId, outletId, `TID-${terminalId.slice(0, 8)}`],
    );
    for (const spec of subset) {
      const id = randomUUID();
      const status = spec.status ?? "approved";
      seq += 1;
      await client.query(
        `INSERT INTO edc_transactions
           (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
            request_fingerprint, amount_idr, method, status, trace, completed_at,
            card_type, rrn, invoice_no, batch_no, dispatch_batch_no, message,
            masked_pan, updated_at, created_at)
         VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-scrub', $7, 'card', $8::varchar, $9,
                 CASE WHEN $8::varchar = 'pending' THEN NULL ELSE '2024-01-02T03:04:05Z'::timestamptz END,
                 $10, $11, $12, $13, $14, $15, $16,
                 '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z')`,
        [
          id,
          tenantId,
          outletId,
          terminalId,
          `REF-SCRUB-${label}-${seq}`,
          randomUUID(),
          10_000 + seq,
          status,
          `TS${label}${String(seq).padStart(6, "0")}`,
          spec.cols.card_type ?? null,
          spec.cols.rrn ?? null,
          spec.cols.invoice_no ?? null,
          spec.cols.batch_no ?? null,
          spec.cols.dispatch_batch_no ?? null,
          spec.cols.message ?? null,
          spec.cols.masked_pan ?? null,
        ],
      );
      ids.set(spec.name, id);
    }
  });
  return { label, tenantId, outletId, terminalId, ids, specs: subset };
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

/** The whole migration file in ONE transaction, as the drizzle migrator does. */
async function runMigration(): Promise<number> {
  const client = await owner.connect();
  let updated = -1;
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      const result = await client.query(statement);
      if (/^\s*(--[^\n]*\n\s*)*UPDATE/i.test(statement)) {
        updated = result.rowCount ?? -1;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return updated;
}

const isDirty = (spec: Spec) => spec.expect !== undefined || spec.expectOneOf !== undefined;

let before: Map<string, RowJson>;
let afterFirst: Map<string, RowJson>;
let afterSecond: Map<string, RowJson>;
let firstRunUpdated = -1;
let secondRunUpdated = -1;
let dirtyCount = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // SET LOCAL lock_timeout, NO FORCE, UPDATE, FORCE, reset lock_timeout.
  expect(statements.length).toBe(5);
  expect(statements[0]).toMatch(/SET LOCAL lock_timeout/i);
  expect(statements[1]).toMatch(/NO FORCE ROW LEVEL SECURITY/i);
  expect(statements[2]).toMatch(/UPDATE\s+"edc_transactions"/i);
  expect(statements[3]).toMatch(/FORCE ROW LEVEL SECURITY/i);
  expect(statements[3]).not.toMatch(/NO FORCE/i);
  expect(statements[4]).toMatch(/lock_timeout/i);
  isolated = await createIsolatedTenant(`pan-${randomUUID().slice(0, 8)}`);
  // Tenant A: seeded fixture tenant, all specs. Tenant B: isolated tenant,
  // a mixed subset, so a tenant-scoped migration bug would show.
  const subsetB = specs.filter((_, i) => i % 2 === 0 || i < 8);
  fixA = await makeFixture("A", seededTenant.id, seededOutlets[0].id, specs);
  fixB = await makeFixture("B", isolated.tenantId, isolated.outletId, subsetB);
  dirtyCount =
    fixA.specs.filter(isDirty).length + fixB.specs.filter(isDirty).length;

  before = new Map([...(await snapshot(fixA)), ...(await snapshot(fixB))]);
  firstRunUpdated = await runMigration();
  afterFirst = new Map([...(await snapshot(fixA)), ...(await snapshot(fixB))]);
  secondRunUpdated = await runMigration();
  afterSecond = new Map([...(await snapshot(fixA)), ...(await snapshot(fixB))]);
});

afterAll(async () => {
  for (const fix of [fixA, fixB]) {
    if (!fix) continue;
    await asTenant(fix.tenantId, async (client) => {
      await client.query("DELETE FROM edc_transactions WHERE id = ANY($1::uuid[])", [
        [...fix.ids.values()],
      ]);
      await client.query("DELETE FROM payment_edc_terminals WHERE id = $1", [
        fix.terminalId,
      ]);
    });
  }
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("EDC-01 legend-5gub migration 0113 PAN scrub", () => {
  it("covers both tenants with dirty and clean rows", () => {
    expect(before.size).toBe(fixA.ids.size + fixB.ids.size);
    expect(dirtyCount).toBeGreaterThan(30);
    expect(fixB.specs.some(isDirty)).toBe(true);
    expect(fixB.specs.some((s) => !isDirty(s))).toBe(true);
  });

  it("masks every dirty column exactly as specified", () => {
    for (const fix of [fixA, fixB]) {
      for (const spec of fix.specs.filter(isDirty)) {
        const id = fix.ids.get(spec.name)!;
        const row = afterFirst.get(id)!;
        const prior = before.get(id)!;
        const candidates = spec.expectOneOf ?? [spec.expect!];
        const matches = candidates.some((exp) =>
          SCRUB_COLUMNS.every((col) => {
            const want = col in exp ? exp[col] : prior[col];
            return row[col] === want;
          }),
        );
        if (!matches) {
          const got = Object.fromEntries(SCRUB_COLUMNS.map((c) => [c, row[c]]));
          throw new Error(
            `${fix.label}/${spec.name}: got ${JSON.stringify(got)}, wanted one of ${JSON.stringify(
              candidates,
            )} over ${JSON.stringify(
              Object.fromEntries(SCRUB_COLUMNS.map((c) => [c, prior[c]])),
            )}`,
          );
        }
      }
    }
  });

  it("leaves amount, status, completed_at, updated_at, tenant and outlet untouched on every row", () => {
    for (const [id, prior] of before) {
      const row = afterFirst.get(id)!;
      for (const col of [
        "amount_idr",
        "status",
        "completed_at",
        "updated_at",
        "created_at",
        "tenant_id",
        "outlet_id",
        "terminal_id",
        "reference",
        "trace",
        "approval_code",
        "needs_reconciliation",
      ]) {
        expect(row[col], `${id} ${col}`).toEqual(prior[col]);
      }
    }
  });

  it("changes only the scrub columns of dirty rows and nothing in clean rows", () => {
    for (const fix of [fixA, fixB]) {
      for (const spec of fix.specs) {
        const id = fix.ids.get(spec.name)!;
        const prior = before.get(id)!;
        const row = afterFirst.get(id)!;
        if (!isDirty(spec)) {
          // Byte-identical full row.
          expect(JSON.stringify(row), `${fix.label}/${spec.name}`).toBe(
            JSON.stringify(prior),
          );
        } else {
          const rest = (r: RowJson) =>
            Object.fromEntries(
              Object.entries(r).filter(
                ([k]) => !(SCRUB_COLUMNS as readonly string[]).includes(k),
              ),
            );
          expect(rest(row), `${fix.label}/${spec.name}`).toEqual(rest(prior));
        }
      }
    }
  });

  it("keeps clean columns of a dirty row and clean 12-digit values as they were", () => {
    const id = fixA.ids.get("one-dirty-keeps-clean-columns")!;
    const row = afterFirst.get(id)!;
    expect(row).toMatchObject({
      card_type: "VISA",
      rrn: null,
      invoice_no: "000123",
      batch_no: "000045",
      dispatch_batch_no: "000044",
      message: "Transaksi disetujui",
      masked_pan: "411111******1111",
    });
    const rrnRow = afterFirst.get(fixA.ids.get("clean-12-digit-rrn")!)!;
    expect(rrnRow.rrn).toBe("123456789012");
  });

  it("a second run is a no-op: zero rows updated and every row unchanged", () => {
    expect(firstRunUpdated).toBeGreaterThanOrEqual(dirtyCount);
    expect(secondRunUpdated).toBe(0);
    expect(JSON.stringify([...afterSecond])).toBe(
      JSON.stringify([...afterFirst]),
    );
  });

  it("no text column of any row holds a card-number-like run afterwards", () => {
    // Random uuid columns (id, idempotency_key) can hold digit runs split by
    // dashes by chance, so uuid-shaped values are skipped.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const [id, row] of afterSecond) {
      for (const [col, value] of Object.entries(row)) {
        if (typeof value === "string" && !uuid.test(value)) {
          expect(CARD_LIKE.test(value), `${id} ${col}=${value}`).toBe(false);
        }
      }
    }
  });

  it("every surviving masked_pan passes maskedPanSchema", () => {
    let seen = 0;
    for (const row of afterSecond.values()) {
      if (row.masked_pan === null) continue;
      seen += 1;
      expect(
        maskedPanSchema.safeParse(row.masked_pan).success,
        String(row.masked_pan),
      ).toBe(true);
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("forced row level security is on again after the migration", async () => {
    const result = await owner.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'edc_transactions'`,
    );
    expect(result.rows).toEqual([{ enabled: true, forced: true }]);
  });
  // Realistic deploy: the migration role owns the table but is NOT a superuser
  // and does NOT bypass RLS, and no tenant context is set. Everything runs in
  // one transaction that is rolled back, so ownership and data revert.
  it("under a NOSUPERUSER NOBYPASSRLS owner role the bare UPDATE fails and the 5 statements scrub", async () => {
    const role = `scrub_probe_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const rowId = randomUUID();
    const setContext = (client: PoolClient, tenant: string, outlets: string) =>
      client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant, outlets],
      );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await setContext(client, fixA.tenantId, "*");
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      // legend_app carries USAGE on schema app (the RLS policy functions).
      await client.query(`GRANT legend_app TO ${role}`);
      await client.query(`GRANT ${role} TO CURRENT_USER`);
      await client.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
      await client.query(`ALTER TABLE edc_transactions OWNER TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);

      const who = await client.query(
        `SELECT r.rolsuper, r.rolbypassrls, c.relowner = r.oid AS owner_is_me
         FROM pg_roles r, pg_class c
         WHERE r.rolname = current_user AND c.oid = 'public.edc_transactions'::regclass`,
      );
      expect(who.rows).toEqual([
        { rolsuper: false, rolbypassrls: false, owner_is_me: true },
      ]);

      seq += 1;
      await client.query(
        `INSERT INTO edc_transactions
           (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
            request_fingerprint, amount_idr, method, status, trace, completed_at,
            card_type, rrn, invoice_no, batch_no, dispatch_batch_no, message,
            masked_pan, updated_at, created_at)
         VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-scrub', 12345, 'card', 'approved', $7,
                 '2024-01-02T03:04:05Z', $8, $9, '000123', '000045', '000044', $10, $11,
                 '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z')`,
        [
          rowId,
          fixA.tenantId,
          fixA.outletId,
          fixA.terminalId,
          `REF-SCRUB-ROLE-${seq}`,
          randomUUID(),
          `TSR${String(seq).padStart(6, "0")}`,
          PAN_SPACED,
          PAN,
          `Kartu ${PAN_DASHED} ditolak`,
          PAN,
        ],
      );

      // Migration time: no tenant context.
      await setContext(client, "", "");

      // The bare UPDATE (statement 3 alone) hits FORCE RLS and fails.
      await client.query("SAVEPOINT bare_update");
      await expect(client.query(statements[2])).rejects.toThrow(
        /tenant context is required/,
      );
      await client.query("ROLLBACK TO SAVEPOINT bare_update");

      // The 5 statements together, as the migrator runs them, succeed.
      let updated = -1;
      for (const statement of statements) {
        const result = await client.query(statement);
        if (/^\s*(--[^\n]*\n\s*)*UPDATE/i.test(statement)) {
          updated = result.rowCount ?? -1;
        }
      }
      expect(updated).toBeGreaterThanOrEqual(1);

      // FORCE is back on: reading without tenant context fails again.
      await client.query("SAVEPOINT forced_again");
      await expect(
        client.query("SELECT 1 FROM edc_transactions LIMIT 1"),
      ).rejects.toThrow(/tenant context is required/);
      await client.query("ROLLBACK TO SAVEPOINT forced_again");

      // With the tenant context back, the row is masked.
      await setContext(client, fixA.tenantId, "*");
      const scrubbed = await client.query(
        `SELECT card_type, rrn, message, masked_pan, invoice_no, amount_idr, status
         FROM edc_transactions WHERE id = $1`,
        [rowId],
      );
      expect(scrubbed.rows).toEqual([
        {
          card_type: "UNKNOWN",
          rrn: null,
          message: `Kartu ${SCRUBBED} ditolak`,
          masked_pan: "411111******1111",
          invoice_no: "000123",
          amount_idr: "12345", // bigint column: node-pg returns a string
          status: "approved",
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // Rolled back: the probe role and the ownership change are gone.
    const after = await owner.query(
      `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = $1)::int AS roles,
              pg_get_userbyid(c.relowner) <> $1 AS owner_restored
       FROM pg_class c WHERE c.oid = 'public.edc_transactions'::regclass`,
      [role],
    );
    expect(after.rows).toEqual([{ roles: 0, owner_restored: true }]);
  });
});
