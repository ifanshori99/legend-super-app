// Finding 1 of docs/briefs/497-findings-fixes.md (second-opinion G8mjq on
// 0310_journal_closed_period_guard): a journal writer that runs in REPEATABLE
// READ keeps an old snapshot. If a close commits after that snapshot, the
// writer still sees the period as open and the journal changes after the close
// snapshot. Decision (CTO): closing or reopening a period UPDATEs the legal
// entity row (raises `legal_entities.ledger_version`), and the journal trigger
// locks that row. A REPEATABLE READ writer with an older snapshot then fails
// with serialization failure 40001 instead of writing into the closed month.
//
// Two real PostgreSQL connections, no mocks. Rules under test: no journal
// enters a closed period on any path (ACC-02); the journal stays balanced and
// equal to the close snapshot (ACC-01).
//
// Assumptions (the brief does not pin these down):
// - `ledger_version` is bigint NOT NULL DEFAULT 0 on legal_entities and
//   increases by at least one for every status change of a fiscal period of
//   that entity (the tests assert "greater", not "exactly one").
// - The serialization failure is the standard PostgreSQL one: SQLSTATE 40001.
// - A writer whose snapshot starts AFTER the close is refused with the
//   existing PERIOD_CLOSED error, not 40001.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import {
  CLOSE_SQL,
  approver,
  closer,
  ensureUsers,
  entryCount,
  key,
  ledgerVersion,
  makeFixture,
  owner,
  periodRow,
  rawInsertEntry,
  reopener,
  saleLines,
  tenantId,
  tenantScope,
  type Fx,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ensureUsers();
});

afterAll(async () => {
  await owner.end();
});

/** Opens a REPEATABLE READ transaction whose snapshot is taken right now. */
async function repeatableReadWriter(periodId: string, asAppRole: boolean) {
  const client = await owner.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  if (asAppRole) {
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
  }
  // The first query of the transaction fixes the snapshot: it sees the period open.
  const { rows } = await client.query<{ status: string }>(
    "SELECT status FROM fiscal_periods WHERE id = $1",
    [periodId],
  );
  expect(rows[0]?.status).toBe("open");
  return client;
}

/** Closes a period on its own connection (autocommit) as a legal close. */
async function closeCommitted(periodId: string): Promise<void> {
  await owner.query(CLOSE_SQL, [periodId, closer]);
}

async function staleWriterIsRefused(
  fx: Fx,
  asAppRole: boolean,
  entriesBefore = 0,
) {
  const writer = await repeatableReadWriter(fx.jan, asAppRole);
  try {
    // The close commits AFTER the writer's snapshot.
    await closeCommitted(fx.jan);
    expect((await periodRow(fx.jan)).status).toBe("closed");

    let error: (Error & { code?: string }) | undefined;
    try {
      await rawInsertEntry(writer, {
        entity: fx.entity,
        periodId: fx.jan,
        date: "2025-01-20",
        lines: saleLines(fx, 6_000),
      });
      await writer.query("COMMIT");
    } catch (caught) {
      error = caught as Error & { code?: string };
    }
    expect(
      error,
      "a REPEATABLE READ writer with a stale snapshot wrote into a closed month",
    ).toBeDefined();
    expect(error!.code).toBe("40001");
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
  }
  expect(await entryCount(fx.entity, fx.jan)).toBe(entriesBefore);
}

describe("497 finding 1: the closed-period guard holds against stale REPEATABLE READ snapshots", () => {
  it("ACC-02 closing a period raises legal_entities.ledger_version, reopening raises it again", async () => {
    const fx = await makeFixture();
    const start = await ledgerVersion(fx.entity);

    const closed = await closeFiscalPeriod(
      tenantScope(),
      fx.jan,
      { expectedVersion: 1, idempotencyKey: key("close") },
      userIdSchema.parse(closer),
    );
    expect(closed.status).toBe("closed");
    const afterClose = await ledgerVersion(fx.entity);
    expect(afterClose).toBeGreaterThan(start);

    const request = await requestPeriodReopen(
      tenantScope(),
      fx.jan,
      { reason: "Koreksi kas Januari (ledger version test)" },
      userIdSchema.parse(reopener),
    );
    await approvePeriodReopen(
      tenantScope(),
      request.id,
      { note: null },
      userIdSchema.parse(approver),
    );
    expect((await periodRow(fx.jan)).status).toBe("open");
    expect(await ledgerVersion(fx.entity)).toBeGreaterThan(afterClose);
  });

  it("ACC-02 a close of one legal entity does not move another entity's ledger_version", async () => {
    const closing = await makeFixture();
    const other = await makeFixture();
    const otherBefore = await ledgerVersion(other.entity);
    await closeCommitted(closing.jan);
    expect(await ledgerVersion(other.entity)).toBe(otherBefore);
  });

  it("ACC-02 a REPEATABLE READ writer whose snapshot predates a committed close is refused with 40001 (migration owner)", async () => {
    await staleWriterIsRefused(await makeFixture(), false);
  });

  it("ACC-02 the same race through the application role (the API's own database role) is refused with 40001", async () => {
    await staleWriterIsRefused(await makeFixture(), true);
  });

  it("ACC-02 a REPEATABLE READ writer whose snapshot starts after the close is refused with PERIOD_CLOSED", async () => {
    const fx = await makeFixture();
    await closeCommitted(fx.jan);
    const client = await owner.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        rawInsertEntry(client, {
          entity: fx.entity,
          periodId: fx.jan,
          date: "2025-01-20",
          lines: saleLines(fx, 6_000),
        }),
      ).rejects.toThrow(/PERIOD_CLOSED/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await entryCount(fx.entity, fx.jan)).toBe(0);
  });

  it("ACC-02 does not over-block: a stale REPEATABLE READ writer still posts into the open month of an entity nobody closed", async () => {
    const closing = await makeFixture();
    const writing = await makeFixture();
    const writer = await owner.connect();
    try {
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writer.query("SELECT 1 FROM fiscal_periods WHERE id = $1", [
        writing.jan,
      ]); // snapshot taken
      await closeCommitted(closing.jan); // a close of ANOTHER entity commits
      await rawInsertEntry(writer, {
        entity: writing.entity,
        periodId: writing.jan,
        date: "2025-01-20",
        lines: saleLines(writing, 4_000),
      });
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    expect(await entryCount(writing.entity, writing.jan)).toBe(1);
  });

  it("ACC-01 after the refused stale write the closed month holds only its own, balanced entries", async () => {
    const fx = await makeFixture();
    // One legal entry before the close, then the stale writer loses the race.
    const seed = await owner.connect();
    try {
      await seed.query("BEGIN");
      await rawInsertEntry(seed, {
        entity: fx.entity,
        periodId: fx.jan,
        date: "2025-01-10",
        lines: saleLines(fx, 40_000),
      });
      await seed.query("COMMIT");
    } finally {
      seed.release();
    }
    await staleWriterIsRefused(fx, false, 1);
    const { rows } = await owner.query<{ d: string; c: string }>(
      `SELECT COALESCE(sum(l.debit_idr), 0)::text AS d, COALESCE(sum(l.credit_idr), 0)::text AS c
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
        WHERE e.legal_entity_id = $1 AND e.fiscal_period_id = $2`,
      [fx.entity, fx.jan],
    );
    expect(Number(rows[0]!.d)).toBe(40_000);
    expect(Number(rows[0]!.c)).toBe(40_000);
  });
});
