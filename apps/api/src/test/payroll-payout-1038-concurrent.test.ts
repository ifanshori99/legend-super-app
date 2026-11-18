// Payout 1038, concurrency of the recon clearance design
// (docs/briefs/1038-design-recon-clearance.md, "Desain temuan 4" and "temuan 7",
// "Bukti": "dua recon bersamaan"). Written from the brief and the sibling tests
// payroll-payout-1038-evidence-clearance.test.ts / -resolve-attestations-lost.test.ts,
// NOT from the implementation.
//
// Rules proven:
// (a) Two night runs at the same time over the same evidence problem: no error, ONE
//     observation row per change (not one per run), the fingerprint of the flag is
//     the same after the race as after a single run, and a clearance given for it
//     still releases the slip afterwards.
// (b) A clearance is proposed for mismatch A; the bytes change (B, or gone) at the
//     same moment as the approve. Either the approve is refused (409, PAYOUT-91) or
//     it wins and the run then reopens the flag. The slip is NEVER free at the end
//     (nobody cleared B), and a later run does not free it either.
// (c) Two night runs at the same time over a resolve whose attestations are gone
//     (finding 7): no error, no duplicate flag for the item, slip held.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - "At the same time" = Promise.all over two calls of the real night run
//   (reconcileTrustedPayouts), each paged as the 905/1038 tests do. The interleaving is
//   up to the database; the assertions hold for every interleaving.
// - In (b) the approve is the real HTTP route and the recon the real service call,
//   started in the same tick. The race outcome (approve first or recon first) is not
//   asserted, only the invariant: refused with 409, or approved and then reopened;
//   and never free with the old fingerprint.
// - "One observation per episode" = the rows of the operation are [mismatch/1] after
//   N concurrent runs of A, and [mismatch/1, mismatch/1] after A then N concurrent
//   runs of B (a change inside the episode is one row, not one per run).
// - No duplicate flag = no two rows of payroll_payout_recon_exceptions with the same
//   (operation_id, item_id, reason) for the item.
// - Observation and sighting tables are append-only; cleanup is done by the table
//   owner with guards off (the observation table may not exist yet).
import { createHash, randomUUID } from "node:crypto";
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
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1038conc");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const REASON = "Sudah dicek manual, berkas bukti sudah diperiksa ulang";
const SECOND_REASON =
  "Bukti berubah lagi, dicek ulang dari awal: berkas dan bank cocok";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const OBSERVATIONS = "payroll_payout_recon_evidence_observations";
const ATTESTATIONS = "payroll_payout_attestations";
const GRANTS = "payroll_payout_grants";
const BYTES_A = "1038 concurrent proof bytes A";
const BYTES_B = "1038 concurrent proof bytes B (different)";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

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
    [W.tenantId, `Template ${key} 1038conc`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Conc1038 ${label}`);
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
const listFlagsHttp = (who: Person) =>
  who.client.get(FLAGS) as unknown as Promise<Res>;

function findFlag(node: unknown, flagId: string): Row | undefined {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findFlag(entry, flagId);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const row = node as Row;
    if (row.id === flagId) return row;
    for (const value of Object.values(row)) {
      const found = findFlag(value, flagId);
      if (found) return found;
    }
  }
  return undefined;
}
async function reopenedOf(flagId: string) {
  const list = await listFlagsHttp(proposer);
  expect(list.status, detail(list)).toBe(200);
  const flag = findFlag(list.body, flagId);
  expect(flag, `the flag is listed: ${detail(list)}`).toBeDefined();
  return flag!.reopened;
}

const clearanceIdOf = (res: Res) =>
  (res.body.data?.clearanceId ?? res.body.clearanceId) as string;

async function clearFlag(flagId: string, reason = REASON) {
  const proposed = await proposeHttp(proposer, flagId, reason);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = clearanceIdOf(proposed);
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- Observations --------------------------------------------------------------------------

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
const observationsOf = (operationId: string) =>
  W.rowsOf(
    `SELECT * FROM ${OBSERVATIONS} WHERE tenant_id = $1 AND operation_id = $2
      ORDER BY observed_at, id`,
    [W.tenantId, operationId],
  );
/** Live fingerprint of a flag, read in the tenant's own context. */
async function fingerprintOf(flagId: string) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    const { rows } = await client.query(
      `SELECT app.payout_recon_flag_fingerprint($1::uuid, $2::uuid) AS fp`,
      [W.tenantId, flagId],
    );
    await client.query("COMMIT");
    return JSON.stringify(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
/** Flags of the item that share (operation, item, reason): there must be none. */
async function duplicateFlagsOf(itemId: string) {
  return W.rowsOf(
    `SELECT operation_id, item_id, reason, count(*)::int AS n
       FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2
      GROUP BY operation_id, item_id, reason HAVING count(*) > 1`,
    [W.tenantId, itemId],
  );
}

// ---- The recon over a storage the test controls --------------------------------------------

const bytesOf = new Map<string, string | "missing">();
const setProof = (key: string, bytes: string | "missing") =>
  bytesOf.set(key, bytes);

async function runRecon() {
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
  const storage = {
    async get(context: unknown, input: { key: string }) {
      const override = bytesOf.get(input.key);
      if (override === "missing")
        throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
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

/** `count` night runs started in the same tick; every one must finish without error. */
async function runReconConcurrently(count: number, label: string) {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => runRecon()),
  );
  const failures = settled.filter((s) => s.status === "rejected");
  expect(
    failures.map((f) => String((f as PromiseRejectedResult).reason)),
    `${label}: no concurrent run fails`,
  ).toEqual([]);
}

// ---- Worlds ---------------------------------------------------------------------------------

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `conc1038-${randomUUID()}.pdf`);
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

/** The proof turns into `bytes` (or goes missing), one real run flags it. */
async function flaggedByEvidence(w: World, bytes: string | "missing") {
  setProof(w.key, bytes);
  await runRecon();
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the real run flagged the item",
  ).toBeGreaterThan(0);
  const payslipId = flags[0]!.payslip_id as string;
  expect(await heldBySql(payslipId), "premise: the flag holds the slip").toBe(
    true,
  );
  const evidenceFlag = flags.find((f) =>
    /evidence_(hash_mismatch|missing)/.test(String(f.reason)),
  );
  expect(
    evidenceFlag,
    `premise: an evidence flag: ${JSON.stringify(flags.map((f) => f.reason))}`,
  ).toBeDefined();
  return {
    flagIds: flags.map((f) => f.id as string),
    operationId: evidenceFlag!.operation_id as string,
    payslipId,
  };
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
// (a) Two recons at once over the same evidence problem
// =========================================================================

describe("1038 concurrency (a): two night runs over the same evidence problem", () => {
  it("[1038-concurrent-same-mismatch-one-observation] three runs at once over mismatch A record ONE observation (episode 1), the fingerprint equals the one of a single run, no error", async () => {
    const w = await correctedWorld();
    setProof(w.key, BYTES_A);
    await runReconConcurrently(3, "first sight of mismatch A");

    const flags = await exceptionRows(w.itemId);
    expect(flags.length, "the item is flagged").toBeGreaterThan(0);
    expect(await duplicateFlagsOf(w.itemId), "no duplicate flag").toEqual([]);
    const operationId = flags.find((f) =>
      String(f.reason).includes("evidence_hash_mismatch"),
    )!.operation_id as string;
    const rows = await observationsOf(operationId);
    expect(
      rows.map((r) => [r.state, r.episode]),
      `one observation, not one per run: ${JSON.stringify(rows)}`,
    ).toEqual([["mismatch", 1]]);
    expect(rows[0]!.observed_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await heldBySql(flags[0]!.payslip_id as string), "held").toBe(true);

    // The fingerprint is stable: a further single run and a further race change nothing.
    const fingerprints = await Promise.all(
      flags.map((f) => fingerprintOf(f.id as string)),
    );
    await runRecon();
    await runReconConcurrently(2, "second race over the same bytes");
    expect(
      await Promise.all(flags.map((f) => fingerprintOf(f.id as string))),
      "fingerprints stable",
    ).toEqual(fingerprints);
    expect(
      (await observationsOf(operationId)).length,
      "still one observation",
    ).toBe(1);
    expect(await duplicateFlagsOf(w.itemId), "still no duplicate").toEqual([]);
  });

  it("[1038-concurrent-a-then-b-one-more-observation] mismatch A seen, then the bytes become B and two runs race: exactly one more observation (A, B), and a clearance given for B releases the slip and survives further races", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(w, BYTES_A);

    setProof(w.key, BYTES_B);
    await runReconConcurrently(2, "A to B");
    const rows = await observationsOf(flagged.operationId);
    expect(
      rows.map((r) => [r.state, r.episode]),
      `A then B, one row each: ${JSON.stringify(rows)}`,
    ).toEqual([
      ["mismatch", 1],
      ["mismatch", 1],
    ]);
    expect(rows[0]!.observed_sha256).not.toBe(rows[1]!.observed_sha256);
    expect(sha256(BYTES_A)).not.toBe(sha256(BYTES_B));
    expect(await duplicateFlagsOf(w.itemId), "no duplicate flag").toEqual([]);
    expect(await heldBySql(flagged.payslipId), "held").toBe(true);

    // Clear B (the flags the change reopened or the live ones), then race again.
    for (const id of flagged.flagIds) await clearFlag(id, SECOND_REASON);
    expect(await heldBySql(flagged.payslipId), "B cleared: free").toBe(false);
    await runReconConcurrently(3, "after the clearance of B");
    expect(
      await heldBySql(flagged.payslipId),
      "the clearance of B survives races over the same B bytes",
    ).toBe(false);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "no new observation for unchanged evidence",
    ).toBe(2);
  });
});

// =========================================================================
// (b) A clearance is approved while the evidence changes
// =========================================================================

describe("1038 concurrency (b): approve races a change of the evidence", () => {
  async function raceApproveAgainstChange(
    changeTo: string | "missing",
    label: string,
  ) {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(w, BYTES_A);
    const proposals: string[] = [];
    for (const id of flagged.flagIds) {
      const res = await proposeHttp(proposer, id, REASON);
      expect(res.status, `premise: propose ${detail(res)}`).toBe(201);
      proposals.push(clearanceIdOf(res));
    }

    // Same tick: every approve and the run that sees the new evidence.
    setProof(w.key, changeTo);
    const [recon, ...approvals] = await Promise.allSettled([
      runRecon(),
      ...proposals.map((id) => approveHttp(approverA, id)),
    ]);
    expect(recon!.status, `${label}: the run does not fail`).toBe("fulfilled");
    const results = approvals.map((a, i) => {
      expect(a.status, `${label}: approve ${i} answers`).toBe("fulfilled");
      return (a as PromiseFulfilledResult<Res>).value;
    });
    for (const res of results)
      expect(
        [200, 409],
        `${label}: an approve is approved or refused as stale, never a server error: ${detail(res)}`,
      ).toContain(res.status);

    // Settle: the run has seen the new evidence for sure.
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      `${label}: nobody cleared the new evidence, the slip is held`,
    ).toBe(true);
    // An approve that won must show up as reopened (its clearance is for the old evidence).
    for (const [i, id] of flagged.flagIds.entries()) {
      if (results[i]!.status === 200)
        expect(
          await reopenedOf(id),
          `${label}: flag ${i} was approved before the change, now reopened`,
        ).toBe(true);
    }
    // And a run later does not free it.
    await runReconConcurrently(2, `${label}: later races`);
    expect(
      await heldBySql(flagged.payslipId),
      `${label}: still held after later runs`,
    ).toBe(true);
    expect(await duplicateFlagsOf(w.itemId), `${label}: no duplicate`).toEqual(
      [],
    );
    return { w, flagged };
  }

  it("[1038-concurrent-approve-vs-bytes-b] clearance proposed for mismatch A, the bytes become B at the moment of the approve: approve refused (409) or reopened afterwards, never free; a new clearance for B then releases", async () => {
    const { flagged } = await raceApproveAgainstChange(BYTES_B, "A to B");
    // Flags reopened by the change and flags whose approve was refused both need a new
    // two-person clearance; a flag that is already free (not reopened) is skipped.
    for (const id of flagged.flagIds) {
      const res = await proposeHttp(proposer, id, SECOND_REASON);
      if (res.status !== 201) continue;
      expect(
        (await approveHttp(approverA, clearanceIdOf(res))).status,
        "premise: second approve",
      ).toBe(200);
    }
    expect(
      await heldBySql(flagged.payslipId),
      "a two-person clearance of the B evidence releases the slip",
    ).toBe(false);
  });

  it("[1038-concurrent-approve-vs-file-missing] clearance proposed for mismatch A, the file disappears at the moment of the approve: approve refused (409) or reopened afterwards, never free", async () => {
    await raceApproveAgainstChange("missing", "A to missing");
  });
});

// =========================================================================
// (c) Finding 7: two runs over a resolve whose attestations are gone
// =========================================================================

describe("1038 concurrency (c): two night runs over a resolve whose attestations are gone", () => {
  async function lostWorld() {
    const slips = [bank(BUDI, NET)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const item = (await W.itemsOf(batchId))[0]!;
    const itemId = item.id as string;
    const payslipId = item.payslip_id as string;
    await W.resolve(batchId, [itemId], "failed", APP);
    await W.resolve(batchId, [itemId], "failed", APP3);
    await runRecon();
    expect(await exceptionRows(itemId), "control: legit resolve clean").toEqual(
      [],
    );
    const dropped = await W.asTenant(async (c) => {
      const res = await c.query(
        `DELETE FROM ${ATTESTATIONS}
          WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
        [W.tenantId, itemId],
      );
      return res.rowCount;
    }, true);
    expect(dropped, "premise: both attestations were deleted").toBe(2);
    return { itemId, payslipId };
  }
  const lostFlags = async (itemId: string) =>
    (await exceptionRows(itemId)).filter((f) =>
      String(f.reason).includes("attestation_count"),
    );

  it("[1038-concurrent-lost-attestations-one-flag] three runs at once over a resolve with no attestations: one attestation_count flag per operation, no duplicate, slip held, same count as a later single run", async () => {
    const w = await lostWorld();
    await runReconConcurrently(3, "lost attestations");

    const flags = await lostFlags(w.itemId);
    expect(flags.length, "the lost resolve is flagged").toBeGreaterThan(0);
    expect(await duplicateFlagsOf(w.itemId), "no duplicate flag").toEqual([]);
    expect(await heldBySql(w.payslipId), "slip held").toBe(true);

    const total = (await exceptionRows(w.itemId)).length;
    await runRecon();
    await runReconConcurrently(2, "second race");
    expect(
      (await exceptionRows(w.itemId)).length,
      "later runs add no flag",
    ).toBe(total);
    expect(await duplicateFlagsOf(w.itemId), "still no duplicate").toEqual([]);
    expect(await heldBySql(w.payslipId), "still held").toBe(true);
  });
});
