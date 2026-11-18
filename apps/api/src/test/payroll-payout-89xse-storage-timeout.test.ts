// Payout 89xse (bead legend-89xse, tier K: money): the night recon reads a proof
// file inside one transaction that holds a per-operation advisory lock. A storage
// read that never returns must not hold that lock and one pool connection for
// ever, and a second run must not wait for the lock without limit. Written
// fail-first from docs/briefs/89xse-recon-storage-timeout.md ("Aturan", "Bukti
// test") and the sibling tests payroll-payout-1057-clearance-stale-evidence /
// -1052-evidence-order, NOT from the implementation.
//
// Rules under test (CTO decision, fail closed):
// - storage.get is bounded by `storageTimeoutMs`; a timeout is an `error`
//   observation (like any other failed read): `unreadable` counts it, the slip is
//   held (qh11l), the lock and the pool connection are released.
// - the advisory lock wait is bounded by `lockTimeoutMs`; a run that cannot get
//   the lock counts the operation as unreadable, does not throw, writes no
//   observation (the lock holder records its own result) and goes on.
// - a read that finishes in time is judged normally; a later good read frees the
//   slip again with the old clearance (qh11l recovery).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The options are `storageTimeoutMs` and `lockTimeoutMs` on the options object of
//   `reconcileTrustedPayouts(context, options)` (named in the brief). Before the
//   fix they are ignored, so the hang tests fail by "the run did not finish".
// - "Did not hang" = the run settles inside HANG_BOUND_MS (10 s, far above the 200 ms
//   / 300 ms timeouts under test, so a slow machine does not flake; a hung run
//   fails the test, it never blocks the suite: every held storage read and lock
//   holder is released in afterEach, so a hung run finishes after the test).
// - The world is one corrected item whose proof is flagged as mismatch A and
//   cleared by two people, as in 1057, so the slip is FREE before the timeout and
//   `held` after it can only come from the unreadable read.
// - "Held" = app.payout_payslip_held_by_recon(tenant, payslip). Observation
//   columns as in 1052: tenant_id, operation_id, state, observed_at.
// - "Lock released" is probed behaviourally (a legend_app call of the trusted
//   observe function for the operation, which takes the same lock, gets through
//   inside a 3 s lock_timeout) and through the app pool (nothing checked out, nobody
//   waiting). No lock key is assumed.
// - Orphan storage promises: after a timeout the held read is later rejected by
//   the test; the process must see no unhandledRejection.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
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

const W = installPayoutWorld("89xsetimeout");
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
const BYTES_A = "89xse tampered proof bytes A";
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
    [W.tenantId, `Template ${key} 89xse`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Timeout89xse ${label}`);
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

// ---- A storage the test controls -----------------------------------------------------------

/** A held read of one proof key: the test decides when (and how) it ends. */
type Gate = {
  /** Resolved when a run is inside the read. */
  reached: Promise<void>;
  signalReached: () => void;
  /** Ends the held read: it returns the real object, or it rejects. */
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

type StorageOptions = {
  /** Hold every read of `key` until the gate ends. */
  hold?: Gate;
  /** Serve other bytes for `key` (a mismatch). */
  bytes?: string;
  /** Return the real object for `key` only after this many ms. */
  delayMs?: number;
};
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
      if (options.delayMs !== undefined)
        await new Promise((r) => setTimeout(r, options.delayMs));
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
  | { kind: "threw"; error: string; codes: string[] }
  | { kind: "hung" };
/** SQL error codes along an error and its causes. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}
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
          codes: codesOf(error),
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

// ---- World: a real corrected item with a stored proof, cleared for mismatch A -----------------

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evid89xse-${randomUUID()}.pdf`);
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

/** The proof turns into bytes A, a real run flags it, two people clear it: the slip is free. */
async function clearedWorld() {
  const w = await correctedWorld();
  await runRecon(makeStorage(w.key, { bytes: BYTES_A }));
  const flags = await exceptionRows(w.itemId);
  const evidenceFlag = flags.find((f) =>
    String(f.reason).includes("evidence_hash_mismatch"),
  );
  expect(evidenceFlag, "premise: an evidence_hash_mismatch flag").toBeDefined();
  const payslipId = flags[0]!.payslip_id as string;
  const operationId = evidenceFlag!.operation_id as string;
  expect(await heldBySql(payslipId), "premise: the flag holds the slip").toBe(
    true,
  );
  for (const f of flags) await clearFlag(f.id as string);
  expect(await heldBySql(payslipId), "premise: cleared is free").toBe(false);
  expect(
    await observedStates(operationId),
    "premise: mismatch on record",
  ).toEqual(["mismatch"]);
  return { ...w, payslipId, operationId };
}

// ---- Probes --------------------------------------------------------------------------------

/**
 * The trusted observe function for the operation, as legend_app, with a 3 s lock
 * timeout: it takes the same per-operation lock the recon takes, so it only gets
 * through when no stuck transaction still holds it. Returns the SQL error code.
 */
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

// ---- Setup / teardown ----------------------------------------------------------------------

/**
 * Runs `body` with `unhandledRejection` listened to by this function only (the
 * other listeners, vitest's included, are put back afterwards), then gives the
 * event loop two macrotask turns: node raises the event right after the
 * microtasks of the turn in which a rejection stays unhandled.
 */
async function withOnlyUnhandledListener(body: () => Promise<void>) {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  const others = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", listener);
  try {
    await body();
    for (let i = 0; i < 2; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    process.off("unhandledRejection", listener);
    for (const other of others) process.on("unhandledRejection", other);
  }
  return seen;
}

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
  // A run still held (a hung run, before the fix) finishes now; nothing stays stuck.
  for (const gate of gates.splice(0)) if (!gate.isEnded()) gate.end("return");
  // Wait until no connection of the app pool is still checked out by a stuck run.
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

// =========================================================================
// T1: a read that never returns is bounded and fails closed
// =========================================================================

describe("89xse T1: a storage read that never returns is bounded and holds the slip", () => {
  it(
    "[89xse-storage-never-returns-holds-slip] storage.get never settles: the run still finishes, counts the operation as unreadable, records an error observation and holds the cleared slip",
    async () => {
      const w = await clearedWorld();
      const gate = makeGate();
      const outcome = await within(
        runRecon(makeStorage(w.key, { hold: gate }), { storageTimeoutMs: 200 }),
      );
      expect(
        outcome.kind,
        `the run must finish although the storage read never returns (${outcome.kind})`,
      ).toBe("done");
      if (outcome.kind !== "done") return;
      expect(
        outcome.value.unreadable,
        "the timed-out read counts as unreadable",
      ).toBeGreaterThanOrEqual(1);
      const states = await observedStates(w.operationId);
      expect(states[states.length - 1], "the last observation is `error`").toBe(
        "error",
      );
      expect(
        await heldBySql(w.payslipId),
        "an unreadable proof holds the cleared slip",
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[89xse-orphan-storage-read-no-unhandled-rejection] the held read is rejected after the timeout: the process sees no unhandled rejection (control: the watcher does see one)",
    async () => {
      const w = await clearedWorld();

      // Control: the watcher catches a rejection nobody handles.
      const control = await withOnlyUnhandledListener(async () => {
        void Promise.reject(new Error("89xse control"));
      });
      expect(
        control,
        "control: the watcher sees an unhandled rejection",
      ).toHaveLength(1);

      const gate = makeGate();
      let outcomeKind = "not run";
      const seen = await withOnlyUnhandledListener(async () => {
        const outcome = await within(
          runRecon(makeStorage(w.key, { hold: gate }), {
            storageTimeoutMs: 200,
          }),
        );
        outcomeKind = outcome.kind;
        // The run is over (timed out); now the orphaned read fails.
        gate.end("reject");
        await gate.ended;
      });
      expect(outcomeKind, "the run must finish").toBe("done");
      expect(seen, "no unhandled rejection").toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T2: after the timeout nothing stays locked
// =========================================================================

describe("89xse T2: after a storage timeout the lock and the pool connection are free", () => {
  it(
    "[89xse-timeout-releases-lock-and-connection] after the timed-out run no advisory lock of the operation is held and no pool connection stays checked out",
    async () => {
      const w = await clearedWorld();
      const gate = makeGate();
      const outcome = await within(
        runRecon(makeStorage(w.key, { hold: gate }), { storageTimeoutMs: 200 }),
      );
      expect(outcome.kind, "the run must finish").toBe("done");

      // The storage read is STILL held (the test has not ended it): the lock
      // must be free all the same.
      expect(gate.isEnded(), "premise: the storage read is still held").toBe(
        false,
      );
      expect(
        await observeProbe(w.operationId),
        "the per-operation lock is free: the trusted observe function gets through",
      ).toBeUndefined();
      await expect
        .poll(() => appPool.totalCount - appPool.idleCount, { timeout: 5_000 })
        .toBe(0);
      expect(appPool.waitingCount, "nobody waits for a connection").toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T3: a second run does not wait for the lock without limit
// =========================================================================

describe("89xse T3: a run that cannot get the operation lock gives up after lockTimeoutMs", () => {
  it(
    "[89xse-lock-wait-is-bounded] run A holds the lock (storage held, long timeout); run B on the same operation with lockTimeoutMs 300 finishes, counts it unreadable, does not throw and writes no observation; A then finishes normally",
    async () => {
      const w = await clearedWorld();
      const gate = makeGate();
      const runA = runRecon(makeStorage(w.key, { hold: gate }), {
        storageTimeoutMs: 120_000,
      });
      const runAOutcome = settle(runA);
      try {
        // A is inside the read, so it holds the lock of the operation.
        const first = await Promise.race([
          gate.reached.then(() => "held" as const),
          runAOutcome.then(() => "ended" as const),
        ]);
        expect(first, "setup: run A reached the read of the proof").toBe(
          "held",
        );
        const before = await observedStates(w.operationId);

        const outcome = await within(
          runRecon(makeStorage(w.key), { lockTimeoutMs: 300 }),
        );
        expect(
          outcome.kind,
          `run B must not wait for the lock without limit and must not throw (${JSON.stringify(outcome)})`,
        ).toBe("done");
        if (outcome.kind === "done")
          expect(
            outcome.value.unreadable,
            "the operation B could not lock counts as unreadable",
          ).toBeGreaterThanOrEqual(1);
        expect(
          await observedStates(w.operationId),
          "B wrote no observation: the holder records its own result",
        ).toEqual(before);

        // Release A: it finishes normally and records its own (ok) read.
        gate.end("return");
        const finished = await within(runA);
        expect(
          finished.kind,
          `run A finishes normally (${JSON.stringify(finished)})`,
        ).toBe("done");
        if (finished.kind === "done")
          expect(finished.value.unreadable, "A read fine").toBe(0);
        const states = await observedStates(w.operationId);
        expect(states[states.length - 1], "A recorded its read").toBe("ok");
      } finally {
        if (!gate.isEnded()) gate.end("return");
        await runAOutcome;
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T4: recovery after a timeout; T5: a read that is only slow is judged normally
// =========================================================================

describe("89xse T4: the recovery path still works after a storage timeout", () => {
  it(
    "[89xse-recovery-after-timeout-frees-slip] a timeout holds the cleared slip; the next run reads the proof fine (ok) and frees it again with the old clearance",
    async () => {
      const w = await clearedWorld();
      const gate = makeGate();
      const timedOut = await within(
        runRecon(makeStorage(w.key, { hold: gate }), { storageTimeoutMs: 200 }),
      );
      expect(timedOut.kind, "the run must finish").toBe("done");
      expect(await heldBySql(w.payslipId), "premise: held by the timeout").toBe(
        true,
      );

      const recovered = await within(runRecon(makeStorage(w.key)));
      expect(recovered.kind, "the next run finishes").toBe("done");
      if (recovered.kind === "done")
        expect(
          recovered.value.unreadable,
          "a good read is not unreadable",
        ).toBe(0);
      const states = await observedStates(w.operationId);
      expect(states[states.length - 1], "the good read is recorded").toBe("ok");
      expect(
        await heldBySql(w.payslipId),
        "the good read lifts the hold, as after any unreadable cycle (qh11l)",
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("89xse T5: a read that finishes before the timeout is judged normally", () => {
  it(
    "[89xse-slow-read-within-timeout-is-normal] the storage answers after 150 ms with a 5 s timeout: the read counts as ok, not unreadable, and no error is recorded",
    async () => {
      const w = await clearedWorld();
      const outcome = await within(
        runRecon(makeStorage(w.key, { delayMs: 150 }), {
          storageTimeoutMs: 5_000,
        }),
      );
      expect(outcome.kind, "the run finishes").toBe("done");
      if (outcome.kind !== "done") return;
      expect(outcome.value.unreadable, "not unreadable").toBe(0);
      expect(
        await observedStates(w.operationId),
        "the read is recorded as the file is: ok",
      ).toEqual(["mismatch", "ok"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[89xse-fast-missing-still-missing] a proof that is not found is still `missing` (not `error`) when a storage timeout is set",
    async () => {
      const w = await clearedWorld();
      const storage = {
        async get(context: unknown, input: { key: string }) {
          if (input.key === w.key)
            throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
          return (
            W.proofs().storage.get as (
              c: unknown,
              i: unknown,
            ) => Promise<Record<string, unknown>>
          )(context, input);
        },
      };
      const outcome = await within(
        runRecon(storage, { storageTimeoutMs: 5_000 }),
      );
      expect(outcome.kind, "the run finishes").toBe("done");
      const states = await observedStates(w.operationId);
      expect(states[states.length - 1], "not found is `missing`").toBe(
        "missing",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T6: one timeout per page (breaker); T7: defaults; T8: a late 55P03 is not swallowed
// =========================================================================

describe("89xse T6: a dead storage costs one timeout per page, not one per operation", () => {
  it(
    "[89xse-breaker-one-timeout-per-page] two operations, storage never answers: the page ends in about one timeout, both operations record `error`, both slips are held, storage.get is entered once",
    async () => {
      const w1 = await clearedWorld();
      const w2 = await clearedWorld();
      expect(await heldBySql(w1.payslipId), "premise: slip 1 free").toBe(false);
      expect(await heldBySql(w2.payslipId), "premise: slip 2 free").toBe(false);

      const gate = makeGate();
      const hung: string[] = [];
      const base = W.proofs().storage.get as (
        c: unknown,
        i: unknown,
      ) => Promise<Record<string, unknown>>;
      const storage = {
        async get(context: unknown, input: { key: string }) {
          if (input.key !== w1.key && input.key !== w2.key)
            return base(context, input);
          hung.push(input.key);
          gate.signalReached();
          await gate.ended;
          return base(context, input);
        },
      };
      const timeoutMs = 2_000;
      const started = Date.now();
      const outcome = await within(
        runRecon(storage, { storageTimeoutMs: timeoutMs }),
        30_000,
      );
      const elapsed = Date.now() - started;
      expect(outcome.kind, "the run finishes").toBe("done");
      if (outcome.kind !== "done") return;
      expect(
        outcome.value.unreadable,
        "both operations count as unreadable",
      ).toBeGreaterThanOrEqual(2);
      expect(
        elapsed,
        `the page took ${elapsed} ms: about one timeout (${timeoutMs} ms), not two in a row`,
      ).toBeLessThan(timeoutMs * 1.75);
      expect(
        hung,
        "storage.get is entered once; the second operation is not waited for",
      ).toHaveLength(1);
      for (const w of [w1, w2]) {
        const states = await observedStates(w.operationId);
        expect(
          states[states.length - 1],
          "every operation of the page records `error`",
        ).toBe("error");
        expect(await heldBySql(w.payslipId), "its slip is held").toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("89xse T7: without options the documented defaults apply", () => {
  it(
    "[89xse-default-storage-timeout-15s] no options: the read is bounded by a 15 s timer (seen as the timer the run asks for), the run finishes, the slip is held",
    async () => {
      const mod =
        (await import("../services/payroll-payout-recon.service.ts")) as Record<
          string,
          unknown
        >;
      expect(
        mod.PAYOUT_RECON_STORAGE_READ_TIMEOUT_MS,
        "documented default",
      ).toBe(15_000);
      const w = await clearedWorld();
      const gate = makeGate();
      const asked: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      // Record every delay asked for; shorten only the 15 s one so the test is quick.
      globalThis.setTimeout = ((
        handler: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        if (typeof ms === "number") asked.push(ms);
        return realSetTimeout(handler, ms === 15_000 ? 20 : ms, ...args);
      }) as unknown as typeof setTimeout;
      let outcome: Outcome<ReconResult>;
      try {
        outcome = await within(runRecon(makeStorage(w.key, { hold: gate })));
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(
        asked,
        "the run bounds the read with a 15 000 ms timer when no option is given",
      ).toContain(15_000);
      expect(outcome.kind, "the run finishes").toBe("done");
      if (outcome.kind !== "done") return;
      expect(
        outcome.value.unreadable,
        "the timed-out read is unreadable",
      ).toBeGreaterThanOrEqual(1);
      const states = await observedStates(w.operationId);
      expect(states[states.length - 1], "recorded as `error`").toBe("error");
      expect(await heldBySql(w.payslipId), "the slip is held").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it("[89xse-default-lock-timeout-30s] no options: a run that cannot get the lock waits about 30 s (not less, not for ever), then counts the operation unreadable without throwing", async () => {
    const mod =
      (await import("../services/payroll-payout-recon.service.ts")) as Record<
        string,
        unknown
      >;
    expect(mod.PAYOUT_RECON_LOCK_TIMEOUT_MS, "documented default").toBe(30_000);
    const w = await clearedWorld();
    const gate = makeGate();
    const runA = runRecon(makeStorage(w.key, { hold: gate }), {
      storageTimeoutMs: 120_000,
    });
    const runAOutcome = settle(runA);
    try {
      const first = await Promise.race([
        gate.reached.then(() => "held" as const),
        runAOutcome.then(() => "ended" as const),
      ]);
      expect(first, "setup: run A holds the lock inside the read").toBe("held");
      const before = await observedStates(w.operationId);
      const started = Date.now();
      const outcome = await within(runRecon(makeStorage(w.key)), 40_000);
      const elapsed = Date.now() - started;
      expect(
        outcome.kind,
        `B gives up on the lock by itself (${JSON.stringify(outcome)})`,
      ).toBe("done");
      expect(
        elapsed,
        `B waited ${elapsed} ms: the default lock wait is 30 s`,
      ).toBeGreaterThanOrEqual(29_000);
      if (outcome.kind === "done")
        expect(
          outcome.value.unreadable,
          "the locked operation counts as unreadable",
        ).toBeGreaterThanOrEqual(1);
      expect(
        await observedStates(w.operationId),
        "B wrote no observation",
      ).toEqual(before);
    } finally {
      if (!gate.isEnded()) gate.end("return");
      await runAOutcome;
    }
  }, 120_000);
});

describe("89xse T8: a lock timeout after the lock is held is a failure, not a skipped operation", () => {
  it(
    "[89xse-late-lock-timeout-is-thrown] the operation lock is held, then recording the read waits on another session's lock and hits lock_timeout (55P03): the run throws and the slip is not counted as merely locked",
    async () => {
      const w = await clearedWorld();
      const base = W.proofs().storage.get as (
        c: unknown,
        i: unknown,
      ) => Promise<Record<string, unknown>>;
      const held: {
        client: PoolClient | null;
      } = { client: null };
      const storage = {
        async get(context: unknown, input: { key: string }) {
          const object = await base(context, input);
          if (input.key !== w.key) return object;
          // The recon is inside the read, so it already holds the operation
          // lock. Another session now locks the observations table: writing
          // this read's observation has to wait for it.
          const blocker = await W.owner.connect();
          held.client = blocker;
          await blocker.query("BEGIN");
          await blocker.query("SET LOCAL lock_timeout = '5s'");
          await blocker.query(
            `LOCK TABLE ${OBSERVATIONS} IN ACCESS EXCLUSIVE MODE`,
          );
          // New bytes: the read ends in a `mismatch` observation to write.
          return { ...object, content: "89xse late lock bytes" };
        },
      };
      let outcome: Outcome<ReconResult>;
      try {
        outcome = await within(
          runRecon(storage, { storageTimeoutMs: 5_000, lockTimeoutMs: 300 }),
        );
      } finally {
        if (held.client) {
          await held.client.query("ROLLBACK").catch(() => undefined);
          held.client.release();
        }
      }
      expect(
        held.client,
        "premise: the other session held its lock",
      ).toBeDefined();
      expect(
        outcome.kind,
        `the run must throw: a lock timeout after the lock was taken is not an operation locked by someone else (${JSON.stringify(outcome)})`,
      ).toBe("threw");
      if (outcome.kind === "threw")
        expect(outcome.codes, "the failure is the lock timeout").toContain(
          "55P03",
        );
      const states = await observedStates(w.operationId);
      expect(states, "nothing was recorded by the failed page").toEqual([
        "mismatch",
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
