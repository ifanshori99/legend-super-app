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
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CoreError } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { recordReadOk } from "../services/payroll-payout-recon.service.ts";
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

const clearanceIds = async () =>
  (
    await W.rowsOf(
      `SELECT id FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1 ORDER BY id`,
      [W.tenantId],
    )
  ).map((r) => r.id as string);
/** The trusted observe function for this tenant, as legend_app, real COMMIT. */
const observeOwn = (operationId: string, state: string, sha: string | null) =>
  appCall(
    `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, $3::text, $4::text)`,
    [W.tenantId, operationId, state, sha],
  );
/**
 * An 'ok' read as the recon job records it: the exported `recordReadOk` helper
 * (SET LOCAL ROLE legend_payout_recon inside the tenant transaction), real COMMIT.
 * 'ok' may come only from this path (legend-qh11l F1); `observeOwn(.., "ok", ..)`
 * is refused. `tenantId` defaults to this tenant.
 */
const readOk = (operationId: string, tenantId: string = W.tenantId) =>
  W.inTx((tx) => recordReadOk(tx, tenantId, operationId));
/** The same, as raw SQL: legend_app switches to legend_payout_recon (what the helper does), real COMMIT. */
async function reconRoleCall(
  sqlText: string,
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
const FLAG_REASON = "recon test: forged transition";
/** A non-evidence flag (the night run's flag function) on an operation nobody observed. */
async function flagNonEvidence(itemId: string) {
  const operationId = randomUUID();
  await W.asTenant(
    (c) =>
      c.query(`SELECT app.payout_recon_flag($1, 'correction', $2, $3, $4)`, [
        W.tenantId,
        operationId,
        itemId,
        FLAG_REASON,
      ]),
    true,
  );
  const row = (await exceptionRows(itemId)).find(
    (f) => f.operation_id === operationId,
  );
  expect(row, "premise: the non-evidence flag is on record").toBeDefined();
  return {
    operationId,
    flagId: row!.id as string,
    payslipId: row!.payslip_id as string,
  };
}

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

  // legend-qh11l (P2, money): a storage fault that is not "not found" (here
  // Error("Invalid stored object")) must FAIL CLOSED at once: that cycle never
  // releases the slip. Founder rule: when in doubt, hold. Per the CTO decision on
  // the card: the hold lifts only after a later successful read whose bytes match
  // the clearance that was approved (recovery, no new clearance needed).
  it("[1057-returned-storage-error-after-clearance-held] A cleared; the storage throws Error('Invalid stored object') and the recon runs: the slip is held at once and a new batch is refused", async () => {
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
  });

  it("[1057-corrected-storage-error-after-clearance-held] same for a corrected item: A cleared; the storage throws Error('Invalid stored object'): the slip is held", async () => {
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
  });

  it("[1057-returned-transient-storage-error-recovers] A cleared; one unreadable cycle holds the slip; the next successful read of the same bytes A frees it again with the OLD clearance, no new clearance, and a new batch is accepted", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await counts(w);
    const clearancesBefore = await clearanceIds();
    expect(
      clearancesBefore.length,
      "premise: clearances exist",
    ).toBeGreaterThan(0);

    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "error cycle: held").toBe(true);
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "error cycle: nothing new").toEqual(before);

    // The storage recovers and serves the very bytes that were cleared.
    setProof(w.key, BYTES_A);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "a later successful read lifts the hold",
    ).toBe(false);
    const failure = await W.httpFailure(followUpBatch(w.runId));
    expect(failure, "recovered: the slip can get a new batch").toBeNull();
    expect((await counts(w)).batches, "one new batch").toBe(before.batches + 1);
    // No new clearance was needed: the very same clearance rows as before.
    expect(
      await clearanceIds(),
      "recovery did not create or change a clearance",
    ).toEqual(clearancesBefore);
  });

  it("[1057-corrected-transient-storage-error-recovers] corrected item: error cycle holds the cleared slip, the next successful read of the cleared bytes frees it", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "error cycle: held").toBe(true);
    setProof(w.key, BYTES_A);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "recovered: free").toBe(false);
  });

  it("[1057-returned-recovery-with-changed-bytes-stays-held] A cleared; an unreadable cycle; the storage then serves different bytes B: a successful read does not free the slip (the clearance covers A only)", async () => {
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
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "B was never cleared").toBe(
      true,
    );
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "nothing new").toEqual(before);
  });

  it("[1057-returned-persistent-storage-error-stays-held] A cleared; the storage keeps failing over repeated recon cycles: the slip stays held every time and a new batch stays refused", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await counts(w);
    setProof(w.key, "invalid");
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await runRecon().catch(() => undefined);
      expect(
        await heldBySql(flagged.payslipId),
        `error cycle ${cycle}: held`,
      ).toBe(true);
    }
    await W.expectRefused(followUpBatch(w.runId), { status: 409 });
    expect(await counts(w), "nothing new").toEqual(before);
  });
});

// =========================================================================
// 1c: legend-qh11l ordering rules between proposals, errors and recovery
// =========================================================================

describe("1057 card D: an unreadable proof and the clearance flow", () => {
  const counts = async (w: { runId: string }) => ({
    batches: await batchCount(w.runId),
    items: await itemCount(w.runId),
    postings: await postingCount(w.runId),
  });

  it("[1057-error-proposal-before-approve-during-error-refused] a clearance proposed for mismatch A before the read error cannot be approved while the proof is unreadable (409, PAYOUT-91); the slip stays held", async () => {
    // Assumption: the refusal is checked by status 409 and the unchanged state;
    // the PAYOUT-91 text is not asserted on the HTTP body (its mapping is not in the contract).
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const proposals: string[] = [];
    for (const id of flagged.flagIds) {
      const res = await proposeHttp(proposer, id, REASON);
      expect(res.status, `premise: propose ${detail(res)}`).toBe(201);
      proposals.push(
        (res.body.data?.clearanceId ?? res.body.clearanceId) as string,
      );
    }
    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    for (const clearanceId of proposals) {
      const res = await approveHttp(approverA, clearanceId);
      expect(
        res.status,
        `approving while the proof is unreadable is refused: ${detail(res)}`,
      ).toBe(409);
    }
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
  });

  it("[1057-error-proposal-during-error-refused-after-recovery] A cleared; a new proposal is made while the proof is unreadable; the proof recovers to A: approving that proposal is refused (409), yet the slip is free through the OLD clearance", async () => {
    const w = await returnedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const before = await counts(w);
    const clearancesBefore = await clearanceIds();

    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "error: held").toBe(true);
    const proposals: string[] = [];
    for (const id of flagged.flagIds) {
      const res = await proposeHttp(proposer, id, SECOND_REASON);
      expect(
        res.status,
        `premise: propose during the error ${detail(res)}`,
      ).toBe(201);
      proposals.push(
        (res.body.data?.clearanceId ?? res.body.clearanceId) as string,
      );
    }

    setProof(w.key, BYTES_A);
    await runRecon();
    for (const clearanceId of proposals) {
      const res = await approveHttp(approverA, clearanceId);
      expect(
        res.status,
        `a proposal made on the error fingerprint is refused: ${detail(res)}`,
      ).toBe(409);
    }
    expect(
      await heldBySql(flagged.payslipId),
      "recovered: free by the old clearance",
    ).toBe(false);
    expect(
      await clearanceIds(),
      "the old clearances are still there, unchanged",
    ).toEqual(expect.arrayContaining(clearancesBefore));
    const failure = await W.httpFailure(followUpBatch(w.runId));
    expect(failure, "recovered: the slip can get a new batch").toBeNull();
    expect((await counts(w)).batches, "one new batch").toBe(before.batches + 1);
  });

  it("[1057-error-a-error-b-error-a-stays-held] A cleared; the sequence error, B, error, A (A again after B, no ok read between): the slip stays held at every step", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    const steps: Array<[ProofState, string]> = [
      ["invalid", "error"],
      [BYTES_B, "B"],
      ["invalid", "error again"],
      [BYTES_A, "A again after B"],
    ];
    for (const [state, label] of steps) {
      setProof(w.key, state);
      await runRecon().catch(() => undefined);
      expect(await heldBySql(flagged.payslipId), `${label}: held`).toBe(true);
    }
    expect(
      await Promise.all(flagged.flagIds.map(reopenedOf)),
      "reopened",
    ).toContain(true);
  });

  it("[1057-error-on-unobserved-operation-then-ok-frees-old-clearance] a non-evidence flag cleared by two people on an operation nobody observed: a read error holds the slip, the next ok frees it again by the old clearance", async () => {
    const w = await correctedWorld();
    const flag = await flagNonEvidence(w.itemId);
    expect(
      await observationsOf(flag.operationId),
      "premise: the operation was never observed",
    ).toHaveLength(0);
    await clearFlag(flag.flagId);
    expect(await heldBySql(flag.payslipId), "premise: cleared is free").toBe(
      false,
    );
    const clearancesBefore = await clearanceIds();

    const error = await observeOwn(flag.operationId, "error", null);
    expect(error.code, error.message).toBeUndefined();
    expect(
      await heldBySql(flag.payslipId),
      "a read error holds even a non-evidence clearance",
    ).toBe(true);

    await readOk(flag.operationId);
    expect(
      await heldBySql(flag.payslipId),
      "the next ok (recon path) frees the slip by the old clearance",
    ).toBe(false);
    expect(await clearanceIds(), "no new clearance").toEqual(clearancesBefore);
  });
});

// =========================================================================
// 1d: the fingerprint of a sequence without errors is the one of migration 0663
// =========================================================================

describe("1057 card D: the fingerprint is unchanged when no read error exists", () => {
  // The fingerprint expression of drizzle/0663 (the contract of what existing
  // clearances were bound to), evaluated here in plain SQL as the owner.
  const FINGERPRINT_0663 = String.raw`
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.jsonb_build_object(
        'item', (
          SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
            FROM public.payroll_disbursement_items it,
                 pg_catalog.jsonb_each(pg_catalog.to_jsonb(it)) AS f(key, value)
           WHERE it.tenant_id = e.tenant_id AND it.id = e.item_id
             AND f.key NOT IN ('updated_at', 'pii_key_version')
             AND f.key NOT LIKE '%\_encrypted'),
        'attestations', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.id)
            FROM public.payroll_payout_attestations a
           WHERE a.tenant_id = e.tenant_id AND a.operation_id = e.operation_id),
          '[]'::jsonb),
        'postings', COALESCE((
          SELECT pg_catalog.jsonb_agg(
                   (SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
                      FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(p)) AS f(key, value)
                     WHERE f.key NOT IN ('updated_at', 'pii_key_version')
                       AND f.key NOT LIKE '%\_encrypted')
                   ORDER BY p.id)
            FROM public.payroll_payout_gl_postings p
            JOIN public.payroll_disbursement_items it
              ON it.tenant_id = e.tenant_id AND it.id = e.item_id
           WHERE p.tenant_id = e.tenant_id
             AND (p.id = it.gl_posting_id
               OR p.item_set_hash = pg_catalog.encode(pg_catalog.sha256(
                    pg_catalog.convert_to(it.id::text, 'UTF8')), 'hex'))),
          '[]'::jsonb)
      ) || COALESCE((
          SELECT pg_catalog.jsonb_build_object('evidence', pg_catalog.jsonb_build_object(
                   'state', o.state,
                   'observed_sha256', o.observed_sha256,
                   'episode', o.episode,
                   'seq', o.seq))
            FROM public.payroll_payout_recon_evidence_observations o
           WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
             AND o.state <> 'ok'
           ORDER BY o.seq DESC
           LIMIT 1),
          '{}'::jsonb))::text, 'UTF8')), 'hex')::varchar AS fp
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = $1 AND e.id = $2`;
  const expected = async (flagId: string) =>
    (await W.rowsOf(FINGERPRINT_0663, [W.tenantId, flagId]))[0]!.fp as string;
  const live = async (flagId: string) =>
    (
      await W.rowsOf(
        `SELECT app.payout_recon_flag_fingerprint($1::uuid, $2::uuid) AS fp`,
        [W.tenantId, flagId],
      )
    )[0]!.fp as string;

  it("[1057-fingerprint-no-error-sequence-equals-0663] mismatch A, ok, mismatch B: at each step the live fingerprint equals the 0663 expression", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const flagId = flagged.flagIds[0]!;
    const steps: string[] = [];

    expect(await live(flagId), "mismatch A").toBe(await expected(flagId));
    steps.push(await live(flagId));

    bytesOf.delete(w.key);
    await runRecon();
    expect(await live(flagId), "ok").toBe(await expected(flagId));
    steps.push(await live(flagId));

    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await live(flagId), "mismatch B").toBe(await expected(flagId));
    steps.push(await live(flagId));

    expect(
      new Set(steps).size,
      "sanity: the expression really follows the evidence",
    ).toBeGreaterThan(1);
  });
});

// =========================================================================
// 1e: the daily sweep alerts ops when the proof stays unreadable
// =========================================================================

describe("1057 card D: the daily sweep alert", () => {
  it("[1057-sweep-alert-two-days-unreadable] the sweep run on two consecutive days with a failing proof storage logs PAYOUT-RECON-ALERT unreadable proof on the second day, not before", async () => {
    // Assumption: the sweep is called as in worker-main:
    // runPayoutTrustedReconSweep(context, now, { storage }); the in-memory
    // streak is kept by the module, and this is the only test of this file that
    // runs the sweep (so the streak starts here).
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, "invalid");

    const { runPayoutTrustedReconSweep } =
      (await import("../worker/payout-trusted-recon.job.ts")) as unknown as {
        runPayoutTrustedReconSweep: (
          context: unknown,
          now: Date,
          options: unknown,
        ) => Promise<unknown>;
      };
    const base = W.proofs().storage;
    const storage = {
      async get(context: unknown, input: { key: string }) {
        if (bytesOf.get(input.key) === "invalid")
          throw new Error("Invalid stored object");
        return (base.get as (c: unknown, i: unknown) => Promise<unknown>)(
          context,
          input,
        );
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alerts = () =>
      spy.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((line) => line.includes("PAYOUT-RECON-ALERT unreadable proof"));
    try {
      const day1 = new Date();
      await runPayoutTrustedReconSweep(W.scope(), day1, { storage }).catch(
        () => undefined,
      );
      expect(
        alerts(),
        "day 1: one unreadable cycle, no alert yet",
      ).toHaveLength(0);
      const day2 = new Date(day1.getTime() + 24 * 3_600_000);
      await runPayoutTrustedReconSweep(W.scope(), day2, { storage }).catch(
        () => undefined,
      );
      expect(
        alerts().length,
        "day 2: still unreadable, the ops alert fires",
      ).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    expect(await heldBySql(flagged.payslipId), "and the slip is held").toBe(
      true,
    );
  });
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
    // The recon path ('ok' only comes from here): this tenant's scope naming the other tenant, and
    // the other tenant's own scope naming either tenant. Refused or without effect, never a release.
    await readOk(flagged.operationId, other).catch(() => undefined);
    for (const subject of [W.tenantId, other])
      await reconRoleCall(
        `SELECT app.payout_recon_evidence_observe_ok($1::uuid, $2::uuid)`,
        [subject, flagged.operationId],
        other,
      );

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

  it("[1057-other-tenant-cannot-hold-cleared-slip-by-error] a cleared slip stays free when another tenant reports a read error for its operation: no hold, no observation", async () => {
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
      await observe(other, subject, flagged.operationId, "error", null);

    expect(
      await heldBySql(flagged.payslipId),
      "the other tenant's read error did not hold this tenant's slip",
    ).toBe(false);
    expect(
      await observationCount(flagged.operationId),
      "no observation was written for this tenant's operation",
    ).toBe(rowsBefore);
  });

  it("[1057-other-tenant-ok-does-not-lift-own-hold] while this tenant's slip is held by an unreadable proof, another tenant's successful read ('ok') does not free it", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "premise: held").toBe(true);
    const other = await foreignTenant();
    for (const subject of [W.tenantId, other])
      await observe(other, subject, flagged.operationId, "ok", null);
    await readOk(flagged.operationId, other).catch(() => undefined);
    for (const subject of [W.tenantId, other])
      await reconRoleCall(
        `SELECT app.payout_recon_evidence_observe_ok($1::uuid, $2::uuid)`,
        [subject, flagged.operationId],
        other,
      );
    expect(
      await heldBySql(flagged.payslipId),
      "a stranger's ok does not release the hold",
    ).toBe(true);
  });

  it("[1057-other-tenant-error-does-not-change-own-recovery] this tenant's unreadable proof held the slip and the next own read freed it; a read error reported by another tenant for its operation afterwards does not hold it again and writes no observation", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "premise: held").toBe(true);
    setProof(w.key, BYTES_A);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "premise: recovered").toBe(
      false,
    );
    const other = await foreignTenant();
    const rowsBefore = await observationCount(flagged.operationId);
    for (const subject of [W.tenantId, other])
      await observe(other, subject, flagged.operationId, "error", null);
    expect(
      await heldBySql(flagged.payslipId),
      "another tenant's error does not hold this tenant's slip",
    ).toBe(false);
    expect(
      await observationCount(flagged.operationId),
      "no observation was written for this tenant's operation",
    ).toBe(rowsBefore);
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

// =========================================================================
// 1e: legend-qh11l F1: 'ok' (the only state that can free a slip) comes only
// from the recon role; every other caller can only hold
// =========================================================================
//
// Assumptions: a refused call is any SQL error (the contract names a clear
// RAISE for observe('ok') and "permission denied", 42501, for observe_ok without
// SET ROLE); no exact SQLSTATE is asserted for the RAISE. "Refused" always also
// means: no observation row written, hold unchanged.

describe("1057 card D2: only the recon role may record an ok read", () => {
  async function foreignTenant() {
    const id = randomUUID();
    foreignTenants.push(id);
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
           SELECT $1, $2, 'Payout 1057 tenant C', plan, status, deployment_mode, feature_flags, limits, created_by
             FROM tenants WHERE id = $3`,
          [id, `payout-1057-${id.slice(0, 8)}`, W.tenantId],
        ),
      true,
    );
    return id;
  }
  const OK_SQL = `SELECT app.payout_recon_evidence_observe_ok($1::uuid, $2::uuid)`;
  /** A slip cleared for mismatch A, then held by an unreadable proof. */
  async function heldByError() {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    setProof(w.key, "invalid");
    await runRecon().catch(() => undefined);
    expect(await heldBySql(flagged.payslipId), "premise: held by error").toBe(
      true,
    );
    return { w, flagged };
  }

  it("[1057-observe-ok-by-app-role-refused] an ordinary legend_app caller of observe(..., 'ok') is refused; a slip held by a read error stays held and no observation is written", async () => {
    const { flagged } = await heldByError();
    const rowsBefore = (await observationsOf(flagged.operationId)).length;
    const clearancesBefore = await clearanceIds();

    const refused = await observeOwn(flagged.operationId, "ok", null);
    expect(
      refused.code,
      "premise: observe('ok') raises for an ordinary caller",
    ).toBeDefined();
    expect(
      await heldBySql(flagged.payslipId),
      "the slip stays held after the refused ok",
    ).toBe(true);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "no observation was written",
    ).toBe(rowsBefore);
    expect(await clearanceIds(), "no clearance changed").toEqual(
      clearancesBefore,
    );
  });

  it("[1057-observe-ok-by-app-role-uncleared-mismatch-stays-held] observe(..., 'ok') by an ordinary caller does not free a slip held by an uncleared mismatch either", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const rowsBefore = (await observationsOf(flagged.operationId)).length;
    const refused = await observeOwn(flagged.operationId, "ok", null);
    expect(refused.code, "observe('ok') raises").toBeDefined();
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
    expect((await observationsOf(flagged.operationId)).length).toBe(rowsBefore);
  });

  it("[1057-observe-ok-direct-without-set-role-denied] legend_app calling observe_ok directly, without SET ROLE legend_payout_recon, gets permission denied; the hold stays", async () => {
    const { flagged } = await heldByError();
    const rowsBefore = (await observationsOf(flagged.operationId)).length;

    const denied = await appCall(OK_SQL, [W.tenantId, flagged.operationId]);
    expect(denied.code, denied.message).toBe("42501");
    expect(denied.message).toMatch(/permission denied/i);
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
    expect((await observationsOf(flagged.operationId)).length).toBe(rowsBefore);
  });

  it("[1057-observe-ok-internal-function-denied] the internal observe function is not callable by legend_app at all", async () => {
    const { flagged } = await heldByError();
    // The internal function takes the by-recon flag as its fifth argument (legend-tiw2h):
    // legend_app is denied with either value.
    for (const byRecon of ["false", "true"]) {
      const denied = await appCall(
        `SELECT app.payout_recon_evidence_observe_internal($1::uuid, $2::uuid, 'ok', NULL, ${byRecon})`,
        [W.tenantId, flagged.operationId],
      );
      expect(denied.code, `by_recon=${byRecon}: ${denied.message}`).toBe(
        "42501",
      );
    }
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
  });

  for (const [state, sha] of [
    ["missing", null],
    ["mismatch", sha256("1057 some other bytes")],
    ["error", null],
  ] as const)
    it(`[1057-observe-${state}-by-app-role-holds] an ordinary caller can still report '${state}': a cleared slip is held at once, and no clearance is touched`, async () => {
      const w = await correctedWorld();
      const flagged = await flaggedByEvidence(
        w,
        BYTES_A,
        "evidence_hash_mismatch",
      );
      await clearAll(flagged);
      const clearancesBefore = await clearanceIds();
      const rowsBefore = (await observationsOf(flagged.operationId)).length;

      const res = await observeOwn(flagged.operationId, state, sha);
      expect(res.code, res.message).toBeUndefined();
      expect(
        await heldBySql(flagged.payslipId),
        `'${state}' holds the cleared slip`,
      ).toBe(true);
      expect(
        (await observationsOf(flagged.operationId)).length,
        "the observation was recorded",
      ).toBe(rowsBefore + 1);
      expect(await clearanceIds(), "no clearance changed").toEqual(
        clearancesBefore,
      );
    });

  it("[1057-recon-path-frees-again-after-error] the recon path (recordReadOk) frees the slip again with the OLD clearance after an error; no new clearance; the transaction keeps its own role", async () => {
    const { flagged } = await heldByError();
    const clearancesBefore = await clearanceIds();

    // The proof reads fine again: the recon records an ok read.
    const roles = await W.inTx(async (tx) => {
      const read = async () =>
        (
          (await tx.execute(sql`SELECT current_user AS who`)) as unknown as {
            rows: { who: string }[];
          }
        ).rows[0]!.who;
      const before = await read();
      await recordReadOk(tx, W.tenantId, flagged.operationId);
      return { before, after: await read() };
    });
    expect(
      roles.after,
      "recordReadOk leaves the transaction's role as it found it",
    ).toBe(roles.before);
    expect(roles.after).not.toBe("legend_payout_recon");

    expect(
      await heldBySql(flagged.payslipId),
      "the ok read through the recon role lifts the error hold",
    ).toBe(false);
    expect(await clearanceIds(), "recovery used the old clearance").toEqual(
      clearancesBefore,
    );
  });

  it("[1057-recon-role-raw-observe-ok-frees-again] the SET ROLE legend_payout_recon path as raw SQL frees the slip after an error", async () => {
    const { flagged } = await heldByError();
    const res = await reconRoleCall(OK_SQL, [W.tenantId, flagged.operationId]);
    expect(res.code, res.message).toBeUndefined();
    expect(await heldBySql(flagged.payslipId), "freed again").toBe(false);
  });

  it("[1057-observe-other-tenant-refused] another tenant is refused by observe and by observe_ok, naming either tenant: no hold, no release, no observation", async () => {
    const { flagged } = await heldByError();
    const other = await foreignTenant();
    const rowsBefore = (await observationsOf(flagged.operationId)).length;

    for (const subject of [W.tenantId, other]) {
      const missing = await appCall(
        `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, 'missing', NULL)`,
        [subject, flagged.operationId],
        other,
      );
      const ok = await reconRoleCall(
        OK_SQL,
        [subject, flagged.operationId],
        other,
      );
      // Either refused, or accepted for the other tenant's own (empty) rows: never this tenant's.
      if (subject === W.tenantId) {
        expect(missing.code, "observe naming a foreign tenant").toBeDefined();
        expect(ok.code, "observe_ok naming a foreign tenant").toBeDefined();
      }
    }
    expect(
      await heldBySql(flagged.payslipId),
      "the other tenant did not release the slip",
    ).toBe(true);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "no observation was written for this tenant's operation",
    ).toBe(rowsBefore);
  });
});
