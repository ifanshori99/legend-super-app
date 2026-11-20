// Card 1218 (SO 1216 F-P1b, docs/briefs/1217-1220-fix-so1216.md): the manual
// reversal endpoint (`reverseJournal`) refuses an automatic expense accrual
// that has its own correction flow: the payroll run-lock accrual
// (`payroll-gl:locked:*`, corrected by cancelling the run) and the inventory
// GL journals (HPP `cogs`, waste/count `stock_adjustment`, corrected through
// the stock movement). Reversing them by hand removes the expense, raises the
// profit and so the profit share. Sales, receipts, payouts and manual
// journals stay reversible (CTO decision: deny list, option b).

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema } from "@starter/shared/core";
import { reverseJournal } from "../services/accounting-journal.service";
import {
  actor,
  makeFixture,
  NOW,
  owner,
  saleLines,
  tenantId,
  tenantScope,
  withOwner,
  type Fx,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

/** A posted journal of `sourceType` with the given idempotency key. */
async function postedJournal(
  fx: Fx,
  sourceType: string,
  idempotencyKey: string,
): Promise<string> {
  return withOwner(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2025-01-15', $3, $4, NULL, 'Jurnal 1218', NULL, $5, $6)
       RETURNING id`,
      [
        tenantId,
        fx.entity,
        fx.jan,
        sourceType,
        idempotencyKey,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const line of saleLines(fx, 60_000_000)) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, entryId, line.accountId, lineNo, line.debit, line.credit],
      );
      lineNo += 1;
    }
    return entryId;
  });
}

const manualReverse = (journalId: string) =>
  reverseJournal(
    tenantScope(),
    journalId,
    {
      entryDate: businessDateSchema.parse("2025-01-20"),
      reason: "Koreksi manual (1218 test)",
      idempotencyKey: `rev-${randomUUID()}`,
    },
    actor,
    NOW,
  );

async function reversalCount(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
    [tenantId, journalId],
  );
  return Number(rows[0]!.n);
}

async function expectLocked(journalId: string): Promise<void> {
  const error = await manualReverse(journalId).then(
    () => {
      throw new Error("manual reversal was accepted");
    },
    (reason: unknown) =>
      reason as { name?: string; status?: number; code?: string },
  );
  expect(error.name).toBe("HttpError");
  expect(error.status).toBe(409);
  expect(error.code).toBe("AUTO_JOURNAL_LOCKED");
  expect(await reversalCount(journalId)).toBe(0);
}

describe("1218 manual reversal of an automatic expense accrual", () => {
  it("1218-PAYROLL the payroll run-lock accrual is refused with 409 AUTO_JOURNAL_LOCKED and nothing is posted", async () => {
    const fx = await makeFixture();
    const journal = await postedJournal(
      fx,
      "payroll",
      `payroll-gl:locked:${randomUUID()}`,
    );
    await expectLocked(journal);
  });

  it("1218-COGS the HPP journal of a sale is refused the same way", async () => {
    const fx = await makeFixture();
    const journal = await postedJournal(fx, "cogs", `inv-gl-${randomUUID()}`);
    await expectLocked(journal);
  });

  it("1218-STOCK a waste or stock count journal is refused the same way", async () => {
    const fx = await makeFixture();
    const journal = await postedJournal(
      fx,
      "stock_adjustment",
      `inv-gl-${randomUUID()}`,
    );
    await expectLocked(journal);
  });

  it("1218-ALLOWED a manual journal, a sale and a payroll payout are still reversed", async () => {
    const fx = await makeFixture();
    for (const [sourceType, key] of [
      ["manual", `manual-${randomUUID()}`],
      ["sale", `sale-${randomUUID()}`],
      ["payroll", `payroll-gl:paid:${randomUUID()}`],
    ] as const) {
      const journal = await postedJournal(fx, sourceType, key);
      const reversal = await manualReverse(journal);
      expect(reversal.reversalOf).toBe(journal);
      expect(await reversalCount(journal)).toBe(1);
    }
  });
});
