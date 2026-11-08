// Fiscal period close/reopen and its serialization with posting (beads
// legend-72we + legend-xm30 BE; PRD v1.7 §3.19 "Tutup Periode"; ACC-02, AUTH-06,
// TEN-01). Runs the services against the disposable PostgreSQL database, so the
// row locks are real: legal entity row -> period row -> request row.
//
// Assumptions (the brief does not pin these down):
// - The service functions take the acting user id as a trailing argument, like
//   `reverseJournal(context, id, input, actorId)`; the brief says "taken from
//   context" but a ScopedTenantContext carries no user. All calls go through
//   the small adapters below, so a different signature is a one-place change.
// - An idempotent retry of a close sends the same input (same expectedVersion
//   and key) and gets the already-closed period back without a second snapshot.
// - A snapshot lists only accounts that have journal lines (zero rows ignored).
//
// Every test owns a fresh legal entity; periods use past months (2025-01..03)
// so "the period has ended" holds. Journal and snapshot rows are append-only
// and stay in the disposable database until the run ends.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type FiscalPeriod,
  type JournalLineInput,
  type PeriodCloseSnapshot,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  getPeriodSnapshot,
  listPeriodReopenRequests,
  rejectPeriodReopen,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ROUNDS = 10;

// Four distinct people: closer, requester, approver and a spare.
const closer = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
const spare = randomUUID();

function scopedContext(tenant: string = tenantA): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

// ---- Service adapters -------------------------------------------------------

function close(
  period: { id: string },
  actor: string,
  opts: {
    expectedVersion?: number;
    idempotencyKey?: string;
    tenant?: string;
  } = {},
): Promise<FiscalPeriod> {
  return closeFiscalPeriod(
    scopedContext(opts.tenant),
    period.id,
    {
      expectedVersion: opts.expectedVersion ?? 1,
      idempotencyKey: opts.idempotencyKey ?? `close-${randomUUID()}`,
    },
    userIdSchema.parse(actor),
  );
}

function snapshotOf(period: { id: string }): Promise<PeriodCloseSnapshot> {
  return getPeriodSnapshot(scopedContext(), period.id);
}

function requestReopen(period: { id: string }, actor: string, reason: string) {
  return requestPeriodReopen(
    scopedContext(),
    period.id,
    { reason },
    userIdSchema.parse(actor),
  );
}

function approveReopen(requestId: string, actor: string) {
  return approvePeriodReopen(
    scopedContext(),
    requestId,
    { note: null },
    userIdSchema.parse(actor),
  );
}

// ---- Fixtures ---------------------------------------------------------------

type Fx = {
  tenant: string;
  entity: string;
  cash: string;
  revenue: string;
};

async function makeEntity(tenant: string = tenantA): Promise<Fx> {
  const entity = randomUUID();
  const cash = randomUUID();
  const revenue = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entity, tenant, `Period close ${unique()}`],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [cash, revenue, tenant, entity],
  );
  return { tenant, entity, cash, revenue };
}

/** An open period row (version 1) created ahead of time. */
async function makePeriod(
  fx: Fx,
  period: string,
): Promise<{ id: string; version: number }> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [fx.tenant, fx.entity, period],
  );
  return { id: rows[0]!.id, version: 1 };
}

function line(accountId: string, debit: number, credit: number) {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: null,
    costCenter: null,
  } satisfies JournalLineInput;
}

function postInput(fx: Fx, date: string, amount: number) {
  return {
    legalEntityId: fx.entity,
    outletId: null,
    entryDate: businessDateSchema.parse(date),
    sourceType: "sale" as const,
    sourceId: randomUUID(),
    description: "Penjualan tunai (period close test)",
    lines: [line(fx.cash, amount, 0), line(fx.revenue, 0, amount)],
    postedBy: null,
    idempotencyKey: `post-${randomUUID()}`,
  };
}

function postEntry(fx: Fx, date: string, amount: number) {
  const context = scopedContext(fx.tenant);
  return withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, postInput(fx, date, amount)),
  );
}

/**
 * A post that inserts its entry and then keeps its transaction (and so its
 * locks) open until `release()`.
 */
function gatedPost(fx: Fx, date: string, amount: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalInserted!: () => void;
  const insertedSignal = new Promise<void>((resolve) => {
    signalInserted = resolve;
  });
  const context = scopedContext(fx.tenant);
  const done = withTenant(db, context, async (tx) => {
    const entry = await postJournalInTransaction(
      tx,
      context,
      postInput(fx, date, amount),
    );
    signalInserted();
    await gate;
    return entry;
  });
  // Resolves once the entry is inserted; rejects if the post fails first.
  const inserted = Promise.race([insertedSignal, done]).then(() => undefined);
  return { inserted, release, done };
}

/** Opens a legend_app transaction the test controls (holds locks deliberately). */
async function openLockHolder(tenant: string): Promise<PoolClient> {
  const client = await appPool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE legend_app");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant],
  );
  return client;
}

/** The error code of a rejected promise, or null when it resolved. */
async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${String(error)}`;
  }
}

async function expectCode(run: Promise<unknown>, code: string) {
  expect(await codeOf(run)).toBe(code);
}

/** Cumulative debit/credit per account straight from the journal tables. */
async function journalBalances(fx: Fx, upToPeriod: string): Promise<string[]> {
  const { rows } = await owner.query<{
    account_id: string;
    d: string;
    c: string;
  }>(
    `SELECT l.account_id, sum(l.debit_idr)::text AS d, sum(l.credit_idr)::text AS c
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
       JOIN fiscal_periods p ON p.id = e.fiscal_period_id AND p.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 AND p.period <= $3
      GROUP BY l.account_id`,
    [fx.tenant, fx.entity, upToPeriod],
  );
  return rows
    .filter((row) => row.d !== "0" || row.c !== "0")
    .map((row) => `${row.account_id}:${row.d}/${row.c}`)
    .sort();
}

/** Expected balances, sorted like `snapshotBalances`. */
function balances(...rows: string[]): string[] {
  return [...rows].sort();
}

function snapshotBalances(snapshot: PeriodCloseSnapshot): string[] {
  return snapshot.balances
    .filter((row) => Number(row.debitIdr) !== 0 || Number(row.creditIdr) !== 0)
    .map((row) => `${row.accountId}:${row.debitIdr}/${row.creditIdr}`)
    .sort();
}

async function snapshotCount(periodId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM fiscal_period_snapshots WHERE fiscal_period_id = $1",
    [periodId],
  );
  return Number(rows[0]!.n);
}

async function periodStates(fx: Fx): Promise<Map<string, string>> {
  const { rows } = await owner.query<{ period: string; status: string }>(
    "SELECT period, status FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2",
    [fx.tenant, fx.entity],
  );
  return new Map(rows.map((row) => [row.period, row.status]));
}

/** Invariant: no open period of an entity is earlier than a closed one. */
async function expectNoOpenBehindClosed(fx: Fx) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM fiscal_periods o JOIN fiscal_periods c
         ON c.tenant_id = o.tenant_id AND c.legal_entity_id = o.legal_entity_id
      WHERE o.tenant_id = $1 AND o.legal_entity_id = $2
        AND o.status = 'open' AND c.status = 'closed' AND o.period < c.period`,
    [fx.tenant, fx.entity],
  );
  expect(Number(rows[0]!.n)).toBe(0);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const id of [closer, requester, approver, spare])
    await owner.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
      [id, "Period close test", `${id}@example.com`],
    );
  // A second tenant, only to prove close locks never cross tenants.
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Period close tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `period-close-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
});

afterAll(async () => {
  // Best effort: snapshots are append-only and tenant B now owns periods, so
  // remove its rows with triggers off (needs the superuser test owner). If the
  // tenant stays behind it is harmless to other files.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "fiscal_period_snapshot_lines",
      "fiscal_period_snapshots",
      "period_reopen_requests",
      "journal_lines",
      "journal_entries",
      "fiscal_periods",
      "chart_of_accounts",
      "legal_entities",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantB,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
  await owner.end();
  await appPool.end();
});

describe("legend-72we close vs in-flight post", () => {
  it("ACC-02 a close waits for an in-flight post, then snapshots it; a later post is PERIOD_CLOSED", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    const held = gatedPost(fx, "2025-01-10", 40_000);
    let closeDone = false;
    let closing: Promise<FiscalPeriod> | undefined;
    try {
      await held.inserted;
      closing = close(p1, closer).then((result) => {
        closeDone = true;
        return result;
      });
      await sleep(400);
      expect(closeDone).toBe(false);
      held.release();
      await held.done;
      const closed = await closing;
      expect(closed.status).toBe("closed");
      expect(closed.version).toBe(2);
      expect(closed.closedBy).toBe(closer);
    } finally {
      held.release();
      await Promise.allSettled([held.done, closing]);
    }

    const snapshot = await snapshotOf(p1);
    expect(snapshot.version).toBe(2);
    expect(snapshot.period).toBe("2025-01");
    expect(snapshot.takenBy).toBe(closer);
    expect(snapshotBalances(snapshot)).toEqual(
      balances(`${fx.cash}:40000/0`, `${fx.revenue}:0/40000`),
    );

    await expectCode(postEntry(fx, "2025-01-20", 1_000), "PERIOD_CLOSED");
    expect(await journalBalances(fx, "2025-01")).toEqual(
      snapshotBalances(snapshot),
    );
  });

  it("ACC-02 close vs post race: each round the post wins and is in the snapshot, or loses with PERIOD_CLOSED and is not", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fx = await makeEntity();
      const p1 = await makePeriod(fx, "2025-01");
      await postEntry(fx, "2025-01-05", 5_000);
      // Vary who starts first so both orders show up across the rounds.
      const startPostFirst = round % 2 === 0;
      const outcomes = await (async () => {
        if (startPostFirst) {
          const posting = postEntry(fx, "2025-01-06", 7_000);
          await sleep(round % 4);
          return Promise.allSettled([posting, close(p1, closer)]);
        }
        const closing = close(p1, closer);
        await sleep(round % 4);
        return Promise.allSettled([
          postEntry(fx, "2025-01-06", 7_000),
          closing,
        ]);
      })();
      const [posted, closed] = outcomes;
      expect(closed.status, `round ${round} close`).toBe("fulfilled");
      const snapshot = await snapshotOf(p1);
      const expected = balances(`${fx.cash}:5000/0`, `${fx.revenue}:0/5000`);
      if (posted.status === "fulfilled") {
        expect(snapshotBalances(snapshot), `round ${round}`).toEqual(
          balances(`${fx.cash}:12000/0`, `${fx.revenue}:0/12000`),
        );
      } else {
        expect(
          (posted.reason as { code?: string }).code,
          `round ${round}`,
        ).toBe("PERIOD_CLOSED");
        expect(snapshotBalances(snapshot), `round ${round}`).toEqual(expected);
      }
      // Whatever happened, the snapshot equals the journal.
      expect(snapshotBalances(snapshot), `round ${round}`).toEqual(
        await journalBalances(fx, "2025-01"),
      );
    }
  });

  it("ACC-02 posts never block each other: a second post finishes while another is in flight", async () => {
    const fx = await makeEntity();
    await makePeriod(fx, "2025-01");
    const held = gatedPost(fx, "2025-01-10", 3_000);
    try {
      await held.inserted;
      await expect(postEntry(fx, "2025-01-11", 4_000)).resolves.toBeDefined();
    } finally {
      held.release();
      await Promise.allSettled([held.done]);
    }
  });
});

describe("legend-72we close ordering under concurrency", () => {
  it("ACC-02 close of P2 vs approved reopen of P1: exactly one wins and no period is left open behind a closed one", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fx = await makeEntity();
      const p1 = await makePeriod(fx, "2025-01");
      const p2 = await makePeriod(fx, "2025-02");
      await close(p1, closer);
      const request = await requestReopen(p1, requester, "Koreksi biaya");

      const closeP2 = close(p2, closer);
      if (round % 2 === 1) await sleep(round % 3);
      const approve = approveReopen(request.id, approver);
      const [closeResult, approveResult] = await Promise.allSettled([
        closeP2,
        approve,
      ]);

      const wins = [closeResult, approveResult].filter(
        (result) => result.status === "fulfilled",
      );
      expect(wins, `round ${round}`).toHaveLength(1);
      if (closeResult.status === "rejected")
        expect((closeResult.reason as { code?: string }).code).toBe(
          "PERIOD_CLOSE_OUT_OF_ORDER",
        );
      if (approveResult.status === "rejected")
        expect((approveResult.reason as { code?: string }).code).toBe(
          "PERIOD_REOPEN_OUT_OF_ORDER",
        );
      await expectNoOpenBehindClosed(fx);
    }
  });

  it("ACC-02 two closes of the same period: one wins, the other is PERIOD_ALREADY_CLOSED or PERIOD_CHANGED, one snapshot", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fx = await makeEntity();
      const p1 = await makePeriod(fx, "2025-01");
      await postEntry(fx, "2025-01-09", 2_500);
      const results = await Promise.allSettled([
        close(p1, closer),
        close(p1, spare),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok, `round ${round}`).toHaveLength(1);
      expect(failed, `round ${round}`).toHaveLength(1);
      expect(
        ["PERIOD_ALREADY_CLOSED", "PERIOD_CHANGED"],
        `round ${round}`,
      ).toContain((failed[0] as PromiseRejectedResult).reason.code);
      expect(await snapshotCount(p1.id), `round ${round}`).toBe(1);
    }
  });

  it("ACC-02 closing P1 and P2 together never leaves P2 closed with P1 open", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fx = await makeEntity();
      const p1 = await makePeriod(fx, "2025-01");
      const p2 = await makePeriod(fx, "2025-02");
      const closeP2First = round % 2 === 0;
      const results = closeP2First
        ? (() => {
            const second = close(p2, closer);
            return Promise.allSettled([close(p1, closer), second]);
          })()
        : Promise.allSettled([close(p1, closer), close(p2, closer)]);
      const [first, second] = await results;
      expect(first.status, `round ${round} P1`).toBe("fulfilled");
      if (second.status === "rejected")
        expect((second.reason as { code?: string }).code).toBe(
          "PERIOD_CLOSE_OUT_OF_ORDER",
        );
      await expectNoOpenBehindClosed(fx);
      const states = await periodStates(fx);
      expect(states.get("2025-01")).toBe("closed");
    }
  });

  it("ACC-02 a reopen request racing a retried close of a closed period: no deadlock, request ok, close PERIOD_ALREADY_CLOSED", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fx = await makeEntity();
      const p1 = await makePeriod(fx, "2025-01");
      await close(p1, closer);
      // The retry carries the current version (2) and a new key, so the only
      // thing wrong with it is that the period is already closed.
      const [requested, retried] = await Promise.allSettled([
        requestReopen(p1, requester, "Koreksi biaya"),
        close(p1, spare, { expectedVersion: 2 }),
      ]);
      // Assumption: one request per round, so it is never a duplicate pending one.
      expect(requested.status, `round ${round} request`).toBe("fulfilled");
      expect(retried.status, `round ${round} close`).toBe("rejected");
      expect(
        (retried as PromiseRejectedResult).reason.code,
        `round ${round}`,
      ).toBe("PERIOD_ALREADY_CLOSED");
      expect((await periodStates(fx)).get("2025-01")).toBe("closed");
      expect(await snapshotCount(p1.id)).toBe(1);
    }
  });

  it("ACC-02 a never-used earlier month cannot take a post once a later month is closed", async () => {
    const fx = await makeEntity();
    // Only March exists; January and February are created lazily on first use.
    const march = await makePeriod(fx, "2025-03");
    await postEntry(fx, "2025-03-10", 6_000);
    await close(march, closer);

    await expectCode(postEntry(fx, "2025-01-15", 1_000), "PERIOD_CLOSED");
    await expectCode(postEntry(fx, "2025-02-15", 1_000), "PERIOD_CLOSED");
    // A month after the closed one is unaffected.
    await expect(postEntry(fx, "2025-04-15", 1_000)).resolves.toBeDefined();
  });
});

describe("legend-72we lock scope", () => {
  async function withTimeout<T>(run: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${what} did not finish while the lock was held`)),
        10_000,
      );
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("TEN-01 a held lock on entity A stalls only A: B (same tenant) and another tenant close freely", async () => {
    const entityA = await makeEntity();
    const entityB = await makeEntity();
    const otherTenant = await makeEntity(tenantB);
    const periodA = await makePeriod(entityA, "2025-01");
    const periodB = await makePeriod(entityB, "2025-01");
    const periodOther = await makePeriod(otherTenant, "2025-01");

    const holder = await openLockHolder(tenantA);
    let closeADone = false;
    let closingA: Promise<FiscalPeriod> | undefined;
    try {
      await holder.query(
        "SELECT id FROM legal_entities WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, entityA.entity],
      );
      closingA = close(periodA, closer).then((result) => {
        closeADone = true;
        return result;
      });

      const closedB = await withTimeout(close(periodB, closer), "close in B");
      expect(closedB.status).toBe("closed");
      const closedOther = await withTimeout(
        close(periodOther, closer, { tenant: tenantB }),
        "close in other tenant",
      );
      expect(closedOther.status).toBe("closed");

      await sleep(400);
      expect(closeADone).toBe(false);
      await holder.query("COMMIT");
      const closedA = await closingA;
      expect(closedA.status).toBe("closed");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled([closingA]);
    }
  });

  it("ACC-02 a held entity lock stalls posts to that entity only, until it is released", async () => {
    const entityA = await makeEntity();
    const entityB = await makeEntity();
    await makePeriod(entityA, "2025-01");
    await makePeriod(entityB, "2025-01");

    const holder = await openLockHolder(tenantA);
    let postDone = false;
    let postingA: Promise<unknown> | undefined;
    try {
      await holder.query(
        "SELECT id FROM legal_entities WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, entityA.entity],
      );
      postingA = postEntry(entityA, "2025-01-12", 9_000).then((entry) => {
        postDone = true;
        return entry;
      });
      await withTimeout(postEntry(entityB, "2025-01-12", 9_000), "post in B");
      await sleep(400);
      expect(postDone).toBe(false);
      await holder.query("COMMIT");
      await postingA;
      expect(postDone).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled([postingA]);
    }
  });
});

describe("legend-72we close and reopen lifecycle", () => {
  it("ACC-02 the snapshot is cumulative over every period up to the closed one", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    const p2 = await makePeriod(fx, "2025-02");
    await postEntry(fx, "2025-01-10", 10_000);
    await postEntry(fx, "2025-02-10", 2_000);

    await close(p1, closer);
    expect(snapshotBalances(await snapshotOf(p1))).toEqual(
      balances(`${fx.cash}:10000/0`, `${fx.revenue}:0/10000`),
    );
    await close(p2, closer);
    const second = await snapshotOf(p2);
    expect(snapshotBalances(second)).toEqual(
      balances(`${fx.cash}:12000/0`, `${fx.revenue}:0/12000`),
    );
    expect(snapshotBalances(second)).toEqual(
      await journalBalances(fx, "2025-02"),
    );
  });

  it("ACC-02 a close retried with the same key returns the closed period and keeps one snapshot", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    const key = `close-${randomUUID()}`;
    const first = await close(p1, closer, { idempotencyKey: key });
    const retry = await close(p1, closer, { idempotencyKey: key });
    expect(retry.status).toBe("closed");
    expect(retry.version).toBe(first.version);
    expect(await snapshotCount(p1.id)).toBe(1);
  });

  it("ACC-02 refuses a stale version, a month that has not ended, and a snapshot before any close", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    await expectCode(snapshotOf(p1), "NOT_FOUND");
    await expectCode(
      close(p1, closer, { expectedVersion: 5 }),
      "PERIOD_CHANGED",
    );
    expect(await snapshotCount(p1.id)).toBe(0);

    const future = await makePeriod(fx, "2099-12");
    await expectCode(close(future, closer), "PERIOD_NOT_ENDED");
    // Both periods are untouched.
    expect((await periodStates(fx)).get("2025-01")).toBe("open");
    expect((await periodStates(fx)).get("2099-12")).toBe("open");
  });

  it("ACC-02 closing a month while an earlier one is open is PERIOD_CLOSE_OUT_OF_ORDER", async () => {
    const fx = await makeEntity();
    await makePeriod(fx, "2025-01");
    const p2 = await makePeriod(fx, "2025-02");
    await expectCode(close(p2, closer), "PERIOD_CLOSE_OUT_OF_ORDER");
  });

  it("ACC-02 reopen needs a reason, a closed period and an approver who is neither requester nor closer", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    await expectCode(
      requestReopen(p1, requester, "Masih terbuka"),
      "PERIOD_ALREADY_OPEN",
    );
    await close(p1, closer);
    // A blank reason is refused by input validation before the period is read.
    await expect(requestReopen(p1, requester, "   ")).rejects.toThrow();

    const request = await requestReopen(p1, requester, "Koreksi biaya sewa");
    expect(request.status).toBe("pending");
    expect(request.period).toBe("2025-01");
    expect(request.requestedBy).toBe(requester);
    const listed = await listPeriodReopenRequests(scopedContext(), fx.entity);
    expect(listed.data.map((row) => row.id)).toEqual([request.id]);

    await expectCode(
      approveReopen(request.id, requester),
      "APPROVER_IS_REQUESTER",
    );
    await expectCode(approveReopen(request.id, closer), "APPROVER_IS_CLOSER");
    // Refused approvals leave the period closed and the request pending.
    expect((await periodStates(fx)).get("2025-01")).toBe("closed");

    const approved = await approveReopen(request.id, approver);
    expect(approved.request.status).toBe("approved");
    expect(approved.request.decidedBy).toBe(approver);
    expect(approved.period.status).toBe("open");
    expect(approved.period.version).toBe(3);
    expect(approved.period.reopenedReason).toBe("Koreksi biaya sewa");
    await expectCode(approveReopen(request.id, spare), "INVALID_TRANSITION");

    // Posting works again, and re-closing adds a new snapshot version.
    await postEntry(fx, "2025-01-25", 800);
    const reclosed = await close(p1, closer, { expectedVersion: 3 });
    expect(reclosed.version).toBe(4);
    const snapshot = await snapshotOf(p1);
    expect(snapshot.version).toBe(4);
    expect(snapshotBalances(snapshot)).toEqual(
      balances(`${fx.cash}:800/0`, `${fx.revenue}:0/800`),
    );
    expect(await snapshotCount(p1.id)).toBe(2);
  });

  it("ACC-02 a rejected reopen leaves the period closed and cannot be decided twice", async () => {
    const fx = await makeEntity();
    const p1 = await makePeriod(fx, "2025-01");
    await close(p1, closer);
    const request = await requestReopen(p1, requester, "Salah periode");
    const rejected = await rejectPeriodReopen(
      scopedContext(),
      request.id,
      { reason: "Tidak perlu dibuka" },
      userIdSchema.parse(approver),
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedBy).toBe(approver);
    expect((await periodStates(fx)).get("2025-01")).toBe("closed");
    await expectCode(approveReopen(request.id, spare), "INVALID_TRANSITION");
    await expectCode(postEntry(fx, "2025-01-28", 500), "PERIOD_CLOSED");
  });
});
