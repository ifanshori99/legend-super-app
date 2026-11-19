// Payout 1e9py (bead legend-1e9py, tier K: money): the guard that refuses the two-person
// clearance of an `evidence_read_locked:<day>` flag while the operation's lock holder
// still runs (jsrcs, migration 0706) looks at pg_locks for the operation's advisory key
// but did not filter on the database. A staging copy in the SAME cluster with the same
// tenant and operation ids can hold the same advisory key and would block the approval
// of production for as long as it runs. Written fail-first from
// docs/briefs/1164-payout-recurring-approval.md / brief 1175 (Kartu B) and the sibling
// test payroll-payout-jsrcs-clear-while-locked, NOT from the implementation.
//
// Rules under test (restrictive where money is concerned: a holder in THIS database
// still blocks; only a lock of another database stops counting):
// - a backend of ANOTHER database on the same cluster holds the same advisory key; the
//   holder in this database has finished: approving the clearance succeeds (200).
// - control: the holder in this database is still stuck while another database holds
//   the same key too: approving is still refused (409), the slip stays held.
// - catalog fallback: the function source names current_database() (it is not possible
//   to see the missing filter by behavior alone if the cluster refuses CREATE DATABASE).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The foreign database is created through STARTER_TEST_DATABASE_URL (the same admin
//   connection the migration tests use for scratch databases) and dropped afterwards.
// - The foreign lock is `pg_advisory_lock(hashtextextended(<key text>, 0))`, which is
//   the single-bigint form: pg_locks shows it as objsubid = 1 with the key split into
//   classid (high 32 bits) and objid (low 32 bits), as the recon service takes it.
// - The key text is `payout_recon_evidence_observe:<tenant>:<operation>`, the same text
//   the existing jsrcs test's holder (the real recon run) uses; the premise check reads
//   pg_locks to prove the foreign lock really has the same key in another database.
// - Refusal is HTTP 409 (as in the jsrcs test); the PAYOUT-91 text is not asserted.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool as appPool } from "../db/index.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
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

const W = installPayoutWorld("lockdb1e9py");
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
const BYTES_A = "1e9py tampered proof bytes A";
const HANG_BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const mfaOwner = new Pool({ connectionString: adminUrl, max: 2 });

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
    [W.tenantId, `Template ${key} 1e9py`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Clear 1e9py ${label}`);
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

/** Clearance proposal only (the approve step is what the card changes). */
async function propose(flagId: string) {
  const proposed = await proposeHttp(proposer, flagId, REASON);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  return clearanceId;
}

/** The two-person clearance of one flag as the evidence is now. */
async function clearFlag(flagId: string) {
  const clearanceId = await propose(flagId);
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- Rows ----------------------------------------------------------------------------------

const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );
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
  const key = uploadEvidence(batchId, `evid1e9py-${randomUUID()}.pdf`);
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

/** Waits until no other backend holds a granted advisory lock. */
async function lockHolderGone() {
  await expect
    .poll(
      async () =>
        (
          await W.rowsOf(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`,
          )
        )[0]!.n as number,
      { timeout: 10_000 },
    )
    .toBe(0);
}

/** A slip held by a real `evidence_read_locked` flag while run A is stuck. */
async function lockedFlagWorld() {
  const w = await freeWithOldOkWorld();
  const a = await startStuckHolder(w.key);
  const waiter = await within(
    runRecon(makeStorage(w.key), { lockTimeoutMs: 300 }),
  );
  expect(waiter.kind, "premise: the waiter finishes").toBe("done");
  const locked = await lockedFlags(w.itemId);
  expect(locked, "premise: one evidence_read_locked flag").toHaveLength(1);
  expect(
    String(locked[0]!.reason),
    "premise: the reason carries the day",
  ).toMatch(/evidence_read_locked:\d{4}-\d{2}-\d{2}/);
  expect(await heldBySql(w.payslipId), "premise: the slip is held").toBe(true);
  return {
    ...w,
    a,
    flagId: locked[0]!.id as string,
    flagOperationId: locked[0]!.operation_id as string,
  };
}

async function endHolder(a: Awaited<ReturnType<typeof startStuckHolder>>) {
  if (!a.gate.isEnded()) a.gate.end("return");
  await a.outcome;
}

// ---- A holder of the same advisory key in ANOTHER database ----------------------------------

function urlFor(database: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Creates a scratch database on the same (disposable) cluster and holds the
 * operation's advisory key there, as a staging copy with the same ids would.
 */
async function holdKeyInForeignDatabase(operationId: string) {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error("Requires the disposable test database");
  const name = `lockdb_1e9py_${randomBytes(6).toString("hex")}`;
  const keyText = `payout_recon_evidence_observe:${W.tenantId}:${operationId}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const holder = new Client({ connectionString: urlFor(name) });
  const errors: Error[] = [];
  holder.on("error", (error) => errors.push(error));
  let connected = false;
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    await holder.connect();
    connected = true;
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      keyText,
    ]);
    // Premise: the same key is really granted to a backend of the other database.
    const [row] = await W.rowsOf(
      `SELECT count(*)::int AS n
         FROM pg_catalog.pg_locks l,
              pg_catalog.hashtextextended($1, 0) AS k
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.classid::bigint = ((k >> 32) & 4294967295)
          AND l.objid::bigint = (k & 4294967295)
          AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = $2)
          AND l.database <> (SELECT oid FROM pg_catalog.pg_database
                              WHERE datname = pg_catalog.current_database())`,
      [keyText, name],
    );
    expect(
      row!.n,
      "premise: another database holds the same advisory key",
    ).toBe(1);
  } catch (error) {
    if (connected) await holder.end().catch(() => undefined);
    await dropTestDatabase(admin, name).catch(() => undefined);
    await endTestPool(admin).catch(() => undefined);
    throw error;
  }
  return {
    async release() {
      try {
        await holder.query("SELECT pg_advisory_unlock_all()").catch(() => {});
        await holder.end().catch(() => undefined);
        await dropTestDatabase(admin, name);
      } finally {
        await endTestPool(admin);
      }
      expect(errors, "the foreign holder saw no connection error").toEqual([]);
    },
  };
}

// =========================================================================
// T1: a lock of another database does not block the approval
// =========================================================================

describe("1e9py T1: only a lock holder in this database blocks the clearance", () => {
  it(
    "[1e9py-foreign-database-lock-does-not-block] the lock flag exists, run A is finished, and a backend of another database holds the same advisory key: approving the clearance succeeds (200), the slip is free, nobody is paid",
    async () => {
      const w = await lockedFlagWorld();
      const before = await moneySnapshot(w.itemId);
      await endHolder(w.a);
      await lockHolderGone();
      const foreign = await holdKeyInForeignDatabase(w.flagOperationId);
      try {
        const clearanceId = await propose(w.flagId);
        const res = await approveHttp(approverA, clearanceId);
        expect(
          res.status,
          `a lock held in another database is no reason to refuse: ${detail(res)}`,
        ).toBe(200);
        expect(await heldBySql(w.payslipId), "the slip is free").toBe(false);
        expect(
          await moneySnapshot(w.itemId),
          "flag and clearance pay nobody",
        ).toEqual(before);
      } finally {
        await foreign.release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1e9py-own-database-holder-still-blocks] control: a foreign-database holder of the same key exists AND run A still holds the lock in this database: approving is still refused (409) and the slip stays held",
    async () => {
      const w = await lockedFlagWorld();
      const before = await moneySnapshot(w.itemId);
      const foreign = await holdKeyInForeignDatabase(w.flagOperationId);
      try {
        const clearanceId = await propose(w.flagId);
        const res = await approveHttp(approverA, clearanceId);
        expect(
          res.status,
          `the holder in this database is still stuck: ${detail(res)}`,
        ).toBe(409);
        expect(
          await heldBySql(w.payslipId),
          "the slip stays held: nobody read the proof",
        ).toBe(true);
        expect(
          await moneySnapshot(w.itemId),
          "the refused clearance pays nothing",
        ).toEqual(before);
      } finally {
        await foreign.release();
        await endHolder(w.a);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T2: catalog fallback
// =========================================================================

describe("1e9py T2: the guard function is scoped to the current database", () => {
  it("[1e9py-function-names-current-database] app.payout_recon_clear_approve reads the current database name in its source", async () => {
    const rows = await W.rowsOf(
      `SELECT p.prosrc
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'payout_recon_clear_approve'`,
    );
    expect(rows, "exactly one function of that name").toHaveLength(1);
    // legend-1hpqt (0708): the guard no longer scans pg_locks (which needed the
    // current_database() filter). It takes pg_try_advisory_xact_lock, which is
    // scoped to the current database by PostgreSQL itself.
    const src = String(rows[0]!.prosrc);
    expect(src).not.toMatch(/pg_locks/i);
    expect(src).toMatch(/pg_try_advisory_xact_lock/i);
  });
});
