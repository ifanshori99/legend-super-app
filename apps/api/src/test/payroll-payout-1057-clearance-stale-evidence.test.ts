// Payout 1057 card A (bead legend-63gyr, tier K: money): proof that a recon
// clearance cannot release a slip on STALE evidence, that the slip is never paid
// twice, and that another tenant can neither release nor reopen it.
// Closes SO 1036 finding 4 as a regression gate over what 1038/1052 built.
// Written from docs/briefs/1038-design-recon-clearance.md and the contract rules
// stated in the 1038 tests, NOT from the implementation. Scaffolding follows
// payroll-payout-1038-evidence-clearance.test.ts (same fixture world).
//
// Assumptions (stated so they can be contested):
// - "Paid twice" is probed as: after the evidence changed, a new disbursement
//   batch for the same run is refused (4xx, 409), no batch/item/journal appears,
//   and the original item stays `succeeded` with its single journal. The
//   corrected item is already paid, so a follow-up batch is refused in the
//   cleared state too: an approved clearance must never open a second payment.
// - "Another tenant is refused" is probed in SQL as legend_app under the OTHER
//   tenant's context: the trusted observe function for this tenant's operation
//   is refused or has no effect, and the other tenant sees none of our rows.
// - The corrected-item tests (section 1) only prove the hold at SQL level plus a
//   409 that comes from the item status (succeeded is not retryable), so they
//   are weak for "paid twice". The returned-item tests (1b) are the strong
//   proof: a returned slip IS retryable, so only the hold can refuse the batch,
//   and the control cases show the same batch accepted when the slip is free.
// - "Held" = app.payout_payslip_held_by_recon plus the flag list `reopened`.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { originHeader } from "./helpers.ts";
import {
  bank,
  BUDI,
  APP,
  APP3,
  REQ,
  actorOf,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1057stale");
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
const GRANTS = "payroll_payout_grants";
const BYTES_A = "1038 tampered proof bytes A";
const BYTES_B = "1038 tampered proof bytes B (different)";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];
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
    [W.tenantId, `Template ${key} 1057stale`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in finance person (tenant-level template role, approve permission), TOTP enrolled in this session. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Stale1057 ${label}`);
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

/** The flag object with this id, found anywhere in the list body. */
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
/** `reopened` of a flag as the first finance person sees it in the list. */
async function reopenedOf(flagId: string) {
  const list = await listFlagsHttp(proposer);
  expect(list.status, detail(list)).toBe(200);
  const flag = findFlag(list.body, flagId);
  expect(flag, `the flag is listed: ${detail(list)}`).toBeDefined();
  return flag!.reopened;
}

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

// ---- Raw SQL (legend_app) ------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** legend_app, one statement, real COMMIT. */
async function appCall(
  sql: string,
  params: unknown[] = [],
  tenantId: string = W.tenantId,
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    try {
      const result = await client.query(sql, params);
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

// ---- The recon over a storage the test controls --------------------------------------------

type ProofState = string | "missing" | "invalid";
const bytesOf = new Map<string, ProofState>();
const setProof = (key: string, bytes: ProofState) => bytesOf.set(key, bytes);

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
      // A storage fault that is not "not found" (legend-qh11l).
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

// ---- World: a real corrected item with a stored proof ---------------------------------------

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evid1038-${randomUUID()}.pdf`);
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

const returnBankRef = (evidenceKey: string, itemIds: string[]) =>
  "TRX" +
  createHash("sha256")
    .update(`${evidenceKey}|${itemIds.join(",")}`)
    .digest("hex")
    .slice(0, 12);
const returnWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  evidenceKey: string,
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey,
        bankRef: returnBankRef(evidenceKey, itemIds),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );

/**
 * A paid slip whose funds came back: a return claim over a stored proof, two
 * different people. The item is `returned`, a status that FREES the slip for a
 * new batch (R7) unless a recon flag holds it. So here a refused batch can only
 * come from the hold, never from the item status.
 */
async function returnedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const itemId = (await W.itemOfPerson(batchId, BUDI)).id as string;
  const key = uploadEvidence(batchId, `return1057-${randomUUID()}.pdf`);
  await returnWith(batchId, [itemId], APP, key);
  await returnWith(batchId, [itemId], APP3, key);
  expect(await itemStatusOf(itemId), "premise: returned").toBe("returned");
  await runRecon();
  expect(
    await exceptionRows(itemId),
    "control: an untouched returned item is not flagged",
  ).toHaveLength(0);
  return { runId, batchId, itemId, key };
}
const itemStatusOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.status as string;

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
/** Clears the flags the live evidence reopened (those the list calls reopened). */
const clearReopened = async (f: Flagged) => {
  for (const id of f.flagIds)
    if ((await reopenedOf(id)) === true) await clearFlag(id, SECOND_REASON);
};

// ---- Setup / teardown ----------------------------------------------------------------------

/** Append-only tables of this file: removed by the owner with guards off (the observation table may not exist yet). */
async function dropAppendOnly(tenantIds: string[]) {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${OBSERVATIONS}') IS NOT NULL AS found`,
  );
  await W.asTenant(async (c) => {
    if (exists!.found)
      await c.query(
        `DELETE FROM ${OBSERVATIONS} WHERE tenant_id = ANY($1::uuid[])`,
        [tenantIds],
      );
    await c.query(
      `DELETE FROM ${SIGHTINGS} WHERE tenant_id = ANY($1::uuid[])`,
      [tenantIds],
    );
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
  await dropAppendOnly([W.tenantId, ...foreignTenants]);
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
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
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

// ---- Probes ---------------------------------------------------------------------------------

const followUpBatch = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
const countOf = async (sql: string, params: unknown[]) =>
  ((await W.rowsOf(sql, params))[0]!.n as number) ?? 0;
const batchCount = (runId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  );
const itemCount = (runId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items i
      JOIN payroll_disbursement_batches b ON b.id = i.batch_id AND b.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND b.payroll_run_id = $2`,
    [W.tenantId, runId],
  );
const postingCount = (runId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings p
      JOIN payroll_disbursement_batches b ON b.id = p.batch_id AND b.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND b.payroll_run_id = $2`,
    [W.tenantId, runId],
  );
const itemStatus = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.status as string;

/** Nothing was paid again: no new batch, item or journal, and the item is still paid once. */
async function snapshot(w: World) {
  return {
    batches: await batchCount(w.runId),
    items: await itemCount(w.runId),
    postings: await postingCount(w.runId),
    status: await itemStatus(w.itemId),
  };
}
async function expectNoSecondPayment(
  w: World,
  before: Awaited<ReturnType<typeof snapshot>>,
  label: string,
) {
  await W.expectRefused(followUpBatch(w.runId), { status: 409 });
  expect(await snapshot(w), `${label}: nothing paid again`).toEqual(before);
  expect(before.status, `${label}: the item stays paid`).toBe("succeeded");
}

// =========================================================================
// 1: stale evidence never releases the slip, and the slip is paid once
// =========================================================================

describe("1057 card A: a clearance bound to old evidence never pays the slip again", () => {
  it("[1057-stale-proof-held-not-paid-twice] mismatch A cleared (slip free); the stored bytes become B: the slip is held, a follow-up batch is refused (409), nothing is paid again", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await snapshot(w);
    expect(before.status, "premise: paid once").toBe("succeeded");

    setProof(w.key, BYTES_B);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "the clearance of A does not cover B: held",
    ).toBe(true);
    await expectNoSecondPayment(w, before, "stale proof B");
    expect(
      await Promise.all(flagged.flagIds.map(reopenedOf)),
      "the flag list says reopened",
    ).toContain(true);
  });

  it("[1057-stale-proof-cleared-anew-still-paid-once] after the stale proof is cleared anew for B the slip is free of the hold, yet an already paid slip still gets no second batch, item or journal", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "premise: held").toBe(true);
    await clearReopened(flagged);
    expect(await heldBySql(flagged.payslipId), "cleared for B: free").toBe(
      false,
    );
    const before = await snapshot(w);
    await expectNoSecondPayment(w, before, "cleared for B");
    await runRecon();
    await expectNoSecondPayment(w, before, "cleared for B, recon again");
  });

  it("[1057-stale-proof-missing-after-clearance] mismatch A cleared; the proof file is gone: held, a follow-up batch is refused, nothing is paid again", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await snapshot(w);

    setProof(w.key, "missing");
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "a missing proof is not what was cleared: held",
    ).toBe(true);
    await expectNoSecondPayment(w, before, "proof missing");
  });

  it("[1057-stale-proof-repeated-runs-stay-held] the stale proof B stays held however often the recon runs; a recon never releases it", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, BYTES_B);
    await runRecon();
    await runRecon();
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "held after three runs").toBe(
      true,
    );
    expect(
      await Promise.all(flagged.flagIds.map(reopenedOf)),
      "still reopened",
    ).toContain(true);
  });
});

// =========================================================================
// 1b: the slip can be paid again by status (returned), so only the hold stops it
// =========================================================================

describe("1057 card A: a returned slip is held by the recon, not by its status", () => {
  const counts = async (w: { runId: string }) => ({
    batches: await batchCount(w.runId),
    items: await itemCount(w.runId),
    postings: await postingCount(w.runId),
  });

  it("[1057-returned-cleared-a-slip-is-free] control: a returned item flagged for mismatch A and cleared by two people: a new batch takes the slip", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const before = await counts(w);
    // Held while the flag is open: the refusal is the hold (the item is returned).
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "held: nothing new").toEqual(before);

    await clearAll(flagged);
    const failure = await W.httpFailure(followUpBatch(w.runId));
    expect(failure, "cleared: the slip can get a new batch").toBeNull();
    const after = await counts(w);
    expect(after.batches, "one new batch").toBe(before.batches + 1);
    expect(after.items, "one new item for the slip").toBe(before.items + 1);
  });

  it("[1057-returned-stale-proof-batch-refused] A cleared (slip free); the bytes become B and the recon runs: a new batch refuses the slip, no new batch, item or posting; a clearance for B opens it again", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await counts(w);

    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "B: held").toBe(true);
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "stale proof: nothing new was created").toEqual(
      before,
    );
    expect(await itemStatusOf(w.itemId), "item unchanged").toBe("returned");

    // Control: the refusal came from the hold; a clearance for B lifts it.
    await clearReopened(flagged);
    const failure = await W.httpFailure(followUpBatch(w.runId));
    expect(failure, "cleared for B: the slip can get a new batch").toBeNull();
    expect((await counts(w)).batches, "one new batch").toBe(before.batches + 1);
  });

  it("[1057-returned-missing-proof-batch-refused] A cleared; the proof file is gone: a new batch refuses the slip, nothing new is created", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await counts(w);
    setProof(w.key, "missing");
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "missing: held").toBe(true);
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "nothing new").toEqual(before);
  });

  // KNOWN GAP (P2, legend-qh11l): when the proof storage throws an error
  // that is not "not found" (here Error("Invalid stored object")), the recon fails
  // OPEN: the cleared slip stays free (payroll-payout-recon.service.ts:1944-1951).
  // Founder rule: when in doubt, hold. These two cases state the RIGHT behavior
  // and are marked it.fails until the follow-up bead fixes it; then drop `.fails`.
  it.fails(
    "[1057-returned-storage-error-after-clearance-held] A cleared; the storage throws Error('Invalid stored object') and the recon runs: the slip must be held and a new batch refused",
    async () => {
      const w = await returnedWorld();
      const flagged = await flaggedByEvidence(
        w,
        BYTES_A,
        "evidence_hash_mismatch",
      );
      await clearAll(flagged);
      const before = await counts(w);
      setProof(w.key, "invalid");
      await runRecon().catch(() => undefined);
      expect(await heldBySql(flagged.payslipId), "unreadable proof: held").toBe(
        true,
      );
      await W.expectRefused(followUpBatch(w.runId), { status: 409 });
      expect(await counts(w), "nothing new").toEqual(before);
    },
  );

  it.fails(
    "[1057-corrected-storage-error-after-clearance-held] same gap for a corrected item: A cleared; the storage throws Error('Invalid stored object'): the slip must be held",
    async () => {
      const w = await correctedWorld();
      const flagged = await flaggedByEvidence(
        w,
        BYTES_A,
        "evidence_hash_mismatch",
      );
      await clearAll(flagged);
      setProof(w.key, "invalid");
      await runRecon().catch(() => undefined);
      expect(await heldBySql(flagged.payslipId), "unreadable proof: held").toBe(
        true,
      );
    },
  );
});

// =========================================================================
// 2: another tenant cannot release or reopen this tenant's slip
// =========================================================================

describe("1057 card A: another tenant is refused", () => {
  async function foreignTenant() {
    const id = randomUUID();
    foreignTenants.push(id);
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
           SELECT $1, $2, 'Payout 1057 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
             FROM tenants WHERE id = $3`,
          [id, `payout-1057-${id.slice(0, 8)}`, W.tenantId],
        ),
      true,
    );
    return id;
  }
  const observe = (
    context: string,
    subject: string,
    operationId: string,
    state: string,
    sha: string | null,
  ) =>
    appCall(
      `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, $3::text, $4::text)`,
      [subject, operationId, state, sha],
      context,
    );
  const observationCount = (operationId: string) =>
    observationsOf(operationId).then((rows) => rows.length);

  it("[1057-other-tenant-cannot-release-held-slip] a held (uncleared) slip stays held when another tenant reports 'ok' for its operation; no observation is recorded", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const other = await foreignTenant();
    const rowsBefore = await observationCount(flagged.operationId);

    // Under the other tenant's context, naming this tenant or itself.
    for (const subject of [W.tenantId, other])
      await observe(other, subject, flagged.operationId, "ok", null);

    expect(
      await heldBySql(flagged.payslipId),
      "the other tenant did not release the slip",
    ).toBe(true);
    expect(
      await observationCount(flagged.operationId),
      "no observation was written for this tenant's operation",
    ).toBe(rowsBefore);
    const seen = await appCall(`SELECT id FROM ${OBSERVATIONS}`, [], other);
    expect(
      seen.rows,
      "the other tenant sees none of our observations",
    ).toHaveLength(0);
  });

  it("[1057-other-tenant-cannot-reopen-cleared-slip] a cleared slip stays free when another tenant reports a mismatch for its operation: no hold, no observation", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const other = await foreignTenant();
    const rowsBefore = await observationCount(flagged.operationId);

    for (const subject of [W.tenantId, other])
      await observe(
        other,
        subject,
        flagged.operationId,
        "mismatch",
        sha256("other tenant bytes"),
      );

    expect(
      await heldBySql(flagged.payslipId),
      "the other tenant did not hold or release anything: still cleared",
    ).toBe(false);
    expect(
      await observationCount(flagged.operationId),
      "no observation was written for this tenant's operation",
    ).toBe(rowsBefore);
    for (const id of flagged.flagIds)
      expect(await reopenedOf(id), "not reopened by a stranger").toBe(false);
  });

  it("[1057-other-tenant-sees-no-slip-hold] asked under the other tenant's context, this tenant's payslip is not held by anything of that tenant", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const other = await foreignTenant();
    const asked = await appCall(
      `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
      [other, flagged.payslipId],
      other,
    );
    // Either the call is refused or it answers "not held": the other tenant has no flags on this slip.
    if (asked.code === undefined)
      expect(asked.rows[0]!.held, "no flag of the other tenant").toBe(false);
    expect(
      await heldBySql(flagged.payslipId),
      "this tenant's own hold is unchanged",
    ).toBe(true);
  });
});
