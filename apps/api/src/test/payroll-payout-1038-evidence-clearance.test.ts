// Payout 1038, finding 4 of the second opinion on 1036 (bead legend-63gyr): a
// recon clearance of an EVIDENCE flag must not outlive the evidence problem it
// was approved for. Written fail-first from docs/briefs/1038-design-recon-clearance.md
// ("Desain temuan 4", "Bukti"), NOT from the implementation.
//
// The hole: flag key = (tenant, kind, operation, item, reason). A proof file that
// does not match its recorded hash (evidence_hash_mismatch) or is gone
// (evidence_missing) is flagged; two people clear the flag; later the bytes are
// replaced by DIFFERENT wrong bytes (or the problem goes away and comes back).
// The flag key and the data fingerprint stay the same, so the old clearance kept
// releasing the slip. Founder rule: when in doubt hold the payment.
//
// Rules proven:
// - Mismatch A cleared by two people, then the stored bytes become B and the recon
//   runs: the slip is held again at once and the flag list says reopened; a NEW
//   two-person clearance releases it again.
// - Mismatch A cleared, the file recovers (recon runs), then A comes back: held
//   again (a new episode of the problem). The same for evidence_missing.
// - Recovery alone never holds a released slip (control).
// - Another tenant is not touched: its flag keeps its fingerprint and no
//   observation rows appear for it.
// - The observation history (design: payroll_payout_recon_evidence_observations)
//   is append-only for the app role and records one row per change.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - "The bytes changed" is simulated by handing the REAL night run
//   (reconcileTrustedPayouts(context, {storage, after}), paged as the 905 test)
//   a storage wrapper over the fixture storage that returns other bytes for the
//   proof key (A or B), or throws NOT_FOUND (missing). The recorded hashes stay
//   as the legit two-person correction wrote them, so A and B both mismatch.
// - The world is a real corrected item (two people, real journal), as the 990
//   recon-reopen test builds it; flags come from the real run, not from the
//   trusted flag function, because the hole is in what the run observes.
// - "Held" = app.payout_payslip_held_by_recon(tenant, payslip) (the SQL test the
//   item guard uses) plus the flag list `reopened` boolean (990 phase 5).
// - Reasons are named as in the brief: evidence_hash_mismatch, evidence_missing.
// - Observation table columns (design item 1): tenant_id, operation_id, state
//   ('missing'|'mismatch'|'ok'), observed_sha256, episode, observed_at. The
//   exact sha value of an observation is not asserted (the recon may hash the
//   stored or the plain bytes); only that A and B differ and A is stable.
// - Cleanup of the append-only tables is done by the table owner with guards off.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
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

const W = installPayoutWorld("1038evid");
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
const PRIVILEGE = "42501";
const HEX64 = /^[0-9a-f]{64}$/;
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
    [W.tenantId, `Template ${key} 1038evid`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in finance person (tenant-level template role, approve permission), TOTP enrolled in this session. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Evid1038 ${label}`);
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
async function appCall(sql: string, params: unknown[] = []): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
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

const bytesOf = new Map<string, string | "missing">();
const setProof = (key: string, bytes: string | "missing") =>
  bytesOf.set(key, bytes);
const recoverProof = (key: string) => bytesOf.delete(key);

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

/** The proof turns into `bytes` (or goes missing), the real run flags it. Returns the flags. */
async function flaggedByEvidence(
  w: World,
  bytes: string | "missing",
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

// =========================================================================
// Mismatch A cleared, then the bytes become B
// =========================================================================

describe("1038 finding 4: a clearance is bound to the evidence problem it cleared", () => {
  it("[1038-evidence-a-then-b-held] mismatch A cleared by two people (slip free); the stored bytes become different bytes B and the recon runs: the slip is held again, the flag list says reopened, a new two-person clearance releases it", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);
    for (const id of flagged.flagIds)
      expect(await reopenedOf(id), "cleared and unchanged").toBe(false);

    // The same wrong state again: the clearance still stands (no change, no new hold).
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "A again, same bytes: free",
    ).toBe(false);

    // The bytes are replaced by other wrong bytes: a different problem.
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "mismatch B is not what two people cleared: held again",
    ).toBe(true);
    const reopened = await Promise.all(flagged.flagIds.map(reopenedOf));
    expect(reopened, "the flag list says reopened").toContain(true);

    // Control: a NEW two-person clearance for B releases it, and B again changes nothing.
    await clearReopened(flagged);
    expect(await heldBySql(flagged.payslipId), "B cleared: free").toBe(false);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "B again: still free").toBe(
      false,
    );
  });

  it("[1038-evidence-recover-then-again-held] mismatch A cleared; the file recovers (recon runs, slip stays free); mismatch A comes back: held again, and a new clearance is needed", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);

    recoverProof(w.key);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "recovery alone does not hold the released slip",
    ).toBe(false);

    setProof(w.key, BYTES_A);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "the same problem is back after a recovery: a new episode, held again",
    ).toBe(true);
    expect(
      await Promise.all(flagged.flagIds.map(reopenedOf)),
      "reopened",
    ).toContain(true);

    await clearReopened(flagged);
    expect(await heldBySql(flagged.payslipId), "cleared anew: free").toBe(
      false,
    );
  });

  it("[1038-evidence-missing-recover-missing-held] a missing proof cleared by two people; the file reappears and recovers (slip free); it goes missing again: held again", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(w, "missing", "evidence_missing");
    await clearAll(flagged);

    recoverProof(w.key);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "recovered: free").toBe(false);

    setProof(w.key, "missing");
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "missing again: the old clearance does not cover the new loss",
    ).toBe(true);

    await clearReopened(flagged);
    expect(await heldBySql(flagged.payslipId), "cleared anew: free").toBe(
      false,
    );
  });

  it("[1038-evidence-recovery-alone-stays-free] control: mismatch A cleared, then the file simply recovers, the recon runs twice: the slip stays free and the flag is not reopened", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);

    recoverProof(w.key);
    await runRecon();
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "recovered: free").toBe(false);
    for (const id of flagged.flagIds)
      expect(await reopenedOf(id), "recovery does not reopen").toBe(false);
  });

  it("[1038-evidence-uncleared-stays-held] a flag nobody cleared stays held when the bytes change from A to B (no release by the change)", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
    recoverProof(w.key);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "recovery alone is not a clearance: still held",
    ).toBe(true);
  });

  it("[1038-evidence-a-b-a-without-ok-held] mismatch A cleared; the bytes become B and then A again with no recovery between: the old clearance of A never releases the slip again (every new problem row changes the fingerprint)", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await clearAll(flagged);

    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "B: held").toBe(true);
    setProof(w.key, BYTES_A);
    await runRecon();
    expect(
      await heldBySql(flagged.payslipId),
      "A again after B, no recovery: not what two people cleared, held",
    ).toBe(true);
    expect(
      await Promise.all(flagged.flagIds.map(reopenedOf)),
      "reopened",
    ).toContain(true);
    await clearReopened(flagged);
    expect(await heldBySql(flagged.payslipId), "cleared anew: free").toBe(
      false,
    );
  });

  it("[1038-evidence-observe-by-app-role-never-releases] after B, a direct call of the observe function by the app role (A again, or the same B) cannot release the slip", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const [first] = await observationsOf(flagged.operationId);
    const shaA = first!.observed_sha256 as string;
    await clearAll(flagged);
    setProof(w.key, BYTES_B);
    await runRecon();
    expect(await heldBySql(flagged.payslipId), "B: held").toBe(true);
    const observe = (state: string, sha: string | null) =>
      appCall(
        `SELECT app.payout_recon_evidence_observe($1::uuid, $2::uuid, $3::text, $4::text)`,
        [W.tenantId, flagged.operationId, state, sha],
      );
    const again = await observe("mismatch", shaA);
    expect(again.code, again.message).toBeUndefined();
    expect(
      await heldBySql(flagged.payslipId),
      "A observed directly after B: still held",
    ).toBe(true);
    const missing = await observe("missing", null);
    expect(missing.code, missing.message).toBeUndefined();
    expect(await heldBySql(flagged.payslipId), "missing: still held").toBe(
      true,
    );
  });

  it("[1038-evidence-pending-clearance-bound] a clearance proposed for mismatch A cannot be approved after the bytes became B (PAYOUT-91 / 409), and the slip stays held", async () => {
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
    setProof(w.key, BYTES_B);
    await runRecon();
    for (const clearanceId of proposals) {
      const res = await approveHttp(approverA, clearanceId);
      expect(
        res.status,
        `approving a clearance of other evidence is refused: ${detail(res)}`,
      ).toBe(409);
    }
    expect(await heldBySql(flagged.payslipId), "still held").toBe(true);
  });
});

// =========================================================================
// Another tenant, and the observation history
// =========================================================================

describe("1038 finding 4: tenants and the observation history", () => {
  it("[1038-evidence-tenant-isolated] a change of evidence in this tenant holds this tenant's slip and leaves the other tenant's flag (same operation id) and observations untouched", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    const [mineFlag] = (await exceptionRows(w.itemId)).filter(
      (f) => f.id === flagged.flagIds[0],
    );
    const foreignTenant = randomUUID();
    const foreignFlag = randomUUID();
    foreignTenants.push(foreignTenant);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 1038 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-1038-${foreignTenant.slice(0, 8)}`, W.tenantId],
      );
      // A flag of that tenant on the same operation id and item id (a copy of mine; FKs are off here).
      await c.query(
        `CREATE TEMP TABLE flag1038_copy ON COMMIT DROP AS
           SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, mineFlag!.id],
      );
      await c.query(`UPDATE flag1038_copy SET id = $1, tenant_id = $2`, [
        foreignFlag,
        foreignTenant,
      ]);
      await c.query(`INSERT INTO ${EXCEPTIONS} SELECT * FROM flag1038_copy`);
    }, true);
    // The live fingerprint of a flag, read in that tenant's own context.
    const fingerprintOf = async (tenantId: string, flagId: string) => {
      const client = await W.owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
        const { rows } = await client.query(
          `SELECT app.payout_recon_flag_fingerprint($1::uuid, $2::uuid) AS fp`,
          [tenantId, flagId],
        );
        await client.query("COMMIT");
        return JSON.stringify(rows[0]);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    const mineBefore = await fingerprintOf(W.tenantId, flagged.flagIds[0]!);
    const foreignBefore = await fingerprintOf(foreignTenant, foreignFlag);

    await clearAll(flagged);
    setProof(w.key, BYTES_B);
    await runRecon();

    expect(await heldBySql(flagged.payslipId), "this tenant: held again").toBe(
      true,
    );
    expect(
      await fingerprintOf(W.tenantId, flagged.flagIds[0]!),
      "this tenant: the live fingerprint follows the new evidence",
    ).not.toBe(mineBefore);
    expect(
      await fingerprintOf(foreignTenant, foreignFlag),
      "the other tenant: fingerprint untouched",
    ).toBe(foreignBefore);
    const foreignRows = await W.owner.query(
      `SELECT count(*)::int AS n FROM ${OBSERVATIONS} WHERE tenant_id = $1`,
      [foreignTenant],
    );
    expect(
      foreignRows.rows[0]!.n,
      "no observation row appears for the other tenant",
    ).toBe(0);
  });

  it("[1038-evidence-observation-history] the recon records one observation row per change of the evidence state (A, B, recovered, A again as a new episode), none for an unchanged re-run; the app role may read but never write them", async () => {
    const w = await correctedWorld();
    const flagged = await flaggedByEvidence(
      w,
      BYTES_A,
      "evidence_hash_mismatch",
    );
    await runRecon(); // unchanged: no extra row
    setProof(w.key, BYTES_B);
    await runRecon();
    recoverProof(w.key);
    await runRecon();
    setProof(w.key, BYTES_A);
    await runRecon();

    const rows = await observationsOf(flagged.operationId);
    expect(
      rows.map((r) => [r.state, r.episode]),
      JSON.stringify(rows),
    ).toEqual([
      ["mismatch", 1],
      ["mismatch", 1],
      ["ok", 1],
      ["mismatch", 2],
    ]);
    expect(rows[0]!.observed_sha256).toMatch(HEX64);
    expect(rows[1]!.observed_sha256).toMatch(HEX64);
    expect(rows[1]!.observed_sha256, "A and B are different bytes").not.toBe(
      rows[0]!.observed_sha256,
    );
    expect(rows[3]!.observed_sha256, "A is the same bytes again").toBe(
      rows[0]!.observed_sha256,
    );
    expect(sha256(BYTES_A)).not.toBe(sha256(BYTES_B));

    const read = await appCall(
      `SELECT count(*)::int AS n FROM ${OBSERVATIONS} WHERE operation_id = $1`,
      [flagged.operationId],
    );
    expect(read.code, read.message).toBeUndefined();
    expect(read.rows[0]!.n, "the app role reads this tenant's rows").toBe(4);

    const insert = await appCall(
      `INSERT INTO ${OBSERVATIONS} (tenant_id, operation_id, state, observed_sha256, episode)
       VALUES ($1, $2, 'ok', NULL, 9)`,
      [W.tenantId, flagged.operationId],
    );
    expect(insert.code, `INSERT: ${insert.message}`).toBe(PRIVILEGE);
    const update = await appCall(
      `UPDATE ${OBSERVATIONS} SET state = 'ok' WHERE operation_id = $1`,
      [flagged.operationId],
    );
    expect(update.code, `UPDATE: ${update.message}`).toBe(PRIVILEGE);
    const del = await appCall(
      `DELETE FROM ${OBSERVATIONS} WHERE operation_id = $1`,
      [flagged.operationId],
    );
    expect(del.code, `DELETE: ${del.message}`).toBe(PRIVILEGE);
    expect(
      (await observationsOf(flagged.operationId)).length,
      "rows unchanged",
    ).toBe(4);
  });
});
