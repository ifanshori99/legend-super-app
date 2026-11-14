// Card legend-qsgg3 (docs/briefs/ws-finance-followups.md): a manual reversal
// through the journal SERVICE (`reverseJournal`, the call behind the reverse
// endpoint) of a journal that fixed_asset_depreciations or
// fixed_asset_depreciation_reversals references is refused with HttpError 409
// DEPRECIATION_JOURNAL_LOCKED, never the raw database error and never a posted
// mirror entry. Per the coordinator the guard already exists, so this file is
// expected to PASS on arrival (a regression net, not fail-first).
//
// Assumptions:
// - The reversal is requested in the journal's own open month, so the only
//   reason for refusal is the depreciation lock.
// - The internal asset path (a backdated disposal that writes correcting
//   journals) is the "internal route must keep working" proof.
// - Ordinary-journal reversal through the service is covered by
//   accounting-journal.test.ts and is not repeated here.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema } from "@starter/shared/core";
import { reverseJournal } from "../services/accounting-journal.service";
import {
  actor,
  allDepreciationRows,
  createAsset,
  disposeAsset,
  makeEntity,
  NOW,
  owner,
  postCorrection,
  runMonth,
  setupAssetLedger,
  tenantId,
  tenantScope,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

async function depreciationLedger() {
  const entity = await makeEntity("Depreciation service reverse");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  await runMonth(entity, "2026-02");
  await runMonth(entity, "2026-03");
  const rows = await allDepreciationRows(machine.id);
  return { entity, machine, rows };
}

async function entryDateOf(journalId: string): Promise<string> {
  const { rows } = await owner.query<{ d: string }>(
    "SELECT entry_date::text AS d FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, journalId],
  );
  return rows[0]!.d;
}

async function reversalCount(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
    [tenantId, journalId],
  );
  return Number(rows[0]!.n);
}

async function manualReverse(journalId: string) {
  return reverseJournal(
    tenantScope(),
    journalId,
    {
      entryDate: businessDateSchema.parse(await entryDateOf(journalId)),
      reason: "Koreksi manual (qsgg3 test)",
      idempotencyKey: `rev-${randomUUID()}`,
    },
    actor,
    NOW,
  );
}

async function refusal(journalId: string) {
  try {
    await manualReverse(journalId);
  } catch (error) {
    return error as { name?: string; status?: number; code?: string };
  }
  throw new Error("manual reversal was accepted");
}

describe("legend-qsgg3 reverseJournal refuses depreciation journals", () => {
  it("ACC-01 the journal of an original depreciation run is refused with 409 DEPRECIATION_JOURNAL_LOCKED and nothing is posted", async () => {
    const { rows } = await depreciationLedger();
    const journalId = rows[1]!.journalEntryId;
    const error = await refusal(journalId);
    expect(error.name).toBe("HttpError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("DEPRECIATION_JOURNAL_LOCKED");
    expect(await reversalCount(journalId)).toBe(0);
  });

  it("ACC-01 the correcting journal of a taken-back depreciation row is refused the same way", async () => {
    const { rows } = await depreciationLedger();
    const march = rows[2]!;
    const correction = await postCorrection(march.journalEntryId);
    await owner.query(
      `INSERT INTO fixed_asset_depreciation_reversals
         (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
       VALUES ($1, $2, $3, 'Pelepasan mundur (qsgg3 test)', 'test-actor')`,
      [tenantId, march.id, correction],
    );
    const error = await refusal(correction);
    expect(error.name).toBe("HttpError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("DEPRECIATION_JOURNAL_LOCKED");
    expect(await reversalCount(correction)).toBe(0);
  });

  it("ACC-01 a refused attempt leaves the depreciation journals untouched and balanced", async () => {
    const { rows } = await depreciationLedger();
    const journalId = rows[0]!.journalEntryId;
    await refusal(journalId);
    const { rows: sums } = await owner.query<{ d: string; c: string }>(
      `SELECT sum(debit_idr)::text AS d, sum(credit_idr)::text AS c
         FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
      [tenantId, journalId],
    );
    expect(sums[0]!.d).toBe("1000000");
    expect(sums[0]!.c).toBe("1000000");
  });

  it("ACC-01 the internal asset path still works: a backdated disposal corrects the later months through the fixed-asset service", async () => {
    const { machine } = await depreciationLedger();
    const sold = await disposeAsset(machine.id, "2026-02-20", 10_000_000);
    expect(sold.status).toBe("disposed");
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);
  });
});
