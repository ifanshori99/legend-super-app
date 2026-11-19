// SO 1105 ronde 6 delta (brief 1106b): the SETTLE branch of the posting guard.
// Written fail-first from the brief and the CTO decisions (restricting rule),
// not from the migration or service code. Model: cash-1102-1106-r6-waive-lock
// (world, helpers, the A-reader emulation, two real connections + barrier).
//
// The hole: legend_app holds UPDATE(kind) on payroll_payout_gl_postings, so it
// can post a settle journal and flip settle_pending / settle_skipped -> settle
// itself. (a) That path took no entity lock: it could run between the GL read
// and the reserve read of a cash guard that holds the lock (GL goes negative).
// (b) A legacy row (settle_net_idr NULL: the net lives only in the sealed total
// that the reserve counts) accepted a journal of any amount, so a Rp1 journal
// released the whole reserve.
//
// CTO decisions under test:
// 1. Settle on a posting with NULL settle_net_idr is refused (fail closed),
//    whatever the journal amount (Rp1 or the exact sealed net). The legacy
//    reserve stays held; finance settles outside the system.
// 2. The settle flip takes the entity advisory lock `acc-cashbank` (the one
//    entityLock() takes), so it WAITS behind a reader that holds it
//    (pg_stat_activity wait_event_type = 'Lock' AND wait_event = 'advisory').
// 3. A consumer/service path that meets a legacy NULL-net posting leaves it as
//    is: no crash, nothing settled, reserve held.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The settle journal is the one the guard describes: key = the posting's
//   journal_key, source_type 'payroll', source_id = the run id, Dr the
//   salaries payable account frozen on the posting / Cr the source GL account
//   (1102). A cash skipped posting may carry no frozen payable account; the
//   fixture then freezes 2103 on it (owner, triggers off) before the attempt.
// - The exact database error of a refusal is not pinned: any error that is not
//   "function does not exist" (42883); refusal at the statement or at COMMIT.
// - The service path is emulated by the real lock consumer (consumeOutbox +
//   deliverPayrollGlEvent, like the 870 file) on a settle_pending legacy row:
//   it must not throw, the posting stays settle_pending, 1102 is not credited.
// - Reader A is emulated as in the waive file: real entityLock(), GL read,
//   barrier, then the real availableCash1102 and the real guard. The kasbon and
//   reimbursement variants use assertCash1102CoversOutflow, the supplier retry
//   uses assertBankCreditCoveredBy1102.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, tenantIdSchema } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { entityLock } from "../services/accounting-bank-matching.ts";
import {
  assertBankCreditCoveredBy1102,
  assertCash1102CoversOutflow,
  availableCash1102,
} from "../services/accounting-petty-cash.service.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeBankAccount,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP2,
  CASHIER,
  cash,
  installPayoutWorld,
  runTotals,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const W = installPayoutWorld("1106bsettlelock");
const ENTRIES = "/api/accounting/cash-bank/entries";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const NET = 100_000;
const EXTRA = 2_000_000;
const UNDEFINED_FUNCTION = "42883";

withLimitSharedLock();

let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
let salariesPayableId: string;
/** Net of the settle_skipped / settle_pending postings this file created and nobody settled. */
let reserve = 0;

const accountId = async (code: string) =>
  (
    await kitOwner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
      [tenantId, W.entityId(), code],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  probeFinance = await signedIn(app, "1106b finance", [
    { role: "finance", outletId: null },
  ]);
  pettyGlId = await accountId("1102");
  salariesPayableId = await accountId("2103");
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6993', 'Beban Uji 1106b', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  expenseAccountId = await accountId("6993");
  await W.fundPettyCash(EXTRA);
});

afterAll(async () => {
  await closeKit();
});

// ---- helpers ----------------------------------------------------------------

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantId,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId, JSON.stringify(original)],
    );
  }
}

async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

const available = async () => (await glBalance()) - reserve;

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

const journalCountOfKey = async (journalKey: string) =>
  Number(
    (
      await kitOwner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
        [tenantId, W.entityId(), journalKey],
      )
    ).rows[0]!.n,
  );

/** Drains GL 1102 (Dr 1103 / Cr 1102, seeded by SQL like W.fundPettyCash) until only the reserve is left: available Rp0. */
async function drainToReserve() {
  const amount = (await glBalance()) - reserve;
  expect(amount, "premise: GL never below the reserve").toBeGreaterThanOrEqual(
    0,
  );
  if (amount === 0) return;
  const date = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  await W.asTenant(async (c) => {
    const account = async (code: string) =>
      (
        await c.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
          [W.tenantId, W.entityId(), code],
        )
      ).rows[0].id as string;
    const period = (
      await c.query(
        `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3`,
        [W.tenantId, W.entityId(), date.slice(0, 7)],
      )
    ).rows[0].id as string;
    const entry = (
      await c.query(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Kuras kas kecil uji 1106b', $5, $6)
         RETURNING id`,
        [
          W.tenantId,
          W.entityId(),
          date,
          period,
          `drain-1102-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0].id as string;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [W.tenantId, entry, await account("1103"), await account("1102"), amount],
    );
  }, true);
  expect(await available(), "premise: available is Rp0").toBe(0);
}

const cashOut = (amountIdr: number) =>
  probeFinance.client
    .post(ENTRIES)
    .set(originHeader)
    .send({
      legalEntityId: W.entityId(),
      entryDate: daysAgo(0),
      description: "Uji kas 1102 1106b",
      reference: `REF-${randomBytes(3).toString("hex")}`,
      idempotencyKey: key(),
      kind: "cash_out",
      bankAccountId: pettyBankId,
      counterAccountId: expenseAccountId,
      amountIdr,
    });

/** Available cash is Rp0: spending Rp1 is refused with the 1102 code and nothing moves. */
async function expectNothingSpendable(why: string) {
  expect(await available(), `${why}: tracked available`).toBe(0);
  const gl = await glBalance();
  const journals = await journalCount();
  const res = await cashOut(1);
  const detail = JSON.stringify(res.body);
  expect([409, 422], `${why}: status ${res.status} ${detail}`).toContain(
    res.status,
  );
  expect(res.body.error?.code, `${why}: ${detail}`).toBe(REFUSAL);
  expect(await glBalance(), `${why}: refused cash out moved nothing`).toBe(gl);
  expect(await journalCount()).toBe(journals);
}

type Posting = Record<string, unknown> & {
  id: string;
  kind: string;
  journal_key: string;
  source_gl_account_id: string;
};

/** Cash batch handed over while accounting is OFF: a final settle_skipped. Reserve grows by `net`. */
async function skippedHandover(net = NET) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  await W.fundPettyCash(net); // covers the approve guard
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: settle_skipped").toBe("settle_skipped");
  reserve += net;
  return { batchId, runId, net, posting: postings[0] as Posting };
}

type Handover = Awaited<ReturnType<typeof skippedHandover>>;

const setPostingColumns = (postingId: string, assignments: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET ${assignments}
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, postingId],
      ),
    true,
  );

/** The posting must carry a frozen salaries payable account for a settle journal to be possible. */
async function freezePayable(h: Handover): Promise<Handover> {
  const [row] = await W.postingsOf(h.batchId);
  if (!row!.salaries_payable_account_id)
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET salaries_payable_account_id = $3
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, h.posting.id, salariesPayableId],
        ),
      true,
    );
  const fresh = (await W.postingsOf(h.batchId))[0] as Posting;
  expect(
    fresh.salaries_payable_account_id,
    "premise: a frozen payable account",
  ).toBeTruthy();
  return { ...h, posting: fresh };
}

/** Legacy row: settle_net_idr NULL, the net only in the sealed total (pre-0392). */
async function legacyHandover() {
  const h = await freezePayable(await skippedHandover());
  await setPostingColumns(h.posting.id, "settle_net_idr = NULL");
  const fresh = (await W.postingsOf(h.batchId))[0] as Posting;
  expect(fresh.settle_net_idr, "premise: legacy NULL net").toBeNull();
  expect(fresh.kind, "premise: still settle_skipped").toBe("settle_skipped");
  return { ...h, posting: fresh };
}

/** A normal row (non-NULL net), optionally stored as settle_pending instead of settle_skipped. */
async function normalHandover(kind: "settle_skipped" | "settle_pending") {
  const h = await freezePayable(await skippedHandover());
  if (kind === "settle_pending")
    await setPostingColumns(h.posting.id, "kind = 'settle_pending'");
  const fresh = (await W.postingsOf(h.batchId))[0] as Posting;
  expect(fresh.kind, `premise: ${kind}`).toBe(kind);
  expect(fresh.settle_net_idr, "premise: non-NULL net").not.toBeNull();
  return { ...h, posting: fresh };
}

const kindOf = async (batchId: string) =>
  (await W.postingsOf(batchId))[0]!.kind as string;

type DbError = { code?: string; constraint?: string; message: string };

/** Opens a legend_app transaction (tenant context set). The caller commits. */
async function openAppTx(): Promise<PoolClient> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

/** A legend_app transaction with a real COMMIT; returns the first error (statement or commit). */
async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await openAppTx();
  try {
    try {
      await work(client);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return error as DbError;
    }
  } finally {
    client.release();
  }
}

type Line = { accountId: string; debit: number; credit: number };
type Header = { entryDate: string; periodId: string };

async function settleHeader(): Promise<Header> {
  const entryDate = new Date(Date.now() + 7 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const { rows } = await kitOwner.query<{ id: string }>(
    "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
    [tenantId, W.entityId(), entryDate.slice(0, 7)],
  );
  expect(rows, "premise: an open fiscal period for today").toHaveLength(1);
  return { entryDate, periodId: rows[0]!.id };
}

async function insertSettleEntry(
  client: PoolClient,
  h: Handover,
  header: Header,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'payroll', $5, 'Settle 1106b test', NULL, $6, $7)
     RETURNING id`,
    [
      W.tenantId,
      W.entityId(),
      header.entryDate,
      header.periodId,
      h.runId,
      h.posting.journal_key,
      randomBytes(32).toString("hex"),
    ],
  );
  return rows[0]!.id;
}

/** One statement, so every line exists when per-row triggers run. */
async function addLines(client: PoolClient, entryId: string, lines: Line[]) {
  const values = lines
    .map(
      (_, i) =>
        `($1, $2, $${i * 3 + 3}, ${1 + i}, $${i * 3 + 4}, $${i * 3 + 5}, NULL)`,
    )
    .join(", ");
  await client.query(
    `INSERT INTO journal_lines
       (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
     VALUES ${values}`,
    [
      W.tenantId,
      entryId,
      ...lines.flatMap((l) => [l.accountId, l.debit, l.credit]),
    ],
  );
}

const settleLines = (h: Handover, amount: number): Line[] => [
  {
    accountId: h.posting.salaries_payable_account_id as string,
    debit: amount,
    credit: 0,
  },
  { accountId: h.posting.source_gl_account_id, debit: 0, credit: amount },
];

const flipToSettle = (client: PoolClient, h: Handover) =>
  client.query(
    `UPDATE payroll_payout_gl_postings SET kind = 'settle'
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, h.posting.id],
  );

/** legend_app posts the settle journal of `amount` and flips the posting to settle. */
const settleAsApp = async (h: Handover, amount: number) => {
  const header = await settleHeader();
  return appTx(async (client) => {
    const entry = await insertSettleEntry(client, h, header);
    await addLines(client, entry, settleLines(h, amount));
    await flipToSettle(client, h);
  });
};

/** The refusal is a real guard, not a missing function. */
const expectGuardError = (error: DbError | null, why: string) => {
  expect(error, `${why}: must be refused`).not.toBeNull();
  expect(
    error!.code,
    `${why}: refused by a guard, not for a missing function (${error!.message})`,
  ).not.toBe(UNDEFINED_FUNCTION);
};

/** Nothing changed: still skipped, no settle journal, still Rp0 spendable. */
async function expectUntouched(h: Handover, why: string) {
  expect(await kindOf(h.batchId), `${why}: kind`).toBe("settle_skipped");
  expect(
    await journalCountOfKey(h.posting.journal_key),
    `${why}: journal`,
  ).toBe(0);
  await expectNothingSpendable(why);
}

// ---- (1) legacy NULL net ----------------------------------------------------

describe("1106b: a legacy settle posting (NULL net) can not be settled by legend_app", () => {
  it("[1106b-legacy-null-net-rp1-settle-refused] legacy settle_skipped posting (NULL settle_net_idr, sealed net Rp100.000, GL 1102 Rp100.000, available Rp0): as legend_app a Rp1 settle journal (Dr frozen salaries payable / Cr source 1102, key = journal_key) plus UPDATE kind = 'settle', committed, is refused: kind stays settle_skipped, the journal is rolled back, available stays Rp0 and a later spend is refused", async () => {
    const h = await legacyHandover();
    await drainToReserve();
    const glBefore = await glBalance();
    const journals = await journalCount();
    await expectNothingSpendable("premise");

    const error = await settleAsApp(h, 1);

    expectGuardError(error, "legacy NULL net with a Rp1 settle journal");
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    expect(await journalCount(), "journal rolled back").toBe(journals);
    await expectUntouched(h, "after the refused Rp1 settle");
  }, 180_000);

  it("[1106b-legacy-null-net-exact-settle-refused] legacy posting (NULL net): even a settle journal of the exact sealed net (Rp100.000) is refused at the statement or at COMMIT (fail closed): kind stays settle_skipped, no journal stays, available stays Rp0", async () => {
    const h = await legacyHandover();
    await drainToReserve();
    const glBefore = await glBalance();
    const journals = await journalCount();

    const error = await settleAsApp(h, h.net);

    expectGuardError(error, "legacy NULL net with the exact net journal");
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    expect(await journalCount(), "journal rolled back").toBe(journals);
    await expectUntouched(h, "after the refused exact-net settle");
  }, 180_000);

  it("[1106b-settle-helper-null-net-false] app.payout_settle_journal_ok on a legacy NULL-net posting with a journal of the exact sealed net answers false, and true for the same journal on a normal non-NULL-net row (so the refusal is the NULL net)", async () => {
    const legacy = await legacyHandover();
    const normal = await normalHandover("settle_skipped");
    const header = await settleHeader();
    const answers: boolean[] = [];
    for (const h of [legacy, normal]) {
      const client = await openAppTx();
      try {
        const entry = await insertSettleEntry(client, h, header);
        await addLines(client, entry, settleLines(h, h.net));
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT app.payout_settle_journal_ok($1, $2) AS ok",
          [W.tenantId, h.posting.id],
        );
        answers.push(rows[0]!.ok);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    expect(answers[1], "control: the normal row's exact journal is ok").toBe(
      true,
    );
    expect(answers[0], "legacy NULL net: never ok").toBe(false);
    for (const h of [legacy, normal]) {
      expect(await kindOf(h.batchId), "probe rolled back").toBe(
        "settle_skipped",
      );
      expect(await journalCountOfKey(h.posting.journal_key)).toBe(0);
    }
  }, 180_000);

  it("[1106b-control-exact-net-settle-commits] control: a normal non-NULL-net settle_skipped posting with the exact-net settle journal still settles for legend_app when nobody holds the lock (only NULL net and the missing lock were closed): kind becomes settle, GL 1102 and the reserve fall together, available stays Rp0", async () => {
    const h = await normalHandover("settle_skipped");
    await drainToReserve();
    const glBefore = await glBalance();

    const error = await settleAsApp(h, h.net);

    expect(error?.message, "exact net settle commits").toBe(undefined);
    reserve -= h.net;
    expect(await kindOf(h.batchId)).toBe("settle");
    expect(await glBalance(), "GL 1102 down by the net").toBe(glBefore - h.net);
    expect(await available(), "available stays Rp0").toBe(0);
    expect(await journalCountOfKey(h.posting.journal_key)).toBe(1);
  }, 180_000);
});

// ---- (2) the service path leaves a legacy posting as is ---------------------

const CONSUME_NOW = new Date("2026-11-30T03:00:00Z");

/** The `payroll.locked` envelope the lock would have produced (same shape the consumer reads). */
function lockedEnvelope(runId: string, slips: Slip[]) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: W.tenantId,
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId: runId,
    sequence: 1,
    occurredAt: lockedAt,
    actor: { type: "user", id: randomUUID() },
    deviceId: null,
    idempotencyKey: `payroll.locked-${runId}-${randomUUID()}`,
    payloadSchemaRef: "payroll.locked.v1",
    payload: {
      payrollRunId: runId,
      legalEntityId: W.entityId(),
      runType: "regular",
      periodStart: "2026-09-26",
      periodEnd: "2026-10-25",
      payDate: "2026-10-27",
      totals: runTotals(slips),
      lockedBy: randomUUID(),
      lockedAt,
    },
  });
}

async function queueLockedViaOutbox(runId: string, slips: Slip[]) {
  const event = lockedEnvelope(runId, slips);
  const outboxId = createUlid();
  await W.inTx((tx) =>
    appendOutbox(tx, W.scope(), {
      id: outboxId,
      event,
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
  return { event, outboxId };
}

/** The real consumer path: consumeOutbox with the payroll GL consumer as the callback. */
async function consumeLocked(outboxId: string) {
  let result: { status: string } | undefined;
  await consumeOutbox(db, W.scope(), {
    outboxId,
    authorize: async () => true,
    deliver: async (
      event: unknown,
      _key: string,
      tx: Parameters<typeof deliverPayrollGlEvent>[2],
    ) => {
      result = (await deliverPayrollGlEvent(
        W.scope(),
        event as Parameters<typeof deliverPayrollGlEvent>[1],
        tx,
        CONSUME_NOW,
      )) as { status: string };
    },
  });
  return result;
}

async function creditOf1102(): Promise<number> {
  const { rows } = await kitOwner.query<{ credit: string }>(
    `SELECT coalesce(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.credit);
}

describe("1106b: the lock consumer leaves a legacy NULL-net pending posting as is", () => {
  it("[1106b-consumer-legacy-null-net-left-as-is] cash handed over before the lock journal exists (settle_pending, outbox event queued), then the row becomes legacy (NULL net): the real consumer does not throw, the posting stays settle_pending, 1102 is not credited, GL 1102 and the reserve do not move; replaying the consumer changes nothing", async () => {
    const slips = [cash(CASHIER, 1_000_000)];
    const runId = await W.seedRun(slips);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);
    await W.fundPettyCash(1_000_000); // covers the cash approve guard
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );
    const [pending] = await W.postingsOf(batchId);
    expect(pending!.kind, "premise: stored as pending").toBe("settle_pending");
    reserve += 1_000_000; // a pending cash posting reserves its net
    await setPostingColumns(pending!.id as string, "settle_net_idr = NULL");
    const [legacy] = await W.postingsOf(batchId);
    expect(legacy!.settle_net_idr, "premise: legacy NULL net").toBeNull();

    const creditBefore = await creditOf1102();
    const tid = tenantIdSchema.parse(W.tenantId);
    const snapshot = () =>
      W.inTx((tx) => availableCash1102(tx, tid, W.entityId()));
    const cashBefore = await snapshot();

    // Must not throw (no 500 / crash): the legacy row is left alone.
    await consumeLocked(outboxId);
    expect(await kindOf(batchId), "legacy posting not settled").toBe(
      "settle_pending",
    );
    expect(await creditOf1102(), "cash is not credited").toBe(creditBefore);
    expect(await snapshot(), "GL 1102 and reserve unchanged").toEqual(
      cashBefore,
    );
    expect((await W.postingsOf(batchId))[0]!.settle_net_idr).toBeNull();

    await consumeLocked(outboxId);
    expect(await kindOf(batchId), "replay: still pending").toBe(
      "settle_pending",
    );
    expect(await creditOf1102(), "replay: cash not credited").toBe(
      creditBefore,
    );
  }, 180_000);
});

// ---- (3) the entity lock ----------------------------------------------------

type Reader = "supplier" | "loan" | "reimbursement";

type Observation = {
  staleGl: number;
  reserveAfterBarrier: number;
  glAfterBarrier: number;
  refused: boolean;
};

/**
 * Connection B: legend_app posts the exact-net settle journal and flips the
 * posting to settle, then commits. `pid` is its backend pid (probe for a lock
 * wait); `done` settles with the first error, or null.
 */
function startSettle(h: Handover, header: Header) {
  let pidResolve!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => (pidResolve = resolve));
  const done = (async (): Promise<DbError | null> => {
    let client: PoolClient | undefined;
    try {
      client = await openAppTx();
      const probe = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      pidResolve(probe.rows[0]!.pid);
      const entry = await insertSettleEntry(client, h, header);
      await addLines(client, entry, settleLines(h, h.net));
      await flipToSettle(client, h);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      return error as DbError;
    } finally {
      pidResolve(-1);
      client?.release();
    }
  })();
  return { pid, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until backend `pid` waits on an advisory lock, or `isDone()`; bounded, never a fixed sleep. */
async function waitsOnAdvisoryLockOrDone(pid: number, isDone: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (isDone()) return { blocked: false, finished: true };
    const { rows } = await kitOwner.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (
      rows[0]?.wait_event_type === "Lock" &&
      rows[0]?.wait_event === "advisory"
    )
      return { blocked: true, finished: false };
    await sleep(25);
  }
  return { blocked: false, finished: false };
}

/**
 * The SO 1105 P1-2 interleaving on the settle path. A (the balance reader)
 * holds the entity lock and reads GL; B (the settle) starts; A reads the
 * reserve and applies the real guard; then A commits and B may finish.
 */
async function raceSettleAgainstReader(
  h: Handover,
  header: Header,
  reader: Reader,
) {
  const tid = tenantIdSchema.parse(W.tenantId);
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => (releaseA = resolve));
  let aReady!: () => void;
  const ready = new Promise<void>((resolve) => (aReady = resolve));

  const a = W.inTx(async (tx): Promise<Observation> => {
    await entityLock(tx, tid, W.entityId());
    const read = await tx.execute(sql`
      SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
        FROM journal_lines l
        JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       WHERE l.tenant_id = ${W.tenantId} AND e.legal_entity_id = ${W.entityId()}
         AND l.account_id = ${pettyGlId}`);
    const staleGl = Number(
      (read as unknown as { rows: { balance: string }[] }).rows[0]!.balance,
    );
    aReady();
    await gate;
    // The reserve read that comes AFTER the barrier, like the guard's second statement.
    const after = await availableCash1102(tx, tid, W.entityId());
    let refused = false;
    try {
      if (reader === "supplier")
        await assertBankCreditCoveredBy1102(
          tx,
          tid,
          W.entityId(),
          pettyGlId,
          h.net,
        );
      else
        await assertCash1102CoversOutflow(tx, tid, W.entityId(), h.net, true);
    } catch {
      refused = true;
    }
    return {
      staleGl,
      reserveAfterBarrier: after!.pendingCreditIdr,
      glAfterBarrier: after!.glIdr,
      refused,
    };
  });
  a.catch(() => aReady());

  let b: ReturnType<typeof startSettle> | undefined;
  let probe: { blocked: boolean; finished: boolean };
  try {
    await ready;
    b = startSettle(h, header);
    let settled = false;
    void b.done.then(() => (settled = true));
    const pid = await b.pid;
    probe = await waitsOnAdvisoryLockOrDone(pid, () => settled);
  } finally {
    releaseA();
  }
  const observation = await a;
  const bError = await b!.done;
  return { observation, bError, probe };
}

describe("1106b: the settle flip waits for the entity cash lock", () => {
  const scenarios: {
    id: string;
    reader: Reader;
    kind: "settle_skipped" | "settle_pending";
    text: string;
  }[] = [
    {
      id: "1106b-supplier-retry-guard-blocks-settle",
      reader: "supplier",
      kind: "settle_skipped",
      text: "a supplier-retry style reader holds the entity lock after reading GL 1102 Rp100.000 (non-NULL net Rp100.000 reserved as settle_skipped, available Rp0): the exact-net settle (journal + UPDATE kind = 'settle', as legend_app) WAITS on the advisory lock until the reader finishes, the reader still sees the reserve and refuses the Rp100.000 payment, after the settle commits GL and reserve fell together (available Rp0, GL never negative, exactly one extra journal) and a later cash out is refused",
    },
    {
      id: "1106b-supplier-retry-guard-blocks-settle-pending",
      reader: "supplier",
      kind: "settle_pending",
      text: "the same race for a settle_pending posting (settle_pending is reserved too)",
    },
    {
      id: "1106b-loan-reader-blocks-settle",
      reader: "loan",
      kind: "settle_skipped",
      text: "a kasbon disbursement style reader (assertCash1102CoversOutflow under the entity lock after a GL read) blocks the exact-net settle on the advisory lock until it finishes, still refuses, and after the settle commits GL and reserve fell together",
    },
    {
      id: "1106b-reimbursement-reader-blocks-settle",
      reader: "reimbursement",
      kind: "settle_skipped",
      text: "a cash reimbursement style reader blocks the exact-net settle on the advisory lock until it finishes, still refuses, and after the settle commits GL and reserve fell together",
    },
  ];

  for (const s of scenarios) {
    it(`[${s.id}] ${s.text}`, async () => {
      const h = await normalHandover(s.kind);
      const header = await settleHeader();
      await drainToReserve();
      const glBefore = await glBalance();
      const journals = await journalCount();
      await expectNothingSpendable("premise");

      const { observation, bError, probe } = await raceSettleAgainstReader(
        h,
        header,
        s.reader,
      );

      expect(
        probe.finished,
        "B must not finish while A holds the entity lock (it waits for it)",
      ).toBe(false);
      expect(
        probe.blocked,
        "B must wait on the advisory lock (pg_stat_activity wait_event_type = Lock, wait_event = advisory)",
      ).toBe(true);
      expect(
        observation.staleGl - observation.reserveAfterBarrier,
        "stale GL read before the barrier minus the reserve read after it: still Rp0 available",
      ).toBe(0);
      expect(observation.glAfterBarrier, "GL did not move under A").toBe(
        observation.staleGl,
      );
      expect(
        observation.refused,
        "the reader still refuses the Rp100.000 payment",
      ).toBe(true);

      // B resumes after A released the lock: the right journal is accepted.
      expect(bError?.message, "B commits once A is done").toBe(undefined);
      reserve -= h.net;
      expect(await kindOf(h.batchId)).toBe("settle");
      expect(await glBalance(), "GL 1102 down by the net").toBe(
        glBefore - h.net,
      );
      expect(await glBalance(), "GL never negative").toBeGreaterThanOrEqual(0);
      expect(await available(), "available stays Rp0").toBe(0);
      expect(await journalCountOfKey(h.posting.journal_key)).toBe(1);
      expect(await journalCount(), "only the settle journal was added").toBe(
        journals + 1,
      );
      await expectNothingSpendable("after the race");
    }, 180_000);
  }
});
