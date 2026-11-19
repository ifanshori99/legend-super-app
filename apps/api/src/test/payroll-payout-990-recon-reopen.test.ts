// Payout 990 phase 5, part A (bead legend-hklnq): a cleared recon flag stays
// cleared only while the flagged data is unchanged. Written fail-first from the
// brief (docs/briefs/990/phase5.md "Kontrak A"), NOT from the implementation.
//
// Rules proven (founder: when in doubt, limit the payment):
// - A flag carries a fingerprint of the data it flagged (the item, the
//   attestations of its operation, its GL postings), written as an insert-only
//   "sighting". The hold compares the LIVE fingerprint (brief phase 6, P2-2):
//   a flag holds the payslip unless an approved clearance carries exactly the
//   fingerprint the data has NOW. Data that changes after the approval holds the
//   slip again AT ONCE, without waiting for the recon ("reopened": true in the
//   flag list = an approved clearance exists but none matches the live data).
// - The recon finding the same key again with a DIFFERENT fingerprint adds a
//   sighting; with unchanged data it adds none (also for the REAL recon run
//   twice) and the slip stays free.
// - Only updated_at, the key version and sealed (_encrypted) columns changing
//   (a re-seal) never reopens a flag.
// - A clearance is bound to the fingerprint it was proposed for: when the data
//   changed between propose and approve, approve is refused (SQL PAYOUT-91,
//   HTTP 409 PAYOUT_RECON_FLAG_CHANGED), nothing changes, the slip stays held.
//   A new proposal (new fingerprint) by one person and approval by another
//   releases the slip again.
// - The app role cannot write the sightings; another tenant is not affected.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Where the test only needs "a flag", "the recon runs again" is simulated, as
//   the 990 recon-clear test does, by the owner calling the trusted flag function
//   app.payout_recon_flag with the SAME key (tenant, 'correction', operation,
//   item, reason). Two tests ("real recon") instead build a corrected item,
//   delete its journal (the 905 forgery) and let the real night run
//   (reconcileTrustedPayouts) raise the flag; there I assume the item has exactly
//   the flags the run raises and clear every one of them.
//   The data change is made by the table owner with guards off: a non-volatile
//   item column (last_response_code), or a new attestation row for the flag's
//   operation. NO recon runs between such a change and the "held again" check:
//   the hold must follow the live data (phase 6).
// - "Held" is probed two ways: the SQL helper app.payout_payslip_held_by_recon
//   (tenant, payslip) and, where no earlier batch exists, a follow-up batch of
//   the failed slip (refused 409 while held, accepted once released).
// - The flag list is GET /api/hris/payroll/payout-recon-flags (990 i2 contract);
//   its row is found by `id` anywhere in the body, so the exact nesting does not
//   matter; `reopened` is a boolean on it (brief: PayoutReconFlagDto.reopened).
// - The sightings table is payroll_payout_recon_flag_sightings (tenant_id,
//   exception_id, flag_sha256, seen_at). A SQL refusal of the app role is 42501.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import {
  actorOf,
  bank,
  BUDI,
  APP,
  APP3,
  REQ,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("990reopen");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const REASON = "Sudah dicek manual, jurnal dan bukti bank cocok semuanya";
const SECOND_REASON =
  "Data berubah, dicek ulang dari awal: jurnal dan bank cocok";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const GRANTS = "payroll_payout_grants";
const ATTESTATIONS = "payroll_payout_attestations";
const PRIVILEGE = "42501";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

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
    [W.tenantId, `Template ${key} 990reopen`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in finance person (tenant-level template role, approve permission), TOTP enrolled in this session. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Reopen990 ${label}`);
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
let approverB: Person;

// ---- HTTP ----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const proposeHttp = (
  who: Person,
  flagId: string,
  body: Record<string, unknown> = { reason: REASON, password: PASSWORD },
) =>
  who.client
    .post(`${FLAGS}/${flagId}/clearance`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const approveHttp = (
  who: Person,
  clearanceId: string,
  body: Record<string, unknown> = { password: PASSWORD },
) =>
  who.client
    .post(`${CLEARANCES}/${clearanceId}/approve`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const listFlagsHttp = (who: Person) =>
  who.client.get(FLAGS) as unknown as Promise<Res>;

const clearanceIdOf = (res: Res) => {
  const id = res.body.data?.clearanceId ?? res.body.clearanceId;
  expect(id, `the response carries clearanceId: ${detail(res)}`).toBeTruthy();
  return id as string;
};

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

// ---- Raw SQL (legend_app, grantor stand-in) ------------------------------------------------

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

/** A recon_clear grant of the grantor stand-in (method password), bound as in brief I1. */
async function issueGrant(input: {
  step: "propose" | "approve";
  userId: string;
  batchId: string;
  refId: string;
  detail: string;
}): Promise<{ grant?: string; message: string }> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_payout_grantor");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      W.tenantId,
    ]);
    try {
      const { rows } = await client.query(
        `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text) AS grant`,
        [
          "recon_clear",
          input.step,
          input.batchId,
          "{}",
          null,
          input.refId,
          null,
          input.detail,
          input.userId,
          actorOf(input.userId).sessionId,
          "password",
        ],
      );
      await client.query("COMMIT");
      return { grant: (rows[0] as { grant: string }).grant, message: "" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return { message: (error as { message?: string }).message ?? "" };
    }
  } finally {
    client.release();
  }
}

const PROPOSE_SQL = `SELECT app.payout_recon_clear_propose($1::uuid, $2::text, $3::text) AS id`;
const APPROVE_SQL = `SELECT app.payout_recon_clear_approve($1::uuid, $2::text) AS id`;

// ---- Observations --------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const clearancesOf = (flagId: string) =>
  W.rowsOf(
    `SELECT * FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1 AND exception_id = $2 ORDER BY proposed_at, id`,
    [W.tenantId, flagId],
  );
const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const sightingsOf = (flagId: string) =>
  W.rowsOf(
    `SELECT * FROM ${SIGHTINGS} WHERE tenant_id = $1 AND exception_id = $2 ORDER BY seen_at, id`,
    [W.tenantId, flagId],
  );
/** The SQL test of "held" the item guard uses. */
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
// ---- Worlds --------------------------------------------------------------------------------

/** The only item was closed `failed` by two people: its slip may get a follow-up batch. */
async function failedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, "premise: failed").toBe("failed");
  return { runId, batchId, itemId };
}

/** The night run flags the item (the owner calls the trusted flag function). */
const FLAG_REASON = "recon test: forged transition";
const flagCall = (itemId: string, operation: string) =>
  W.asTenant(
    (c) =>
      c.query(`SELECT app.payout_recon_flag($1, 'correction', $2, $3, $4)`, [
        W.tenantId,
        operation,
        itemId,
        FLAG_REASON,
      ]),
    true,
  );

async function flaggedWorld() {
  const world = await failedWorld();
  const operation = randomUUID();
  await flagCall(world.itemId, operation);
  const rows = await exceptionRows(world.itemId);
  expect(rows.length, "premise: the flag is on record").toBeGreaterThan(0);
  const flagId = rows[0]!.id as string;
  return {
    ...world,
    flagId,
    operation,
    payslipId: rows[0]!.payslip_id as string,
  };
}

type World = Awaited<ReturnType<typeof flaggedWorld>>;

const followUpBatch = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
const batchCount = (runId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  );
/** The follow-up batch is refused (409) and no batch appears. */
async function expectHeld(runId: string, label: string) {
  const before = await batchCount(runId);
  await W.expectRefused(followUpBatch(runId), { status: 409 });
  expect(await batchCount(runId), `${label}: no new batch`).toBe(before);
}
/** The follow-up batch is accepted: the slip is free. */
async function expectReleased(runId: string, label: string) {
  const before = await batchCount(runId);
  const failure = await W.httpFailure(followUpBatch(runId));
  expect(failure, `${label}: the slip can get a new batch`).toBeNull();
  expect(await batchCount(runId), `${label}: one new batch`).toBe(before + 1);
}

/** Propose over HTTP; returns the clearance id. */
async function proposedBy(who: Person, flagId: string, reason = REASON) {
  const res = await proposeHttp(who, flagId, { reason, password: PASSWORD });
  expect(res.status, `premise: propose ${detail(res)}`).toBe(201);
  return clearanceIdOf(res);
}
/** The two-person clearance of the flag as it is now. */
async function clearedBy(flagId: string) {
  const clearanceId = await proposedBy(proposer, flagId);
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
  return clearanceId;
}

// ---- Data changes (table owner, guards off) -----------------------------------------------

/** A non-volatile column of the flagged item changes: the flagged data is not what it was. */
const changeItemData = (itemId: string, value = "FORGED-01") =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_items SET last_response_code = $3
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId, value],
      ),
    true,
  );
/** An attestation appears for the operation of the flag. */
const addAttestation = (w: World) =>
  W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO ${ATTESTATIONS}
           (tenant_id, kind, operation_id, step, batch_id, item_ids, actor, session_id,
            session_created_at, mfa_verified_at, grant_id)
         VALUES ($1, 'correction', $2, 'propose', $3, ARRAY[$4::uuid], 'forged-actor',
                 'forged-session', now(), now(), $5)`,
        [W.tenantId, w.operation, w.batchId, w.itemId, randomUUID()],
      ),
    true,
  );

// ---- The recon (adapter of the 905 recon test: one page per call) --------------------------

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
  const { storage } = W.proofs();
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- Real recon worlds (the 905 forgery: a corrected item whose journal is gone) ------------

/** A corrected item: failed, then corrected by two different people over one proof. */
async function correctedWorld() {
  const w = await failedWorld();
  const key = uploadEvidence(w.batchId, `reopen-${randomUUID()}.pdf`);
  for (const who of [proposer, approverA]) {
    const res = (await who.client
      .post(
        `/api/hris/payroll/disbursement-batches/${w.batchId}/correct-failed`,
      )
      .set(originHeader)
      .send({
        itemIds: [w.itemId],
        evidenceKey: key,
        note: "Mutasi bank menunjukkan transfer ternyata berhasil",
        password: PASSWORD,
      })) as unknown as Res;
    expect([200, 201], `correct-failed ${detail(res)}`).toContain(res.status);
  }
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, w.itemId],
  );
  expect(item!.status, "premise: corrected").toBe("succeeded");
  return w;
}

/** The journal of the item's transition is deleted (owner, guards off). */
async function dropJournalOf(itemId: string) {
  const [row] = await W.rowsOf(
    `SELECT p.journal_key FROM payroll_payout_gl_postings p
      WHERE p.tenant_id = $1
        AND p.id = COALESCE(
              (SELECT i.gl_posting_id FROM payroll_disbursement_items i
                WHERE i.tenant_id = $1 AND i.id = $2),
              (SELECT p2.id FROM payroll_payout_gl_postings p2
                WHERE p2.tenant_id = $1 AND p2.batch_id =
                      (SELECT i.batch_id FROM payroll_disbursement_items i
                        WHERE i.tenant_id = $1 AND i.id = $2)
                ORDER BY p2.posted_at DESC LIMIT 1))`,
    [W.tenantId, itemId],
  );
  expect(
    row?.journal_key,
    "premise: the transition has a journal",
  ).toBeTruthy();
  const key = row!.journal_key as string;
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
         (SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2)`,
      [W.tenantId, key],
    );
    await c.query(
      `DELETE FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
      [W.tenantId, key],
    );
  }, true);
}

/** A flag raised by the REAL night run: returns every flag of the item. */
async function realFlaggedWorld() {
  const w = await correctedWorld();
  await runRecon();
  expect(
    await exceptionRows(w.itemId),
    "control: an untouched corrected item is not flagged",
  ).toHaveLength(0);
  await dropJournalOf(w.itemId);
  await runRecon();
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the real run flagged the item",
  ).toBeGreaterThan(0);
  return {
    ...w,
    flagIds: flags.map((f) => f.id as string),
    payslipId: flags[0]!.payslip_id as string,
  };
}
type RealWorld = Awaited<ReturnType<typeof realFlaggedWorld>>;

const sightingTotal = async (w: RealWorld) =>
  (await Promise.all(w.flagIds.map((id) => sightingsOf(id)))).flat().length;
const clearAll = async (w: RealWorld) => {
  for (const id of w.flagIds) await clearedBy(id);
};

// ---- Setup / teardown ----------------------------------------------------------------------

/** Sightings are insert-only: remove those of this file as the owner with guards off (the table may not exist yet). */
async function dropSightings(tenantIds: string[]) {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${SIGHTINGS}') IS NOT NULL AS found`,
  );
  if (!exists!.found) return;
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM ${SIGHTINGS} WHERE tenant_id = ANY($1::uuid[])`, [
        tenantIds,
      ]),
    true,
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approverA = await makePerson("Approver A", "finance");
  approverB = await makePerson("Approver B", "finance");
});

afterEach(async () => {
  await dropSightings([W.tenantId, ...foreignTenants]);
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    await c.query(
      `DELETE FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'recon_clear'`,
      [W.tenantId],
    );
    await c.query(
      `DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND actor = 'forged-actor'`,
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
// 1: changed data reopens a cleared flag
// =========================================================================

describe("990 phase 5 A: a cleared flag reopens when the flagged data changes", () => {
  it("[legend-hklnq-reopen-item-changed] after the two-person clearance releases the slip, the flagged item changes and the recon finds the key again: a second sighting, the slip is held again (a new batch is refused), the flag list says reopened", async () => {
    const w = await flaggedWorld();
    expect(
      await sightingsOf(w.flagId),
      "premise: the first finding wrote one sighting",
    ).toHaveLength(1);
    expect(await heldBySql(w.payslipId), "premise: flagged is held").toBe(true);

    await clearedBy(w.flagId);
    expect(await heldBySql(w.payslipId), "premise: cleared is free").toBe(
      false,
    );
    expect(await reopenedOf(w.flagId), "cleared and unchanged").toBe(false);

    // Phase 6: NO recon yet. The hold already follows the live data.
    await changeItemData(w.itemId);
    expect(await heldBySql(w.payslipId), "held at once, before any recon").toBe(
      true,
    );
    expect(await reopenedOf(w.flagId), "reopened at once").toBe(true);
    await expectHeld(w.runId, "changed data holds the slip before the recon");
    expect(
      await sightingsOf(w.flagId),
      "nothing ran, so still one sighting",
    ).toHaveLength(1);

    await flagCall(w.itemId, w.operation);

    const sightings = await sightingsOf(w.flagId);
    expect(sightings, "a different fingerprint adds a sighting").toHaveLength(
      2,
    );
    expect(sightings[0]!.flag_sha256).toMatch(HEX64);
    expect(sightings[1]!.flag_sha256).toMatch(HEX64);
    expect(sightings[1]!.flag_sha256).not.toBe(sightings[0]!.flag_sha256);
    expect(
      await exceptionRows(w.itemId),
      "the flag row itself is still one (insert-only key)",
    ).toHaveLength(1);

    expect(await heldBySql(w.payslipId), "held again").toBe(true);
    await expectHeld(w.runId, "the changed data holds the slip again");
    expect(await reopenedOf(w.flagId)).toBe(true);
  });

  it("[legend-hklnq-reopen-attestation-added] a new attestation for the operation of the flag also changes the fingerprint: reopened and held again", async () => {
    const w = await flaggedWorld();
    await clearedBy(w.flagId);
    expect(await heldBySql(w.payslipId), "premise: free").toBe(false);

    await addAttestation(w);
    // Phase 6: held again before any recon.
    expect(await heldBySql(w.payslipId), "held at once").toBe(true);
    expect(await reopenedOf(w.flagId), "reopened at once").toBe(true);
    await expectHeld(w.runId, "a new attestation holds the slip at once");
    await flagCall(w.itemId, w.operation);

    expect(await sightingsOf(w.flagId)).toHaveLength(2);
    expect(await heldBySql(w.payslipId)).toBe(true);
    await expectHeld(w.runId, "a new attestation holds the slip again");
    expect(await reopenedOf(w.flagId)).toBe(true);
  });

  it("[legend-hklnq-reopen-unchanged-no-sighting] the recon finding the same key with unchanged data adds no sighting; the slip stays free and the flag is not reopened", async () => {
    const w = await flaggedWorld();
    await clearedBy(w.flagId);
    expect(await sightingsOf(w.flagId)).toHaveLength(1);

    await flagCall(w.itemId, w.operation);
    await runRecon();

    expect(await sightingsOf(w.flagId), "no new sighting").toHaveLength(1);
    expect(await exceptionRows(w.itemId)).toHaveLength(1);
    expect(await heldBySql(w.payslipId)).toBe(false);
    expect(await reopenedOf(w.flagId)).toBe(false);
    await expectReleased(w.runId, "unchanged data keeps the slip free");
  });

  it("[legend-hklnq-reopen-reseal-ignored] only updated_at, the key version and a sealed column changing (a re-seal) does not reopen the flag", async () => {
    const w = await flaggedWorld();
    await clearedBy(w.flagId);

    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_items
              SET updated_at = now() + interval '3 hours',
                  pii_key_version = pii_key_version + 1,
                  inquiry_account_name_encrypted = '\\xdeadbeef'::bytea
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.itemId],
        ),
      true,
    );
    await flagCall(w.itemId, w.operation);

    expect(await sightingsOf(w.flagId), "no new sighting").toHaveLength(1);
    expect(await heldBySql(w.payslipId)).toBe(false);
    expect(await reopenedOf(w.flagId)).toBe(false);
    await expectReleased(w.runId, "a re-seal keeps the slip free");
  });
});

// =========================================================================
// 2: a clearance is bound to the fingerprint it was proposed for
// =========================================================================

describe("990 phase 5 A: approve refuses when the flagged data changed after the proposal", () => {
  it("[legend-hklnq-approve-changed-http] data changes between propose and approve: approve is 409 PAYOUT_RECON_FLAG_CHANGED, the clearance stays unapproved, the slip stays held; a new proposal by one person and approval by another releases it", async () => {
    const w = await flaggedWorld();
    const stale = await proposedBy(proposer, w.flagId);

    await changeItemData(w.itemId);
    const refused = await approveHttp(approverA, stale);
    expect(refused.status, detail(refused)).toBe(409);
    expect(detail(refused)).toContain("PAYOUT_RECON_FLAG_CHANGED");
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    expect(await heldBySql(w.payslipId)).toBe(true);
    await expectHeld(w.runId, "a stale clearance does not release");

    // The recon sees the new data: a new fingerprint, so a new proposal is allowed.
    await flagCall(w.itemId, w.operation);
    expect(await sightingsOf(w.flagId)).toHaveLength(2);
    const fresh = await proposedBy(approverA, w.flagId, SECOND_REASON);
    expect(fresh, "a new clearance for the new fingerprint").not.toBe(stale);
    expect(
      new Set((await clearancesOf(w.flagId)).map((c) => c.flag_sha256)).size,
      "each clearance carries its own fingerprint",
    ).toBe(2);

    // The stale one still cannot be approved, the fresh one can (by someone else).
    const staleAgain = await approveHttp(approverB, stale);
    expect(staleAgain.status, detail(staleAgain)).toBe(409);
    const ok = await approveHttp(approverB, fresh);
    expect(ok.status, detail(ok)).toBe(200);
    expect(await heldBySql(w.payslipId)).toBe(false);
    expect(await reopenedOf(w.flagId)).toBe(false);
    await expectReleased(w.runId, "released by the clearance of the new data");
  });

  it("[legend-hklnq-approve-changed-sql] in SQL as legend_app: approve after the data changed is refused with PAYOUT-91; nothing is approved and the slip stays held", async () => {
    const w = await flaggedWorld();
    const grantP = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: w.flagId,
      detail: sha256(REASON),
    });
    expect(grantP.grant, `propose grant: ${grantP.message}`).toBeTruthy();
    const proposal = await appCall(PROPOSE_SQL, [
      w.flagId,
      grantP.grant!,
      REASON,
    ]);
    expect(proposal.code, proposal.message).toBeUndefined();
    const clearanceId = proposal.rows[0]!.id as string;

    await changeItemData(w.itemId);
    const grantA = await issueGrant({
      step: "approve",
      userId: approverA.userId,
      batchId: w.batchId,
      refId: clearanceId,
      detail: sha256(REASON),
    });
    expect(grantA.grant, `approve grant: ${grantA.message}`).toBeTruthy();
    const out = await appCall(APPROVE_SQL, [clearanceId, grantA.grant!]);
    expect(out.code, "the stale approval must be refused").toBeDefined();
    expect(out.message).toMatch(/PAYOUT-91/);
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    expect(await heldBySql(w.payslipId)).toBe(true);
    await expectHeld(w.runId, "a stale approval does not release");
  });

  it("[legend-hklnq-propose-idempotent-per-fingerprint] proposing again for the same fingerprint returns the open clearance; after a data change the same flag takes a second clearance", async () => {
    const w = await flaggedWorld();
    const first = await proposedBy(proposer, w.flagId);
    const again = await proposeHttp(proposer, w.flagId);
    expect(again.status, detail(again)).toBeLessThan(300);
    expect(clearanceIdOf(again), "the open clearance comes back").toBe(first);
    expect(await clearancesOf(w.flagId)).toHaveLength(1);

    await changeItemData(w.itemId);
    await flagCall(w.itemId, w.operation);
    const second = await proposedBy(proposer, w.flagId, SECOND_REASON);
    expect(second).not.toBe(first);
    expect(await clearancesOf(w.flagId)).toHaveLength(2);
  });
});

// =========================================================================
// 3: sightings are insert-only and per tenant
// =========================================================================

describe("990 phase 5 A: the sightings table", () => {
  it("[legend-hklnq-sightings-app-readonly] legend_app can read the sightings of its tenant but cannot INSERT, UPDATE or DELETE them (42501); the rows are unchanged", async () => {
    const w = await flaggedWorld();
    const before = JSON.stringify(await sightingsOf(w.flagId));
    expect(before, "premise: a sighting exists").not.toBe("[]");

    const read = await appCall(
      `SELECT flag_sha256 FROM ${SIGHTINGS} WHERE exception_id = $1`,
      [w.flagId],
    );
    expect(read.code, read.message).toBeUndefined();
    expect(read.rows).toHaveLength(1);

    const insert = await appCall(
      `INSERT INTO ${SIGHTINGS} (tenant_id, exception_id, flag_sha256) VALUES ($1, $2, $3)`,
      [W.tenantId, w.flagId, "a".repeat(64)],
    );
    expect(insert.code, `INSERT: ${insert.message}`).toBe(PRIVILEGE);
    const update = await appCall(
      `UPDATE ${SIGHTINGS} SET flag_sha256 = $3 WHERE tenant_id = $1 AND exception_id = $2`,
      [W.tenantId, w.flagId, "b".repeat(64)],
    );
    expect(update.code, `UPDATE: ${update.message}`).toBe(PRIVILEGE);
    const del = await appCall(
      `DELETE FROM ${SIGHTINGS} WHERE tenant_id = $1 AND exception_id = $2`,
      [W.tenantId, w.flagId],
    );
    expect(del.code, `DELETE: ${del.message}`).toBe(PRIVILEGE);

    expect(JSON.stringify(await sightingsOf(w.flagId))).toBe(before);
    expect(await heldBySql(w.payslipId), "still held").toBe(true);
  });

  it("[legend-hklnq-sightings-tenant-isolated] another tenant's sighting is not visible to this tenant, and a change in this tenant leaves the other tenant's flag and sightings untouched", async () => {
    const mine = await flaggedWorld();
    const foreignTenant = randomUUID();
    const foreignFlag = randomUUID();
    const foreignSha = "c".repeat(64);
    foreignTenants.push(foreignTenant);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 990 reopen tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-990r-${foreignTenant.slice(0, 8)}`, W.tenantId],
      );
      await c.query(
        `CREATE TEMP TABLE flag990r_copy ON COMMIT DROP AS
           SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, mine.flagId],
      );
      await c.query(`UPDATE flag990r_copy SET id = $1, tenant_id = $2`, [
        foreignFlag,
        foreignTenant,
      ]);
      await c.query(`INSERT INTO ${EXCEPTIONS} SELECT * FROM flag990r_copy`);
      await c.query(
        `INSERT INTO ${SIGHTINGS} (tenant_id, exception_id, flag_sha256) VALUES ($1, $2, $3)`,
        [foreignTenant, foreignFlag, foreignSha],
      );
    }, true);
    const foreignState = () =>
      W.owner
        .query(
          `SELECT (SELECT count(*) FROM ${SIGHTINGS} WHERE exception_id = $1)::int AS sightings,
                  (SELECT flag_sha256 FROM ${SIGHTINGS} WHERE exception_id = $1 LIMIT 1) AS sha`,
          [foreignFlag],
        )
        .then((r) => JSON.stringify(r.rows[0]));
    const foreignBefore = await foreignState();
    expect(foreignBefore, "premise: the foreign sighting exists").toContain(
      foreignSha,
    );

    const seen = await appCall(
      `SELECT exception_id FROM ${SIGHTINGS} WHERE exception_id = $1`,
      [foreignFlag],
    );
    expect(seen.code, seen.message).toBeUndefined();
    expect(seen.rows, "RLS hides the other tenant's sighting").toHaveLength(0);

    await clearedBy(mine.flagId);
    await changeItemData(mine.itemId);
    await flagCall(mine.itemId, mine.operation);
    expect(await sightingsOf(mine.flagId)).toHaveLength(2);
    expect(await foreignState(), "the other tenant is untouched").toBe(
      foreignBefore,
    );
  });
});

// =========================================================================
// 4: the real recon, and the hold that follows the live data
// =========================================================================

describe("990 phase 6: real recon and the live fingerprint", () => {
  it("[legend-hklnq-real-recon-twice-no-new-sighting] the real night run flags a forged item once; running it again, before and after the clearance, adds no sighting and no flag", async () => {
    const w = await realFlaggedWorld();
    const flagCount = w.flagIds.length;
    const firstSightings = await sightingTotal(w);
    expect(firstSightings, "one sighting per flag").toBe(flagCount);
    expect(await heldBySql(w.payslipId), "premise: flagged is held").toBe(true);

    await runRecon();
    await runRecon();
    expect(await sightingTotal(w), "unchanged data, no new sighting").toBe(
      firstSightings,
    );
    expect(await exceptionRows(w.itemId), "no new flag").toHaveLength(
      flagCount,
    );

    await clearAll(w);
    expect(await heldBySql(w.payslipId), "cleared is free").toBe(false);

    await runRecon();
    expect(await sightingTotal(w), "no sighting after the clearance").toBe(
      firstSightings,
    );
    expect(await exceptionRows(w.itemId)).toHaveLength(flagCount);
    expect(await heldBySql(w.payslipId), "the slip stays free").toBe(false);
    for (const id of w.flagIds) expect(await reopenedOf(id)).toBe(false);
  });

  it("[legend-hklnq-live-hold-without-recon] a clearance is approved, the flagged data changes and NO recon runs: the payslip is held at once (helper true, a new batch is 409) and the flag list says reopened; a later real recon adds the new sighting and the slip stays held", async () => {
    const w = await realFlaggedWorld();
    await clearAll(w);
    expect(await heldBySql(w.payslipId), "premise: cleared is free").toBe(
      false,
    );
    const before = await sightingTotal(w);

    await changeItemData(w.itemId);

    expect(await heldBySql(w.payslipId), "held at once").toBe(true);
    for (const id of w.flagIds)
      expect(await reopenedOf(id), "reopened at once").toBe(true);
    expect(
      await sightingTotal(w),
      "the recon has not run: no new sighting yet",
    ).toBe(before);
    // The corrected slip is paid anyway, so a follow-up batch would be refused for
    // another reason; the 409 on a failed slip is proven in section 1.

    await runRecon();
    expect(
      await sightingTotal(w),
      "the recon sees the new fingerprint",
    ).toBeGreaterThan(before);
    expect(await heldBySql(w.payslipId), "still held").toBe(true);
    for (const id of w.flagIds) expect(await reopenedOf(id)).toBe(true);
  });
});

// =========================================================================
// 5: raising known flags again never fails the page
// =========================================================================

describe("990 phase 6: raising known flags again is chunked and cannot fail the page", () => {
  it("[legend-hklnq-reraise-failure-page-ok] raising a known flag again fails (the sighting insert is refused): the new flag is still written, the page result succeeds, reraiseFailed counts the known flags", async () => {
    const w = await realFlaggedWorld();
    const w2 = await correctedWorld();
    await dropJournalOf(w2.itemId);
    expect(
      await exceptionRows(w2.itemId),
      "premise: the second item is not flagged yet",
    ).toHaveLength(0);
    await changeItemData(w.itemId);

    const guard = `reraise_block_${randomUUID().replaceAll("-", "")}`;
    const ids = w.flagIds.map((id) => `'${id}'`).join(",");
    await W.asTenant(async (c) => {
      await c.query(
        `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: sighting refused'; END $$`,
      );
      await c.query(
        `CREATE TRIGGER ${guard} BEFORE INSERT ON ${SIGHTINGS} FOR EACH ROW WHEN (NEW.exception_id IN (${ids})) EXECUTE FUNCTION ${guard}()`,
      );
    }, true);
    try {
      const { reconcileTrustedPayouts } =
        await import("../services/payroll-payout-recon.service.ts");
      const { storage } = W.proofs();
      let flagged = 0;
      let reraised = 0;
      let reraiseFailed = 0;
      let after: string | null = null;
      for (let page = 0; page < 1000; page += 1) {
        const result: Awaited<ReturnType<typeof reconcileTrustedPayouts>> =
          await reconcileTrustedPayouts(W.scope(), { storage, after });
        flagged += result.flagged;
        reraised += result.reraised;
        reraiseFailed += result.reraiseFailed;
        if (result.last === null || result.exhausted) break;
        after = result.last;
      }
      expect(
        (await exceptionRows(w2.itemId)).length,
        "the new flag is written",
      ).toBeGreaterThan(0);
      expect(flagged, "the page counts the new flag").toBeGreaterThan(0);
      expect(reraiseFailed, "the known flags failed").toBeGreaterThanOrEqual(
        w.flagIds.length,
      );
      // One savepoint per row (legend-t1ufu): known flags of the page that are not
      // refused are raised again, so `reraised` may be above 0.
      expect(
        reraised + reraiseFailed,
        "every known flag of the page is counted, none lost",
      ).toBeGreaterThanOrEqual(w.flagIds.length);
    } finally {
      await W.asTenant(async (c) => {
        await c.query(`DROP TRIGGER IF EXISTS ${guard} ON ${SIGHTINGS}`);
        await c.query(`DROP FUNCTION IF EXISTS ${guard}()`);
      }, true);
    }
  });

  it("[legend-hklnq-reraise-chunks] 250 known flags are all raised again in chunks of 100 (each gets its new sighting); a bad row fails alone and the others still run", async () => {
    const { reraiseKnownFlags, PAYOUT_RECON_RERAISE_CHUNK } =
      await import("../services/payroll-payout-recon.service.ts");
    expect(PAYOUT_RECON_RERAISE_CHUNK).toBe(100);
    const w = await failedWorld();
    type Flags = Parameters<typeof reraiseKnownFlags>[1];
    const flags = Array.from({ length: 250 }, () => ({
      kind: "correction",
      operationId: randomUUID(),
      itemId: w.itemId,
      reason: FLAG_REASON,
    }));
    for (const flag of flags) await flagCall(w.itemId, flag.operationId);
    const rows = await exceptionRows(w.itemId);
    expect(rows, "premise: 250 flags on record").toHaveLength(250);
    const exceptionIds = rows.map((r) => r.id as string);
    const sightingCount = () =>
      count(
        `SELECT count(*) AS n FROM ${SIGHTINGS} WHERE tenant_id = $1 AND exception_id = ANY($2::uuid[])`,
        [W.tenantId, exceptionIds],
      );
    expect(await sightingCount(), "premise: one sighting each").toBe(250);

    await changeItemData(w.itemId);
    const done = await reraiseKnownFlags(W.scope(), flags as unknown as Flags);
    expect(done).toEqual({ reraised: 250, failed: 0 });
    expect(await sightingCount(), "every flag has its new sighting").toBe(500);

    const mixed = [
      flags[0]!,
      { ...flags[1]!, operationId: "not-a-uuid" },
      flags[2]!,
      flags[3]!,
    ];
    await changeItemData(w.itemId, "FORGED-02");
    const part = await reraiseKnownFlags(
      W.scope(),
      mixed as unknown as Flags,
      2,
    );
    expect(part, "the bad row fails alone (savepoint per row)").toEqual({
      reraised: 3,
      failed: 1,
    });
    expect(await sightingCount(), "the good chunk still wrote").toBeGreaterThan(
      500,
    );
  });
});
