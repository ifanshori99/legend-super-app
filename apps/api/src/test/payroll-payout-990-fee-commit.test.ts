// Payout 990, card B (bead legend-d9pxr; docs/briefs/sub-990-payout-lanjutan.md
// card B, I3 and I4). Written fail-first from the brief and the CTO decisions,
// NOT from the implementation.
//
// Rules proven here (founder: the GL matches the money that moved; nobody pays
// or loses more than the stored amounts):
// - An item moving failed -> overpaid whose overpaid posting carries fee_idr > 0
//   is refused at COMMIT (23514) when the fee journal
//   `payroll-payout-overpaid-fee:<id>` does not exist. Only the principal
//   journal was checked before.
// - With the balanced fee journal the same move commits (control).
// - A posting with fee_idr = 0 needs no fee journal (control, no false refusal).
// - The same holds for a run without a locked journal (accounting on, fee only).
// - The night recon flags an overpaid item whose fee journal is missing or was
//   reversed (journal_missing / journal_reversed).
// - Two simultaneous overpaid reports: one posting, one fee journal, Rp5.000.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The `<id>` of the fee journal key is the item id, like
//   `payroll-payout-overpaid:<itemId>`; if the key carries the posting id the
//   lookup below also finds it (`feeKeyOf` tries both).
// - SIMULATION OF A TRUSTED PATH WITHOUT FEE JOURNAL. A real overpaid world is
//   built through the services (item snapshot BEFORE and AFTER). Then, as table
//   owner with guards off, the item is put back to its BEFORE state (and the fee
//   journal removed or the posting fee set to 0), and the AFTER state is replayed
//   as the trusted role `legend_payout` with the overpaid GUC on and a REAL
//   COMMIT (pattern `[db-overpaid-guard]` in payroll-payout-hardening). Only the
//   columns that differ between the snapshots are written. The control (fee
//   journal present) proves the replay itself is accepted; the refusal is then
//   about the fee journal only. A refusal is SQLSTATE 23514 at the statement or
//   at COMMIT; the message naming PAYOUT-90 is the CTO decision for the new
//   check and is asserted only as "mentions PAYOUT-".
// - Recon entry point: same adapter as payroll-payout-905-recon.test.ts
//   (`reconcileTrustedPayouts(context, {storage, after})`, paged).
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import { reverseJournal } from "../services/accounting-journal.service.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  ANDI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("990fee");
const FEE = 5_000;
const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const GUARD_CODE = "23514";
const NOTE = "Mutasi bank menunjukkan transfer kedua untuk slip yang sama";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const FEE_PREFIX = "payroll-payout-overpaid-fee:";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
  "reconcilePayoutTrustedBoundary",
  "reconcilePayoutTrusted",
  "runPayoutReconciliation",
];

type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];
type Json = Record<string, unknown>;

let reverser = "";

beforeAll(async () => {
  const { userId } = await W.signedInClient("Fee990 Reverser");
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  reverser = userId;
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

// ---- Worlds (patterns of payroll-payout-source-active.test.ts) -------------------------

const idOf = (row: Row) => row.id as string;

async function exportedRun(options: { lockedJournal?: boolean } = {}) {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  if (options.lockedJournal !== false) await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}

/** Budi's first transfer failed (two people), a follow-up paid him: a double payment candidate. */
async function lateDoublePayment(options: { lockedJournal?: boolean } = {}) {
  const { runId, batchId, items } = await exportedRun(options);
  const budiFirst = items.find((i) => i.employee_id === BUDI.id)!;
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.employee_id !== BUDI.id),
    ),
  );
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP);
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP3);
  const followUp = await W.exportedBatch(runId);
  const followItems = (await W.itemsOf(followUp)).filter(
    (i) => i.status === "exported",
  );
  expect(followItems, "premise: one follow-up attempt").toHaveLength(1);
  await W.confirm(followUp, W.succeedItems(followUp, followItems));
  return { runId, batchId, followUp, itemId: idOf(budiFirst) };
}

const recordOverpaidItem = async (
  itemId: string,
  batchId: string,
  by = APP,
) => {
  // The second step needs the first step of another person.
  await W.proposeOverpaid(
    batchId,
    itemId,
    uploadEvidence(batchId, "mutasi-bank.pdf"),
    NOTE,
    by,
  );
  return W.inTx((tx: Tx) =>
    (
      glService as unknown as {
        recordOverpaidItem: (...args: unknown[]) => Promise<unknown>;
      }
    ).recordOverpaidItem(
      tx,
      actorOf(by),
      itemId,
      { evidenceKey: uploadEvidence(batchId, "mutasi-bank.pdf"), note: NOTE },
      W.proofs(),
    ),
  );
};

const itemJson = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT to_jsonb(i) AS j FROM payroll_disbursement_items i
        WHERE i.tenant_id = $1 AND i.id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.j as Json;

/** An overpaid item recorded through the services, with its BEFORE and AFTER item rows. */
async function overpaidWorld(options: { lockedJournal?: boolean } = {}) {
  const w = await lateDoublePayment(options);
  const before = await itemJson(w.itemId);
  expect(before.status, "premise: failed before").toBe("failed");
  await recordOverpaidItem(w.itemId, w.batchId);
  const after = await itemJson(w.itemId);
  expect(after.status, "premise: overpaid after").toBe("overpaid");
  const postingId = after.gl_posting_id as string;
  expect(
    postingId,
    "premise: the item links its overpaid posting",
  ).toBeTruthy();
  const [posting] = await W.rowsOf(
    `SELECT kind, fee_idr::text AS fee FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, postingId],
  );
  expect(posting?.kind, "premise: an overpaid posting").toBe("overpaid");
  expect(Number(posting?.fee), "premise: the stored fee is Rp5.000").toBe(FEE);
  return { ...w, before, after, postingId };
}

// ---- Fee journal ------------------------------------------------------------------------

/** The idempotency key of the fee journal (item id, else posting id). */
async function feeKeyOf(itemId: string, postingId: string) {
  for (const id of [itemId, postingId]) {
    const key = `${FEE_PREFIX}${id}`;
    if ((await W.countJournals(key)) > 0) return key;
  }
  expect.fail(
    `premise: a fee journal ${FEE_PREFIX}<item or posting id> exists for the overpaid item`,
  );
}
const feeEntryCount = async (itemId: string, postingId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries
          WHERE tenant_id = $1 AND legal_entity_id = $2
            AND idempotency_key LIKE $3
            AND (idempotency_key LIKE '%' || $4 || '%' OR idempotency_key LIKE '%' || $5 || '%')`,
        [W.tenantId, W.entityId(), `${FEE_PREFIX}%`, itemId, postingId],
      )
    )[0]!.n,
  );

const dropJournal = (key: string) =>
  W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
         (SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2)`,
      [W.tenantId, key],
    );
    await c.query(
      `DELETE FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
      [W.tenantId, key],
    );
  }, true);

async function reverseTheJournal(key: string) {
  const [entry] = await W.rowsOf(
    `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS day FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [W.tenantId, key],
  );
  expect(
    entry,
    "premise: the fee journal exists before it is reversed",
  ).toBeDefined();
  await reverseJournal(
    W.scope(),
    entry!.id as string,
    {
      entryDate: entry!.day as string,
      reason: "Koreksi keuangan",
      idempotencyKey: `fee990-${randomUUID()}`,
    },
    userIdSchema.parse(reverser),
  );
}

// ---- Item snapshots and the replay ------------------------------------------------------

const changedColumns = (from: Json, to: Json) =>
  Object.keys(to).filter(
    (k) =>
      /^[a-z0-9_]+$/.test(k) &&
      k !== "id" &&
      k !== "tenant_id" &&
      JSON.stringify(from[k]) !== JSON.stringify(to[k]),
  );
const updateItemTo = (
  c: import("pg").PoolClient,
  itemId: string,
  target: Json,
  columns: string[],
) =>
  c.query(
    `UPDATE payroll_disbursement_items i
        SET ${columns.map((col) => `"${col}" = r."${col}"`).join(", ")}
       FROM jsonb_populate_record(NULL::payroll_disbursement_items, $3::jsonb) r
      WHERE i.tenant_id = $1 AND i.id = $2`,
    [W.tenantId, itemId, JSON.stringify(target)],
  );

/** Owner, guards off: the item goes back to the state before the overpaid record. */
const revertItem = (itemId: string, before: Json, after: Json) =>
  W.asTenant(
    (c) => updateItemTo(c, itemId, before, changedColumns(before, after)),
    true,
  );

/** The trusted role replays the failed -> overpaid move with a REAL commit; the error, or null. */
const replayOverpaid = (itemId: string, before: Json, after: Json) =>
  W.asTenant(async (c) => {
    // The commit check (0414/0462) only accepts a `record` attestation written in
    // the SAME transaction (txid = txid_current()). The real record happened in
    // an earlier transaction, so this replay re-stamps that one row (owner,
    // guards off), then turns the guards back on for the move itself.
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      `UPDATE payroll_payout_attestations a
          SET txid = pg_catalog.txid_current()
        WHERE a.tenant_id = $1 AND a.kind = 'overpaid' AND a.step = 'record'
          AND a.item_ids @> ARRAY[$2::uuid]`,
      [W.tenantId, itemId],
    );
    await c.query("SET LOCAL session_replication_role = origin");
    await c.query("SET LOCAL ROLE legend_payout");
    await c.query("SELECT set_config('app.payout_overpaid', 'on', true)");
    await updateItemTo(c, itemId, after, changedColumns(before, after));
  }).then(
    () => null,
    (error: unknown) => error as { code?: string; message?: string },
  );

const statusOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.status as string;

// =========================================================================
// Recon: the fee journal of an overpaid item
// =========================================================================

type ReconModule = Record<string, unknown>;
async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as ReconModule;
  const name = RECON_EXPORTS.find((n) => typeof mod[n] === "function");
  expect(
    name,
    `payroll-payout-recon.service.ts must export the night run; it exports: ${Object.keys(mod).join(", ")}`,
  ).toBeDefined();
  const { storage } = W.proofs();
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}
const exceptionsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const financeFlags = async () => {
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const result = await listFinanceExceptions(W.scope(), {
    from: day(-2),
    to: day(2),
    kind: "payout_recon_flag",
  } as never);
  return JSON.stringify(result.items);
};
async function expectFlagged(itemId: string, reason: string, label: string) {
  const rows = await exceptionsOf(itemId);
  expect(
    rows.some((r) => String(r.reason).includes(reason)),
    `${label}: recon exception with reason ${reason}; got ${JSON.stringify(rows.map((r) => r.reason))}`,
  ).toBe(true);
  const shown = await financeFlags();
  expect(
    [itemId, ...rows.map((r) => r.operation_id as string)].some((id) =>
      shown.includes(id),
    ),
    `${label}: finance exception payout_recon_flag mentions the item or operation`,
  ).toBe(true);
}

describe("990 B recon: the overpaid fee journal is checked", () => {
  it("[legend-d9pxr-recon-fee-missing] a legit overpaid item is not flagged; once its fee journal is gone the night run flags journal_missing and holds the slip", async () => {
    const w = await overpaidWorld();
    await runRecon();
    expect(
      await exceptionsOf(w.itemId),
      "control: a legit overpaid item (fee journal present) is not flagged",
    ).toHaveLength(0);

    await dropJournal(await feeKeyOf(w.itemId, w.postingId));
    await runRecon();
    await expectFlagged(w.itemId, "journal_missing", "fee journal missing");
    expect(
      (await exceptionsOf(w.itemId)).every((r) => r.payslip_id !== null),
      "the flag carries the payslip, so the slip is held",
    ).toBe(true);
  });

  it("[legend-d9pxr-recon-fee-reversed] once the fee journal is reversed the night run flags journal_reversed", async () => {
    const w = await overpaidWorld();
    await runRecon();
    expect(await exceptionsOf(w.itemId), "control").toHaveLength(0);

    await reverseTheJournal(await feeKeyOf(w.itemId, w.postingId));
    await runRecon();
    await expectFlagged(w.itemId, "journal_reversed", "fee journal reversed");
  });
});

// =========================================================================
// COMMIT: the move to overpaid needs the fee journal
// =========================================================================

describe("990 B commit: failed -> overpaid with a fee needs the fee journal", () => {
  it("[legend-d9pxr-commit-fee-missing] the posting says fee Rp5.000 but the fee journal does not exist: the COMMIT is refused (23514), the item stays failed", async () => {
    const w = await overpaidWorld();
    await dropJournal(await feeKeyOf(w.itemId, w.postingId));
    await revertItem(w.itemId, w.before, w.after);
    expect(await statusOf(w.itemId), "premise: back to failed").toBe("failed");

    const error = await replayOverpaid(w.itemId, w.before, w.after);
    expect(
      error,
      "the move without a fee journal must be refused",
    ).not.toBeNull();
    expect(error!.code).toBe(GUARD_CODE);
    expect(error!.message ?? "").toContain("PAYOUT-90");
    expect(await statusOf(w.itemId), "nothing stayed").toBe("failed");
  });

  it("[legend-d9pxr-commit-fee-present] control: the same move with the balanced fee journal commits and the item is overpaid", async () => {
    const w = await overpaidWorld();
    expect(
      await W.journalByKey(await feeKeyOf(w.itemId, w.postingId)),
      "premise: the fee journal is balanced Dr 8101 / Cr 1103",
    ).toEqual({
      "8101": { debit: FEE, credit: 0 },
      "1103": { debit: 0, credit: FEE },
    });
    await revertItem(w.itemId, w.before, w.after);
    expect(await statusOf(w.itemId), "premise: back to failed").toBe("failed");

    const error = await replayOverpaid(w.itemId, w.before, w.after);
    expect(error, JSON.stringify(error)).toBeNull();
    expect(await statusOf(w.itemId)).toBe("overpaid");
  });

  it("[legend-d9pxr-commit-fee-zero] a posting with fee_idr 0 needs no fee journal: the move commits without it", async () => {
    const w = await overpaidWorld();
    await dropJournal(await feeKeyOf(w.itemId, w.postingId));
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_idr = 0 WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.postingId],
        ),
      true,
    );
    await revertItem(w.itemId, w.before, w.after);

    const error = await replayOverpaid(w.itemId, w.before, w.after);
    expect(error, JSON.stringify(error)).toBeNull();
    expect(await statusOf(w.itemId)).toBe("overpaid");
  });

  it("[legend-d9pxr-commit-fee-no-locked-journal] a run without a locked journal (fee only, accounting on): the fee journal is also required", async () => {
    const w = await overpaidWorld({ lockedJournal: false });
    await revertItem(w.itemId, w.before, w.after);
    const key = await feeKeyOf(w.itemId, w.postingId);

    // Control first: with the fee journal the move commits.
    const ok = await replayOverpaid(w.itemId, w.before, w.after);
    expect(ok, `control: ${JSON.stringify(ok)}`).toBeNull();
    expect(await statusOf(w.itemId)).toBe("overpaid");

    // Same move again without the fee journal.
    await revertItem(w.itemId, w.before, w.after);
    await dropJournal(key);
    const error = await replayOverpaid(w.itemId, w.before, w.after);
    expect(error, "no fee journal, no overpaid").not.toBeNull();
    expect(error!.code).toBe(GUARD_CODE);
    expect(await statusOf(w.itemId)).toBe("failed");
  });
});

// =========================================================================
// Concurrency: no double posting, no double fee
// =========================================================================

describe("990 B concurrency: two simultaneous overpaid reports", () => {
  it("[legend-d9pxr-concurrent-once] exactly one report wins: one overpaid posting, one fee journal of Rp5.000, nothing doubled", async () => {
    const w = await lateDoublePayment();
    const outcomes = await Promise.allSettled([
      recordOverpaidItem(w.itemId, w.batchId),
      recordOverpaidItem(w.itemId, w.batchId, APP3),
    ]);
    expect(
      outcomes.filter((o) => o.status === "fulfilled"),
      "exactly one report is accepted",
    ).toHaveLength(1);
    expect(await statusOf(w.itemId)).toBe("overpaid");

    const postings = await W.rowsOf(
      `SELECT id FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
      [W.tenantId, w.batchId],
    );
    expect(postings, "one overpaid posting").toHaveLength(1);
    const postingId = postings[0]!.id as string;
    expect(await feeEntryCount(w.itemId, postingId), "one fee journal").toBe(1);
    expect(await W.journalByKey(await feeKeyOf(w.itemId, postingId))).toEqual({
      "8101": { debit: FEE, credit: 0 },
      "1103": { debit: 0, credit: FEE },
    });
    expect(
      await W.countJournals(`payroll-payout-overpaid:${w.itemId}`),
      "one principal journal",
    ).toBe(1);
  });
});
