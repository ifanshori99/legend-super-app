// Payout 1052, finding 1 (P1) of the second opinion on 1049 round 2: the order in
// which a night run READS the proof file and RECORDS the observation must be the
// same for every run, and the "file is ok again" observation must be decided by
// the database state at recording time, not by the stale snapshot a run took at
// its start. Written fail-first from docs/briefs/1052-design-so1049.md
// ("Temuan 1", "Bukti") and the sibling tests payroll-payout-1038-evidence-clearance
// / -concurrent, NOT from the implementation.
//
// The holes (brief):
// (A) Run 1 snapshots without a flag. Meanwhile run 2 records mismatch X and two
//     people clear the flag. The file recovers and run 1 reads `ok`, but run 1 drops
//     the `ok` (its snapshot says "not flagged"). The file breaks as X again: X is
//     the last row, nothing is recorded, the fingerprint is the same, and the OLD
//     clearance releases the slip. Founder rule: when in doubt hold the payment.
// (B) Read order and record order can swap between two runs (run 1 reads `missing`,
//     run 2 reads `ok`, run 2 records first, run 1 records later): the stale
//     `missing` becomes the last observation although the file is ok.
//
// Oracle (the rule from the brief, not the implementation): the observation
// history must equal the FOLD OF THE READS IN READ ORDER, with the table's own
// rules: an `ok` with no earlier row is dropped, a state equal to the last row is
// not recorded again. A test-owned storage wrapper logs every read of the proof
// key, so the oracle needs no knowledge of how the service is built.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Racing is simulated with a storage wrapper over the fixture storage handed to
//   the REAL night run (reconcileTrustedPayouts(context, {storage, after}), paged
//   as the 905/1038 tests). A run is held inside `storage.get` of ONE proof key,
//   after its snapshot, until the test releases it.
// - (A) is deterministic: two worlds (two operations). The held run is stuck at
//   the read of Y (the operation with the smaller id, read first: paging is
//   ascending operation id, checked by a setup guard). Run 2 pages `after` Y
//   (the paging cursor is `correction:<operation id>`), so it
//   never waits for a lock run 1 holds on Y. Operation ids are learned from a
//   throwaway run that flags both items; its flags and observations are wiped.
//   The slip must be held after X breaks again: no conditional branch.
// - (B) holds run 1 at the read of the only key, content `missing` decided at the
//   start. Before the fix run 2 overtakes; after the fix it queues behind the lock,
//   so the test waits for "run 2 finished OR waits on a lock" (pg_locks polling, no
//   fixed sleeps). The oracle is the fold of the reads in read order, with the
//   table's rules: an `ok` with no earlier row is dropped, a state equal to the
//   last row is not recorded again. B's flag is in the snapshot already; A is the
//   test of the stale snapshot.
// - (C) one batch, two items, two correct-failed operations; the API refuses a
//   shared key (409 PAYOUT_PROOF_REUSED) and the corrections table has a unique
//   (tenant_id, evidence_key); so the owner lifts that guard for the test (restored
//   in a finally) and rewrites the second operation's proposal,
//   attestations and grants are rewritten to the first one's key and hashes by the
//   table owner (guards off). The first read of the key returns ok and the
//   file breaks right after it. Every operation that recorded mismatch X must be
//   flagged in the same run (state per operation, or mismatch beats ok when keys
//   are merged: doubt holds the slip).
// - In (C) the rewrite leaves the binding and audit rows of the second operation on
//   its old key, so the run also raises binding_mismatch / audit_mismatch for the
//   items: they are not evidence flags and are ignored; the assertions of (C) look
//   at the evidence_hash_mismatch flag of the operation that recorded X.
// - "Held" = app.payout_payslip_held_by_recon(tenant, payslip).
// - Observation columns as in 1038: tenant_id, operation_id, state
//   ('missing'|'mismatch'|'ok'), observed_at. Only `state` is compared, X is the
//   only mismatch byte string used.
// - Observation and sighting tables are append-only; cleanup is done by the table
//   owner with guards off.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  bank,
  BUDI,
  SITI,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1052ord");
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
const ATTESTATIONS = "payroll_payout_attestations";
const CORRECTIONS = "payroll_payout_failed_corrections";
const BYTES_X = "1052 order proof bytes X";

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
    [W.tenantId, `Template ${key} 1052ord`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Order1052 ${label}`);
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

// ---- The recon over a storage the test controls --------------------------------------------

type ProofState = "ok" | "missing" | "mismatch";
/** What each proof file is NOW (test-controlled); a key not set is ok. */
const fileStates = new Map<string, ProofState>();
const stateOf = (key: string): ProofState => fileStates.get(key) ?? "ok";
const setFile = (key: string, state: ProofState) => {
  fileStates.set(key, state);
};
/** Every read of a proof key of the test, in read order, over all runs. */
const reads: { key: string; state: ProofState }[] = [];
const readsOf = (key: string) =>
  reads.filter((r) => r.key === key).map((r) => r.state);

type Gate = {
  key: string;
  /** The content is decided when the read STARTS when given, else when it returns. */
  stateAtStart?: ProofState;
  /** Resolved when the held run is inside the read of `key`. */
  reached: Promise<void>;
  release: () => void;
  signalReached: () => void;
  released: Promise<void>;
};
function makeGate(key: string, stateAtStart?: ProofState): Gate {
  let signalReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (signalReached = r));
  const released = new Promise<void>((r) => (release = r));
  return { key, stateAtStart, reached, release, released, signalReached };
}

type RunOptions = {
  /** Hold the run inside the first read of `hold.key` (after its snapshot). */
  hold?: Gate;
  /** Start the paging after this operation id (skips every operation up to it). */
  after?: string;
  /** Called with the state each read decided, before the content is returned. */
  afterRead?: (key: string, nth: number, state: ProofState) => void;
};

async function runRecon(options: RunOptions = {}) {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = [
    "reconcileTrustedPayouts",
    "runTrustedPayoutRecon",
    "runPayoutRecon",
  ].find((n) => typeof mod[n] === "function");
  expect(name, "the recon service exports the night run").toBeDefined();
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  const base = W.proofs().storage;
  const { hold } = options;
  let held = false;
  const nth = new Map<string, number>();
  const storage = {
    async get(context: unknown, input: { key: string }) {
      let state = stateOf(input.key);
      if (hold && !held && input.key === hold.key) {
        held = true;
        if (hold.stateAtStart) {
          state = hold.stateAtStart;
          reads.push({ key: input.key, state });
        }
        hold.signalReached();
        await hold.released;
        if (!hold.stateAtStart) {
          state = stateOf(input.key);
          reads.push({ key: input.key, state });
        }
      } else {
        reads.push({ key: input.key, state });
      }
      const count = (nth.get(input.key) ?? 0) + 1;
      nth.set(input.key, count);
      options.afterRead?.(input.key, count, state);
      if (state === "missing")
        throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
      const real = await (
        base.get as (c: unknown, i: unknown) => Promise<Record<string, unknown>>
      )(context, input);
      return state === "mismatch" ? { ...real, content: BYTES_X } : real;
    },
  };
  let after: string | null = options.after ?? null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}
/** A run that never rejects: the failure (if any) is returned. */
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => String(error),
  );

/** True while another backend of this database waits on any lock. */
async function someoneWaitsOnALock() {
  const [row] = await W.rowsOf(
    `SELECT count(*)::int AS n
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND l.pid <> pg_backend_pid()
        AND a.datname = current_database()`,
  );
  return (row!.n as number) > 0;
}
/** Resolves "done" when `run` settled, "blocked" when a run waits on a lock. Condition polling, hard cap only against a hang. */
async function doneOrBlocked(run: Promise<string | null>) {
  let settled = false;
  void run.then(() => (settled = true));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (settled) return "done" as const;
    if (await someoneWaitsOnALock()) return "blocked" as const;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("neither finished nor waits on a lock");
}

/** The history the brief demands: the fold of the reads in read order. */
function expectedHistory(log: ProofState[]) {
  const rows: ProofState[] = [];
  for (const state of log) {
    const last = rows[rows.length - 1];
    if (state === "ok" && last === undefined) continue; // no earlier row: dropped
    if (last === state) continue; // same as the last row: not recorded again
    rows.push(state);
  }
  return rows;
}

// ---- Worlds: real corrected items with a stored proof ---------------------------------------

type Person0 = typeof BUDI;

async function correctFailed(
  batchId: string,
  itemId: string,
  key: string,
  label: string,
) {
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
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
    expect([200, 201], `${label}: correct-failed ${detail(res)}`).toContain(
      res.status,
    );
  }
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, `${label}: premise: corrected`).toBe("succeeded");
}

async function correctedWorld(person: Person0 = BUDI) {
  const slips = [bank(person, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  const key = uploadEvidence(batchId, `order1052-${randomUUID()}.pdf`);
  await correctFailed(batchId, itemId, key, "world");
  return { batchId, itemId, key };
}
type World = Awaited<ReturnType<typeof correctedWorld>>;

/**
 * One batch, two items, TWO operations that share ONE evidence key. The API refuses
 * to reuse a key (409 PAYOUT_PROOF_REUSED), so the second correction is made with its
 * own key and then rewritten by the table owner (guards off, as the 911 tests do) to
 * the key and hashes of the first: proposal, attestations and grants.
 */
async function sharedKeyWorld() {
  const slips = [bank(BUDI, NET), bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  expect(itemIds, "premise: two items").toHaveLength(2);
  const key = uploadEvidence(batchId, `order1052-shared-${randomUUID()}.pdf`);
  const other = uploadEvidence(batchId, `order1052-other-${randomUUID()}.pdf`);
  await correctFailed(batchId, itemIds[0]!, key, "shared key, first");
  await correctFailed(batchId, itemIds[1]!, other, "shared key, second");
  const [first] = await W.rowsOf(
    `SELECT content_sha256, stored_sha256 FROM ${CORRECTIONS}
      WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
    [W.tenantId, batchId, key],
  );
  expect(first, "premise: the first correction record").toBeDefined();
  const [second] = await W.rowsOf(
    `SELECT id, content_sha256, stored_sha256 FROM ${CORRECTIONS} WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
    [W.tenantId, batchId, other],
  );
  expect(second, "premise: the second correction record").toBeDefined();
  // The table refuses two corrections on one key or one hash (unique
  // guards): the owner lifts them for this test and puts them back in `restore`.
  const guards = await W.rowsOf(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.conrelid = 'public.${CORRECTIONS}'::regclass AND c.contype = 'u'
        AND (pg_get_constraintdef(c.oid) ILIKE '%evidence_key%'
          OR pg_get_constraintdef(c.oid) ILIKE '%_sha256%')`,
  );
  const indexes = await W.rowsOf(
    `SELECT i.indexname AS name, i.indexdef AS def FROM pg_indexes i
      WHERE i.schemaname = 'public' AND i.tablename = '${CORRECTIONS}'
        AND i.indexdef ILIKE 'CREATE UNIQUE%'
        AND (i.indexdef ILIKE '%evidence_key%' OR i.indexdef ILIKE '%_sha256%')
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                         WHERE c.conrelid = 'public.${CORRECTIONS}'::regclass
                           AND c.conname = i.indexname)`,
  );
  expect(
    guards.length + indexes.length,
    "premise: unique guards on the evidence key",
  ).toBeGreaterThan(0);
  const owner = await W.owner.connect();
  const restore = async () => {
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query(
        `UPDATE ${CORRECTIONS} SET evidence_key = $2, content_sha256 = $4, stored_sha256 = $5
          WHERE tenant_id = $1 AND id = $3`,
        [
          W.tenantId,
          other,
          second!.id,
          second!.content_sha256,
          second!.stored_sha256,
        ],
      );
      await owner.query("COMMIT");
      for (const g of guards)
        await owner.query(
          `ALTER TABLE ${CORRECTIONS} ADD CONSTRAINT ${g.name} ${g.def}`,
        );
      for (const i of indexes) await owner.query(String(i.def));
    } finally {
      owner.release();
    }
  };
  try {
    for (const g of guards)
      await owner.query(`ALTER TABLE ${CORRECTIONS} DROP CONSTRAINT ${g.name}`);
    for (const i of indexes) await owner.query(`DROP INDEX public.${i.name}`);
    await W.asTenant(async (c) => {
      const proposal = await c.query(
        `UPDATE ${CORRECTIONS}
            SET evidence_key = $3, content_sha256 = $4, stored_sha256 = $5
          WHERE tenant_id = $1 AND id = $2`,
        [
          W.tenantId,
          second!.id,
          key,
          first!.content_sha256,
          first!.stored_sha256,
        ],
      );
      expect(proposal.rowCount, "premise: second correction moved").toBe(1);
      await c.query(
        `UPDATE ${ATTESTATIONS} SET evidence_key = $3
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction' AND evidence_key = $4`,
        [W.tenantId, batchId, key, other],
      );
      await c.query(
        `UPDATE ${GRANTS} SET evidence_key = $2 WHERE tenant_id = $1 AND evidence_key = $3`,
        [W.tenantId, key, other],
      );
    }, true);
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
  return { batchId, itemIds, key, restore };
}

async function untouchedRun(itemIds: string[]) {
  await runRecon();
  for (const itemId of itemIds) {
    const rows = await exceptionRows(itemId);
    expect(
      rows
        .map((r) => String(r.reason))
        .filter((r) => r.startsWith("evidence_")),
      "control: an untouched corrected item has no evidence flag",
    ).toEqual([]);
  }
}

const evidenceFlagOf = async (itemId: string) =>
  (await exceptionRows(itemId)).find((f) =>
    String(f.reason).includes("evidence_hash_mismatch"),
  );

/** Wipes flags, clearances, observations and sightings of the tenant (owner, guards off). */
async function resetRecon() {
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
}

/** The proof turns into mismatch X, one real run flags it. */
async function flaggedByMismatch(w: World) {
  setFile(w.key, "mismatch");
  await runRecon();
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the real run flagged the item",
  ).toBeGreaterThan(0);
  const evidenceFlag = await evidenceFlagOf(w.itemId);
  expect(evidenceFlag, "premise: an evidence_hash_mismatch flag").toBeDefined();
  const payslipId = flags[0]!.payslip_id as string;
  expect(await heldBySql(payslipId), "premise: the flag holds the slip").toBe(
    true,
  );
  return {
    flagIds: flags.map((f) => f.id as string),
    operationId: evidenceFlag!.operation_id as string,
    payslipId,
  };
}

/** Operation ids of the evidence of two worlds, learned from a throwaway flagging run (then wiped). */
async function operationIdsOf(a: World, b: World) {
  setFile(a.key, "mismatch");
  setFile(b.key, "mismatch");
  await runRecon();
  const ops: Record<string, string> = {};
  for (const w of [a, b]) {
    const flag = await evidenceFlagOf(w.itemId);
    expect(flag, "premise: the probe run flagged the item").toBeDefined();
    ops[w.key] = flag!.operation_id as string;
  }
  setFile(a.key, "ok");
  setFile(b.key, "ok");
  await resetRecon();
  reads.length = 0;
  return ops;
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
  fileStates.clear();
  reads.length = 0;
  await resetRecon();
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
// (A) A run with a stale snapshot reads `ok` after the clearance
// =========================================================================

describe("1052 evidence order (A): a stale snapshot must not swallow the recovery", () => {
  it("[1052-stale-snapshot-recovery-then-x-again-holds] run 1 is held at another operation Y with a snapshot that has no flag; run 2 records X and two people clear it; the file recovers; run 1 reads X as ok; X breaks again: the slip is held until a new clearance", async () => {
    const w1 = await correctedWorld(BUDI);
    const w2 = await correctedWorld(SITI);
    await untouchedRun([w1.itemId, w2.itemId]);
    // Y = the operation the run reads first, X = the other one. The paging order
    // is ascending operation id (assumption), so Y has the smaller id and run 2
    // can start after Y: it never touches Y, whatever lock run 1 holds there.
    const ops = await operationIdsOf(w1, w2);
    const [y, x] = ops[w1.key]! < ops[w2.key]! ? [w1, w2] : [w2, w1];

    // Run 1: snapshot taken (nothing flagged), held inside the read of Y.
    const gate = makeGate(y.key);
    const run1 = settle(runRecon({ hold: gate }));
    const first = await Promise.race([
      gate.reached.then(() => "held" as const),
      run1.then(() => "ended" as const),
    ]);
    expect(
      first,
      "setup: run 1 must reach the read of Y before the read of X (paging order is ascending operation id)",
    ).toBe("held");

    // Run 2 (the rest of the page after Y) sees X broken and records it. Two people clear the flag.
    setFile(x.key, "mismatch");
    expect(
      await settle(runRecon({ after: `correction:${ops[y.key]!}` })),
      "run 2 finishes",
    ).toBeNull();
    const flagged = await exceptionRows(x.itemId);
    expect(flagged.length, "premise: run 2 flagged X").toBeGreaterThan(0);
    const payslipId = flagged[0]!.payslip_id as string;
    for (const f of flagged) await clearFlag(f.id as string);
    expect(await heldBySql(payslipId), "premise: cleared is free").toBe(false);

    // The file recovers; run 1 is released and reads X as ok.
    setFile(x.key, "ok");
    gate.release();
    expect(await run1, "run 1 finishes").toBeNull();
    expect(
      readsOf(x.key).slice(-1),
      "premise: the last read of X is ok",
    ).toEqual(["ok"]);

    // X breaks again: one more real run.
    setFile(x.key, "mismatch");
    await runRecon();

    expect(
      await heldBySql(payslipId),
      "the old clearance must not release the slip after the file recovered and broke again",
    ).toBe(true);
    expect(
      await observedStates(ops[x.key]!),
      "the recovery was recorded although run 1 had no flag in its snapshot",
    ).toEqual(["mismatch", "ok", "mismatch"]);
    // Held until a NEW clearance, then free.
    for (const f of await exceptionRows(x.itemId))
      await clearFlag(f.id as string);
    expect(await heldBySql(payslipId), "a new clearance frees it").toBe(false);
  });
});

// =========================================================================
// (B) Read order and record order swapped between two runs
// =========================================================================

describe("1052 evidence order (B): a late record must not make a stale observation the last", () => {
  it("[1052-swapped-read-record-order] run 1 reads missing, run 2 then reads ok, run 2 records first: the last observation is ok, not the stale missing", async () => {
    const w = await correctedWorld();
    await untouchedRun([w.itemId]);
    const flagged = await flaggedByMismatch(w); // a non-ok row exists: ok is recordable
    setFile(w.key, "ok"); // the file has recovered; nobody has seen it yet

    // Run 1 read `missing` (decided when its read starts) but records late.
    const gate = makeGate(w.key, "missing");
    const run1 = settle(runRecon({ hold: gate }));
    await gate.reached;

    // Run 2 reads the file as it is now: ok. Before the fix it overtakes; after
    // the fix it queues behind the lock run 1 holds while reading.
    const run2 = settle(runRecon());
    const outcome = await doneOrBlocked(run2);
    gate.release();
    expect(await run1, "run 1 finishes").toBeNull();
    expect(await run2, `run 2 finishes (${outcome})`).toBeNull();

    const states = await observedStates(flagged.operationId);
    expect(
      states,
      `observation history equals the reads in read order (reads: ${readsOf(w.key).join(", ")})`,
    ).toEqual(expectedHistory(readsOf(w.key)));
    expect(
      states[states.length - 1],
      "the file is ok now: the stale missing must not be the last observation",
    ).toBe("ok");
  });
});

// =========================================================================
// (C) Two operations share one evidence key (P3-1 of the architect, round 1)
// =========================================================================

describe("1052 evidence order (C): two operations that share an evidence key are judged each on their own read", () => {
  it("[1052-shared-key-per-operation] the first operation reads ok, the file breaks, the second reads mismatch X: the operation that recorded X is flagged in the same run and its slip is held", async () => {
    const w = await sharedKeyWorld();
    try {
      await untouchedRun(w.itemIds);

      // The file is ok for the first read of the key and broken for every later one.
      setFile(w.key, "ok");
      await runRecon({
        afterRead: (key, nth) => {
          if (key === w.key && nth === 1) setFile(w.key, "mismatch");
        },
      });

      const mismatchOps = (
        await W.rowsOf(
          `SELECT DISTINCT operation_id FROM ${OBSERVATIONS}
          WHERE tenant_id = $1 AND state = 'mismatch'`,
          [W.tenantId],
        )
      ).map((r) => r.operation_id as string);
      expect(
        mismatchOps.length,
        "premise: an operation recorded the broken file",
      ).toBeGreaterThan(0);

      const flags = (
        await Promise.all(w.itemIds.map((id) => exceptionRows(id)))
      ).flat();
      for (const operationId of mismatchOps) {
        const own = flags.filter(
          (f) =>
            f.operation_id === operationId &&
            String(f.reason).includes("evidence_hash_mismatch"),
        );
        expect(
          own.length,
          `the operation ${operationId} recorded mismatch X, so its item must be flagged in this very run (not one cycle later)`,
        ).toBeGreaterThan(0);
        expect(
          await heldBySql(own[0]!.payslip_id as string),
          "its slip is held",
        ).toBe(true);
      }
    } finally {
      await w.restore();
    }
  });
});
