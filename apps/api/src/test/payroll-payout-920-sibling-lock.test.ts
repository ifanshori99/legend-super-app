// Payout 920 (second opinion 919, finding 2, P1; brief 920 P1-2). Written fail-first
// from the finding and the CTO decision, not from the implementation.
//
// Rule proven: freezing a batch ("Bukan saya" / disown) and every money step on a
// batch that shares a payslip with it take the SAME lock, so the freeze can never
// finish while a sibling's step is still able to commit afterwards.
//   World: A = a failed attempt that has an approval log, B = the retry of the same
//   payslip, approved. T1 runs a whole step on B up to the end of its service code
//   and is held just before COMMIT (a barrier). T2 disowns A (a raw pg client, the
//   trusted SQL function, a real COMMIT).
//   - T1 first: T2 must WAIT for T1's commit (it may not finish while T1 is open),
//     then succeed; the step stays committed, both batches end frozen.
//   - T2 first (held before its COMMIT): the step on B must WAIT, then be refused
//     (PAYOUT-79 / PAYOUT_BATCH_FROZEN) with nothing changed: no transfer file, no
//     item, journal or posting moved, nobody paid.
//   - A batch of an unrelated payslip is never blocked. No deadlock (40P01) or
//     serialization failure (40001) on any side.
//
// Steps covered: export (the transfer file), settle (bank confirmation), and the
// reversal request of the run (the world has only the failed attempt A there).
//
// Assumptions (the spec leaves them open, stated so they can be contested):
// - The refusal is PAYOUT-79 from SQL, or the friendly 409 PAYOUT_BATCH_FROZEN /
//   "dibekukan" of the service (the 918 review suite accepts both for submit).
// - "Waiting" is observed from the database: pg_blocking_pids of the waiting
//   backend contains the holder's backend pid. No sleep decides an outcome; the
//   poll only waits for "finished" or "blocked by the holder".
// - The "other tenant" control is an unrelated payslip (another run) of the same
//   tenant: the fixture world has one tenant, and a tenant-wide or global lock
//   would block it just the same.
// - The retry B is made with createDisbursementBatch for the same run by the
//   fixture requester (the 915 convention), submitted, then approved by APP.
// - "No transfer file" is observed on bank_transfer_files (by payroll_run_id) and
//   on the item and batch statuses; a refused export returns nothing. Journals
//   are observed through the GL postings of the run's batches (a count of all
//   journals of the tenant would move with other test files).
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  confirmManualItems,
  exportManualBatch,
} from "../services/payroll-payout-manual.service.ts";
import { requestPayrollRunReversalInTransaction } from "../services/payroll-run-reversal.service.ts";
import {
  actorOf,
  APP,
  APP2,
  bank,
  BUDI,
  installPayoutWorld,
  REQ,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("920sib");
const NET = 1_000_000;
const REASON =
  "Bukan saya yang menyetujui langkah ini, akun saya dipakai orang";
const REVERSAL_REASON = "Uji pembalikan payroll dengan batch saudara";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const DISOWN = `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`;
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const personIds: string[] = [];
const batchIds: string[] = [];
type Person = { userId: string };
let a: Person; // finance: resolves first, the disputant of A
let b: Person; // finance: resolves second
let locker: Person; // may ask for the reversal of a run

async function templateRoleId(key: "owner" | "finance") {
  const read = () =>
    W.owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2`,
      [W.tenantId, key],
    );
  const found = await read();
  if (found.rows[0]) return found.rows[0].id;
  await W.owner.query(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, '[]'::jsonb, false, '["tenant","brand"]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [W.tenantId, `Template ${key} 920sib`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A real user with the approve permission and, optionally, a tenant-wide template role. */
async function makePerson(
  label: string,
  template?: "owner" | "finance",
): Promise<Person> {
  const { userId } = await W.signedInClient(`Sibling920 ${label}`);
  personIds.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  if (template) {
    const roleId = await templateRoleId(template);
    await W.owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId],
    );
  }
  return { userId };
}

// ---- Grants and observations -------------------------------------------------------------

/** Password grant of the grantor stand-in to disown the log of `userId` on `batchId`. */
async function disownGrant(
  userId: string,
  batchId: string,
  logId: string,
): Promise<string> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_payout_grantor");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      W.tenantId,
    ]);
    const { rows } = await client.query(
      `SELECT app.payout_grant_issue('disown'::text, 'record'::text, $1::uuid, '{}'::uuid[], NULL::varchar, $2::uuid, NULL::uuid, $3::varchar, $4::text, $5::text, 'password'::text) AS grant`,
      [batchId, logId, sha256(REASON), userId, actorOf(userId).sessionId],
    );
    await client.query("COMMIT");
    return (rows[0] as { grant: string }).grant;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const count = async (query: string, params: unknown[]) =>
  Number((await W.rowsOf(query, params))[0]!.n);
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );
const logOf = async (batchId: string, userId: string) =>
  (
    await W.rowsOf(
      `SELECT id::text AS id FROM payroll_payout_approval_log
        WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3 ORDER BY logged_at LIMIT 1`,
      [W.tenantId, batchId, userId],
    )
  )[0]!.id as string;

/** Everything a refused or waiting step must leave exactly as it was: the money and the files. */
async function stateOf(runId: string) {
  const rows = (query: string) => W.rowsOf(query, [W.tenantId, runId]);
  return JSON.stringify({
    items: await rows(
      `SELECT id::text AS id, status FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY id`,
    ),
    batches: await rows(
      `SELECT id::text AS id, status FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY id`,
    ),
    transferFiles: await rows(
      `SELECT count(*)::int AS n FROM bank_transfer_files
        WHERE $1::uuid IS NOT NULL AND payroll_run_id = $2`,
    ),
    postings: await rows(
      `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id IN
              (SELECT id FROM payroll_disbursement_batches
                WHERE tenant_id = $1 AND payroll_run_id = $2)`,
    ),
    run: await rows(
      `SELECT status, reversal FROM payroll_runs WHERE tenant_id = $1 AND id = $2`,
    ),
  });
}

function messageChain(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== "object" || error === null) return "";
  const e = error as { message?: unknown; cause?: unknown; code?: unknown };
  return `${typeof e.message === "string" ? e.message : ""} ${
    typeof e.code === "string" ? e.code : ""
  } ${messageChain(e.cause, depth + 1)}`;
}
/** Class 40 = deadlock (40P01) or serialization failure (40001): never acceptable here. */
const rolledBackByDatabase = (error: unknown) =>
  /40P01|40001|deadlock detected|could not serialize/i.test(
    messageChain(error),
  );
const refusedAsFrozen = (error: unknown) =>
  /PAYOUT-79:|PAYOUT_BATCH_FROZEN|dibekukan/i.test(messageChain(error));

// ---- Worlds ------------------------------------------------------------------------------------

type Kind = "export" | "settle" | "reversal";
type World = {
  runId: string;
  /** The failed attempt with approval logs: what gets disowned. */
  aId: string;
  /** The sibling retry of the same payslip (absent in the reversal world). */
  bId: string | null;
  /** Bank results of B for the settle step. */
  confirmResults: ReturnType<typeof W.succeedItems>;
};

/**
 * A: exported, closed `failed` by two people (a, b), so it has approval logs.
 * B (not for `reversal`): the retry of the same payslip, submitted and approved;
 * for `settle` it is also exported, waiting for the bank result.
 */
async function siblingWorld(kind: Kind): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const aId = await W.exportedBatch(runId);
  batchIds.push(aId);
  const aItems = (await W.itemsOf(aId)).map((i) => i.id as string);
  await W.resolve(aId, aItems, "failed", a.userId);
  await W.resolve(aId, aItems, "failed", b.userId);
  for (const item of await W.itemsOf(aId))
    expect(item.status, "premise: the item of A is failed").toBe("failed");
  expect(
    await logOf(aId, a.userId),
    "premise: A has an approval log",
  ).toBeTruthy();
  if (kind === "reversal") return { runId, aId, bId: null, confirmResults: [] };

  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [row] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 AND id <> $3
      ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId, aId],
  );
  const bId = row!.id as string;
  batchIds.push(bId);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), bId));
  const [source] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  await W.inTx(async (tx) =>
    approveDisbursementBatch(tx, actorOf(APP), bId, {
      contentHash: (await W.batchById(bId)).content_hash as string,
      sourceBankAccountId: source!.id as string,
    } as never),
  );
  const bItems = await W.itemsOf(bId);
  const aRows = await W.itemsOf(aId);
  expect(bItems, "premise: B has one item").toHaveLength(1);
  expect(bItems[0]!.employee_id, "premise: the same payslip as A").toBe(
    aRows[0]!.employee_id,
  );

  let confirmResults: World["confirmResults"] = [];
  if (kind === "settle") {
    await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), bId));
    const exported = (await W.itemsOf(bId)).filter(
      (i) => i.status === "exported",
    );
    expect(exported, "premise: B is exported").toHaveLength(1);
    confirmResults = W.succeedItems(bId, exported);
  }
  return { runId, aId, bId, confirmResults };
}

// ---- The step under test ------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];
type Step = {
  name: string;
  /** Whole service call of the step, on the sibling B (the run for the reversal). */
  run: (tx: Tx, w: World) => Promise<unknown>;
};
const steps: Record<Kind, Step> = {
  export: {
    name: "export",
    run: (tx, w) => exportManualBatch(tx, actorOf(APP), w.bId!),
  },
  settle: {
    name: "settle",
    run: (tx, w) =>
      confirmManualItems(
        tx,
        actorOf(APP2),
        w.bId!,
        { results: w.confirmResults } as never,
        W.proofs(),
      ),
  },
  reversal: {
    name: "reversal request",
    run: (tx, w) =>
      requestPayrollRunReversalInTransaction(
        tx,
        W.scope(),
        locker.userId,
        w.runId as never,
        REVERSAL_REASON,
      ),
  },
};

// ---- Two transactions with a barrier --------------------------------------------------------------

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Ended = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * The service step in one app transaction. With `hold`, it stays open after the
 * service code ended and until `release()` (the barrier just before COMMIT).
 */
function appSide(run: (tx: Tx) => Promise<unknown>, hold: boolean) {
  const reached = deferred();
  const gate = deferred();
  const pid = deferred<number>();
  let settled = false;
  const done: Promise<Ended> = W.inTx(async (tx) => {
    const res = (await tx.execute(
      sql`SELECT pg_backend_pid() AS pid`,
    )) as unknown as { rows: { pid: number }[] };
    pid.resolve(Number(res.rows[0]!.pid));
    const value = await run(tx);
    reached.resolve();
    if (hold) await gate.promise;
    return value;
  }).then(
    (value): Ended => ({ ok: true, value }),
    (error: unknown): Ended => ({ ok: false, error }),
  );
  void done.then(() => {
    settled = true;
    pid.resolve(0);
    reached.resolve();
  });
  return {
    pid: pid.promise,
    reached: reached.promise,
    release: () => gate.resolve(),
    done,
    isSettled: () => settled,
  };
}

/** The disown of A: a raw legend_app transaction (the trusted SQL function), real COMMIT. */
function disownSide(logId: string, grant: string, hold: boolean) {
  const pid = deferred<number>();
  const ran = deferred();
  const gate = deferred();
  let settled = false;
  const done: Promise<Ended> = (async (): Promise<Ended> => {
    const client = await W.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      pid.resolve(
        Number(
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        ),
      );
      const result = await client.query(DISOWN, [logId, grant, REASON]);
      ran.resolve();
      if (hold) await gate.promise;
      await client.query("COMMIT");
      return { ok: true, value: (result.rows[0] as Row).id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return { ok: false, error };
    } finally {
      client.release();
    }
  })();
  void done.then(() => {
    settled = true;
    pid.resolve(0);
    ran.resolve();
  });
  return {
    pid: pid.promise,
    ran: ran.promise,
    release: () => gate.resolve(),
    done,
    isSettled: () => settled,
  };
}

/** True while some backend of the database is blocked by the transaction of `holder`. */
const isBlockedBy = async (holder: number) =>
  holder > 0 &&
  Number(
    (
      await W.owner.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [holder],
      )
    ).rows[0].n,
  ) > 0;

/**
 * Polls (no fixed sleep decides anything) until the side either finished or is
 * blocked by the backend of the other (open) transaction; gives up as "stuck" after 20 s.
 */
async function observe(
  side: { isSettled: () => boolean },
  holderPid: number,
): Promise<"finished" | "waiting" | "stuck"> {
  for (let i = 0; i < 800; i += 1) {
    if (side.isSettled()) return "finished";
    if (await isBlockedBy(holderPid)) return "waiting";
    await sleep(25);
  }
  return side.isSettled() ? "finished" : "stuck";
}

/** After the step ran to its end and waits at the barrier, T2 disowns A. */
async function stepThenDisown(kind: Kind) {
  const w = await siblingWorld(kind);
  const before = await stateOf(w.runId);
  const logId = await logOf(w.aId, a.userId);
  const grant = await disownGrant(a.userId, w.aId, logId);
  const t1 = appSide((tx) => steps[kind].run(tx, w), true);
  let observed: "finished" | "waiting" | "stuck" = "stuck";
  let t1Early: Ended | null = null;
  try {
    await t1.reached;
    if (t1.isSettled()) t1Early = await t1.done;
    else {
      const t2 = disownSide(logId, grant, false);
      observed = await observe(t2, await t1.pid);
      // While T1 is still open nothing of it may be visible to anybody else.
      const duringT1 = await stateOf(w.runId);
      t1.release();
      const [first, second] = await Promise.all([t1.done, t2.done]);
      return {
        w,
        before,
        duringT1,
        observed,
        t1: first,
        t2: second,
        after: await stateOf(w.runId),
      };
    }
  } finally {
    t1.release();
    await t1.done;
  }
  return {
    w,
    before,
    duringT1: before,
    observed,
    t1: t1Early!,
    t2: null,
    after: await stateOf(w.runId),
  };
}

/** T2 disowned A and is held before its COMMIT; then the step on B starts. */
async function disownThenStep(kind: Kind) {
  const w = await siblingWorld(kind);
  const before = await stateOf(w.runId);
  const logId = await logOf(w.aId, a.userId);
  const grant = await disownGrant(a.userId, w.aId, logId);
  const t2 = disownSide(logId, grant, true);
  try {
    await t2.ran;
    if (t2.isSettled()) {
      const failed = await t2.done;
      throw new Error(
        `premise: the disown must run: ${messageChain(failed.ok ? "" : failed.error)}`,
      );
    }
    const t1 = appSide((tx) => steps[kind].run(tx, w), false);
    const observed = await observe(t1, await t2.pid);
    t2.release();
    const [second, first] = await Promise.all([t2.done, t1.done]);
    return {
      w,
      before,
      observed,
      t1: first,
      t2: second,
      after: await stateOf(w.runId),
    };
  } finally {
    t2.release();
    await t2.done;
  }
}

// ---- Setup / teardown ------------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await makePerson("A", "finance");
  b = await makePerson("B", "finance");
  locker = await makePerson("Locker");
  await W.grantRole(locker.userId, ["payroll.lock", "payroll.cancel.approve"]);
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
    if (batchIds.length > 0) {
      for (const table of [UNFREEZES, DISPUTES])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
          [W.tenantId, batchIds],
        );
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, batchIds],
      );
    }
  }, true).catch(() => undefined);
});

// =========================================================================
// The step is open (before COMMIT): the disown of the sibling waits for it
// =========================================================================

const TIMEOUT = 120_000;

describe("920 a step on the retry B, open before COMMIT: the disown of A waits", () => {
  for (const [id, kind] of [
    ["920-sibling-export-then-disown", "export"],
    ["920-sibling-settle-then-disown", "settle"],
    ["920-sibling-reversal-then-disown", "reversal"],
  ] as const)
    it(
      `[${id}] ${steps[kind].name} ran to its end and is held before COMMIT; the disown of A waits for the commit, then succeeds; the step stays committed and the freeze stands; no deadlock`,
      async () => {
        const r = await stepThenDisown(kind);
        expect(
          r.t1,
          `premise: the step reaches its end: ${messageChain(r.t1.ok ? "" : r.t1.error)}`,
        ).toMatchObject({ ok: true });
        expect(r.duringT1, "nobody sees the open step before it commits").toBe(
          r.before,
        );
        expect(
          r.observed,
          "the disown must queue behind the open step of the sibling (same lock), not finish and freeze under it",
        ).toBe("waiting");
        for (const side of [r.t1, r.t2])
          if (side && !side.ok)
            expect(
              rolledBackByDatabase(side.error),
              `no deadlock or serialization failure: ${messageChain(side.error)}`,
            ).toBe(false);
        expect(
          r.t2,
          `the disown succeeds once the step committed: ${messageChain(r.t2 && !r.t2.ok ? r.t2.error : "")}`,
        ).toMatchObject({ ok: true });
        if (kind !== "reversal")
          expect(r.after, "the committed step stays committed").not.toBe(
            r.before,
          );
        expect(await openDisputes(r.w.aId), "A is frozen").toBe(1);
      },
      TIMEOUT,
    );
});

// =========================================================================
// The disown is open (before COMMIT): the step on the sibling waits, then is refused
// =========================================================================

describe("920 the disown of A, open before COMMIT: a step on the retry B waits and is refused", () => {
  for (const [id, kind] of [
    ["920-sibling-disown-then-export", "export"],
    ["920-sibling-disown-then-settle", "settle"],
    ["920-sibling-disown-then-reversal", "reversal"],
  ] as const)
    it(
      `[${id}] the disown of A is held before COMMIT; the ${steps[kind].name} queues behind it and is refused as frozen after the commit, with no file and no money moved`,
      async () => {
        const r = await disownThenStep(kind);
        expect(
          r.t2,
          `premise: the disown commits: ${messageChain(!r.t2.ok ? r.t2.error : "")}`,
        ).toMatchObject({ ok: true });
        expect(
          r.observed,
          "the step must queue behind the open freeze (same lock) and not run past it",
        ).toBe("waiting");
        if (!r.t1.ok)
          expect(
            rolledBackByDatabase(r.t1.error),
            `no deadlock or serialization failure: ${messageChain(r.t1.error)}`,
          ).toBe(false);
        expect(
          r.t1.ok,
          `the step is refused after the freeze committed, it returns nothing (no transfer file): ${JSON.stringify(
            r.t1.ok ? "returned" : "",
          )}`,
        ).toBe(false);
        if (!r.t1.ok)
          expect(
            refusedAsFrozen(r.t1.error),
            `refused as frozen (PAYOUT-79 / PAYOUT_BATCH_FROZEN): ${messageChain(r.t1.error)}`,
          ).toBe(true);
        expect(
          r.after,
          "no transfer file, item, batch, posting, journal or run moved",
        ).toBe(r.before);
        expect(await openDisputes(r.w.aId), "A is frozen").toBe(1);
        if (kind !== "reversal") {
          // The sibling is frozen through A: its batch row is refused too.
          const touch = await W.owner.connect();
          try {
            await touch.query("BEGIN");
            await touch.query("SET LOCAL ROLE legend_app");
            await touch.query(
              "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
              [W.tenantId],
            );
            const error = await touch
              .query(
                `UPDATE payroll_disbursement_batches SET content_hash = $3
                  WHERE tenant_id = $1 AND id = $2`,
                [W.tenantId, r.w.bId, randomBytes(32).toString("hex")],
              )
              .then(
                () => null,
                (e: unknown) => e,
              );
            expect(
              messageChain(error),
              "B is frozen through its sibling A",
            ).toMatch(/PAYOUT-79:/);
          } finally {
            await touch.query("ROLLBACK").catch(() => undefined);
            touch.release();
          }
        }
      },
      TIMEOUT,
    );
});

// =========================================================================
// Control: an unrelated payslip is never blocked
// =========================================================================

describe("920 control: another payslip is not blocked by the open step", () => {
  it(
    "[920-sibling-control-unrelated] an export of B is held before COMMIT; the disown of an unrelated failed batch (another run) finishes at once without waiting, and the held export then commits",
    async () => {
      const held = await siblingWorld("export");
      const other = await siblingWorld("reversal");
      const logId = await logOf(other.aId, a.userId);
      const grant = await disownGrant(a.userId, other.aId, logId);
      const t1 = appSide((tx) => steps.export.run(tx, held), true);
      let observed: "finished" | "waiting" | "stuck" = "stuck";
      let t2: Ended | null = null;
      try {
        await t1.reached;
        expect(
          t1.isSettled(),
          "premise: the export reaches its end and waits at the barrier",
        ).toBe(false);
        const side = disownSide(logId, grant, false);
        observed = await observe(side, await t1.pid);
        if (observed === "finished") t2 = await side.done;
      } finally {
        t1.release();
      }
      const ended = await t1.done;
      expect(
        observed,
        "an unrelated payslip must not queue behind the open export",
      ).toBe("finished");
      expect(t2, "the unrelated disown succeeds").toMatchObject({ ok: true });
      expect(ended, "the held export commits").toMatchObject({ ok: true });
      expect(await openDisputes(other.aId), "the unrelated A is frozen").toBe(
        1,
      );
      expect(
        await openDisputes(held.aId),
        "the batches of the held payslip are not frozen",
      ).toBe(0);
    },
    TIMEOUT,
  );
});
