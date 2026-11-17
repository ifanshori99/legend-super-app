// legend-fnxl.10 reopened (brief 952, second-opinion P2): a case `write_off`
// and a reversal of the very journal it uses as the adjustment must not
// deadlock. Written from the money rules, not the implementation, and failing
// first.
//
// Scenario (two connections, same legal entity, same journal J):
//   T1  write_off of a reconciliation case, adjustment journal = J
//   T2  reverseJournal(J)
// Both touch "the entity" and "J". If they take those two things in opposite
// orders PostgreSQL aborts one of them with 40P01 (deadlock_detected) and the
// services do not retry, so the user sees a 500 instead of a clear answer.
//
// How the test forces the bad interleaving without hooks into the code: a
// third connection (the gate) holds `SELECT ... FOR UPDATE` on J. Both
// services start, pile up behind the gate in a chosen order, the test waits
// (by reading pg_stat_activity / pg_blocking_pids, never by sleeping a fixed
// time) until both are blocked, then commits the gate and lets them race on.
//
// Rules asserted (any order of arrival, with or without a bank match on J):
//  - neither call fails with 40P01 ("deadlock detected"); a loser is refused
//    with a domain answer (HTTP status below 500), never a server error;
//  - at least one of the two succeeds;
//  - no duplicates: at most ONE reversal journal for J, at most one
//    write_off event on the case, the case is `written_off` with J only if
//    the write_off succeeded and stays `open` without an adjustment otherwise;
//  - the numbers are not changed by the race: J keeps its debit and credit,
//    and the reversal (if any) is balanced.
//
// "Journal with no bank match": a write_off journal can never be matched to a
// bank line (the write_off refuses matched journals, see
// accounting-bank-recon-cases.test.ts), so every case here is the no-match
// case the second opinion asked for; the stale-match hook must not take the
// entity lock in the opposite order even when there is nothing to mark stale.
// The matched-journal path (stale match opened) stays covered by
// accounting-bank-recon-stale-match.test.ts.
//
// Assumption: which of the two wins is not specified, so both are accepted.
// Tests that pass before the fix: none expected for the gated order where the
// reversal arrives first; the stress test is probabilistic and may pass early.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingBankReconCasesRouter } from "../routes/accounting-bank-recon-cases.routes";
import { actOnReconciliationCase } from "../services/accounting-bank-recon-cases.service";
import { reverseJournal } from "../services/accounting-journal.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdUserIds: string[] = [];
const createdEntityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const BASE = "/api/accounting/reconciliation-cases";
const DEBIT = 10_000;

const host = express();
host.use(
  "/api",
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
    fallback: async () => ({
      tenantId,
      brandId: null,
      source: "session" as const,
    }),
  }),
);
host.use("/api/accounting", createAccountingBankReconCasesRouter());
host.use(notFound);
host.use(errorHandler);

function scope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type User = { cookie: string; userId: string };
let finance: User;

async function signedInFinance(): Promise<User> {
  const email = `wo-race-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Write-off race", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
  return { cookie, userId };
}

// ---------------------------------------------------------------- fixtures

type Entity = {
  id: string;
  glAccountId: string;
  revenueAccountId: string;
  periodId: string;
  bankAccountId: string;
  importId: string;
};

async function seedEntity(): Promise<Entity> {
  const id = randomUUID();
  const glAccountId = randomUUID();
  const revenueAccountId = randomUUID();
  const periodId = randomUUID();
  const bankAccountId = randomUUID();
  const importId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `WO race entity ${unique()}`],
  );
  createdEntityIds.push(id);
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1102', 'Bank', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [glAccountId, revenueAccountId, tenantId, id],
  );
  await owner.query(
    "INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, '2026-11')",
    [periodId, tenantId, id],
  );
  await owner.query(
    `INSERT INTO bank_accounts
       (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
     VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
    [
      bankAccountId,
      tenantId,
      id,
      randomBytes(32),
      randomBytes(32).toString("hex"),
      glAccountId,
    ],
  );
  await owner.query(
    `INSERT INTO bank_statement_imports
       (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by, line_count, duplicate_count, auto_matched_count)
     VALUES ($1, $2, $3, 'seed.csv', $4, 'seed', 0, 0, 0)`,
    [importId, tenantId, bankAccountId, randomBytes(32).toString("hex")],
  );
  return {
    id,
    glAccountId,
    revenueAccountId,
    periodId,
    bankAccountId,
    importId,
  };
}

async function seedUnmatchedLine(entity: Entity): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description,
        dedupe_key, match_status)
     VALUES ($1, $2, $3, $4, '2026-11-05', $5, 'Setoran', $6, 'unmatched')`,
    [id, tenantId, entity.bankAccountId, entity.importId, DEBIT, `k-${id}`],
  );
  return id;
}

/** A posted manual entry debiting the bank account (no bank match on it). */
async function seedJournal(entity: Entity): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-05', $3, 'manual', 'Penyesuaian selisih', $4, $5)
       RETURNING id`,
      [
        tenantId,
        entity.id,
        entity.periodId,
        `race-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, id, entity.glAccountId, entity.revenueAccountId, DEBIT],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One open case over an unmatched line, plus a free adjustment journal J. */
async function openCaseWithJournal() {
  const entity = await seedEntity();
  const lineId = await seedUnmatchedLine(entity);
  const opened = await request(host)
    .post(BASE)
    .set(originHeader)
    .set("Cookie", finance.cookie)
    .send({
      legalEntityId: entity.id,
      outletId: null,
      type: "bank_statement",
      differenceIdr: DEBIT,
      ownerId: finance.userId,
      refs: [{ type: "bank_statement_line", id: lineId }],
      idempotencyKey: `open-${randomUUID()}`,
    });
  expect(opened.status).toBe(201);
  const caseId = opened.body.data.id as string;
  const journalId = await seedJournal(entity);
  return { entity, caseId, journalId };
}

// ------------------------------------------------------- the two operations

const writeOff = (caseId: string, journalId: string) =>
  actOnReconciliationCase(
    scope(),
    caseId,
    {
      type: "write_off",
      note: "Selisih dihapuskan",
      adjustmentJournalEntryId: journalId,
    } as never,
    finance.userId as never,
  );

const reverse = (journalId: string) =>
  reverseJournal(
    scope(),
    journalId,
    {
      entryDate: businessDateSchema.parse("2026-11-05"),
      reason: "Koreksi (race test)",
      idempotencyKey: `rev-${randomUUID()}`,
    },
    userIdSchema.parse(finance.userId),
    new Date(),
  );

// ------------------------------------------------------------ observations

function describeError(reason: unknown): string {
  const parts: string[] = [];
  let current: unknown = reason;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const err = current as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    parts.push(
      `code=${String(err.code)} status=${String(err.status)} message=${String(err.message)}`,
    );
    current = err.cause;
  }
  return parts.join(" <- ");
}

function isDeadlock(reason: unknown): boolean {
  return /40P01|deadlock detected/i.test(describeError(reason));
}

/** A refusal must be a domain answer (HTTP status below 500). */
function expectDomainRefusal(reason: unknown) {
  expect(isDeadlock(reason), describeError(reason)).toBe(false);
  const status = (reason as { status?: unknown }).status;
  expect(typeof status, describeError(reason)).toBe("number");
  expect(status as number, describeError(reason)).toBeGreaterThanOrEqual(400);
  expect(status as number, describeError(reason)).toBeLessThan(500);
}

async function sleep(ms: number) {
  await new Promise((accept) => setTimeout(accept, ms));
}

/** Backends waiting, directly or behind a waiter, on the gate connection. */
async function waitersBehind(gatePid: number): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `WITH direct AS (
       SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
     )
     SELECT count(*)::text AS n FROM pg_stat_activity a
      WHERE a.pid IN (SELECT pid FROM direct)
         OR EXISTS (
              SELECT 1 FROM unnest(pg_blocking_pids(a.pid)) AS b(pid)
               WHERE b.pid IN (SELECT pid FROM direct))`,
    [gatePid],
  );
  return Number(rows[0]!.n);
}

/** Polls (bounded, no fixed sleep as a verdict) until `want` waiters queue. */
async function waitForWaiters(gatePid: number, want: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await waitersBehind(gatePid)) >= want) return;
    await sleep(25);
  }
}

async function openGate(journalId: string): Promise<{
  client: PoolClient;
  pid: number;
  release: () => Promise<void>;
}> {
  const client = await owner.connect();
  await client.query("BEGIN");
  const locked = await client.query(
    "SELECT id FROM journal_entries WHERE id = $1 FOR UPDATE",
    [journalId],
  );
  if (locked.rowCount !== 1) {
    await client.query("ROLLBACK");
    client.release();
    throw new Error("Gate could not lock the journal row");
  }
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return {
    client,
    pid: rows[0]!.pid,
    release: async () => {
      await client.query("COMMIT");
      client.release();
    },
  };
}

async function afterState(caseId: string, journalId: string, entityId: string) {
  const reversals = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
    [tenantId, journalId],
  );
  const figures = await owner.query<{
    entry_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT entry_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines
      WHERE tenant_id = $1 AND entry_id IN (
        SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)
      GROUP BY entry_id`,
    [tenantId, entityId],
  );
  const caseRow = await owner.query<{
    status: string;
    adjustment: string | null;
  }>(
    `SELECT status, to_jsonb(c) ->> 'adjustment_journal_entry_id' AS adjustment
       FROM bank_reconciliation_cases c WHERE c.id = $1`,
    [caseId],
  );
  const events = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM bank_reconciliation_case_events WHERE case_id = $1 AND action = 'write_off'",
    [caseId],
  );
  return {
    reversalIds: reversals.rows.map((row) => row.id),
    figures: figures.rows,
    caseStatus: caseRow.rows[0]!.status,
    caseAdjustment: caseRow.rows[0]!.adjustment,
    writeOffEvents: Number(events.rows[0]!.n),
  };
}

async function expectConsistent(
  fixture: { entity: Entity; caseId: string; journalId: string },
  results: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>],
) {
  const [writeOffResult, reverseResult] = results;
  for (const result of results)
    if (result.status === "rejected") expectDomainRefusal(result.reason);
  expect(
    results.some((result) => result.status === "fulfilled"),
    "at least one of write_off / reversal must succeed",
  ).toBe(true);

  const state = await afterState(
    fixture.caseId,
    fixture.journalId,
    fixture.entity.id,
  );
  // No duplicates.
  expect(state.reversalIds.length).toBeLessThanOrEqual(1);
  expect(state.writeOffEvents).toBeLessThanOrEqual(1);
  expect(state.reversalIds.length === 1).toBe(
    reverseResult.status === "fulfilled",
  );
  // The case follows the write_off outcome exactly.
  if (writeOffResult.status === "fulfilled") {
    expect(state.caseStatus).toBe("written_off");
    expect(state.caseAdjustment).toBe(fixture.journalId);
    expect(state.writeOffEvents).toBe(1);
  } else {
    expect(state.caseStatus).toBe("open");
    expect(state.caseAdjustment).toBeNull();
    expect(state.writeOffEvents).toBe(0);
  }
  // The numbers did not move: J intact, every journal balanced.
  const original = state.figures.find(
    (row) => row.entry_id === fixture.journalId,
  );
  expect(original).toMatchObject({
    debit: String(DEBIT),
    credit: String(DEBIT),
  });
  for (const row of state.figures) expect(row.debit).toBe(row.credit);
}

async function raceBehindGate(order: "reversal-first" | "write-off-first") {
  const fixture = await openCaseWithJournal();
  const gate = await openGate(fixture.journalId);
  let writeOffPromise!: Promise<unknown>;
  let reversePromise!: Promise<unknown>;
  const startWriteOff = () => {
    writeOffPromise = writeOff(fixture.caseId, fixture.journalId);
    writeOffPromise.catch(() => undefined);
  };
  const startReverse = () => {
    reversePromise = reverse(fixture.journalId);
    reversePromise.catch(() => undefined);
  };
  try {
    if (order === "reversal-first") {
      startReverse();
      await waitForWaiters(gate.pid, 1);
      startWriteOff();
    } else {
      startWriteOff();
      await waitForWaiters(gate.pid, 1);
      startReverse();
    }
    await waitForWaiters(gate.pid, 2);
  } finally {
    await gate.release();
  }
  const results = (await Promise.allSettled([
    writeOffPromise,
    reversePromise,
  ])) as [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
  await expectConsistent(fixture, results);
}

// ------------------------------------------------------------------- tests

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedInFinance();
});

afterAll(async () => {
  if (createdEntityIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const args = [tenantId, createdEntityIds];
      const byEntity = "tenant_id = $1 AND legal_entity_id = ANY($2::uuid[])";
      const accounts = `(SELECT id FROM bank_accounts WHERE ${byEntity})`;
      await client.query(
        `DELETE FROM bank_statement_line_matches WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_statement_lines WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_statement_imports WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_reconciliation_case_events WHERE tenant_id = $1 AND case_id IN
           (SELECT id FROM bank_reconciliation_cases WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM bank_reconciliation_cases WHERE ${byEntity}`,
        args,
      );
      await client.query(`DELETE FROM bank_accounts WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM app.journal_entry_seals WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(`DELETE FROM journal_entries WHERE ${byEntity}`, args);
      await client.query(`DELETE FROM fiscal_periods WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM chart_of_accounts WHERE ${byEntity}`,
        args,
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        args,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-fnxl.10/952 P2 write_off vs journal reversal: same lock order, no deadlock", () => {
  it("control: write_off alone on a free journal succeeds and the reversal alone succeeds on another", async () => {
    const a = await openCaseWithJournal();
    await expect(writeOff(a.caseId, a.journalId)).resolves.toBeDefined();
    const state = await afterState(a.caseId, a.journalId, a.entity.id);
    expect(state).toMatchObject({
      caseStatus: "written_off",
      caseAdjustment: a.journalId,
      writeOffEvents: 1,
    });
    const b = await openCaseWithJournal();
    await expect(reverse(b.journalId)).resolves.toBeDefined();
    expect(
      (await afterState(b.caseId, b.journalId, b.entity.id)).caseStatus,
    ).toBe("open");
  });

  it("reversal queues first, write_off second, behind a held journal row: no 40P01, no duplicates, numbers intact", async () => {
    await raceBehindGate("reversal-first");
  });

  it("write_off queues first, reversal second, behind a held journal row: no 40P01, no duplicates, numbers intact", async () => {
    await raceBehindGate("write-off-first");
  });

  it("stress: simultaneous write_off and reversal on eight fresh journals never deadlock", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 8 }, () => openCaseWithJournal()),
    );
    const outcomes = await Promise.all(
      fixtures.map(async (fixture) => {
        const results = (await Promise.allSettled([
          writeOff(fixture.caseId, fixture.journalId),
          reverse(fixture.journalId),
        ])) as [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
        return { fixture, results };
      }),
    );
    for (const { fixture, results } of outcomes)
      await expectConsistent(fixture, results);
  });
});
