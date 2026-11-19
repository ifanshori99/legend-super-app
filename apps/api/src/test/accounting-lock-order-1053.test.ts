// Card legend-f250r (second opinion 1049, finding P2: docs/qa/second-opinion-
// kas-payout-ronde2-1049.md; docs/briefs/1053). Written fail-first from the
// brief and the public API/validators, not from the services.
//
// Rule under test: one canonical lock order for every journal posting,
//   entity advisory lock -> entity row share -> fiscal period -> batch/journal rows.
// A caller that takes the fiscal-period gate FIRST and then posts (which takes
// the entity lock) runs in the opposite direction of a petty cash return
// (entity lock, then period). Two such transactions at the same time are a
// lock cycle, and Postgres kills one of them with 40P01 "deadlock detected".
//
// Each case fires an operation that crosses the period gate and then posts
// (manual journal approve and submit, due recurring journal, fixed asset
// acquisition / disposal / revaluation, period close) at the same time as a
// petty cash return (the operation that already takes entity lock first). It
// repeats the pair many times, because a deadlock needs the two transactions to
// interleave. Nothing here sleeps or depends on a clock: each pair starts
// together, the test waits for both answers and judges only what they say and
// what the ledger looks like.
//
// What a user (finance) must see for every pair:
//   - no request ends in a server error (a deadlock victim answers 5xx);
//   - each side either finishes or is refused with a business error (409/422);
//   - GL 1102 and the petty cash fund never go below zero, the fund and GL
//     1102 agree, and nothing is posted twice.
//
// Assumptions where the brief is silent:
// - "Deadlock" is observed as a 5xx answer (or a rejected service call, or an
//   error recorded on a recurring template), not as a log line. A deadlock that
//   the API silently retried would also be caught by the database counter
//   check at the end of each case (pg_stat_database.deadlocks of this
//   database). It is a hard check only when this file runs alone; see
//   `deadlocksSince`.
// - Business outcomes are 200/201 (done) and 409/422 (refused). A closed period
//   or an insufficient fund are refusals; anything else is a defect.
// - An approval policy for manual and recurring journals is mandatory in this
//   codebase (no policy fails closed). The test installs one at Rp1.000.000 when
//   the tenant has none and removes it afterwards; the amounts here are below
//   the threshold, so "approve" decides directly, by a different finance user.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUlid } from "@starter/shared/core";
import {
  payrollConfigSnapshotSchema,
  payrollLocked,
} from "@starter/shared/hris/payroll";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { runDueRecurringJournals } from "../services/accounting-journal-recurring.service.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeOutlet,
  makeWorld,
  owner,
  scopeOf,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";

// Each case repeats a pair many times over HTTP; a loaded machine needs time.
vi.setConfig({ testTimeout: 180_000 });

const app = createApp();
const BASE = "/api/accounting";
const MOVEMENTS = `${BASE}/petty-cash/movements`;

/** How often each pair is raced. A deadlock needs an interleaving. */
const ROUNDS = 25;
const FUND_IDR = 4_000_000;
const RETURN_IDR = 10_000;
const JOURNAL_IDR = 10_000;
/** Statuses that mean "done" or "refused for a business reason". */
const BUSINESS = new Set([200, 201, 409, 422]);

let world: World;
let outletId: string;
let requester: Session;
let approver: Session;
let finance: Session;
const insertedPolicyIds: string[] = [];
let deadlocksAtStart = 0;

withLimitSharedLock();

type Answer = { status: number; body: unknown };
const answer = (res: { status: number; body: unknown }): Answer => ({
  status: res.status,
  body: res.body,
});

// ---- period keys ------------------------------------------------------------

/** `YYYY-MM` of the WIB month `shift` months from today. */
function periodKey(shift: number): string {
  const today = daysAgo(0);
  const [year, month] = today.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(year, month - 1 + shift, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const currentPeriod = () => periodKey(0);

// ---- setup ------------------------------------------------------------------

async function financeRoleId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  return rows[0]!.id;
}

async function ensurePolicy(actionType: string): Promise<void> {
  const existing = await owner.query(
    "SELECT 1 FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
    [tenantId, actionType],
  );
  if (existing.rowCount) return;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, 1000000, $3, 1) RETURNING id`,
    [tenantId, actionType, await financeRoleId()],
  );
  insertedPolicyIds.push(rows[0]!.id);
}

/** Chart accounts and posting-role mappings that fixed asset journals need. */
async function mapAssetAccounts(entityId: string): Promise<void> {
  const rows: [string, string, string, string, string][] = [
    ["fixed_assets", "1501", "Aset Tetap", "asset", "non_current_asset"],
    [
      "accumulated_depreciation",
      "1502",
      "Akumulasi Penyusutan",
      "asset",
      "non_current_asset",
    ],
    ["revaluation_surplus", "3201", "Surplus Revaluasi", "equity", "equity"],
    [
      "depreciation_expense",
      "6111",
      "Beban Penyusutan",
      "expense",
      "operating_expense",
    ],
    [
      "asset_revaluation_loss",
      "6112",
      "Rugi Revaluasi",
      "expense",
      "other_expense",
    ],
    [
      "asset_disposal_result",
      "7101",
      "Laba/Rugi Pelepasan Aset",
      "revenue",
      "other_income",
    ],
  ];
  for (const [role, code, name, type, group] of rows) {
    const account = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entityId, code, name, type, group],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entityId, role, account.rows[0]!.id],
    );
  }
}

/** Open fiscal periods older than the ones the world seeds (for close races). */
async function seedOldPeriods(entityId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, periodKey(-3 - i)],
    );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await signedIn(app, "LO finance requester", [
    { role: "finance", outletId: null },
  ]);
  approver = await signedIn(app, "LO finance approver", [
    { role: "finance", outletId: null },
  ]);
  finance = requester;
  world = await makeWorld();
  outletId = await makeOutlet(world.entityId);
  await mapAssetAccounts(world.entityId);
  await seedOldPeriods(world.entityId, ROUNDS + 2);
  await ensurePolicy("manual_journal");
  await ensurePolicy("recurring_journal");
  const topup = await movement("topup", FUND_IDR);
  expect(topup.status, JSON.stringify(topup.body)).toBe(201);
  deadlocksAtStart = await deadlockCount();
});

afterAll(async () => {
  if (insertedPolicyIds.length)
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, insertedPolicyIds],
    );
  await closeKit();
});

// ---- operations -------------------------------------------------------------

function movement(kind: "topup" | "return", amountIdr: number) {
  return finance.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send({
      kind,
      outletId,
      bankAccountId: world.bankAccountA,
      amountIdr,
      description:
        kind === "topup" ? "Isi kas kecil lock order" : "Setor kas kecil",
      idempotencyKey: key(),
    });
}

const pettyReturn = () => movement("return", RETURN_IDR).then(answer);

function journalBody(
  entryDate: string,
  creditAccountId: string = world.gl.revenue,
) {
  const side = (accountId: string, debitIdr: number, creditIdr: number) => ({
    accountId,
    debitIdr,
    creditIdr,
    outletId,
    costCenter: null,
  });
  return {
    legalEntityId: world.entityId,
    outletId,
    entryDate,
    kind: "general",
    description: "Jurnal umum uji urutan kunci",
    lines: [
      side(world.gl.expense, JOURNAL_IDR, 0),
      side(creditAccountId, 0, JOURNAL_IDR),
    ],
    idempotencyKey: `manual-${randomUUID()}`,
  };
}

async function draftJournal(
  entryDate: string,
  creditAccountId?: string,
): Promise<string> {
  const created = await requester.client
    .post(`${BASE}/manual-journals`)
    .set(originHeader)
    .send(journalBody(entryDate, creditAccountId));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

function manualCommand(
  who: Session,
  id: string,
  action: "submit" | "approve",
): Promise<Answer> {
  return who.client
    .post(`${BASE}/manual-journals/${id}/${action}`)
    .set(originHeader)
    .send({ idempotencyKey: `cmd-${randomUUID()}` })
    .then(answer);
}

async function submittedJournal(
  entryDate: string,
  creditAccountId?: string,
): Promise<string> {
  const id = await draftJournal(entryDate, creditAccountId);
  const submitted = await manualCommand(requester, id, "submit");
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return id;
}

function assetBody(overrides: Record<string, unknown> = {}) {
  return {
    legalEntityId: world.entityId,
    outletId,
    name: "Mesin uji kunci",
    acquiredOn: daysAgo(0),
    costIdr: 12_000_000,
    residualValueIdr: 0,
    usefulLifeMonths: 12,
    depreciationStartPeriod: currentPeriod(),
    sourceDocumentId: null,
    idempotencyKey: key(),
    ...overrides,
  };
}

function createAsset(): Promise<Answer> {
  return finance.client
    .post(`${BASE}/fixed-assets`)
    .set(originHeader)
    .send(assetBody())
    .then(answer);
}

async function registeredAsset(): Promise<string> {
  const created = await createAsset();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body as { data: { id: string } }).data.id;
}

// ---- observation ------------------------------------------------------------

/** Debit minus credit of this entity's GL 1102. */
async function glPettyBalance(): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, world.entityId, world.gl.pettyCash],
  );
  return Number(rows[0]!.balance);
}

async function fundBalance(): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return Number(rows[0]!.balance);
}

async function returnJournals(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'petty_cash_return'",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

/** Journal entries of this entity that share an idempotency key or a source. */
async function doublePosted(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT 1 FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2
        GROUP BY idempotency_key HAVING count(*) > 1
       UNION ALL
       SELECT 1 FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id IS NOT NULL
        GROUP BY source_type, source_id HAVING count(*) > 1
     ) d`,
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

async function deadlockCount(): Promise<number> {
  await owner.query("SELECT pg_stat_clear_snapshot()");
  const { rows } = await owner.query<{ n: string }>(
    "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(rows[0]!.n);
}

/**
 * Deadlocks the database counted since this file started. Postgres reports the
 * counter with a delay, so a deadlock may show up late; it can only be missed,
 * never invented by this file. The database is shared with other test files,
 * which is why the 5xx check, not this counter, is the main assertion.
 */
async function deadlocksSince(): Promise<number> {
  return (await deadlockCount()) - deadlocksAtStart;
}

// ---- judging ----------------------------------------------------------------

type Incident = { round: number; side: string; detail: string };
/** Answers that were 200/201 per side, so a case cannot pass by refusing all. */
const completed = new Map<string, number>();
/** First refusal text per side, for the failure message. */
const refused = new Map<string, string>();

function judge(
  incidents: Incident[],
  round: number,
  side: string,
  result: PromiseSettledResult<unknown>,
): void {
  if (result.status === "rejected") {
    incidents.push({
      round,
      side,
      detail: `rejected: ${String(result.reason)}`,
    });
    return;
  }
  const value = result.value as Partial<Answer> | undefined;
  if (typeof value?.status !== "number") return;
  if (value.status === 200 || value.status === 201)
    completed.set(side, (completed.get(side) ?? 0) + 1);
  if (value.status === 409 || value.status === 422)
    refused.set(side, `${value.status} ${JSON.stringify(value.body)}`);
  if (!BUSINESS.has(value.status))
    incidents.push({
      round,
      side,
      detail: `${value.status} ${JSON.stringify(value.body)}`,
    });
}

/** Starts both operations in the same tick and waits for both answers. */
async function pair<A, B>(
  a: () => PromiseLike<A>,
  b: () => PromiseLike<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  return Promise.allSettled([a(), b()]);
}

/** Both sides really ran: each side finished in most rounds (not refused). */
function expectExercised(): void {
  const total = [...completed.values()].reduce((a, b) => a + b, 0);
  expect(
    total,
    `the pairs mostly ended in refusals: ${JSON.stringify([...completed])} ${JSON.stringify([...refused])}`,
  ).toBeGreaterThanOrEqual(ROUNDS);
  completed.clear();
  refused.clear();
}

/** The ledger rules that hold after any number of racing pairs. */
async function expectLedgerSound(incidents: Incident[]): Promise<void> {
  const detail = JSON.stringify(incidents);
  expectExercised();
  expect(incidents, `deadlock or server error: ${detail}`).toEqual([]);
  expect(await glPettyBalance(), "GL 1102 below zero").toBeGreaterThanOrEqual(
    0,
  );
  expect(
    await fundBalance(),
    "petty cash fund below zero",
  ).toBeGreaterThanOrEqual(0);
  // Fund and GL 1102 move together: each return that posted took Rp10.000 from
  // both, and nothing else touches 1102 of this entity.
  expect(await glPettyBalance(), "fund and GL 1102 disagree").toBe(
    await fundBalance(),
  );
  expect(await fundBalance()).toBe(
    FUND_IDR - (await returnJournals()) * RETURN_IDR,
  );
  expect(await doublePosted(), "a journal was posted twice").toBe(0);
  expect(await deadlocksSince(), "database counted a deadlock").toBe(0);
}

// ---- cases ------------------------------------------------------------------

describe("legend-f250r one lock order: journal posting versus petty cash return", () => {
  it("[legend-f250r-manual-approve] approving a manual journal at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await submittedJournal(daysAgo(0));
      const [approved, returned] = await pair(
        () => manualCommand(approver, id, "approve"),
        pettyReturn,
      );
      judge(incidents, round, "manual journal approve", approved);
      judge(incidents, round, "petty cash return", returned);
    }
    await expectLedgerSound(incidents);
  });

  it("[legend-f250r-manual-submit] submitting a manual journal at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await draftJournal(daysAgo(0));
      const [submitted, returned] = await pair(
        () => manualCommand(requester, id, "submit"),
        pettyReturn,
      );
      judge(incidents, round, "manual journal submit", submitted);
      judge(incidents, round, "petty cash return", returned);
    }
    await expectLedgerSound(incidents);
  });

  it("[legend-f250r-recurring] posting a due recurring journal at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const template = await requester.client
        .post(`${BASE}/recurring-journals`)
        .set(originHeader)
        .send({
          legalEntityId: world.entityId,
          outletId,
          description: "Akrual berulang uji urutan kunci",
          lines: journalBody(daysAgo(0)).lines,
          // Due from the first day of the month, so it is due today.
          dayOfMonth: 1,
          startPeriod: currentPeriod(),
          endPeriod: currentPeriod(),
          idempotencyKey: `recurring-${randomUUID()}`,
        });
      expect(template.status, JSON.stringify(template.body)).toBe(201);
      const id = template.body.data.id as string;
      for (const [who, type] of [
        [requester, "submit"],
        [approver, "approve"],
      ] as const) {
        const step = await who.client
          .post(`${BASE}/recurring-journals/${id}/transition`)
          .set(originHeader)
          .send({ type });
        expect(step.status, JSON.stringify(step.body)).toBe(200);
      }
      const [ran, returned] = await pair(
        () => runDueRecurringJournals(scopeOf(), new Date()),
        pettyReturn,
      );
      judge(incidents, round, "recurring journal run", ran);
      judge(incidents, round, "petty cash return", returned);
      // A failed template keeps its error text (a deadlock is recorded here
      // instead of being thrown), so it has to be empty and the month posted.
      const row = await owner.query<{
        last_error: string | null;
        last_generated_period: string | null;
      }>(
        "SELECT last_error, last_generated_period FROM recurring_journals WHERE tenant_id = $1 AND id = $2",
        [tenantId, id],
      );
      if (row.rows[0]?.last_error)
        incidents.push({
          round,
          side: "recurring template",
          detail: `last_error ${row.rows[0].last_error}`,
        });
    }
    await expectLedgerSound(incidents);
  });

  it("[legend-f250r-fixed-asset-acquire] registering a fixed asset at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const [created, returned] = await pair(createAsset, pettyReturn);
      judge(incidents, round, "fixed asset acquisition", created);
      judge(incidents, round, "petty cash return", returned);
    }
    await expectLedgerSound(incidents);
  });

  it("[legend-f250r-fixed-asset-dispose] disposing a fixed asset at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const assetId = await registeredAsset();
      const [disposed, returned] = await pair(
        () =>
          finance.client
            .post(`${BASE}/fixed-assets/${assetId}/dispose`)
            .set(originHeader)
            .send({
              disposedOn: daysAgo(0),
              proceedsIdr: 500_000,
              reason: "Dijual (uji urutan kunci)",
              idempotencyKey: key(),
            })
            .then(answer),
        pettyReturn,
      );
      judge(incidents, round, "fixed asset disposal", disposed);
      judge(incidents, round, "petty cash return", returned);
    }
    await expectLedgerSound(incidents);
  });

  it("[legend-f250r-fixed-asset-revalue] revaluing a fixed asset at the same time as a petty cash return never deadlocks", async () => {
    const incidents: Incident[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const assetId = await registeredAsset();
      const [revalued, returned] = await pair(
        () =>
          finance.client
            .post(`${BASE}/fixed-assets/${assetId}/revalue`)
            .set(originHeader)
            .send({
              revaluedOn: daysAgo(0),
              newCarryingAmountIdr: 11_000_000,
              reason: "Penilaian ulang (uji urutan kunci)",
              idempotencyKey: key(),
            })
            .then(answer),
        pettyReturn,
      );
      judge(incidents, round, "fixed asset revaluation", revalued);
      judge(incidents, round, "petty cash return", returned);
    }
    await expectLedgerSound(incidents);
  });
});

describe("legend-f250r one lock order: period close versus journal posting", () => {
  it("[legend-f250r-period-close] closing a period at the same time as a manual journal is approved into it never deadlocks, and the journal is posted or refused, never lost", async () => {
    const incidents: Incident[] = [];
    const periods = await finance.client
      .get(`${BASE}/legal-entities/${world.entityId}/fiscal-periods`)
      .set(originHeader);
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
    const byKey = new Map(
      (
        periods.body.data as { id: string; period: string; version: number }[]
      ).map((row) => [row.period, row]),
    );
    for (let round = 0; round < ROUNDS; round += 1) {
      const target = byKey.get(periodKey(-3 - round));
      expect(target, `period ${periodKey(-3 - round)} exists`).toBeTruthy();
      const id = await submittedJournal(`${target!.period}-15`);
      const [approved, closed] = await pair(
        () => manualCommand(approver, id, "approve"),
        () =>
          finance.client
            .post(`${BASE}/fiscal-periods/${target!.id}/close`)
            .set(originHeader)
            .send({
              expectedVersion: target!.version,
              idempotencyKey: key(),
            })
            .then(answer),
      );
      judge(incidents, round, "manual journal approve", approved);
      judge(incidents, round, "period close", closed);
      // The journal is never half done: it is posted, or it ended refused.
      const row = await owner.query<{ status: string }>(
        "SELECT status FROM manual_journals WHERE tenant_id = $1 AND id = $2",
        [tenantId, id],
      );
      if (
        !["posted", "rejected", "pending_approval"].includes(
          row.rows[0]!.status,
        )
      )
        incidents.push({
          round,
          side: "manual journal state",
          detail: row.rows[0]!.status,
        });
    }
    expectExercised();
    expect(
      incidents,
      `deadlock or server error: ${JSON.stringify(incidents)}`,
    ).toEqual([]);
    expect(await doublePosted(), "a journal was posted twice").toBe(0);
    expect(await deadlocksSince(), "database counted a deadlock").toBe(0);
  });
});

describe("legend-f250r the detector sees a reversed lock order", () => {
  it("[legend-f250r-detector] period gate first then entity lock against entity lock first then period gate is a real 40P01, so the cases above would catch it", async () => {
    // Private lock key: nothing else in the suite takes it. This is the old,
    // wrong order in plain SQL: A = period then entity, B = entity then period.
    const lockKey = `lock-order-1053:${randomUUID()}`;
    const period = periodKey(0);
    const connA = await owner.connect();
    const connB = await owner.connect();
    const bPid = Number(
      (await connB.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid,
    );
    const lockPeriod = (c: typeof connA) =>
      c.query(
        "SELECT 1 FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3 FOR UPDATE",
        [tenantId, world.entityId, period],
      );
    const lockEntity = (c: typeof connA) =>
      c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        lockKey,
      ]);
    try {
      await connA.query("BEGIN");
      await connB.query("BEGIN");
      await lockPeriod(connA); // A: period gate first
      await lockEntity(connB); // B: entity lock first
      // B now waits for the period; wait (observed, not slept) until it does.
      const bWaits = lockPeriod(connB).then(
        () => "got period" as const,
        (error: { code?: string }) => error.code ?? "error",
      );
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [bPid],
        );
        if (rows.length > 0) break;
        if (Date.now() > deadline)
          throw new Error("Detector scenario: B never waited for the period");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // A now wants the entity lock: the cycle closes.
      const aResult = await lockEntity(connA).then(
        () => "got entity" as const,
        (error: { code?: string }) => error.code ?? "error",
      );
      const bResult = await bWaits;
      expect([aResult, bResult]).toContain("40P01");
    } finally {
      await connA.query("ROLLBACK").catch(() => {});
      await connB.query("ROLLBACK").catch(() => {});
      connA.release();
      connB.release();
    }
  });
});

// ---- deterministic: the period row does not exist yet ------------------------
//
// The period gate creates the month's fiscal_periods row on first use (insert
// on conflict). An insert that is not committed yet makes a second inserter of
// the same month wait. That is how the wrong order becomes a real deadlock:
//
//   service: gate first (inserts the month, uncommitted) -> then wants the entity lock
//   return:  holds the entity lock                       -> then inserts the same month
//
// The test plays the return with one helper transaction that holds the same
// advisory lock(s) a real petty cash return holds (learned from a real return
// stopped at a barrier, see `learnEntityLocks`; no lock key is assumed). It
// starts the service path for a month that has no period row, waits until the
// service is waiting for the helper (read from pg_blocking_pids), then lets the
// helper insert the same month. With the canonical order the service has not
// inserted anything yet (it waits for the entity lock first), so the helper's
// insert goes through and the service finishes after the helper commits. With
// the wrong order the helper's insert waits for the service's insert: 40P01.

type AdvisoryLock = { classid: string; objid: string; objsubid: number };
let entityLocks: AdvisoryLock[] = [];
/** Months used up so far by the deterministic cases (distinct per case). */
let nextDeadMonth = 0;
const monthPair = () => {
  const base = -40 - 4 * nextDeadMonth++;
  return { first: periodKey(base), second: periodKey(base + 1) };
};

async function waitFor(
  what: string,
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error(`Scenario did not reach: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The advisory locks a petty cash return holds while it is stopped right before
 * it writes its journal (barrier: a test-only trigger waits on a gate lock).
 * The return takes the entity lock first (SO 1036), so these include it.
 */
async function learnEntityLocks(
  sourceMatch = "NEW.source_type = 'petty_cash_return'",
  run: () => Promise<Answer> = pettyReturn,
): Promise<AdvisoryLock[]> {
  const gateKey = `lock-order-1053-gate:${randomUUID()}`;
  const triggerName = `lo1053_gate_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const helper = await owner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await helper.query("COMMIT");
  };
  const gateMatch = `((classid::bigint << 32) | objid::bigint) = hashtextextended('${gateKey}', 0)`;
  let held: AdvisoryLock[] = [];
  let returned: Promise<Answer> | undefined;
  try {
    await owner.query(`CREATE FUNCTION public.${triggerName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id::text = TG_ARGV[0]
           AND NEW.legal_entity_id::text = TG_ARGV[1]
           AND ${sourceMatch} THEN
          PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[2], 0));
        END IF;
        RETURN NEW;
      END $$`);
    await owner.query(`CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON journal_entries FOR EACH ROW
      EXECUTE FUNCTION public.${triggerName}('${tenantId}', '${world.entityId}', '${gateKey}')`);
    await helper.query("BEGIN");
    await helper.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [gateKey],
    );
    returned = run();
    let returnPid = 0;
    await waitFor("the return waiting at the barrier", async () => {
      const { rows } = await owner.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ${gateMatch}`,
      );
      if (rows[0]) returnPid = rows[0].pid;
      return rows.length > 0;
    });
    const { rows } = await owner.query<AdvisoryLock>(
      `SELECT classid::text AS classid, objid::text AS objid, objsubid
         FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = $1`,
      [returnPid],
    );
    held = rows;
    await release();
    const done = await returned;
    expect([200, 201], JSON.stringify(done.body)).toContain(done.status);
  } finally {
    await release().catch(() => {});
    helper.release();
    await owner.query(
      `DROP TRIGGER IF EXISTS ${triggerName} ON journal_entries`,
    );
    await owner.query(`DROP FUNCTION IF EXISTS public.${triggerName}()`);
  }
  return held;
}

/** Takes, in the helper transaction, every advisory lock a return holds. */
async function holdEntityLocks(helper: {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  for (const lock of entityLocks) {
    const classid = BigInt(lock.classid);
    const objid = BigInt(lock.objid);
    if (lock.objsubid === 1)
      await helper.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        String(BigInt.asIntN(64, (classid << 32n) | objid)),
      ]);
    else
      await helper.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
        Number(BigInt.asIntN(32, classid)),
        Number(BigInt.asIntN(32, objid)),
      ]);
  }
}

async function dropPeriodRow(period: string): Promise<void> {
  await owner.query(
    "DELETE FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
    [tenantId, world.entityId, period],
  );
}

/**
 * Runs `start` (a service path that posts into `period`, which has no period
 * row) against a helper that holds the entity lock and then inserts the same
 * month. Returns what the helper's insert and the service answered.
 */
async function crossAgainstEntityLock(
  period: string,
  start: () => Promise<unknown>,
): Promise<{
  helperInsert: string;
  service: PromiseSettledResult<unknown>;
  deadlocksCounted?: number;
}> {
  await dropPeriodRow(period);
  const deadlocksBefore = await deadlockCount();
  const helper = await owner.connect();
  let finished = false;
  const finish = async (how: "COMMIT" | "ROLLBACK") => {
    if (finished) return;
    finished = true;
    await helper.query(how).catch(() => {});
  };
  let service: Promise<PromiseSettledResult<unknown>> | undefined;
  let serviceEnded = false;
  try {
    await helper.query("BEGIN");
    await helper.query("SET LOCAL lock_timeout = '30s'");
    const helperPid = Number(
      (await helper.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid,
    );
    await holdEntityLocks(helper);
    service = Promise.allSettled([start()]).then(([settled]) => {
      serviceEnded = true;
      return settled!;
    });
    await waitFor("the service waiting for the entity lock", async () => {
      if (serviceEnded) return true;
      const { rows } = await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [helperPid],
      );
      return rows.length > 0;
    });
    if (serviceEnded) {
      await finish("ROLLBACK");
      const settled = await service;
      throw new Error(
        `the service finished without waiting for the entity lock: ${JSON.stringify(settled)}`,
      );
    }
    // The return's step: insert the same month while holding the entity lock.
    const helperInsert = await helper
      .query(
        "INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period) VALUES ($1, $2, $3)",
        [tenantId, world.entityId, period],
      )
      .then(
        () => "inserted",
        (error: { code?: string }) => error.code ?? "error",
      );
    await finish(helperInsert === "inserted" ? "COMMIT" : "ROLLBACK");
    const settled = await service;
    const failed =
      helperInsert !== "inserted" ||
      settled.status === "rejected" ||
      ((settled.value as Answer | undefined)?.status ?? 0) >= 500 ||
      ((settled.value as { failed?: number } | undefined)?.failed ?? 0) > 0;
    let deadlocksCounted: number | undefined;
    if (failed) {
      // Diagnostic only: Postgres reports its counter a moment late.
      const until = Date.now() + 5_000;
      do {
        deadlocksCounted = (await deadlockCount()) - deadlocksBefore;
        if (deadlocksCounted > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < until);
    }
    return { helperInsert, service: settled, deadlocksCounted };
  } finally {
    await finish("ROLLBACK");
    helper.release();
  }
}

function expectNoDeadlockOutcome(
  label: string,
  outcome: {
    helperInsert: string;
    service: PromiseSettledResult<unknown>;
    deadlocksCounted?: number;
  },
  serviceOk: (value: unknown) => boolean,
): void {
  const text = JSON.stringify(outcome);
  expect(
    outcome.helperInsert,
    `${label}: the entity-lock holder's insert of the month was killed by a deadlock (the service took the period gate before the entity lock): ${text}`,
  ).toBe("inserted");
  expect(outcome.service.status, `${label}: ${text}`).toBe("fulfilled");
  if (outcome.service.status === "fulfilled")
    expect(serviceOk(outcome.service.value), `${label}: ${text}`).toBe(true);
}

const answered = (value: unknown) => {
  const status = (value as Answer | undefined)?.status;
  return status === 200 || status === 201;
};

// ---- payroll.locked consumer (legend-zfq7e) ----------------------------------

/** One locked run's totals: gross = net, so only two posting roles are used. */
const PAYROLL_TOTALS = {
  employeeCount: 1,
  grossIdr: 1_000_000,
  deductionsIdr: 0,
  netIdr: 1_000_000,
  bpjsEmployeeIdr: 0,
  bpjsCompanyIdr: 0,
  pph21Idr: 0,
  pph21WithheldIdr: 0,
  pph21EmployerBorneIdr: 0,
  pph21RefundIdr: 0,
  pph21EmployerRefundIdr: 0,
  pph21EmployerAllowanceRefundIdr: 0,
  loanRepaymentIdr: 0,
  pph21ReceivableIdr: 0,
  pph21ReceivableCollectedIdr: 0,
  otherDeductionsIdr: 0,
  customDeductionsIdr: 0,
  serviceChargeIdr: 0,
  reimbursementIdr: 0,
  bankTransferIdr: 0,
  cashIdr: 1_000_000,
};

/** The frozen configuration a locked run must carry (same shape as the payout fixtures). */
function configSnapshot(policyId: string) {
  return payrollConfigSnapshotSchema.parse({
    statutoryVersions: [
      {
        type: "pph21_ter",
        versionId: randomUUID(),
        version: 9300,
        effectiveFrom: "2002-01-01",
      },
    ],
    policy: {
      id: policyId,
      cycle: {
        frequency: "monthly",
        cutoffDay: null,
        payDay: null,
        payMonthOffset: 0,
      },
      payDateAdjustment: "none",
      jkkRiskClass: "low",
      bpjsProgrammes: [],
    },
    components: [
      {
        id: randomUUID(),
        code: "GAJI",
        category: "base_salary",
        taxable: true,
        taxScheme: "gross",
        bpjsBase: true,
        overtimeBase: true,
        thrBase: true,
      },
    ],
    loanMaxDeductionOfNetPayBp: 0,
    pph21Policy: null,
    capturedAt: "2037-03-31T00:00:00.000Z",
  });
}

/**
 * A payroll run of the world's entity with one disbursement batch (the payout
 * resolver takes the entity lock per batch, the step that closed the cycle),
 * and the two posting roles the run journal needs.
 */
async function seedLockedRunWithBatch(period: string): Promise<string> {
  const payable = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '2103', 'Utang Gaji', 'liability', 'current_liability')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantId, world.entityId],
  );
  for (const [role, account] of [
    ["salary_expense", world.gl.expense],
    ["salaries_payable", payable.rows[0]!.id],
  ] as const)
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING`,
      [tenantId, world.entityId, role, account],
    );
  const policyId = randomUUID();
  const code = `LO${policyId.slice(0, 8)}`;
  await owner.query(
    `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                   employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
     VALUES ($1, $2, $3, 'Kebijakan urutan kunci', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
    [policyId, tenantId, world.entityId, code, JSON.stringify({ code })],
  );
  const runId = randomUUID();
  await owner.query(
    `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                               period_start, period_end, pay_date, created_by)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, '00000000-0000-4000-8000-0000000000a4')`,
    [runId, tenantId, world.entityId, policyId, `${period}-01`, `${period}-10`],
  );
  for (const step of [
    `status = 'simulated', simulation_count = 1, last_simulated_at = now()`,
    `status = 'hr_approved', approved_by_hr = '00000000-0000-4000-8000-0000000000a1', approved_by_hr_at = now()`,
    `status = 'approved', approved_by_finance = '00000000-0000-4000-8000-0000000000a2', approved_by_finance_at = now()`,
    `status = 'locked', totals = '${JSON.stringify(PAYROLL_TOTALS)}'::jsonb, config_snapshot = '${JSON.stringify(configSnapshot(policyId))}'::jsonb, locked_by = '00000000-0000-4000-8000-0000000000a3', locked_at = now()`,
  ])
    await owner.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [runId]);
  await owner.query(
    `INSERT INTO payroll_disbursement_batches
       (tenant_id, legal_entity_id, payroll_run_id, channel, requested_by, totals_encrypted, pii_key_version)
     VALUES ($1, $2, $3, 'cash', 'lock-order-1053', '\\x00', 1)`,
    [tenantId, world.entityId, runId],
  );
  return runId;
}

/** The books after the deterministic cases: no negative cash, nothing twice. */
async function expectBooksSound(): Promise<void> {
  expect(await glPettyBalance(), "GL 1102 below zero").toBeGreaterThanOrEqual(
    0,
  );
  expect(await fundBalance(), "fund below zero").toBeGreaterThanOrEqual(0);
  expect(await doublePosted(), "a journal was posted twice").toBe(0);
}

describe("legend-f250r the period gate takes the entity lock first (month without a period row)", () => {
  beforeAll(async () => {
    entityLocks = await learnEntityLocks();
    expect(
      entityLocks.length,
      "a petty cash return holds at least one advisory lock (the entity lock)",
    ).toBeGreaterThan(0);
  });

  it("[legend-f250r-gate-manual-approve] approving a manual journal into a new month waits for the entity lock before it creates the period", async () => {
    const { second } = monthPair();
    const id = await submittedJournal(`${second}-15`, world.gl.pettyCash);
    const outcome = await crossAgainstEntityLock(second, () =>
      manualCommand(approver, id, "approve"),
    );
    expectNoDeadlockOutcome("manual approve", outcome, answered);
    const row = await owner.query<{ status: string }>(
      "SELECT status FROM manual_journals WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    expect(row.rows[0]!.status).toBe("posted");
    await expectBooksSound();
  });

  it("[legend-f250r-gate-recurring] a due recurring journal for a new month waits for the entity lock before it creates the period", async () => {
    const { second } = monthPair();
    const template = await requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send({
        legalEntityId: world.entityId,
        outletId,
        description: "Akrual berulang bulan baru",
        lines: journalBody(`${second}-15`, world.gl.pettyCash).lines,
        dayOfMonth: 1,
        startPeriod: second,
        endPeriod: second,
        idempotencyKey: `recurring-${randomUUID()}`,
      });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    const id = template.body.data.id as string;
    for (const [who, type] of [
      [requester, "submit"],
      [approver, "approve"],
    ] as const) {
      const step = await who.client
        .post(`${BASE}/recurring-journals/${id}/transition`)
        .set(originHeader)
        .send({ type });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
    }
    const outcome = await crossAgainstEntityLock(second, () =>
      runDueRecurringJournals(scopeOf(), new Date()),
    );
    expectNoDeadlockOutcome("recurring run", outcome, (value) => {
      const run = value as { posted: number; failed: number };
      return run.failed === 0 && run.posted >= 1;
    });
    const row = await owner.query<{
      last_error: string | null;
      last_generated_period: string | null;
    }>(
      "SELECT last_error, last_generated_period FROM recurring_journals WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    expect(row.rows[0], JSON.stringify(outcome)).toMatchObject({
      last_error: null,
      last_generated_period: second,
    });
    await expectBooksSound();
  });

  it("[legend-f250r-gate-manual-submit] submitting a manual journal into a new month waits for the entity lock before it creates the period", async () => {
    const { second } = monthPair();
    const id = await draftJournal(`${second}-15`, world.gl.pettyCash);
    const outcome = await crossAgainstEntityLock(second, () =>
      manualCommand(requester, id, "submit"),
    );
    expectNoDeadlockOutcome("manual submit", outcome, answered);
    await expectBooksSound();
  });

  for (const action of ["dispose", "revalue"] as const)
    it(`[legend-f250r-gate-fixed-asset-${action}] ${action === "dispose" ? "disposing" : "revaluing"} a fixed asset in a new month waits for the entity lock before it creates the period`, async () => {
      const { first, second } = monthPair();
      // Bought in `first` (its acquisition creates that month); the later month
      // has no row, and the dispose / revalue journal posts into it.
      const created = await finance.client
        .post(`${BASE}/fixed-assets`)
        .set(originHeader)
        .send(
          assetBody({
            acquiredOn: `${first}-05`,
            depreciationStartPeriod: first,
          }),
        );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const assetId = created.body.data.id as string;
      const body =
        action === "dispose"
          ? {
              disposedOn: `${second}-10`,
              proceedsIdr: 500_000,
              reason: "Dijual (bulan baru)",
              idempotencyKey: key(),
            }
          : {
              revaluedOn: `${second}-10`,
              newCarryingAmountIdr: 11_000_000,
              reason: "Penilaian ulang (bulan baru)",
              idempotencyKey: key(),
            };
      const outcome = await crossAgainstEntityLock(second, () =>
        finance.client
          .post(`${BASE}/fixed-assets/${assetId}/${action}`)
          .set(originHeader)
          .send(body)
          .then(answer),
      );
      expectNoDeadlockOutcome(`fixed asset ${action}`, outcome, answered);
      await expectBooksSound();
    });

  // Legend-zfq7e (second opinion 1066, round 3, finding 3): the consumer of
  // `payroll.locked` posted the run journal (which inserts the month's period)
  // before the payout resolver took the entity lock. Run -> entity -> period
  // is the one order, so the consumer takes the entity lock before it posts.
  it("[legend-zfq7e-payroll-locked] consuming payroll.locked into a new month waits for the entity lock before it creates the period, and posts the run journal once", async () => {
    const { second } = monthPair();
    const runId = await seedLockedRunWithBatch(second);
    const lockedAt = `${second}-15T05:00:00.000Z`;
    const event = payrollLocked.envelopeSchema.parse({
      id: createUlid(),
      tenantId,
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
        legalEntityId: world.entityId,
        runType: "regular",
        periodStart: `${second}-01`,
        periodEnd: `${second}-10`,
        payDate: `${second}-12`,
        totals: PAYROLL_TOTALS,
        lockedBy: randomUUID(),
        lockedAt,
      },
    });
    const outcome = await crossAgainstEntityLock(second, () =>
      withTenant(db, scopeOf(), (tx) =>
        deliverPayrollGlEvent(scopeOf(), event, tx, new Date()),
      ),
    );
    expectNoDeadlockOutcome(
      "payroll.locked consumer",
      outcome,
      (value) =>
        (value as { status?: string } | undefined)?.status === "posted",
    );
    const journals = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, `payroll-gl:locked:${runId}`],
    );
    expect(journals.rows[0]!.n, JSON.stringify(outcome)).toBe("1");
    await expectBooksSound();
  });
});
