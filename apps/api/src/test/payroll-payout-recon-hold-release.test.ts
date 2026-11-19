// Payout 1192 (bead legend-6o7pc, tier K: money): a hold of a recon flag that could
// not be written (payroll_payout_recon_unwritten_holds, migration 0709) can be
// released, but never by one person alone, and only when the recon evidence is
// clean. Written fail-first from docs/briefs/sub-1192-payout-hold-release.md
// (Part 1 and 2) and from the sibling tests payroll-payout-990-recon-clear and
// payroll-payout-t1ufu-reraise-failclosed, NOT from the implementation.
//
// Rules proven (founder: nobody is paid on one person's word; when in doubt the
// slip stays held; tenants never touch each other):
// - A hold is released by a proposal (reason 10..500 chars) of one person and the
//   approval of ANOTHER person, each with the account password and a fresh MFA
//   step-up. The proposer can never approve; an approved release cannot be
//   approved again; two approvals at once: exactly one wins.
// - A release is possible only when the latest recon evidence of the operation is
//   clean ('ok') AFTER the hold. Otherwise the slip stays held (409
//   PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN). A hold already taken over by a later
//   flag is refused (409 PAYOUT_RECON_HOLD_TAKEN_OVER): that flag and its own
//   clearance decide. The approval checks both again (it is the authoritative one).
// - Proposal alone keeps holding. Only an approved release lifts
//   app.payout_payslip_held_by_recon. Propose is idempotent (one row, one audit).
// - The app role cannot write the release table (42501). Another tenant's hold is
//   not found (404) and never listed.
// - Audit: payroll.disbursement.recon_hold_release_proposed / _approved. The finance
//   exceptions list shows a hold (kind payout_recon_hold) until it is taken over or
//   released.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Routes (brief Part 2), under /api/hris/payroll: GET /payout-recon-holds,
//   POST /payout-recon-holds/:holdId/release {reason, password} -> 201 and
//   {data:{releaseId}} (a repeat of the same proposal -> 200 or 201, same id),
//   POST /payout-recon-hold-releases/:releaseId/approve {password} -> 200.
//   The list is {data: PayoutReconHoldDto[]} (an array, or {items:[...]}).
// - Statuses as the clearance routes: no password 401, wrong password 403,
//   missing permission / not Owner or Finance Manager (PAYOUT-42) / self-approval
//   (PAYOUT-86) 403, approved already (PAYOUT-87) and 96/97 409, a hold of another
//   tenant 404, a reason that is too short or too long 400 or 422 (shared validator),
//   missing or stale MFA step-up 401 or 403. The 409 body carries error.code
//   PAYOUT_RECON_HOLD_TAKEN_OVER / PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN.
// - A new proposal for a hold that already has an approved release: 409.
// - Releasing does not need the SQL grant plumbing here: the raw grant functions of
//   release are not named in the brief, so SQL is exercised only through the table
//   privileges and the held-by function.
// - A hold of clean evidence is made like this: a clean run, a tampered run (flags
//   plus a not-ok observation), the flags cleared by two people, the hold made for
//   another reason (so no flag takes it over), then a clean run (an 'ok' observation
//   after the hold). A hold that a flag takes over: the hold has no reason and the
//   tampered run writes the flag afterwards.
// - The slip of a corrected item is already paid, so a follow-up batch cannot tell
//   the cause; the discriminating observation is app.payout_payslip_held_by_recon.
// - audit_logs rows are counted by action and by the hold or release id inside the
//   event, as a delta (audit rows are not removed).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
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

const W = installPayoutWorld("1192hold");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const REASON =
  "Bukti bank sudah bersih lagi, hold boleh dilepas oleh dua orang";
const OTHER_REASON =
  "Alasan lain yang diajukan oleh orang kedua untuk hold ini";
const FLAG_CLEAR_REASON =
  "Sudah dicek manual, berkas bukti sudah diperiksa ulang";
const LOCK_REASON = "evidence_read_locked:2031-01-01";
const HOLDS_URL = "/api/hris/payroll/payout-recon-holds";
const RELEASES_URL = "/api/hris/payroll/payout-recon-hold-releases";
const FLAGS_URL = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES_URL = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const OBSERVATIONS = "payroll_payout_recon_evidence_observations";
const HOLDS = "payroll_payout_recon_unwritten_holds";
const RELEASES = "payroll_payout_recon_hold_releases";
const CLEAN_READS = "payroll_payout_recon_hold_clean_reads";
const GRANTS = "payroll_payout_grants";
const BYTES_A = "1192 tampered proof bytes A";
const PROPOSED_ACTION = "payroll.disbursement.recon_hold_release_proposed";
const APPROVED_ACTION = "payroll.disbursement.recon_hold_release_approved";
const TAKEN_OVER = "PAYOUT_RECON_HOLD_TAKEN_OVER";
const NOT_CLEAN = "PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN";
const PRIVILEGE = "42501";
const TEST_TIMEOUT_MS = 120_000;

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
    [W.tenantId, `Template ${key} 1192`, key],
  );
  return (await read()).rows[0]!.id;
}

/**
 * A signed-in person. `template` is the tenant-wide Owner / Finance Manager role (null =
 * only a custom role with `permissions`), `enroll` = TOTP verified in this session
 * (a fresh MFA step-up).
 */
async function makePerson(
  label: string,
  template: "owner" | "finance" | null,
  options: { permissions?: string[]; enroll?: boolean } = {},
) {
  const { client, userId } = await W.signedInClient(`Hold1192 ${label}`);
  personIds.push(userId);
  await W.grantRole(
    userId,
    options.permissions ?? ["payroll.view", "payroll.disburse.approve"],
  );
  if (template) {
    const roleId = await templateRoleId(template);
    await W.owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId],
    );
  }
  if (options.enroll !== false) {
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
  }
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
  holdId: string,
  body: Record<string, unknown> = { reason: REASON, password: PASSWORD },
) =>
  who.client
    .post(`${HOLDS_URL}/${holdId}/release`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const approveHttp = (
  who: Person,
  releaseId: string,
  body: Record<string, unknown> = { password: PASSWORD },
) =>
  who.client
    .post(`${RELEASES_URL}/${releaseId}/approve`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;

const releaseIdOf = (res: Res) => {
  const data = (res.body.data ?? {}) as Row;
  const id = data.releaseId ?? data.id ?? res.body.releaseId;
  expect(
    id,
    `the response carries the release id: ${detail(res)}`,
  ).toBeTruthy();
  return id as string;
};
const errorCodeOf = (res: Res) => res.body.error?.code ?? res.body.code;

/** The holds the person sees (the list is an array, or an object with `items`). */
async function listHolds(who: Person): Promise<Row[]> {
  const res = (await who.client.get(HOLDS_URL)) as unknown as Res;
  expect(res.status, detail(res)).toBe(200);
  const data = res.body.data as unknown;
  const rows = Array.isArray(data)
    ? data
    : ((data as { items?: Row[] } | undefined)?.items ?? []);
  return rows as Row[];
}
async function listedHold(who: Person, holdId: string) {
  return (await listHolds(who)).find((h) => h.id === holdId);
}

/** Two-person clearance of a recon FLAG (existing 990 routes), used to make a free slip. */
async function clearFlag(flagId: string) {
  const proposed = (await proposer.client
    .post(`${FLAGS_URL}/${flagId}/clearance`)
    .set(originHeader)
    .send({ reason: FLAG_CLEAR_REASON, password: PASSWORD })) as unknown as Res;
  expect(proposed.status, `premise: flag propose ${detail(proposed)}`).toBe(
    201,
  );
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  const approved = (await approverA.client
    .post(`${CLEARANCES_URL}/${clearanceId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD })) as unknown as Res;
  expect(approved.status, `premise: flag approve ${detail(approved)}`).toBe(
    200,
  );
}

// ---- Raw SQL ---------------------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };
/** legend_app (optionally then `innerRole`) in the tenant's context, one statement, real COMMIT. */
async function sqlAs(
  sqlText: string,
  params: unknown[],
  innerRole?: string,
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
      if (innerRole) await client.query(`SET LOCAL ROLE ${innerRole}`);
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
const HOLD_SQL = `SELECT app.payout_recon_hold_unwritten($1::uuid, $2::text, $3::uuid, $4::uuid[], $5::text)`;
const holdUnwritten = (
  kind: string,
  operationId: string,
  itemIds: string[],
  reason: string | null,
) =>
  sqlAs(
    HOLD_SQL,
    [W.tenantId, kind, operationId, itemIds, reason],
    "legend_payout_recon",
  );

// ---- Observations --------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );
const holdRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${HOLDS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY created_at, id`,
    [W.tenantId, itemId],
  );
const releaseRows = (holdId: string) =>
  W.rowsOf(
    `SELECT * FROM ${RELEASES} WHERE tenant_id = $1 AND hold_id = $2 ORDER BY proposed_at, id`,
    [W.tenantId, holdId],
  );
const releaseCount = () =>
  count(`SELECT count(*)::int AS n FROM ${RELEASES} WHERE tenant_id = $1`, [
    W.tenantId,
  ]);
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
async function lastState(operationId: string) {
  const rows = await W.rowsOf(
    `SELECT state FROM ${OBSERVATIONS} WHERE tenant_id = $1 AND operation_id = $2
      ORDER BY observed_at, id`,
    [W.tenantId, operationId],
  );
  return rows.length ? (rows[rows.length - 1]!.state as string) : undefined;
}
const auditCount = (action: string, ...ids: string[]) =>
  count(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS id WHERE event::text LIKE '%' || id || '%')`,
    [W.tenantId, action, ids],
  );
/** What a release must never move: paid items and payout journals. */
async function moneyOf() {
  return {
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND status = 'succeeded'`,
      [W.tenantId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId],
    ),
    batches: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE tenant_id = $1`,
      [W.tenantId],
    ),
  };
}
const changeItemData = (itemId: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_items SET last_response_code = $3
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId, "FORGED-1192"],
      ),
    true,
  );

// ---- A storage the test controls (tampered keys return other bytes) -----------------------

function makeStorage(tampered: string[] = []) {
  const base = W.proofs().storage;
  return {
    async get(context: unknown, input: { key: string }) {
      const object = await (
        base.get as (c: unknown, i: unknown) => Promise<Record<string, unknown>>
      )(context, input);
      return tampered.includes(input.key)
        ? { ...object, content: BYTES_A }
        : object;
    },
  };
}

type PageResult = { operations: number; last: string | null; held?: number };
/** The night run over all pages of the tenant. */
async function runRecon(storage: unknown) {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const run = mod.reconcileTrustedPayouts as (
    context: unknown,
    options: unknown,
  ) => Promise<PageResult>;
  expect(run, "the recon service exports reconcileTrustedPayouts").toBeTypeOf(
    "function",
  );
  let after: string | null = null;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- Worlds --------------------------------------------------------------------------------

/** A real corrected item with a stored proof; an untouched run does not flag it. */
async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evid1192-${randomUUID()}.pdf`);
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
  return { batchId, itemId, key, runId };
}
type Corrected = Awaited<ReturnType<typeof correctedWorld>>;
type HeldWorld = Corrected & {
  holdId: string;
  payslipId: string;
  operationId: string;
  kind: string;
};

/** Reads the operation of the item from the flags a tampered run writes. */
async function flaggedByTamper(w: Corrected) {
  await runRecon(makeStorage());
  await runRecon(makeStorage([w.key]));
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the tampered run flagged the item",
  ).toBeGreaterThan(0);
  return {
    flags,
    payslipId: flags[0]!.payslip_id as string,
    operationId: flags[0]!.operation_id as string,
    kind: flags[0]!.kind as string,
  };
}

async function makeHold(
  w: Corrected,
  ids: { kind: string; operationId: string; payslipId: string },
  reason: string | null,
): Promise<HeldWorld> {
  const made = await holdUnwritten(
    ids.kind,
    ids.operationId,
    [w.itemId],
    reason,
  );
  expect(made.code, `premise: hold call ${made.message}`).toBeUndefined();
  const rows = await holdRows(w.itemId);
  expect(rows, "premise: one hold row").toHaveLength(1);
  return { ...w, ...ids, holdId: rows[0]!.id as string };
}

/** Clean evidence after the hold: a release can be proposed. Also left: flags cleared by two people. */
async function cleanWorld(reason: string = LOCK_REASON): Promise<HeldWorld> {
  const w = await correctedWorld();
  const ids = await flaggedByTamper(w);
  for (const f of ids.flags) await clearFlag(f.id as string);
  const held = await makeHold(w, ids, reason);
  expect(await heldBySql(ids.payslipId), "premise: held by the hold").toBe(
    true,
  );
  await runRecon(makeStorage());
  expect(
    await lastState(ids.operationId),
    "premise: an 'ok' observation after the hold",
  ).toBe("ok");
  expect(await heldBySql(ids.payslipId), "premise: still held").toBe(true);
  return held;
}

/**
 * 1192 P1a: the operation's latest observation BEFORE the hold is already 'ok' (or there
 * is none), then a lock hold is made, then (optionally) a good read goes through the real
 * recon path. An 'ok' read after an 'ok' observation writes no new observation row, so
 * only a separate clean-read record can say "read after the hold".
 */
async function priorReadWorld(
  prior: "ok" | "none",
  readAfterHold: boolean,
): Promise<HeldWorld> {
  const w = await correctedWorld();
  const ids = await flaggedByTamper(w);
  if (prior === "ok") {
    for (const f of ids.flags) await clearFlag(f.id as string);
    await runRecon(makeStorage());
    expect(await lastState(ids.operationId), "premise: prior 'ok'").toBe("ok");
  } else {
    // No flag and no observation of this operation at all (like takenOverWorld).
    await resetRecon();
    expect(
      await lastState(ids.operationId),
      "premise: no observation",
    ).toBeUndefined();
  }
  const held = await makeHold(w, ids, LOCK_REASON);
  expect(await heldBySql(ids.payslipId), "premise: held by the hold").toBe(
    true,
  );
  if (readAfterHold) {
    await runRecon(makeStorage());
    // A first 'ok' (nothing observed before) writes no observation row: ok or none.
    expect(
      [prior === "ok" ? "ok" : undefined],
      "premise: the latest observation is ok or none",
    ).toContain(await lastState(ids.operationId));
  }
  return held;
}

/** A hold with no observation after it: the evidence is not clean. */
async function notCleanWorld(): Promise<HeldWorld> {
  const w = await correctedWorld();
  const ids = await flaggedByTamper(w);
  for (const f of ids.flags) await clearFlag(f.id as string);
  const held = await makeHold(w, ids, LOCK_REASON);
  expect(await heldBySql(ids.payslipId), "premise: held by the hold").toBe(
    true,
  );
  return held;
}

/** The hold is taken over by a flag written afterwards (the hold has no reason). */
async function takenOverWorld(): Promise<HeldWorld> {
  const w = await correctedWorld();
  const ids = await flaggedByTamper(w);
  await resetRecon();
  const held = await makeHold(w, ids, null);
  await runRecon(makeStorage([w.key]));
  expect(
    (await exceptionRows(w.itemId)).length,
    "premise: the tampered run wrote the flag after the hold",
  ).toBeGreaterThan(0);
  return held;
}

/** Propose over HTTP by `proposer`; returns the release id. */
async function proposed(holdId: string, who: Person = proposer) {
  const res = await proposeHttp(who, holdId);
  expect(res.status, `premise: propose ${detail(res)}`).toBe(201);
  return releaseIdOf(res);
}

// ---- Setup / teardown ----------------------------------------------------------------------

async function tableExists(name: string) {
  const [row] = await W.rowsOf(
    `SELECT to_regclass('public.${name}') IS NOT NULL AS found`,
  );
  return row!.found as boolean;
}

async function resetRecon() {
  const hasReleases = await tableExists(RELEASES);
  const hasHolds = await tableExists(HOLDS);
  const hasObservations = await tableExists(OBSERVATIONS);
  const hasCleanReads = await tableExists(CLEAN_READS);
  await W.asTenant(async (c) => {
    if (hasCleanReads)
      await c.query(`DELETE FROM ${CLEAN_READS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    if (hasReleases)
      await c.query(`DELETE FROM ${RELEASES} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    if (hasHolds)
      await c.query(`DELETE FROM ${HOLDS} WHERE tenant_id = $1`, [W.tenantId]);
    if (hasObservations)
      await c.query(`DELETE FROM ${OBSERVATIONS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    await c.query(`DELETE FROM ${SIGHTINGS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
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
      if (hasHolds)
        await c.query(`DELETE FROM ${HOLDS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
  }, true);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approverA = await makePerson("Approver A", "finance");
  approverB = await makePerson("Approver B", "finance");
});

afterEach(async () => {
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
// 1: two different people release a hold whose evidence is clean
// =========================================================================

describe("1192: a hold is released by two people", () => {
  it(
    "[1192-release-two-person-clean-evidence] one finance proposes with a reason, a different one approves, both with the password: the proposal alone keeps the slip held, the approval frees it (basis clean_evidence); the hold row stays (append-only); the list shows each status; no money moves",
    async () => {
      const w = await cleanWorld();
      const money = await moneyOf();

      const listed = await listedHold(proposer, w.holdId);
      expect(listed, "the hold is listed").toBeDefined();
      expect(listed!.itemId).toBe(w.itemId);
      expect(listed!.payslipId).toBe(w.payslipId);
      expect(listed!.batchId).toBe(w.batchId);
      expect(listed!.kind).toBe(w.kind);
      expect(listed!.reason).toBe(LOCK_REASON);
      expect(listed!.takenOver).toBe(false);
      expect(listed!.releasable, "clean evidence after the hold").toBe(true);
      expect(listed!.release).toBeNull();
      expect(typeof listed!.heldAt).toBe("string");

      const releaseId = await proposed(w.holdId);
      const [proposal] = await releaseRows(w.holdId);
      expect(proposal, "the proposal is on record").toBeDefined();
      expect(proposal!.id).toBe(releaseId);
      expect(proposal!.proposed_by).toBe(proposer.userId);
      expect(proposal!.reason).toBe(REASON);
      expect(proposal!.approved_by, "not approved yet").toBeNull();
      expect(proposal!.approved_at).toBeNull();
      expect(proposal!.basis, "no basis before the approval").toBeNull();
      expect(await heldBySql(w.payslipId), "a proposal alone still holds").toBe(
        true,
      );
      const afterPropose = await listedHold(approverA, w.holdId);
      expect(afterPropose!.release).toMatchObject({
        id: releaseId,
        status: "proposed",
        reason: REASON,
        proposedBy: proposer.userId,
        approvedBy: null,
        approvedAt: null,
      });

      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      const [done] = await releaseRows(w.holdId);
      expect(done!.approved_by).toBe(approverA.userId);
      expect(done!.approved_by).not.toBe(done!.proposed_by);
      expect(done!.approved_at).not.toBeNull();
      expect(done!.basis).toBe("clean_evidence");
      expect(await heldBySql(w.payslipId), "approved: the slip is free").toBe(
        false,
      );
      expect(await holdRows(w.itemId), "the hold row is kept").toHaveLength(1);
      expect(await moneyOf(), "releasing moves no money").toEqual(money);

      const afterApprove = await listedHold(approverA, w.holdId);
      expect(afterApprove!.release).toMatchObject({
        id: releaseId,
        status: "approved",
        approvedBy: approverA.userId,
        approvedAt: expect.any(String),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-release-owner-and-finance-manager] an Owner (tenant-wide) can propose and a Finance Manager can approve",
    async () => {
      const owner = await makePerson("Owner", "owner");
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId, owner);
      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      expect(await heldBySql(w.payslipId)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-release-only-its-hold] releasing the hold of one slip does not free the slip of another hold",
    async () => {
      const a = await cleanWorld();
      const b = await correctedWorld();
      const idsB = await flaggedByTamper(b);
      for (const f of idsB.flags) await clearFlag(f.id as string);
      const heldB = await makeHold(b, idsB, LOCK_REASON);
      await runRecon(makeStorage());
      expect(await heldBySql(heldB.payslipId), "premise: B held").toBe(true);

      const releaseId = await proposed(a.holdId);
      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      expect(await heldBySql(a.payslipId), "A is free").toBe(false);
      expect(await heldBySql(heldB.payslipId), "B stays held").toBe(true);
      expect(await releaseRows(heldB.holdId)).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 2: nobody releases alone
// =========================================================================

describe("1192: the proposer cannot approve", () => {
  it(
    "[1192-self-approval] the proposer approving their own release is refused 403; not approved, the slip stays held; a different person can still approve",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);

      const res = await approveHttp(proposer, releaseId);
      expect(res.status, detail(res)).toBe(403);
      expect((await releaseRows(w.holdId))[0]!.approved_by).toBeNull();
      expect(await heldBySql(w.payslipId), "self-approval frees nothing").toBe(
        true,
      );
      expect(await auditCount(APPROVED_ACTION, releaseId, w.holdId)).toBe(0);

      const ok = await approveHttp(approverA, releaseId);
      expect(ok.status, detail(ok)).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-approved-twice] a release already approved cannot be approved again: 409; the first approver stays",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);
      const first = await approveHttp(approverA, releaseId);
      expect(first.status, detail(first)).toBe(200);

      const second = await approveHttp(approverB, releaseId);
      expect(second.status, detail(second)).toBe(409);
      expect((await releaseRows(w.holdId))[0]!.approved_by).toBe(
        approverA.userId,
      );
      expect(await auditCount(APPROVED_ACTION, releaseId, w.holdId)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-concurrent-approve] two different people approve the same release at the same moment: exactly one 200, the other 409; one approver on record; the slip is released once",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);

      const results = await Promise.all([
        approveHttp(approverA, releaseId),
        approveHttp(approverB, releaseId),
      ]);
      expect(
        results.map((r) => r.status).sort(),
        results.map(detail).join(" | "),
      ).toEqual([200, 409]);
      const rows = await releaseRows(w.holdId);
      expect(rows).toHaveLength(1);
      const winner = results[0]!.status === 200 ? approverA : approverB;
      expect(rows[0]!.approved_by).toBe(winner.userId);
      expect(await heldBySql(w.payslipId)).toBe(false);
      expect(await auditCount(APPROVED_ACTION, releaseId, w.holdId)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 3: propose is idempotent
// =========================================================================

describe("1192: propose is idempotent", () => {
  it(
    "[1192-propose-idempotent] the same proposal twice, and a proposal of another person, return the same release: one row (the first reason and proposer stay) and one audit row; after the approval a new proposal is refused 409",
    async () => {
      const w = await cleanWorld();
      const proposedBefore = await auditCount(PROPOSED_ACTION, w.holdId);

      const first = await proposeHttp(proposer, w.holdId);
      expect(first.status, detail(first)).toBe(201);
      const releaseId = releaseIdOf(first);
      const again = await proposeHttp(proposer, w.holdId);
      expect([200, 201], detail(again)).toContain(again.status);
      expect(releaseIdOf(again)).toBe(releaseId);
      const other = await proposeHttp(approverB, w.holdId, {
        reason: OTHER_REASON,
        password: PASSWORD,
      });
      expect([200, 201], detail(other)).toContain(other.status);
      expect(releaseIdOf(other)).toBe(releaseId);

      const rows = await releaseRows(w.holdId);
      expect(rows, "one row, no duplicate").toHaveLength(1);
      expect(rows[0]!.proposed_by).toBe(proposer.userId);
      expect(rows[0]!.reason).toBe(REASON);
      expect(
        (await auditCount(PROPOSED_ACTION, w.holdId, releaseId)) -
          proposedBefore,
        "one audit row for the proposal",
      ).toBe(1);

      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      const late = await proposeHttp(approverB, w.holdId, {
        reason: OTHER_REASON,
        password: PASSWORD,
      });
      expect(late.status, detail(late)).toBe(409);
      expect(await releaseRows(w.holdId), "still one row").toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-propose-concurrent] two people propose for the same hold at the same moment: both get the same release id, one row, one audit row",
    async () => {
      const w = await cleanWorld();
      const before = await auditCount(PROPOSED_ACTION, w.holdId);
      const results = await Promise.all([
        proposeHttp(proposer, w.holdId),
        proposeHttp(approverB, w.holdId, {
          reason: OTHER_REASON,
          password: PASSWORD,
        }),
      ]);
      for (const r of results)
        expect([200, 201], detail(r)).toContain(r.status);
      const ids = results.map(releaseIdOf);
      expect(ids[0]).toBe(ids[1]);
      expect(await releaseRows(w.holdId)).toHaveLength(1);
      expect(
        (await auditCount(PROPOSED_ACTION, w.holdId, ids[0]!)) - before,
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 4: reason, password, step-up, role
// =========================================================================

describe("1192: reason, password, step-up and role are required", () => {
  it(
    "[1192-reason-required] a reason that is missing, shorter than 10 or longer than 500 characters is refused (400 or 422); no release row; the slip stays held",
    async () => {
      const w = await cleanWorld();
      for (const reason of [undefined, "pendek", "x".repeat(501)]) {
        const res = await proposeHttp(proposer, w.holdId, {
          reason,
          password: PASSWORD,
        });
        expect(
          [400, 422],
          `reason ${reason?.length}: ${detail(res)}`,
        ).toContain(res.status);
      }
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId)).toBe(true);

      // Control: exactly 10 and exactly 500 characters are accepted (one proposal, idempotent).
      const ten = await proposeHttp(proposer, w.holdId, {
        reason: "x".repeat(10),
        password: PASSWORD,
      });
      expect(ten.status, detail(ten)).toBe(201);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-password-required] propose and approve without the password are refused 401, with a wrong password 403; nothing is recorded; the slip stays held",
    async () => {
      const w = await cleanWorld();
      const noPassword = await proposeHttp(proposer, w.holdId, {
        reason: REASON,
      });
      expect(noPassword.status, detail(noPassword)).toBe(401);
      const wrong = await proposeHttp(proposer, w.holdId, {
        reason: REASON,
        password: WRONG_PASSWORD,
      });
      expect(wrong.status, detail(wrong)).toBe(403);
      expect(await releaseRows(w.holdId), "no proposal").toHaveLength(0);

      const releaseId = await proposed(w.holdId);
      const approveNoPassword = await approveHttp(approverA, releaseId, {});
      expect(approveNoPassword.status, detail(approveNoPassword)).toBe(401);
      const approveWrong = await approveHttp(approverA, releaseId, {
        password: WRONG_PASSWORD,
      });
      expect(approveWrong.status, detail(approveWrong)).toBe(403);
      expect((await releaseRows(w.holdId))[0]!.approved_by).toBeNull();
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-step-up-required] a person without a fresh MFA step-up (never verified, or verified long ago) is refused (401 or 403) for propose and approve; nothing is recorded",
    async () => {
      const w = await cleanWorld();
      const noMfa = await makePerson("No MFA", "finance", { enroll: false });
      const stale = await makePerson("Stale MFA", "finance");
      await W.owner.query(
        `UPDATE session SET created_at = now() - interval '4 hours', mfa_verified_at = now() - interval '3 hours' WHERE user_id = $1`,
        [stale.userId],
      );
      for (const who of [noMfa, stale]) {
        const res = await proposeHttp(who, w.holdId);
        expect([401, 403], detail(res)).toContain(res.status);
      }
      expect(await releaseRows(w.holdId)).toHaveLength(0);

      const releaseId = await proposed(w.holdId);
      for (const who of [noMfa, stale]) {
        const res = await approveHttp(who, releaseId);
        expect([401, 403], detail(res)).toContain(res.status);
      }
      expect((await releaseRows(w.holdId))[0]!.approved_by).toBeNull();
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-role-required] a person without payroll.disburse.approve, and a person with the permission through a custom role who is not an Owner or Finance Manager, are refused 403 for propose and approve; nothing is recorded",
    async () => {
      const w = await cleanWorld();
      const noPermission = await makePerson("No permission", null, {
        permissions: ["payroll.view"],
      });
      const customOnly = await makePerson("Custom role only", null);
      for (const who of [noPermission, customOnly]) {
        const res = await proposeHttp(who, w.holdId);
        expect(res.status, detail(res)).toBe(403);
      }
      expect(await releaseRows(w.holdId)).toHaveLength(0);

      const releaseId = await proposed(w.holdId);
      for (const who of [noPermission, customOnly]) {
        const res = await approveHttp(who, releaseId);
        expect(res.status, detail(res)).toBe(403);
      }
      expect((await releaseRows(w.holdId))[0]!.approved_by).toBeNull();
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 5: only clean evidence releases; a taken-over hold is not released
// =========================================================================

describe("1192: a release needs clean evidence", () => {
  it(
    "[1192-not-clean-no-observation] a hold with no clean observation after it cannot be proposed: 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, no release row, the slip stays held, the list says not releasable",
    async () => {
      const w = await notCleanWorld();
      const listed = await listedHold(proposer, w.holdId);
      expect(listed!.releasable).toBe(false);
      expect(listed!.takenOver).toBe(false);

      const res = await proposeHttp(proposer, w.holdId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(NOT_CLEAN);
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-not-clean-latest-observation-bad] the latest observation after the hold is not clean (the proof is tampered again): 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN; the slip stays held",
    async () => {
      const w = await notCleanWorld();
      await changeItemData(w.itemId);
      await runRecon(makeStorage([w.key]));
      expect(
        await lastState(w.operationId),
        "premise: the latest observation is not ok",
      ).not.toBe("ok");

      const res = await proposeHttp(proposer, w.holdId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(NOT_CLEAN);
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId)).toBe(true);
      expect((await listedHold(proposer, w.holdId))!.releasable).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-approve-rechecks-evidence] the evidence turns bad between the proposal and the approval: the approval is refused 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN; the release stays unapproved and the slip stays held",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);
      await changeItemData(w.itemId);
      await runRecon(makeStorage([w.key]));
      expect(
        await lastState(w.operationId),
        "premise: the latest observation is not ok",
      ).not.toBe("ok");

      const res = await approveHttp(approverA, releaseId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(NOT_CLEAN);
      const [row] = await releaseRows(w.holdId);
      expect(row!.approved_by).toBeNull();
      expect(row!.basis).toBeNull();
      expect(await heldBySql(w.payslipId)).toBe(true);
      expect(await auditCount(APPROVED_ACTION, releaseId, w.holdId)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-approve-observe-lock] a run still reading the proof of the operation (it holds the observe advisory lock of tenant and operation in an open transaction): a different person's approval is refused 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, the release stays unapproved and the slip stays held; after that run has ended the same approval succeeds",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);

      // Mimics a read that is still running: a second connection keeps the lock open.
      const reader = await mfaOwner.connect();
      let readerOpen = false;
      try {
        await reader.query("BEGIN");
        readerOpen = true;
        await reader.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('payout_recon_evidence_observe:' || $1::text || ':' || $2::text, 0))`,
          [W.tenantId, w.operationId],
        );

        const refused = await approveHttp(approverA, releaseId);
        expect(refused.status, detail(refused)).toBe(409);
        expect(errorCodeOf(refused)).toBe(NOT_CLEAN);
        const [row] = await releaseRows(w.holdId);
        expect(
          row!.approved_by,
          "not approved while the lock is held",
        ).toBeNull();
        expect(row!.approved_at).toBeNull();
        expect(row!.basis).toBeNull();
        expect(await heldBySql(w.payslipId), "the slip stays held").toBe(true);
        expect(await auditCount(APPROVED_ACTION, releaseId, w.holdId)).toBe(0);

        await reader.query("COMMIT");
        readerOpen = false;
      } finally {
        if (readerOpen) await reader.query("ROLLBACK").catch(() => undefined);
        reader.release();
      }

      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      const [done] = await releaseRows(w.holdId);
      expect(done!.approved_by).toBe(approverA.userId);
      expect(done!.basis).toBe("clean_evidence");
      expect(await heldBySql(w.payslipId), "approved: the slip is free").toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-taken-over-refused] a hold that a later flag took over cannot be released: 409 PAYOUT_RECON_HOLD_TAKEN_OVER, no release row; the list says takenOver and not releasable; the flag holds the slip",
    async () => {
      const w = await takenOverWorld();
      const listed = await listedHold(proposer, w.holdId);
      expect(listed!.takenOver).toBe(true);
      expect(listed!.releasable).toBe(false);

      const res = await proposeHttp(proposer, w.holdId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(TAKEN_OVER);
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId), "held by the flag").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 6: list, empty state, other tenant, table privileges
// =========================================================================

describe("1192: list, other tenant and table privileges", () => {
  it(
    "[1192-list-empty] with no hold the list is empty (200), not an error",
    async () => {
      expect(await listHolds(proposer)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-foreign-hold-untouched] a hold of another tenant is not listed, not found (404) for propose, and unchanged; my own hold releases normally",
    async () => {
      const mine = await cleanWorld();
      const foreignTenant = randomUUID();
      const foreignHold = randomUUID();
      foreignTenants.push(foreignTenant);
      await W.asTenant(async (c) => {
        await c.query(
          `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
           SELECT $1, $2, 'Payout 1192 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
             FROM tenants WHERE id = $3`,
          [
            foreignTenant,
            `payout-1192-${foreignTenant.slice(0, 8)}`,
            W.tenantId,
          ],
        );
        // A hold of that tenant: a copy of mine under the other tenant (FKs are off in this fixture).
        await c.query(
          `CREATE TEMP TABLE hold1192_copy ON COMMIT DROP AS
             SELECT * FROM ${HOLDS} WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, mine.holdId],
        );
        await c.query(`UPDATE hold1192_copy SET id = $1, tenant_id = $2`, [
          foreignHold,
          foreignTenant,
        ]);
        await c.query(`INSERT INTO ${HOLDS} SELECT * FROM hold1192_copy`);
      }, true);
      const rowOf = async () =>
        JSON.stringify(
          (
            await W.rowsOf(`SELECT * FROM ${HOLDS} WHERE id = $1`, [
              foreignHold,
            ])
          )[0],
        );
      const rowBefore = await rowOf();
      expect(rowBefore, "premise: the foreign hold exists").not.toBe(undefined);

      const ids = (await listHolds(proposer)).map((h) => h.id);
      expect(ids, "my own hold is listed").toContain(mine.holdId);
      expect(ids, "the other tenant's hold is not listed").not.toContain(
        foreignHold,
      );

      const res = await proposeHttp(proposer, foreignHold);
      expect(res.status, detail(res)).toBe(404);
      const rows = await W.rowsOf(
        `SELECT count(*)::int AS n FROM ${RELEASES} WHERE hold_id = $1`,
        [foreignHold],
      );
      expect(Number(rows[0]!.n), "no release for the foreign hold").toBe(0);
      expect(await rowOf(), "the foreign hold is unchanged").toBe(rowBefore);

      const own = await proposeHttp(proposer, mine.holdId);
      expect(own.status, detail(own)).toBe(201);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-release-table-app-cannot-write] legend_app can read the releases of its tenant but cannot INSERT, UPDATE or DELETE them (42501); the proposal is unchanged and the slip stays held",
    async () => {
      const w = await cleanWorld();
      const releaseId = await proposed(w.holdId);
      const before = JSON.stringify((await releaseRows(w.holdId))[0]);
      const total = await releaseCount();

      const read = await sqlAs(
        `SELECT id FROM ${RELEASES} WHERE tenant_id = $1 AND hold_id = $2`,
        [W.tenantId, w.holdId],
      );
      expect(read.code, read.message).toBeUndefined();
      expect(read.rows, "the own release is visible").toHaveLength(1);

      const insert = await sqlAs(
        `INSERT INTO ${RELEASES}
           (tenant_id, hold_id, reason, proposed_by, approved_by, approved_at, basis)
         VALUES ($1, $2, $3, $4, $5, now(), 'clean_evidence')`,
        [W.tenantId, w.holdId, REASON, proposer.userId, approverA.userId],
      );
      expect(insert.code, `INSERT: ${insert.message}`).toBe(PRIVILEGE);
      const approve = await sqlAs(
        `UPDATE ${RELEASES} SET approved_by = $3, approved_at = now(), basis = 'clean_evidence'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, releaseId, approverA.userId],
      );
      expect(approve.code, `UPDATE approve: ${approve.message}`).toBe(
        PRIVILEGE,
      );
      const rewrite = await sqlAs(
        `UPDATE ${RELEASES} SET reason = $3 WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, releaseId, OTHER_REASON],
      );
      expect(rewrite.code, `UPDATE reason: ${rewrite.message}`).toBe(PRIVILEGE);
      const del = await sqlAs(
        `DELETE FROM ${RELEASES} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, releaseId],
      );
      expect(del.code, `DELETE: ${del.message}`).toBe(PRIVILEGE);

      expect(JSON.stringify((await releaseRows(w.holdId))[0])).toBe(before);
      expect(await releaseCount(), "no row added or removed").toBe(total);
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 7: audit and finance exceptions
// =========================================================================

describe("1192: audit and finance exceptions", () => {
  it(
    "[1192-audit] the proposal and the approval each write one audit row (payroll.disbursement.recon_hold_release_proposed / _approved), without the password",
    async () => {
      const w = await cleanWorld();
      const proposedBefore = await auditCount(PROPOSED_ACTION, w.holdId);
      const approvedBefore = await auditCount(APPROVED_ACTION, w.holdId);
      const releaseId = await proposed(w.holdId);
      expect(
        (await auditCount(PROPOSED_ACTION, w.holdId, releaseId)) -
          proposedBefore,
      ).toBe(1);
      expect(await auditCount(APPROVED_ACTION, w.holdId, releaseId)).toBe(
        approvedBefore,
      );
      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      expect(
        (await auditCount(APPROVED_ACTION, w.holdId, releaseId)) -
          approvedBefore,
      ).toBe(1);
      const events = await W.rowsOf(
        `SELECT event::text AS text FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' IN ($2, $3)
            AND (event::text LIKE '%' || $4 || '%' OR event::text LIKE '%' || $5 || '%')`,
        [W.tenantId, PROPOSED_ACTION, APPROVED_ACTION, w.holdId, releaseId],
      );
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events)
        expect(String(event.text), "no password in audit").not.toContain(
          PASSWORD,
        );
    },
    TEST_TIMEOUT_MS,
  );

  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const exceptionsText = async (kind?: string) => {
    const result = await listFinanceExceptions(W.scope(), {
      from: day(-2),
      to: day(2),
      ...(kind ? { kind } : {}),
    } as never);
    return JSON.stringify(result.items);
  };
  const mentionsHold = (text: string, w: HeldWorld) =>
    text.includes(w.holdId) || text.includes(w.itemId);

  it(
    "[1192-finance-exceptions-hold-kind] an open hold shows in finance exceptions as kind payout_recon_hold (also without a kind filter); it disappears once released",
    async () => {
      const w = await notCleanWorld();
      const filtered = await exceptionsText("payout_recon_hold");
      expect(filtered, "listed with kind payout_recon_hold").toContain(
        "payout_recon_hold",
      );
      expect(mentionsHold(filtered, w), "mentions the hold or its item").toBe(
        true,
      );
      expect(
        mentionsHold(await exceptionsText(), w),
        "also in the unfiltered list",
      ).toBe(true);

      const clean = await cleanWorld();
      expect(
        mentionsHold(await exceptionsText("payout_recon_hold"), clean),
      ).toBe(true);
      const releaseId = await proposed(clean.holdId);
      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      const after = await exceptionsText("payout_recon_hold");
      expect(mentionsHold(after, clean), "the released hold is gone").toBe(
        false,
      );
      expect(mentionsHold(after, w), "the other open hold stays").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-finance-exceptions-taken-over-gone] a hold taken over by a flag is not listed as payout_recon_hold any more (the flag is the exception)",
    async () => {
      // (takenOverWorld empties the recon tables, so it comes first.) Control: an
      // open hold of another slip is listed, so an empty list is not a pass.
      const w = await takenOverWorld();
      const open = await notCleanWorld();
      expect(
        mentionsHold(await exceptionsText("payout_recon_hold"), open),
        "control: the open hold is listed",
      ).toBe(true);
      const text = await exceptionsText("payout_recon_hold");
      expect(mentionsHold(text, w), "taken over: not a hold exception").toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// 8: bead 1192 architect findings (P0, P1a, P1b): fail-first
// =========================================================================
//
// Assumptions (the brief "Status WIP" names the rules, not the columns):
// - "Not clean" is the same 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN (PAYOUT-97) as above.
// - The clean-read table payroll_payout_recon_hold_clean_reads has a tenant_id column and is
//   insert-only: UPDATE / DELETE by any role (the owner login included, triggers on) are
//   refused with PAYOUT-87; legend_app has no INSERT privilege (42501).
// - Row counts of that table are read per tenant; the cleanup after each test removes them
//   with triggers off, like the observations.

describe("1192: only evidence reasons can be clean (P0)", () => {
  it(
    "[1192-p0-non-evidence-reason] a hold with reason net_mismatch (or attestation_same_person) is never clean, although the proof file reads ok after it: propose is 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, no release row, the slip stays held, the list says releasable=false",
    async () => {
      for (const reason of ["net_mismatch", "attestation_same_person"]) {
        await resetRecon();
        const w = await cleanWorld(reason); // premise inside: an 'ok' observation after the hold
        const listed = await listedHold(proposer, w.holdId);
        expect(listed, `${reason}: the hold is listed`).toBeDefined();
        expect(listed!.reason).toBe(reason);
        expect(listed!.releasable, `${reason}: not releasable`).toBe(false);

        const res = await proposeHttp(proposer, w.holdId);
        expect(res.status, `${reason}: ${detail(res)}`).toBe(409);
        expect(errorCodeOf(res)).toBe(NOT_CLEAN);
        expect(
          await releaseRows(w.holdId),
          `${reason}: no release`,
        ).toHaveLength(0);
        expect(await heldBySql(w.payslipId), `${reason}: still held`).toBe(
          true,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("1192: a good read after the hold counts even when the last observation was already ok (P1a)", () => {
  for (const prior of ["ok", "none"] as const) {
    it(
      `[1192-p1a-lock-prior-${prior}] the operation's observation before the lock hold is ${prior === "ok" ? "already ok" : "absent"}, then a good read goes through the real recon path: the hold is clean and releasable, two people release it, the slip is free`,
      async () => {
        const w = await priorReadWorld(prior, true);
        const money = await moneyOf();
        const listed = await listedHold(proposer, w.holdId);
        expect(listed!.releasable, "clean read after the hold").toBe(true);

        const releaseId = await proposed(w.holdId);
        expect(await heldBySql(w.payslipId), "proposal alone holds").toBe(true);
        const approved = await approveHttp(approverA, releaseId);
        expect(approved.status, detail(approved)).toBe(200);
        expect((await releaseRows(w.holdId))[0]!.basis).toBe("clean_evidence");
        expect(await heldBySql(w.payslipId), "approved: free").toBe(false);
        expect(await moneyOf(), "releasing moves no money").toEqual(money);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "[1192-p1a-no-read-after] a lock hold with no read after it is not clean even though an older 'ok' observation exists: releasable=false, propose 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, the slip stays held",
    async () => {
      const w = await priorReadWorld("ok", false);
      expect((await listedHold(proposer, w.holdId))!.releasable).toBe(false);
      const res = await proposeHttp(proposer, w.holdId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(NOT_CLEAN);
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-p1a-observation-not-ok] a good read happened after the hold, but the latest observation is a mismatch: not clean, propose 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, the slip stays held",
    async () => {
      const w = await cleanWorld(); // a clean read after the hold
      await changeItemData(w.itemId);
      await runRecon(makeStorage([w.key]));
      expect(
        await lastState(w.operationId),
        "premise: the latest observation is not ok",
      ).not.toBe("ok");
      const res = await proposeHttp(proposer, w.holdId);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe(NOT_CLEAN);
      expect(await releaseRows(w.holdId)).toHaveLength(0);
      expect(await heldBySql(w.payslipId)).toBe(true);
      expect((await listedHold(proposer, w.holdId))!.releasable).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-p1a-clean-read-row-growth] reading ok twice more after one hold keeps one clean-read row for the operation (no row per read)",
    async () => {
      expect(await tableExists(CLEAN_READS), `${CLEAN_READS} exists`).toBe(
        true,
      );
      const w = await priorReadWorld("ok", true);
      const rowsNow = () =>
        count(
          `SELECT count(*)::int AS n FROM ${CLEAN_READS} WHERE tenant_id = $1`,
          [W.tenantId],
        );
      expect(
        await rowsNow(),
        "one clean-read row after the first good read",
      ).toBe(1);
      await runRecon(makeStorage());
      await runRecon(makeStorage());
      expect(await lastState(w.operationId)).toBe("ok");
      expect(await rowsNow(), "still one row after more good reads").toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("1192: holds of one item are told apart by reason and by clean reads (P1b)", () => {
  it(
    "[1192-p1b-failure-after-proposal] a new read failure after a proposal makes a NEW hold; approving the first release succeeds but the slip stays held by the new hold until a new clean read and its own release",
    async () => {
      const first = await cleanWorld(); // hold H (day 2031-01-01) + a clean read
      const releaseId = await proposed(first.holdId);

      const second = await holdUnwritten(
        first.kind,
        first.operationId,
        [first.itemId],
        "evidence_read_locked:2031-01-02",
      );
      expect(second.code, `hold call ${second.message}`).toBeUndefined();
      const holds = await holdRows(first.itemId);
      expect(holds, "a new failure is a new hold row").toHaveLength(2);
      const h2 = holds.find((h) => h.id !== first.holdId)!;
      expect(h2.reason).toBe("evidence_read_locked:2031-01-02");

      const approved = await approveHttp(approverA, releaseId);
      expect(approved.status, detail(approved)).toBe(200);
      expect(
        await heldBySql(first.payslipId),
        "the new hold still holds the slip",
      ).toBe(true);
      expect(
        (await listedHold(proposer, h2.id as string))!.releasable,
        "no clean read after the new hold yet",
      ).toBe(false);
      const early = await proposeHttp(proposer, h2.id as string);
      expect(early.status, detail(early)).toBe(409);
      expect(errorCodeOf(early)).toBe(NOT_CLEAN);

      await runRecon(makeStorage());
      expect((await listedHold(proposer, h2.id as string))!.releasable).toBe(
        true,
      );
      const release2 = await proposed(h2.id as string);
      const approved2 = await approveHttp(approverA, release2);
      expect(approved2.status, detail(approved2)).toBe(200);
      expect(await heldBySql(first.payslipId), "all holds released").toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-p1b-reason-dedupe] two holds of one item with different reasons are two rows; the same reason twice with no clean read between is one row",
    async () => {
      const w = await correctedWorld();
      const ids = await flaggedByTamper(w);
      for (const f of ids.flags) await clearFlag(f.id as string);
      const hold = async (reason: string) => {
        const made = await holdUnwritten(
          ids.kind,
          ids.operationId,
          [w.itemId],
          reason,
        );
        expect(made.code, `hold ${reason}: ${made.message}`).toBeUndefined();
        return (await holdRows(w.itemId)).length;
      };
      const a = "evidence_read_locked:2031-01-01";
      const b = "evidence_read_locked:2031-01-02";
      expect(await hold(a), "first hold").toBe(1);
      expect(await hold(a), "same reason, no clean read between: one row").toBe(
        1,
      );
      expect(await hold(b), "different reason: a second row").toBe(2);
      expect(await hold(a), "same reason again: still two rows").toBe(2);
      expect(await hold(b), "same reason again: still two rows").toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[1192-p1b-clean-reads-insert-only] clean-read rows cannot be updated or deleted by anyone (PAYOUT-87, even the owner login) and legend_app cannot insert one (42501)",
    async () => {
      expect(await tableExists(CLEAN_READS), `${CLEAN_READS} exists`).toBe(
        true,
      );
      const w = await cleanWorld();
      const rowsOf = () =>
        W.rowsOf(
          `SELECT * FROM ${CLEAN_READS} WHERE tenant_id = $1 ORDER BY 1`,
          [W.tenantId],
        );
      const before = JSON.stringify(await rowsOf());
      expect(
        (await rowsOf()).length,
        "premise: a clean read is on record",
      ).toBe(1);

      const ownerUpdate = await W.asTenant(async (c) => {
        try {
          await c.query("SAVEPOINT s");
          await c.query(
            `UPDATE ${CLEAN_READS} SET tenant_id = tenant_id WHERE tenant_id = $1`,
            [W.tenantId],
          );
          return "";
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          return (e as Error).message;
        }
      });
      expect(ownerUpdate, "UPDATE is refused").toMatch(/PAYOUT-87/);
      const ownerDelete = await W.asTenant(async (c) => {
        try {
          await c.query("SAVEPOINT s");
          await c.query(`DELETE FROM ${CLEAN_READS} WHERE tenant_id = $1`, [
            W.tenantId,
          ]);
          return "";
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          return (e as Error).message;
        }
      });
      expect(ownerDelete, "DELETE is refused").toMatch(/PAYOUT-87/);

      const insert = await sqlAs(
        `INSERT INTO ${CLEAN_READS} DEFAULT VALUES`,
        [],
      );
      expect(insert.code, `legend_app INSERT: ${insert.message}`).toBe(
        PRIVILEGE,
      );
      const update = await sqlAs(
        `UPDATE ${CLEAN_READS} SET tenant_id = tenant_id WHERE tenant_id = $1`,
        [W.tenantId],
      );
      expect(update.code, `legend_app UPDATE: ${update.message}`).toBe(
        PRIVILEGE,
      );
      const del = await sqlAs(
        `DELETE FROM ${CLEAN_READS} WHERE tenant_id = $1`,
        [W.tenantId],
      );
      expect(del.code, `legend_app DELETE: ${del.message}`).toBe(PRIVILEGE);

      expect(JSON.stringify(await rowsOf()), "rows unchanged").toBe(before);
      expect(await heldBySql(w.payslipId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
