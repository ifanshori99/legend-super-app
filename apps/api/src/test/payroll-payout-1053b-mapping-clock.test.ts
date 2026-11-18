// Card 1053b items 2 and 3 (CTO decision: the rule limits payment). Written
// fail-first from the brief (scratchpad brief-1053b.md), the founder rules
// "nobody is paid twice, GL 1102 never goes negative, other entities and tenants
// are untouched", and the public service surface, NOT from the service code.
//
// Item 2: with accounting ON and no `petty_cash` account mapping, approving a CASH
// batch is refused 409 PAYOUT_PETTY_CASH_MAPPING_MISSING (the cash cannot be
// checked, so nothing may go out). Accounting OFF and bank batches are unaffected.
// Item 3: the 24 hour approval window is decided by the DATABASE clock. The app
// clock is skewed on purpose (Date faked only around the call under test): the
// export / handover refusal, and the expiry written at approval, follow the DB
// clock and agree with the cash reservation (an item whose window ran out in the
// DB no longer reserves 1102 and is also refused at handover; a live one both
// reserves and may be handed over).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Refusal: HttpError status 409, code PAYOUT_PETTY_CASH_MAPPING_MISSING, the
//   message is exactly the sentence in the brief.
// - "Accounting on" = the tenant's feature_flags.modules lists "accounting" (the
//   same flag the 1053 guard test flips); the payout world starts with it on.
// - Only Date is faked (vi.useFakeTimers toFake Date): timers and the pg driver
//   keep real time. The fake clock never advances by itself.
// - "Expiry written from the DB clock" = approval_expires_at lies within a few
//   seconds of (DB now() + 24h), whatever the app clock says.
// - Cash on hand is read as GL 1102 minus the net of cash batches this file
//   approved and that still reserve cash (`committed`), as in the 1053 guard
//   test; the file never hands over except in the last test (an approved item
//   reserves, a handed over one is posted asynchronously by the outbox).
// - Not covered: a second entity or tenant with the mapping removed (the
//   removal helper is entity-scoped, the 1053 guard file covers foreign pending
//   credits).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  APP,
  APP2,
  CASHIER,
  BUDI,
  REQ,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1053bmc");

const MAPPING_MESSAGE =
  "Mapping kas kecil (petty_cash) belum diatur. Atur mapping akun kas kecil lalu setujui batch lagi.";
const HOUR = 3_600_000;

/** Net of the cash batches approved by this file that still reserve cash. */
let committed = 0;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(() => {
  vi.useRealTimers();
});

// ---- helpers ---------------------------------------------------------------

/** Runs `work` with only the app's Date shifted by `offsetMs` from real time. */
async function withAppClock<T>(offsetMs: number, work: () => Promise<T>) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + offsetMs });
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

/** Debit minus credit of GL 1102 of the payout world's entity. */
async function glBalance(): Promise<number> {
  const [row] = await W.rowsOf(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = '1102'`,
    [W.tenantId, W.entityId()],
  );
  return Number(row!.balance);
}

const available = async () => (await glBalance()) - committed;

/** Tops 1102 up until at least `min` is available. */
async function fund(min: number) {
  const avail = await available();
  if (avail < min) await W.fundPettyCash(min - avail);
}

async function journalCount(): Promise<number> {
  const [row] = await W.rowsOf(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [W.tenantId, W.entityId()],
  );
  return Number(row!.n);
}

type Pending = { batchId: string; hash: string; net: number; runId: string };

/** A cash batch of one slip (lock journal posted), submitted, waiting approval. */
async function pendingCash(net: number): Promise<Pending> {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.createBatch(runId, "cash");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net, runId };
}

async function pendingBank(net: number): Promise<Pending> {
  const runId = await W.seedRun([bank(BUDI, net)]);
  const batchId = await W.createBatch(runId, "manual_bank");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net, runId };
}

async function sourceAccountOf(channel: string): Promise<string | null> {
  if (channel !== "manual_bank") return null;
  const [row] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  return (row?.id as string | undefined) ?? null;
}

/** Approves through the service; null on success, the thrown error otherwise. */
async function tryApprove(
  batch: Pending,
  channel: "cash" | "manual_bank" = "cash",
): Promise<unknown> {
  const sourceBankAccountId = await sourceAccountOf(channel);
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId,
      } as never),
    ),
  );
  if (failure === null && channel === "cash") committed += batch.net;
  return failure;
}

function expectRefusal(failure: unknown, code: string) {
  expect(failure, "the call must be refused").toBeInstanceOf(HttpError);
  const error = failure as HttpError;
  expect(error.status, `${error.code}: ${error.message}`).toBe(409);
  expect(error.code).toBe(code);
  return error;
}

async function expectUntouched(batch: Pending, journalsBefore: number) {
  const row = await W.batchById(batch.batchId);
  expect(row.status).toBe("pending_approval");
  expect(row.approved_by).toBeNull();
  expect(row.approved_at).toBeNull();
  for (const item of await W.itemsOf(batch.batchId))
    expect(item.status, "items stay as submitted").toBe("prepared");
  expect(await journalCount(), "no journal written").toBe(journalsBefore);
}

async function expectApproved(batch: Pending) {
  expect((await W.batchById(batch.batchId)).status).toBe("approved");
  for (const item of await W.itemsOf(batch.batchId))
    expect(item.status).toBe("approved");
}

/** Sets approval_expires_at from SQL, relative to the DB clock. */
async function setExpiry(batchId: string, sqlInterval: string) {
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_batches
            SET approval_expires_at = now() + interval '${sqlInterval}'
          WHERE id = $1`,
        [batchId],
      ),
    true,
  );
}

async function withoutPettyCashMapping<T>(work: () => Promise<T>) {
  const rows = await W.rowsOf(
    `SELECT role, account_id FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`,
    [W.tenantId, W.entityId()],
  );
  expect(rows, "premise: the entity has a petty_cash mapping").toHaveLength(1);
  await W.owner.query(
    "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [W.tenantId, W.entityId()],
  );
  try {
    return await work();
  } finally {
    await W.owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [W.tenantId, W.entityId(), (rows[0] as Row).account_id],
    );
  }
}

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await W.owner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [W.tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  const off = {
    ...original,
    modules: (original.modules ?? []).filter((m) => m !== "accounting"),
  };
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [W.tenantId, JSON.stringify(off)],
  );
  try {
    return await work();
  } finally {
    await W.owner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [W.tenantId, JSON.stringify(original)],
    );
  }
}

// ---- item 2: accounting on, no petty_cash mapping ----------------------------

describe("1053b-mapping accounting on without a petty_cash mapping", () => {
  it("[1053b-mapping-refused] approving a cash batch is refused 409 PAYOUT_PETTY_CASH_MAPPING_MISSING with the clear message; nothing moves", async () => {
    await fund(2_000_000);
    const batch = await pendingCash(1_000_000);
    const journals = await journalCount();

    const failure = await withoutPettyCashMapping(() => tryApprove(batch));

    const error = expectRefusal(failure, "PAYOUT_PETTY_CASH_MAPPING_MISSING");
    expect(error.message).toBe(MAPPING_MESSAGE);
    await expectUntouched(batch, journals);
  }, 60_000);

  it("[1053b-mapping-retry] once the mapping is set again the same batch can be approved (cash is covered)", async () => {
    await fund(2_000_000);
    const batch = await pendingCash(1_000_000);

    const refused = await withoutPettyCashMapping(() => tryApprove(batch));
    expectRefusal(refused, "PAYOUT_PETTY_CASH_MAPPING_MISSING");

    expect(
      await tryApprove(batch),
      "approved with the mapping back",
    ).toBeNull();
    await expectApproved(batch);
  }, 60_000);

  it("[1053b-mapping-accounting-off] accounting off and no mapping: the cash batch is approved as before", async () => {
    await fund(2_000_000);
    const batch = await pendingCash(1_000_000);
    const failure = await withAccountingOff(() =>
      withoutPettyCashMapping(() => tryApprove(batch)),
    );
    expect(failure, "nothing to check while accounting is off").toBeNull();
    await expectApproved(batch);
  }, 60_000);

  it("[1053b-mapping-bank-unaffected] a bank batch is approved without a petty_cash mapping", async () => {
    const batch = await pendingBank(1_500_000);
    const failure = await withoutPettyCashMapping(() =>
      tryApprove(batch, "manual_bank"),
    );
    expect(failure, "bank batches never touch 1102").toBeNull();
    await expectApproved(batch);
  }, 60_000);
});

// ---- item 3: the database clock decides the approval window ------------------

describe("1053b-clock approval window follows the database clock", () => {
  it("[1053b-clock-export-expired-app-behind] the DB says expired, the app clock runs 3h behind: export is still refused PAYOUT_APPROVAL_EXPIRED", async () => {
    const batchId = await W.approvedBatch(
      await W.seedRun([bank(BUDI, 2_000_000)]),
    );
    await setExpiry(batchId, "-1 minute");

    const failure = await withAppClock(-3 * HOUR, () =>
      W.httpFailure(
        W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId)),
      ),
    );

    expect(
      failure,
      "refused although the app clock thinks it is early",
    ).toBeInstanceOf(HttpError);
    expect((failure as HttpError).code).toBe("PAYOUT_APPROVAL_EXPIRED");
    expect((await W.batchById(batchId)).status).toBe("approved");
    expect((await W.itemsOf(batchId))[0]!.status).toBe("approved");
  }, 60_000);

  it("[1053b-clock-export-live-app-ahead] the DB says still valid, the app clock runs 2h ahead: export is NOT refused as expired", async () => {
    const batchId = await W.approvedBatch(
      await W.seedRun([bank(BUDI, 2_000_000)]),
    );
    await setExpiry(batchId, "30 minutes");

    const failure = await withAppClock(2 * HOUR, () =>
      W.httpFailure(
        W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId)),
      ),
    );

    expect(failure, "the window is open in the DB").toBeNull();
    expect((await W.batchById(batchId)).status).toBe("exported");
  }, 60_000);

  it("[1053b-clock-approve-sets-db-expiry] approving with the app clock 3h behind still sets the expiry 24h after the DB clock", async () => {
    await fund(2_000_000);
    const batch = await pendingCash(1_000_000);
    const [{ t: dbBefore }] = (await W.rowsOf(
      "SELECT extract(epoch FROM clock_timestamp())::float8 AS t",
    )) as [{ t: number }];

    const failure = await withAppClock(-3 * HOUR, () => tryApprove(batch));
    expect(failure, "approval itself succeeds").toBeNull();

    const [{ t: dbAfter }] = (await W.rowsOf(
      "SELECT extract(epoch FROM clock_timestamp())::float8 AS t",
    )) as [{ t: number }];
    const expires =
      new Date(
        (await W.batchById(batch.batchId)).approval_expires_at as string,
      ).getTime() / 1000;
    const day = 24 * 3600;
    expect(expires).toBeGreaterThanOrEqual(dbBefore + day - 5);
    expect(expires).toBeLessThanOrEqual(dbAfter + day + 5);
  }, 60_000);

  it("[1053b-clock-expired-no-reserve-and-refused] DB-expired item: it no longer reserves 1102 AND the handover is refused, even with the app clock 3h behind", async () => {
    await fund(3_000_000);
    const a = await pendingCash(1_000_000);
    expect(await tryApprove(a)).toBeNull();
    await setExpiry(a.batchId, "-1 minute");
    committed -= a.net; // its window ran out in the DB: nothing reserved

    // Handover side: refused, nothing moves.
    const [item] = await W.itemsOf(a.batchId);
    const failure = await withAppClock(-3 * HOUR, () =>
      W.httpFailure(W.handover(a.batchId, [item!.id as string], APP2)),
    );
    expect(failure, "handover refused").toBeInstanceOf(HttpError);
    expect((failure as HttpError).code).toBe("PAYOUT_APPROVAL_EXPIRED");
    expect((await W.itemsOf(a.batchId))[0]!.status).toBe("approved");

    // Reservation side: the released cash is available again, to the rupiah.
    const all = await available();
    const b = await pendingCash(all);
    expect(
      await tryApprove(b),
      "an exact claim on all cash fits: the expired item reserves nothing",
    ).toBeNull();
    expect(await available()).toBe(0);
  }, 90_000);

  // Last on purpose: a successful handover leaves a payroll.paid fact in the
  // outbox, which the `committed` bookkeeping above does not model.
  it("[1053b-clock-live-reserves-and-handover-ok] DB-live item: it still reserves 1102 AND the handover works, even with the app clock 2h ahead", async () => {
    await fund(3_000_000);
    const a = await pendingCash(1_000_000);
    expect(await tryApprove(a)).toBeNull();
    await setExpiry(a.batchId, "30 minutes");

    // Reservation side: one rupiah more than what is left is refused.
    const left = await available();
    const over = await pendingCash(left + 1);
    const journals = await journalCount();
    const refused = await tryApprove(over);
    expectRefusal(refused, "PAYOUT_CASH_INSUFFICIENT");
    await expectUntouched(over, journals);

    // Handover side: the app clock says expired, the DB says open: it goes.
    const [item] = await W.itemsOf(a.batchId);
    const failure = await withAppClock(2 * HOUR, () =>
      W.httpFailure(W.handover(a.batchId, [item!.id as string], APP2)),
    );
    expect(failure, "handover accepted").toBeNull();
    expect((await W.itemsOf(a.batchId))[0]!.status).toBe("succeeded");
  }, 90_000);
});
