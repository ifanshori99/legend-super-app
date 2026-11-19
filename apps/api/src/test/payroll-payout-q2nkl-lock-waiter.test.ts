// Payout q2nkl (bead legend-q2nkl, tier K: money): the night recon takes a
// per-operation advisory lock (89xse). A run that cannot get the lock inside
// `lockTimeoutMs` (55P03) gives up on that operation. Today it then leaves NO
// trace: the slip stays at the last observation of the operation, which can be an
// old `ok`, for as long as the lock holder is stuck. Written fail-first from
// docs/briefs/1164-payout-recurring-approval.md (Kartu A) and the bead text, and
// from the sibling test payroll-payout-89xse-storage-timeout, NOT from the
// implementation.
//
// Rules under test (restrictive: when in doubt, hold the slip):
// - a waiter that times out on the lock does not skip the operation silently: the
//   operation counts as unreadable, the run does not throw, and it raises a flag
//   with reason `evidence_read_locked` in payroll_payout_recon_exceptions for the
//   terminal item of that operation (section "Keputusan engineer" of the brief:
//   the observe function needs the stuck lock, so the flag path is used). The
//   flag holds the slip although its last observation was `ok`, until two people
//   close it. The run stays money-neutral: nothing is paid, re-paid or posted.
// - the hold is not lifted by a dead holder: when the stuck holder's backend is
//   killed (pg_terminate_backend), its transaction is rolled back, the lock is
//   free, the process stays up (no uncaught connection error), the pool recovers,
//   and the flag keeps the slip held, also after a later good read (`ok`), until
//   the two-person clearance closes it; then the slip is free and nobody was paid.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The flag row is found by `reason` containing `evidence_read_locked` (as the
//   other tests match `evidence_hash_mismatch`), with `operation_id`/`item_id`/
//   `payslip_id` as in 1052/89xse. A flag that stays after a good read is the
//   brief's decision ("menahan slip sampai ditutup dua-orang"); the old 89xse T3
//   (B writes no OBSERVATION) stays true because the waiter writes a flag.
// - The clearance of the new flag goes through the same two-person HTTP flow as
//   any other flag (clearFlag).
// - Options as in 89xse: `storageTimeoutMs`, `lockTimeoutMs` on the options of
//   `reconcileTrustedPayouts(context, options)`.
// - The holder is found without assuming a lock key: the one backend that holds a
//   granted advisory lock in pg_locks while the run is inside the held storage
//   read.
// - "Money-neutral" = row counts of the batch, item, GL posting, journal entry and
//   grant tables of the tenant, plus the item status, do not change.
// - After a killed holder, run A either finishes or throws; both are accepted, a
//   hang or an uncaught process error is not.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool as appPool } from "../db/index.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  bank,
  BUDI,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("q2nklwaiter");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const REASON = "Sudah dicek manual, berkas bukti sudah diperiksa ulang";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const OBSERVATIONS = "payroll_payout_recon_evidence_observations";
const GRANTS = "payroll_payout_grants";
const BYTES_A = "q2nkl tampered proof bytes A";
const HANG_BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// ---- People (HTTP, TOTP enrolled in this very session) --------------------------------

type Person = Awaited<ReturnType<typeof makePerson>>;

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
    [W.tenantId, `Template ${key} q2nkl`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Waiter q2nkl ${label}`);
  personIds.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const roleId = await templateRoleId(template);
  await W.owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [W.tenantId, userId, roleId],
  );
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return { client, userId };
}

let proposer: Person;
let approverA: Person;

// ---- HTTP ----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const proposeHttp = (who: Person, flagId: string, reason: string) =>
  who.client
    .post(`${FLAGS}/${flagId}/clearance`)
    .set(originHeader)
    .send({ reason, password: PASSWORD }) as unknown as Promise<Res>;
const approveHttp = (who: Person, clearanceId: string) =>
  who.client
    .post(`${CLEARANCES}/${clearanceId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD }) as unknown as Promise<Res>;

/** The two-person clearance of one flag as the evidence is now. */
async function clearFlag(flagId: string) {
  const proposed = await proposeHttp(proposer, flagId, REASON);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- Rows ----------------------------------------------------------------------------------

const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );
/** The flags a lock-timed-out waiter raised for the item (reason `evidence_read_locked`). */
async function lockedFlags(itemId: string) {
  return (await exceptionRows(itemId)).filter((f) =>
    String(f.reason).includes("evidence_read_locked"),
  );
}
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
async function observedStates(operationId: string) {
  const rows = await W.rowsOf(
    `SELECT state FROM ${OBSERVATIONS} WHERE tenant_id = $1 AND operation_id = $2
      ORDER BY observed_at, id`,
    [W.tenantId, operationId],
  );
  return rows.map((r) => r.state as string);
}

/** Everything that moves money for the tenant: counts and the item status. */
async function moneySnapshot(itemId: string) {
  const count = async (table: string, extra = "") => {
    const [row] = await W.rowsOf(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1${extra}`,
      [W.tenantId],
    );
    return row!.n as number;
  };
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  return {
    batches: await count("payroll_disbursement_batches"),
    items: await count("payroll_disbursement_items"),
    glPostings: await count("payroll_payout_gl_postings"),
    journalEntries: await count("journal_entries"),
    // The two-person clearance itself consumes `recon_clear` grants; they move no money.
    grants: await count(GRANTS, " AND kind <> 'recon_clear'"),
    itemStatus: item!.status as string,
  };
}

// ---- A storage the test controls -----------------------------------------------------------

type Gate = {
  reached: Promise<void>;
  signalReached: () => void;
  end: (how: "return" | "reject") => void;
  ended: Promise<"return" | "reject">;
  isEnded: () => boolean;
};
const gates: Gate[] = [];
function makeGate(): Gate {
  let signalReached!: () => void;
  let end!: (how: "return" | "reject") => void;
  let done = false;
  const reached = new Promise<void>((r) => (signalReached = r));
  const ended = new Promise<"return" | "reject">((r) => {
    end = (how) => {
      done = true;
      r(how);
    };
  });
  const gate: Gate = {
    reached,
    signalReached,
    end,
    ended,
    isEnded: () => done,
  };
  gates.push(gate);
  return gate;
}

type StorageOptions = { hold?: Gate; bytes?: string };
function makeStorage(key: string, options: StorageOptions = {}) {
  const base = W.proofs().storage;
  const real = (context: unknown, input: unknown) =>
    (base.get as (c: unknown, i: unknown) => Promise<Record<string, unknown>>)(
      context,
      input,
    );
  return {
    async get(context: unknown, input: { key: string }) {
      if (input.key !== key) return real(context, input);
      if (options.hold) {
        options.hold.signalReached();
        if ((await options.hold.ended) === "reject")
          throw new Error("storage went away");
        return real(context, input);
      }
      const object = await real(context, input);
      return options.bytes === undefined
        ? object
        : { ...object, content: options.bytes };
    },
  };
}

type ReconResult = { unreadable: number; pages: number };

/** The night run over all pages of the tenant; `extra` are the options under test. */
async function runRecon(
  storage: unknown,
  extra: Record<string, unknown> = {},
): Promise<ReconResult> {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const run = mod.reconcileTrustedPayouts as (
    context: unknown,
    options: unknown,
  ) => Promise<{
    operations: number;
    last: string | null;
    unreadable: number;
  }>;
  expect(run, "the recon service exports reconcileTrustedPayouts").toBeTypeOf(
    "function",
  );
  let after: string | null = null;
  let unreadable = 0;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await run(W.scope(), { storage, after, ...extra });
    unreadable += result.unreadable;
    if (result.last === null || result.operations === 0)
      return { unreadable, pages: page };
    after = result.last;
  }
  throw new Error("recon did not finish");
}

type Outcome<T> =
  | { kind: "done"; value: T }
  | { kind: "threw"; error: string }
  | { kind: "hung" };
/** Settles with the run's outcome, or "hung" when it is still going after `ms`. */
async function within<T>(promise: Promise<T>, ms = HANG_BOUND_MS) {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "hung" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Outcome<T> => ({ kind: "done", value }),
        (error: unknown): Outcome<T> => ({
          kind: "threw",
          error: String(error),
        }),
      ),
      bound,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** A promise that never rejects (for runs that are awaited only to clean up). */
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => String(error),
  );

// ---- World: a real corrected item with a stored proof, cleared, then read `ok` -----------------

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evidq2nkl-${randomUUID()}.pdf`);
  for (const who of [proposer, approverA]) {
    const res = (await who.client
      .post(`/api/hris/payroll/disbursement-batches/${batchId}/correct-failed`)
      .set(originHeader)
      .send({
        itemIds: [itemId],
        evidenceKey: key,
        note: "Mutasi bank menunjukkan transfer ternyata berhasil",
        password: PASSWORD,
      })) as unknown as Res;
    expect([200, 201], `correct-failed ${detail(res)}`).toContain(res.status);
  }
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, "premise: corrected").toBe("succeeded");
  await runRecon(makeStorage(key));
  expect(
    await exceptionRows(itemId),
    "control: an untouched corrected item is not flagged",
  ).toHaveLength(0);
  return { batchId, itemId, key };
}

/**
 * The proof turns into bytes A, a real run flags it, two people clear it, and a
 * later good run reads the proof fine: the slip is FREE and the last observation
 * of the operation is an old `ok`.
 */
async function freeWithOldOkWorld() {
  const w = await correctedWorld();
  await runRecon(makeStorage(w.key, { bytes: BYTES_A }));
  const flags = await exceptionRows(w.itemId);
  const evidenceFlag = flags.find((f) =>
    String(f.reason).includes("evidence_hash_mismatch"),
  );
  expect(evidenceFlag, "premise: an evidence_hash_mismatch flag").toBeDefined();
  const payslipId = flags[0]!.payslip_id as string;
  const operationId = evidenceFlag!.operation_id as string;
  for (const f of flags) await clearFlag(f.id as string);
  expect(await heldBySql(payslipId), "premise: cleared is free").toBe(false);
  const good = await runRecon(makeStorage(w.key));
  expect(good.unreadable, "premise: the good read is readable").toBe(0);
  const states = await observedStates(operationId);
  expect(states[states.length - 1], "premise: last observation is ok").toBe(
    "ok",
  );
  expect(await heldBySql(payslipId), "premise: still free after ok").toBe(
    false,
  );
  return { ...w, payslipId, operationId };
}

// ---- Probes --------------------------------------------------------------------------------

/** Same probe as 89xse: the trusted observe function takes the operation lock. */
async function observeProbe(operationId: string) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    await client.query("SET LOCAL lock_timeout = '3s'");
    try {
      await client.query(
        `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, 'error', NULL)`,
        [W.tenantId, operationId],
      );
      await client.query("COMMIT");
      return undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return (error as { code?: string }).code ?? "unknown";
    }
  } finally {
    client.release();
  }
}

/** The backend pid that holds a granted advisory lock (the stuck run A). */
async function lockHolderPid(): Promise<number> {
  let pid: number | undefined;
  for (let i = 0; i < 100 && pid === undefined; i += 1) {
    const rows = await W.rowsOf(
      `SELECT DISTINCT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`,
    );
    if (rows.length === 1) pid = Number(rows[0]!.pid);
    else await new Promise((r) => setTimeout(r, 50));
  }
  expect(
    pid,
    "premise: exactly one backend holds an advisory lock",
  ).toBeDefined();
  return pid!;
}

/** Runs `body` while this function alone listens to process-level errors. */
async function watchProcessErrors(body: () => Promise<void>) {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  const events = ["uncaughtException", "unhandledRejection"] as const;
  const emitter: NodeJS.EventEmitter = process;
  const others = events.map((e) => emitter.listeners(e));
  for (const e of events) {
    process.removeAllListeners(e);
    process.on(e, listener);
  }
  try {
    await body();
    // A connection error is emitted on a later turn of the event loop.
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 2; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    events.forEach((e, i) => {
      process.removeListener(e, listener);
      for (const other of others[i]!) process.on(e, other as never);
    });
  }
  return seen;
}

// ---- Setup / teardown ----------------------------------------------------------------------

async function dropAppendOnly() {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${OBSERVATIONS}') IS NOT NULL AS found`,
  );
  await W.asTenant(async (c) => {
    if (exists!.found)
      await c.query(`DELETE FROM ${OBSERVATIONS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    await c.query(`DELETE FROM ${SIGHTINGS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approverA = await makePerson("Approver A", "finance");
});

afterEach(async () => {
  // A run still held finishes now; nothing stays stuck.
  for (const gate of gates.splice(0)) if (!gate.isEnded()) gate.end("return");
  for (let i = 0; i < 200 && appPool.totalCount !== appPool.idleCount; i += 1)
    await new Promise((r) => setTimeout(r, 50));
  await dropAppendOnly();
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    await c.query(
      `DELETE FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'recon_clear'`,
      [W.tenantId],
    );
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

afterAll(async () => {
  await W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
        [W.tenantId, personIds],
      ),
    true,
  ).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

/** Run A holds the operation lock inside a held storage read. */
async function startStuckHolder(key: string) {
  const gate = makeGate();
  const run = runRecon(makeStorage(key, { hold: gate }), {
    storageTimeoutMs: 120_000,
  });
  const outcome = settle(run);
  const first = await Promise.race([
    gate.reached.then(() => "held" as const),
    outcome.then(() => "ended" as const),
  ]);
  expect(first, "setup: run A is inside the read and holds the lock").toBe(
    "held",
  );
  return { gate, run, outcome };
}

// =========================================================================
// T1: a waiter that times out on the lock does not leave a stale `ok`
// =========================================================================

describe("q2nkl T1: a waiter that cannot get the operation lock holds the slip", () => {
  it(
    "[q2nkl-waiter-timeout-holds-slip] run A is stuck holding the lock; run B (lockTimeoutMs 300) finishes without throwing, counts the operation unreadable, and the slip whose last read was an old ok is now held",
    async () => {
      const w = await freeWithOldOkWorld();
      const a = await startStuckHolder(w.key);
      try {
        const outcome = await within(
          runRecon(makeStorage(w.key), { lockTimeoutMs: 300 }),
        );
        expect(
          outcome.kind,
          `B must finish and not throw (${JSON.stringify(outcome)})`,
        ).toBe("done");
        if (outcome.kind === "done")
          expect(
            outcome.value.unreadable,
            "the operation B could not lock counts as unreadable",
          ).toBeGreaterThanOrEqual(1);
        const locked = await lockedFlags(w.itemId);
        expect(
          locked,
          "the waiter raises one evidence_read_locked flag for the terminal item",
        ).toHaveLength(1);
        expect(locked[0]!.operation_id, "flag of that operation").toBe(
          w.operationId,
        );
        expect(locked[0]!.payslip_id, "flag of that slip").toBe(w.payslipId);
        expect(
          await heldBySql(w.payslipId),
          "the waiter timed out: the old ok must not keep the slip free while the holder is stuck",
        ).toBe(true);
      } finally {
        if (!a.gate.isEnded()) a.gate.end("return");
        await a.outcome;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[q2nkl-waiter-timeout-pays-nobody] a timed-out waiter, repeated twice, moves no money: no new batch, item, GL posting, journal entry or grant, and the item stays succeeded",
    async () => {
      const w = await freeWithOldOkWorld();
      const before = await moneySnapshot(w.itemId);
      expect(before.itemStatus, "premise: corrected item").toBe("succeeded");
      const a = await startStuckHolder(w.key);
      try {
        for (const round of [1, 2]) {
          const outcome = await within(
            runRecon(makeStorage(w.key), { lockTimeoutMs: 300 }),
          );
          expect(
            outcome.kind,
            `waiter round ${round} finishes (${JSON.stringify(outcome)})`,
          ).toBe("done");
          expect(
            await heldBySql(w.payslipId),
            `round ${round}: the slip stays held`,
          ).toBe(true);
        }
        expect(
          await lockedFlags(w.itemId),
          "repeated waiters do not pile up flags for the same item",
        ).toHaveLength(1);
        expect(
          await moneySnapshot(w.itemId),
          "a timed-out waiter pays, re-pays and posts nothing",
        ).toEqual(before);
      } finally {
        if (!a.gate.isEnded()) a.gate.end("return");
        await a.outcome;
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("q2nkl T1b: a lock timeout after the flag was closed raises a new flag", () => {
  it(
    "[q2nkl-waiter-timeout-after-clearance-new-day-new-flag] the lock flag is cleared by two people; a later timeout on another Jakarta day (options.now) raises a new flag with a day-marked reason and holds the slip again",
    async () => {
      const w = await freeWithOldOkWorld();
      const day1 = new Date("2031-03-10T05:00:00Z"); // 12:00 Jakarta, 10 Mar
      const day2 = new Date("2031-03-11T05:00:00Z"); // 11 Mar
      let a = await startStuckHolder(w.key);
      try {
        const first = await within(
          runRecon(makeStorage(w.key), { lockTimeoutMs: 300, now: day1 }),
        );
        expect(first.kind, "first waiter finishes").toBe("done");
        const firstFlags = await lockedFlags(w.itemId);
        expect(firstFlags, "premise: one lock flag").toHaveLength(1);
        expect(
          String(firstFlags[0]!.reason),
          "the reason is marked with the Jakarta day",
        ).toContain("evidence_read_locked:2031-03-10");
        // legend-jsrcs: a two-person clearance is refused while the holder still
        // holds the lock, so the first holder ends before the flag is closed.
        a.gate.end("return");
        await a.outcome;
        await clearFlag(firstFlags[0]!.id as string);
        expect(
          await heldBySql(w.payslipId),
          "premise: the cleared flag frees the slip",
        ).toBe(false);
        a = await startStuckHolder(w.key);

        const second = await within(
          runRecon(makeStorage(w.key), { lockTimeoutMs: 300, now: day2 }),
        );
        expect(second.kind, "second waiter finishes").toBe("done");
        const flags = await lockedFlags(w.itemId);
        expect(flags, "a new flag for the new day").toHaveLength(2);
        expect(
          flags.some((f) =>
            String(f.reason).includes("evidence_read_locked:2031-03-11"),
          ),
          "the new flag carries the new day",
        ).toBe(true);
        expect(
          await heldBySql(w.payslipId),
          "the timeout after the clearance holds the slip again",
        ).toBe(true);
      } finally {
        if (!a.gate.isEnded()) a.gate.end("return");
        await a.outcome;
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T2: the lock holder dies (pg_terminate_backend)
// =========================================================================

describe("q2nkl T2: the stuck lock holder is killed", () => {
  it(
    "[q2nkl-killed-holder-no-process-error] pg_terminate_backend on the holder inside its storage read: run A settles (no hang), the process sees no uncaught error, the lock is free and the pool has nothing checked out",
    async () => {
      const w = await freeWithOldOkWorld();
      const a = await startStuckHolder(w.key);
      const pid = await lockHolderPid();
      let aOutcome: Outcome<ReconResult> | undefined;
      const seen = await watchProcessErrors(async () => {
        await W.owner.query("SELECT pg_terminate_backend($1)", [pid]);
        // A's storage read is still pending; the dead connection surfaces once
        // A goes on, or earlier as a client error event.
        await new Promise((r) => setTimeout(r, 500));
        a.gate.end("return");
        aOutcome = await within(a.run);
      });
      expect(seen, "no uncaught exception or unhandled rejection").toEqual([]);
      expect(
        aOutcome?.kind,
        `run A settles after its backend was killed (${JSON.stringify(aOutcome)})`,
      ).not.toBe("hung");
      expect(
        await observeProbe(w.operationId),
        "the operation lock is free after the holder died",
      ).toBeUndefined();
      await expect
        .poll(() => appPool.totalCount - appPool.idleCount, { timeout: 5_000 })
        .toBe(0);
      expect(appPool.waitingCount, "nobody waits for a connection").toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[q2nkl-killed-holder-flag-holds-until-two-person-clearance] waiter B raised the flag while A was stuck; A's backend is killed: the slip stays held, also after the next good read (ok); only the two-person clearance of the flag frees it; nobody is paid on the way",
    async () => {
      const w = await freeWithOldOkWorld();
      const before = await moneySnapshot(w.itemId);
      const a = await startStuckHolder(w.key);
      const pid = await lockHolderPid();
      const waiter = await within(
        runRecon(makeStorage(w.key), { lockTimeoutMs: 300 }),
      );
      expect(waiter.kind, "B finishes").toBe("done");
      expect(await heldBySql(w.payslipId), "premise: B held the slip").toBe(
        true,
      );

      await watchProcessErrors(async () => {
        await W.owner.query("SELECT pg_terminate_backend($1)", [pid]);
        await new Promise((r) => setTimeout(r, 500));
        a.gate.end("return");
        expect((await within(a.run)).kind, "run A settles").not.toBe("hung");
      });
      expect(
        await heldBySql(w.payslipId),
        "the killed holder rolled back: the slip is still held, not freed by the stale ok",
      ).toBe(true);

      const recovered = await within(runRecon(makeStorage(w.key)));
      expect(
        recovered.kind,
        `the next run finishes (${JSON.stringify(recovered)})`,
      ).toBe("done");
      if (recovered.kind === "done")
        expect(recovered.value.unreadable, "a good read is readable").toBe(0);
      const states = await observedStates(w.operationId);
      expect(states[states.length - 1], "the good read is recorded").toBe("ok");
      expect(
        await heldBySql(w.payslipId),
        "a good read does not close the flag: the slip stays held until two people clear it",
      ).toBe(true);

      for (const f of await lockedFlags(w.itemId))
        await clearFlag(f.id as string);
      expect(
        await heldBySql(w.payslipId),
        "the two-person clearance of the flag frees the slip",
      ).toBe(false);
      expect(
        await moneySnapshot(w.itemId),
        "flag, kill, recovery and clearance pay nobody",
      ).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T3: db/index.ts: a killed borrowed connection is not an unhandled 'error'
// =========================================================================

describe("q2nkl T3: pg_terminate_backend on a borrowed pool connection", () => {
  it(
    "[q2nkl-pool-killed-borrowed-connection-no-unhandled-error] a connection checked out of the app pool is terminated while idle in its transaction: the process sees no uncaught 'error' event, and the pool serves queries again afterwards",
    async () => {
      const client = await appPool.connect();
      let pid: number;
      try {
        await client.query("BEGIN");
        pid = Number(
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        const seen = await watchProcessErrors(async () => {
          await W.owner.query("SELECT pg_terminate_backend($1)", [pid]);
          // The client is checked out and not running a query: the lost
          // connection can only surface as an 'error' event on the client.
          await new Promise((r) => setTimeout(r, 500));
        });
        expect(
          seen,
          "no uncaught exception: the connection has an error listener",
        ).toEqual([]);
      } finally {
        // `true` destroys the dead client instead of returning it to the pool.
        client.release(true);
      }
      const probe = await appPool.query("SELECT 1 AS ok");
      expect(probe.rows[0].ok, "the pool still serves queries").toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
