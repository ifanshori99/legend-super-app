// Payout legend-tiw2h (tier K: money): an ordinary caller can never turn a hold
// by a read error into a release. Only a fresh recon read can.
// Written from docs/briefs/tiw2h-recon-clearance-restriktif.md (rule and design as
// the CTO decided them), NOT from the implementation. Scaffolding follows
// payroll-payout-1057-clearance-stale-evidence.test.ts (same fixture world).
//
// The attack: mismatch A (seq10) -> two-person clearance -> read error (seq11).
// The slip is held. An ordinary legend_app caller then reports
// observe(tenant, op, 'mismatch', sha(A)) (or 'missing' for a missing episode):
// the error row is ignored by the run logic, so the fingerprint returns to the
// cleared one and the slip is freed without any storage read.
//
// Rule: a caller other than legend_payout_recon may never change a slip from
// held to free. After a read error, only the recon role records a problem read
// (app.payout_recon_evidence_observe_difference) or an ok read (observe_ok).
//
// Assumptions (stated so they can be contested):
// - A refused call: SQLSTATE 42501 with PAYOUT-92 in the message (the brief names
//   both for the ordinary-caller refusals). Refused also means: no observation
//   row written, the slip hold and the live flag fingerprint unchanged.
// - The `_difference` role checks assert only the PAYOUT code in the message
//   (92 for a state other than missing/mismatch, 68 for a mismatch without a
//   sha); no exact SQLSTATE except 42501 for "permission denied" (no SET ROLE).
// - After a fresh recon read of mismatch A identical to the cleared bytes the
//   brief only says it "may record". Whether that frees the slip is not asserted
//   (an identical fresh read of what two people cleared plausibly frees it).
//   A fresh recon read of OTHER bytes or `missing` holds the slip: asserted.
// - The race (d) is exercised with two connections: the first holds the
//   per-operation lock inside an open transaction (its ordinary error report);
//   the second (ordinary mismatch A) is shown to be waiting on an advisory lock
//   by polling pg_locks, then the first commits. The check being inside the lock
//   is also checked on the function definitions (pg_get_functiondef): the
//   by-recon test comes after the advisory lock. Both rely on the observe
//   functions taking a transaction-level advisory lock (brief design item 1).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
import * as recon from "../services/payroll-payout-recon.service.ts";
import { originHeader } from "./helpers.ts";
import {
  bank,
  BUDI,
  APP,
  APP3,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("tiw2h");
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
const BYTES_A = "tiw2h tampered proof bytes A";
const BYTES_B = "tiw2h tampered proof bytes B (different)";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// ---- People (HTTP, TOTP enrolled in this very session) --------------------------------------

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
    [W.tenantId, `Template ${key} tiw2h`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Tiw2h ${label}`);
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

// ---- HTTP -----------------------------------------------------------------------------------

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
async function clearFlag(flagId: string, reason = REASON) {
  const proposed = await proposeHttp(proposer, flagId, reason);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- Raw SQL (legend_app / legend_payout_recon) ---------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** legend_app, one statement, real COMMIT. */
async function appCall(
  sqlText: string,
  params: unknown[] = [],
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      const result = await client.query(sqlText, params);
      await client.query("COMMIT");
      return { code: undefined, message: "", rows: result.rows as Row[] };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "", rows: [] };
    }
  } finally {
    client.release();
  }
}

/** legend_app switches to legend_payout_recon (what the recon helpers do), real COMMIT. */
async function reconRoleCall(
  sqlText: string,
  params: unknown[] = [],
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      await client.query("SET LOCAL ROLE legend_payout_recon");
      const result = await client.query(sqlText, params);
      await client.query("COMMIT");
      return { code: undefined, message: "", rows: result.rows as Row[] };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "", rows: [] };
    }
  } finally {
    client.release();
  }
}

/** The trusted observe function as an ordinary legend_app caller, real COMMIT. */
const observeOwn = (operationId: string, state: string, sha: string | null) =>
  appCall(
    `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, $3::text, $4::text)`,
    [W.tenantId, operationId, state, sha],
  );
/** An ok read as the recon job records it (SET LOCAL ROLE legend_payout_recon inside the tenant transaction). */
const readOk = (operationId: string) =>
  W.inTx((tx) => recon.recordReadOk(tx, W.tenantId, operationId));
/** A problem read (missing / mismatch) as the recon job records it. */
const readProblem = (
  operationId: string,
  state: "missing" | "mismatch",
  sha: string | null,
) =>
  W.inTx((tx) =>
    recon.recordProblemRead(tx, W.tenantId, operationId, state, sha),
  );
const DIFFERENCE_SQL = `SELECT app.payout_recon_evidence_observe_difference($1::uuid, $2::uuid, $3::text, $4::text)`;

// ---- Observations ---------------------------------------------------------------------------

async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
const observationsOf = (operationId: string) =>
  W.rowsOf(
    `SELECT * FROM ${OBSERVATIONS} WHERE tenant_id = $1 AND operation_id = $2
      ORDER BY observed_at, id`,
    [W.tenantId, operationId],
  );
const clearanceIds = async () =>
  (
    await W.rowsOf(
      `SELECT id FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1 ORDER BY id`,
      [W.tenantId],
    )
  ).map((r) => r.id as string);
/** The live fingerprint of every flag of the episode (what a clearance is bound to). */
const fingerprintsOf = async (flagIds: string[]) => {
  const out: string[] = [];
  for (const id of flagIds)
    out.push(
      (
        await W.rowsOf(
          `SELECT app.payout_recon_flag_fingerprint($1::uuid, $2::uuid) AS fp`,
          [W.tenantId, id],
        )
      )[0]!.fp as string,
    );
  return out;
};
const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );

// ---- The recon over a storage the test controls ----------------------------------------------

type ProofState = string | "missing" | "invalid";
const bytesOf = new Map<string, ProofState>();
const setProof = (key: string, bytes: ProofState) => bytesOf.set(key, bytes);

async function runRecon() {
  const mod = recon as unknown as Record<string, unknown>;
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
  const storage = {
    async get(context: unknown, input: { key: string }) {
      const override = bytesOf.get(input.key);
      if (override === "missing")
        throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
      // A storage fault that is not "not found".
      if (override === "invalid") throw new Error("Invalid stored object");
      const real = await (
        base.get as (c: unknown, i: unknown) => Promise<Record<string, unknown>>
      )(context, input);
      return override === undefined ? real : { ...real, content: override };
    },
  };
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- World: a real corrected item with a stored proof ----------------------------------------

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evidtiw2h-${randomUUID()}.pdf`);
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
  await runRecon();
  expect(
    await exceptionRows(itemId),
    "control: an untouched corrected item is not flagged",
  ).toHaveLength(0);
  return { runId, batchId, itemId, key };
}
type World = Awaited<ReturnType<typeof correctedWorld>>;

/** The proof turns into `bytes` (or goes missing), the real run flags it. Returns the flags. */
async function flaggedByEvidence(
  w: World,
  bytes: ProofState,
  reason: "evidence_hash_mismatch" | "evidence_missing",
) {
  setProof(w.key, bytes);
  await runRecon();
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the real run flagged the item",
  ).toBeGreaterThan(0);
  expect(
    flags.some((f) => String(f.reason).includes(reason)),
    `premise: a ${reason} flag: ${JSON.stringify(flags.map((f) => f.reason))}`,
  ).toBe(true);
  const payslipId = flags[0]!.payslip_id as string;
  expect(await heldBySql(payslipId), "premise: the flag holds the slip").toBe(
    true,
  );
  return {
    flagIds: flags.map((f) => f.id as string),
    operationId: flags.find((f) => String(f.reason).includes(reason))!
      .operation_id as string,
    payslipId,
  };
}
type Flagged = Awaited<ReturnType<typeof flaggedByEvidence>>;

const clearAll = async (f: Flagged, reason = REASON) => {
  for (const id of f.flagIds) await clearFlag(id, reason);
  expect(await heldBySql(f.payslipId), "premise: cleared is free").toBe(false);
};

/**
 * Evidence `first` (mismatch A or missing) flagged and cleared by two people, then
 * an unreadable proof (a read error) holds the slip: the state the attack starts from.
 */
async function heldByError(
  first: string = BYTES_A,
  reason:
    "evidence_hash_mismatch" | "evidence_missing" = "evidence_hash_mismatch",
) {
  const w = await correctedWorld();
  const flagged = await flaggedByEvidence(w, first, reason);
  await clearAll(flagged);
  setProof(w.key, "invalid");
  await runRecon().catch(() => undefined);
  expect(await heldBySql(flagged.payslipId), "premise: held by error").toBe(
    true,
  );
  return { w, flagged };
}

/** Everything an attempt may not change, taken before and compared after a refusal. */
async function stateOf(flagged: Flagged) {
  return {
    held: await heldBySql(flagged.payslipId),
    fingerprints: await fingerprintsOf(flagged.flagIds),
    observations: (await observationsOf(flagged.operationId)).length,
    clearances: await clearanceIds(),
  };
}

// ---- Setup / teardown ------------------------------------------------------------------------

async function dropAppendOnly() {
  await W.asTenant(async (c) => {
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
  bytesOf.clear();
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
// a, b: the attack is refused
// =========================================================================

describe("tiw2h: an ordinary caller cannot free a slip held by a read error", () => {
  it("[tiw2h-a-mismatch-after-error-refused] mismatch A cleared, then an error: observe(mismatch, sha(A)) by an ordinary caller without any storage read is refused (PAYOUT-92); the slip stays held, nothing is recorded", async () => {
    const { flagged } = await heldByError();
    const [first] = await observationsOf(flagged.operationId);
    const shaA = first!.observed_sha256 as string;
    expect(shaA, "premise: A was observed with its sha").toBe(sha256(BYTES_A));
    const before = await stateOf(flagged);

    const res = await observeOwn(
      flagged.operationId,
      "mismatch",
      sha256(BYTES_A),
    );

    expect(
      await heldBySql(flagged.payslipId),
      "the slip stays held: the ordinary call freed nothing",
    ).toBe(true);
    expect(res.code, `refused: ${res.message}`).toBe("42501");
    expect(res.message).toMatch(/PAYOUT-92/);
    expect(await stateOf(flagged), "no observation, same fingerprint").toEqual(
      before,
    );
  });

  it("[tiw2h-b-missing-after-error-refused] missing episode cleared, then an error: observe(missing) by an ordinary caller is refused (PAYOUT-92); the slip stays held, nothing is recorded", async () => {
    const { flagged } = await heldByError("missing", "evidence_missing");
    const before = await stateOf(flagged);

    const res = await observeOwn(flagged.operationId, "missing", null);

    expect(
      await heldBySql(flagged.payslipId),
      "the slip stays held: the ordinary call freed nothing",
    ).toBe(true);
    expect(res.code, `refused: ${res.message}`).toBe("42501");
    expect(res.message).toMatch(/PAYOUT-92/);
    expect(await stateOf(flagged), "no observation, same fingerprint").toEqual(
      before,
    );
  });

  it("[tiw2h-a-any-problem-read-after-error-refused] after an error an ordinary caller cannot record any missing/mismatch, whatever the bytes (A, other bytes, missing)", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);
    for (const [state, sha] of [
      ["mismatch", sha256(BYTES_A)],
      ["mismatch", sha256(BYTES_B)],
      ["missing", null],
    ] as const) {
      const res = await observeOwn(flagged.operationId, state, sha);
      expect(res.code, `${state}: ${res.message}`).toBe("42501");
      expect(res.message, state).toMatch(/PAYOUT-92/);
    }
    expect(await stateOf(flagged), "nothing changed").toEqual(before);
  });
});

// =========================================================================
// c: only a fresh recon read records or frees
// =========================================================================

describe("tiw2h: only a fresh recon read records a problem or frees the slip", () => {
  it("[tiw2h-c-recon-ok-frees-old-clearance] after the refused attack the recon's ok read still frees the slip by the old clearance; no new clearance", async () => {
    const { flagged } = await heldByError();
    const clearancesBefore = await clearanceIds();
    const refused = await observeOwn(
      flagged.operationId,
      "mismatch",
      sha256(BYTES_A),
    );
    expect(refused.code, "premise: the attack is refused").toBe("42501");
    expect(await heldBySql(flagged.payslipId), "premise: still held").toBe(
      true,
    );

    await readOk(flagged.operationId);

    expect(
      await heldBySql(flagged.payslipId),
      "only the fresh recon read frees the slip",
    ).toBe(false);
    expect(await clearanceIds(), "recovery used the old clearance").toEqual(
      clearancesBefore,
    );
  });

  it("[tiw2h-c-recon-problem-read-records] after the refused attack the recon path records a problem read: other bytes hold the slip with a new observation and a new fingerprint", async () => {
    const { flagged } = await heldByError();
    const refused = await observeOwn(
      flagged.operationId,
      "mismatch",
      sha256(BYTES_A),
    );
    expect(refused.code, "premise: the attack is refused").toBe("42501");
    const before = await stateOf(flagged);

    await readProblem(flagged.operationId, "mismatch", sha256(BYTES_B));

    const after = await stateOf(flagged);
    expect(after.observations, "recorded").toBe(before.observations + 1);
    expect(after.held, "other bytes: held").toBe(true);
    expect(after.fingerprints, "a new episode, a new fingerprint").not.toEqual(
      before.fingerprints,
    );
    expect(after.clearances, "no clearance touched").toEqual(before.clearances);
  });

  it("[tiw2h-c-recon-identical-mismatch-records] the recon path may record mismatch A identical to the cleared bytes after an error (it is a fresh read): the observation is written, no clearance is touched", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);

    await readProblem(flagged.operationId, "mismatch", sha256(BYTES_A));

    const after = await stateOf(flagged);
    expect(after.observations, "recorded").toBe(before.observations + 1);
    expect(after.clearances, "no clearance touched").toEqual(before.clearances);
  });

  it("[tiw2h-c-recon-missing-read-records] on a missing episode the recon path records `missing` after an error: the observation is written, no clearance is touched", async () => {
    const { flagged } = await heldByError("missing", "evidence_missing");
    const before = await stateOf(flagged);

    await readProblem(flagged.operationId, "missing", null);

    const after = await stateOf(flagged);
    expect(after.observations, "recorded").toBe(before.observations + 1);
    expect(after.clearances, "no clearance touched").toEqual(before.clearances);
  });

  it("[tiw2h-c-night-run-other-bytes-hold] the real night run is a fresh recon read: other bytes after the error are recorded and hold the slip", async () => {
    const { w, flagged } = await heldByError();
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "other bytes read by the recon after the error: held",
    ).toBe(true);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "the recon recorded its problem read",
    ).toBeGreaterThanOrEqual(3);
  });
});

// =========================================================================
// d: the check is inside the per-operation lock
// =========================================================================

describe("tiw2h: the check happens inside the lock", () => {
  it("[tiw2h-d-race-error-lands-while-caller-waits] an ordinary mismatch A waits behind an ordinary error on the same operation; once the error commits it is refused", async () => {
    // Cleared slip: the last observation is mismatch A, no error yet.
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const rowsBefore = (await observationsOf(flagged.operationId)).length;

    const open = async () => {
      const client = await W.owner.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      await client.query("SET LOCAL lock_timeout = '30s'");
      return client;
    };
    const first = await open();
    const second = await open();
    try {
      // The first caller reports an error and keeps its transaction (and the lock) open.
      await first.query(
        `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, 'error', NULL)`,
        [W.tenantId, flagged.operationId],
      );
      const secondPid = (
        await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;

      // The second caller tries mismatch A and has to wait for the lock.
      const secondOutcome = second
        .query(
          `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, 'mismatch', $3::text)`,
          [W.tenantId, flagged.operationId, sha256(BYTES_A)],
        )
        .then(
          () => ({ code: undefined as string | undefined, message: "" }),
          (error: { code?: string; message?: string }) => ({
            code: error.code ?? "unknown",
            message: error.message ?? "",
          }),
        );

      // Wait until the second backend is really queued behind an advisory lock.
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i += 1) {
        const rows = (
          await W.owner.query(
            `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
            [secondPid],
          )
        ).rows;
        waiting = rows.length > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        waiting,
        "premise: the second observe call queues on the per-operation advisory lock",
      ).toBe(true);

      await first.query("COMMIT");
      const result = await secondOutcome;
      expect(
        result.code,
        `refused once the error is visible: ${result.message}`,
      ).toBe("42501");
      expect(result.message).toMatch(/PAYOUT-92/);
      await second.query("ROLLBACK");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }

    expect(
      await heldBySql(flagged.payslipId),
      "the slip stays held: the waiting caller freed nothing",
    ).toBe(true);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "only the error was recorded",
    ).toBe(rowsBefore + 1);
  });

  it("[tiw2h-d-check-after-lock-in-definition] in the internal function the by-recon checks come after the advisory lock; the wrapper passes false and carries no check of its own for the error rule", async () => {
    const defs = await W.owner.query<{
      proname: string;
      args: string;
      def: string;
    }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('payout_recon_evidence_observe_internal',
                            'payout_recon_evidence_observe',
                            'payout_recon_evidence_observe_ok',
                            'payout_recon_evidence_observe_difference')`,
    );
    const byName = (name: string) =>
      defs.rows.filter((r) => r.proname === name);
    const internal = byName("payout_recon_evidence_observe_internal");
    expect(internal, "exactly one internal function").toHaveLength(1);
    expect(
      internal[0]!.args,
      "the internal function takes the by-recon flag as its fifth argument",
    ).toMatch(/boolean/i);
    const def = internal[0]!.def;
    const lockAt = def.search(/pg_advisory/i);
    expect(
      lockAt,
      "the internal function takes an advisory lock",
    ).toBeGreaterThan(-1);
    const checks = [...def.matchAll(/NOT\s+p_by_recon/gi)].map((m) => m.index!);
    expect(
      checks.length,
      "the ok check and the problem-after-error check both test the by-recon flag",
    ).toBeGreaterThanOrEqual(2);
    for (const at of checks)
      expect(
        at,
        "each by-recon check comes after the advisory lock",
      ).toBeGreaterThan(lockAt);
    expect(def, "the problem-after-error check names the error state").toMatch(
      /'error'/,
    );

    const wrapper = byName("payout_recon_evidence_observe");
    expect(wrapper, "exactly one wrapper").toHaveLength(1);
    expect(wrapper[0]!.def, "the wrapper calls internal with false").toMatch(
      /payout_recon_evidence_observe_internal\s*\([^;]*\bfalse\b/i,
    );
    expect(
      byName("payout_recon_evidence_observe_ok")[0]!.def,
      "observe_ok calls internal with true",
    ).toMatch(/payout_recon_evidence_observe_internal\s*\([^;]*\btrue\b/i);
    expect(
      byName("payout_recon_evidence_observe_difference")[0]?.def,
      "difference calls internal with true",
    ).toMatch(/payout_recon_evidence_observe_internal\s*\([^;]*\btrue\b/i);
  });
});

// =========================================================================
// e: an ordinary caller may still only hold
// =========================================================================

describe("tiw2h: an ordinary caller can still only hold", () => {
  it("[tiw2h-e-ordinary-error-allowed] an ordinary caller can report 'error' (also twice in a row): recorded, the slip is held, no clearance touched", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await stateOf(flagged);

    const first = await observeOwn(flagged.operationId, "error", null);
    expect(first.code, first.message).toBeUndefined();
    expect(await heldBySql(flagged.payslipId), "held by the error").toBe(true);
    const second = await observeOwn(flagged.operationId, "error", null);
    expect(second.code, `error after error: ${second.message}`).toBeUndefined();
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
    const after = await stateOf(flagged);
    expect(after.observations, "recorded").toBeGreaterThan(before.observations);
    expect(after.clearances, "no clearance touched").toEqual(before.clearances);
  });

  for (const [state, sha] of [
    ["mismatch", sha256(BYTES_B)],
    ["missing", null],
  ] as const)
    it(`[tiw2h-e-ordinary-${state}-when-last-is-not-error-holds] when the last observation is not an error an ordinary caller can still report '${state}': a cleared slip is held at once with a new fingerprint, no clearance touched`, async () => {
      const w = await correctedWorld();
      const flagged = await flaggedByEvidence(
        w,
        BYTES_A,
        "evidence_hash_mismatch",
      );
      await clearAll(flagged);
      const before = await stateOf(flagged);

      const res = await observeOwn(flagged.operationId, state, sha);
      expect(res.code, res.message).toBeUndefined();

      const after = await stateOf(flagged);
      expect(after.held, `'${state}' holds the cleared slip`).toBe(true);
      expect(after.observations, "recorded").toBe(before.observations + 1);
      expect(
        after.fingerprints,
        "the fingerprint moved to the new episode",
      ).not.toEqual(before.fingerprints);
      expect(after.clearances, "no clearance touched").toEqual(
        before.clearances,
      );
    });

  it("[tiw2h-e-ordinary-ok-still-refused] an ordinary caller still cannot report 'ok' (PAYOUT-92) on a slip held by an error; nothing recorded", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);
    const res = await observeOwn(flagged.operationId, "ok", null);
    // Only "refused" is asserted for the wrapper's early 'ok' refusal (no exact SQLSTATE).
    expect(
      res.code,
      "observe('ok') raises for an ordinary caller",
    ).toBeDefined();
    expect(await stateOf(flagged)).toEqual(before);
  });
});

// =========================================================================
// f: the new recon-only function
// =========================================================================

describe("tiw2h: payout_recon_evidence_observe_difference is for the recon role only", () => {
  it("[tiw2h-f-difference-without-set-role-denied] legend_app calling it directly, without SET ROLE legend_payout_recon, gets permission denied; nothing changes", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);
    const denied = await appCall(DIFFERENCE_SQL, [
      W.tenantId,
      flagged.operationId,
      "mismatch",
      sha256(BYTES_A),
    ]);
    expect(denied.code, denied.message).toBe("42501");
    expect(denied.message).toMatch(/permission denied/i);
    expect(await stateOf(flagged)).toEqual(before);
  });

  for (const state of ["ok", "error"])
    it(`[tiw2h-f-difference-state-${state}-refused] through the recon role, state '${state}' is refused (PAYOUT-92); nothing recorded`, async () => {
      const { flagged } = await heldByError();
      const before = await stateOf(flagged);
      const res = await reconRoleCall(DIFFERENCE_SQL, [
        W.tenantId,
        flagged.operationId,
        state,
        null,
      ]);
      expect(res.code, `refused: ${res.message}`).toBeDefined();
      expect(res.message).toMatch(/PAYOUT-92/);
      expect(await stateOf(flagged)).toEqual(before);
    });

  it("[tiw2h-f-difference-mismatch-without-sha-refused] a mismatch without a sha is refused (PAYOUT-68); nothing recorded", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);
    const res = await reconRoleCall(DIFFERENCE_SQL, [
      W.tenantId,
      flagged.operationId,
      "mismatch",
      null,
    ]);
    expect(res.code, `refused: ${res.message}`).toBeDefined();
    expect(res.message).toMatch(/PAYOUT-68/);
    expect(await stateOf(flagged)).toEqual(before);
  });

  it("[tiw2h-f-difference-by-recon-role-records] through the recon role a mismatch is recorded even right after an error (raw SQL, as the helper does)", async () => {
    const { flagged } = await heldByError();
    const before = await stateOf(flagged);
    const res = await reconRoleCall(DIFFERENCE_SQL, [
      W.tenantId,
      flagged.operationId,
      "mismatch",
      sha256(BYTES_B),
    ]);
    expect(res.code, res.message).toBeUndefined();
    const after = await stateOf(flagged);
    expect(after.observations, "recorded").toBe(before.observations + 1);
    expect(after.held, "other bytes: held").toBe(true);
  });
});
