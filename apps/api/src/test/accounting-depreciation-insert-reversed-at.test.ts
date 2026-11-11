// Finding 4 of the second-opinion on 0313 (brief "ledger guards fixes", item 4,
// P2). The unique partial index
//   fixed_asset_depreciations (tenant_id, fixed_asset_id, period) WHERE reversed_at IS NULL
// only guards ACTIVE rows. An INSERT that already carries a non-null
// `reversed_at` is outside the index, so it slips past the uniqueness guard and
// the same asset month can be counted again. Decision (CTO): `reversed_at` is
// set only by the SECURITY DEFINER reversal function; a new row is always
// active (INSERT with reversed_at not null is refused, by trigger or by column
// privilege, or both).
//
// Rules under test: no depreciation counted twice (ACC-01).
//
// Assumptions (the brief does not pin these down):
// - A refusal is 23514 (check/trigger), 22023, P0001 or 42501 (column privilege
//   for `legend_app`). It must not be 23505: the unique index is not what
//   stops this row, it never sees it.
// - The month used (2026-09) has no row yet, so no other guard than this one can
//   refuse the INSERT; the test fails today because the INSERT succeeds.
// - Inserting a normal active row (reversed_at omitted or NULL) keeps working
//   for the migration owner; the service path is covered by other tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  allDepreciationRows,
  createAsset,
  failure,
  makeEntity,
  owner,
  runMonth,
  setupAssetLedger,
  tenantId,
  withAppRole,
  withOwner,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

const REFUSAL_CODES = ["23514", "22023", "P0001", "42501"];

const INSERT_REVERSED = `INSERT INTO fixed_asset_depreciations
   (tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id, generation, reversed_at)
 VALUES ($1, $2, $3, 1000000, $4, $5, now())`;

const INSERT_ACTIVE = `INSERT INTO fixed_asset_depreciations
   (tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id, generation)
 VALUES ($1, $2, $3, 1000000, $4, $5)`;

async function seededAsset() {
  const entity = await makeEntity("Depreciation insert reversed_at");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  const [january] = await allDepreciationRows(machine.id);
  return { machine, january: january! };
}

async function rowsFor(assetId: string, period: string) {
  const { rows } = await owner.query<{
    generation: number;
    reversed_at: Date | null;
  }>(
    `SELECT generation, reversed_at FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND fixed_asset_id = $2 AND period = $3
      ORDER BY generation`,
    [tenantId, assetId, period],
  );
  return rows;
}

function expectRefused(error: { code?: string; message: string }) {
  expect(
    error.code,
    `expected the INSERT to be refused, got: ${error.message}`,
  ).not.toBe("23505");
  expect(REFUSAL_CODES).toContain(error.code);
}

describe("finding 4: a depreciation row is born active; only the reversal function sets reversed_at", () => {
  it("ACC-01 a direct INSERT with a non-null reversed_at is refused for the migration owner", async () => {
    const { machine, january } = await seededAsset();
    const error = await failure(
      owner.query(INSERT_REVERSED, [
        tenantId,
        machine.id,
        "2026-09",
        january.journalEntryId,
        1,
      ]),
    );
    expectRefused(error);
    expect(await rowsFor(machine.id, "2026-09")).toEqual([]);
  });

  it("ACC-01 the same INSERT is refused for the application role (the API's own database role)", async () => {
    const { machine, january } = await seededAsset();
    const error = await failure(
      withAppRole((client) =>
        client.query(INSERT_REVERSED, [
          tenantId,
          machine.id,
          "2026-09",
          january.journalEntryId,
          1,
        ]),
      ),
    );
    expectRefused(error);
    expect(await rowsFor(machine.id, "2026-09")).toEqual([]);
  });

  it("ACC-01 a second generation of a month that has an active row cannot be smuggled in as already reversed", async () => {
    const { machine, january } = await seededAsset();
    // 2026-01 is active (generation 1). A row born "reversed" would sit outside
    // the unique partial index and double the month once it is flipped or read.
    const error = await failure(
      owner.query(INSERT_REVERSED, [
        tenantId,
        machine.id,
        "2026-01",
        january.journalEntryId,
        2,
      ]),
    );
    expect(REFUSAL_CODES.concat("23505")).toContain(error.code);
    const rows = await rowsFor(machine.id, "2026-01");
    expect(rows.map((row) => row.generation)).toEqual([1]);
    expect(rows[0]!.reversed_at).toBeNull();
  });

  it("ACC-01 race: an active row committed by one transaction and a pre-reversed row from another cannot both reach the ledger", async () => {
    const { machine, january } = await seededAsset();
    const first = await owner.connect();
    const second = await owner.connect();
    let secondRefused: { code?: string; message: string } | undefined;
    try {
      await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await first.query("SELECT 1 FROM fiscal_periods LIMIT 1");
      await second.query("SELECT 1 FROM fiscal_periods LIMIT 1");

      await first.query(INSERT_ACTIVE, [
        tenantId,
        machine.id,
        "2026-09",
        january.journalEntryId,
        1,
      ]);
      // The pre-reversed row is outside the unique index, so it never waits on
      // the first transaction: it is refused at once or it is accepted.
      try {
        await second.query(INSERT_REVERSED, [
          tenantId,
          machine.id,
          "2026-09",
          january.journalEntryId,
          2,
        ]);
        await second.query("COMMIT");
      } catch (error) {
        secondRefused = error as { code?: string; message: string };
      }
      await first.query("COMMIT");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(
      secondRefused,
      "the pre-reversed duplicate of the month was accepted",
    ).toBeDefined();
    expectRefused(secondRefused!);
    const rows = await rowsFor(machine.id, "2026-09");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reversed_at).toBeNull();
  });

  it("ACC-01 a normal active INSERT (reversed_at omitted) is still accepted, so the guard does not over-block", async () => {
    const { machine, january } = await seededAsset();
    await withOwner((client: PoolClient) =>
      client.query(INSERT_ACTIVE, [
        tenantId,
        machine.id,
        "2026-09",
        january.journalEntryId,
        1,
      ]),
    );
    const rows = await rowsFor(machine.id, "2026-09");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reversed_at).toBeNull();
  });
});
