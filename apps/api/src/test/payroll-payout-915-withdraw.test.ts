// Payout 915 (bead legend-xatux): withdrawing a correction or overpaid proposal
// that waits for its second person. Written fail-first from
// docs/briefs/915/design-xatux.md, section "Test", cases 1 to 14 (15, the web,
// is not in this file), NOT from the implementation.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): a proposal of step one (`proposed`) can be withdrawn by the
// proposer or by another approver, but never by the requester of the batch. The
// row is kept with status `withdrawn`; the item is not touched (status, live
// attempt, closure hold stay), nothing is booked, and the proof of a withdrawn
// proposal can never be used again. Only the payout role writes, through two
// trusted functions that spend a one-time grant of step `withdraw`.
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - Routes: POST /disbursement-batches/:id/correct-failed/withdraw and
//   POST /disbursement-batches/:id/overpaid/withdraw, body { itemIds, password },
//   answer 200 on success (the body is not asserted). Errors (design): 403
//   PAYOUT_REQUESTER_CANNOT_WITHDRAW, 409 PAYOUT_PROPOSAL_NOT_WITHDRAWABLE,
//   409 PAYOUT_PROOF_SPENT_BY_WITHDRAWN (a proof key of a withdrawn row), 401
//   REAUTH_REQUIRED for a stale step-up.
// - SQL: app.payout_correction_withdraw(operation uuid, grant text) and
//   app.payout_overpaid_withdraw(batch uuid, item_ids uuid[], key varchar,
//   grant text), called as legend_app with a REAL COMMIT. The grant binding is
//   (correction | overpaid, step `withdraw`, batch, item set, proof key, ref):
//   ref = the operation id for a correction, NULL for overpaid (design 5).
//   Errors by message: PAYOUT-63 (not withdrawable), PAYOUT-64 (requester),
//   PAYOUT-69 (no such operation), PAYOUT-70 (grant, 42501), PAYOUT-72 (matrix,
//   22023), PAYOUT-75 (key of a withdrawn row). SQLSTATE is asserted only for
//   PAYOUT-70 (42501, as the 911 suite) and the guard CHECK/trigger (23514).
// - The proposal tables get columns withdrawn_by (the user id of the withdrawer)
//   and withdrawn_at; rows are read as to_jsonb so a missing column reads as
//   undefined and the test fails on the missing behavior, not on a SQL error.
// - Proposals are made over HTTP (the real route binds the proof); the SQL
//   world of cases 4 (bytes), 10 and 9 (control) drives the trusted functions
//   directly like 911-grants (proof bound with app.payout_bind_proof).
// - The audit actions are payroll.disbursement.correction_withdrawn and
//   payroll.disbursement.overpaid_withdrawn (design 21). The audit event is
//   found by tenant, action and any of the batch, item, operation or proposal
//   ids inside it (the object id of the event is not fixed by the design).
// - Case 5 retry hold: the retry is `createDisbursementBatch` of the same run
//   (HttpError 409); only the status is asserted (as 911 closure-swap), the
//   exact code is not.
// - Case 3 "one overpaid item of a group already recorded" is forced as the
//   owner (replica mode, CHECKs on) with recorded_by / recorded_at.
// - Case 4 "same bytes under a new key" is driven in SQL: a second upload
//   record with the same content hash; the bind or the propose must refuse, the
//   exact code is not asserted.
// - Case 11 (overpaid record with a withdrawn key) is driven over HTTP (the
//   second step has no open proposal and the key is spent: 409
//   PAYOUT_PROOF_SPENT_BY_WITHDRAWN) and in SQL with any refusal.
// - Case 12 uses the night recon `reconcileTrustedPayouts(context, options)` as
//   the 905 recon suite does; a grant whose actor was changed gives the reason
//   `grant_mismatch`.
// - Case 13 reads GET .../resolution-proposals: items of kind `correction` or
//   `overpaid` carry `groupItemIds` (the whole group; for a correction just the
//   item). Whether the list has one row per item or per group is not fixed, so
//   each listed row of the kind is checked against the group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import type { PayoutGrantBinding } from "../services/payroll-payout-grant.service.ts";
import { reconcileTrustedPayouts } from "../services/payroll-payout-recon.service.ts";
import { withdrawError } from "../services/payroll-payout-proposal-withdraw.service.ts";
import { HttpError } from "../lib/http-error.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  uploadEvidence,
  type Person as Employee,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("915wd");
const NET = 1_000_000;
const NOTE = "Mutasi bank menunjukkan transfer ternyata berhasil";
const NOTE_CLOSE =
  "Bukti macet, file tidak bisa dibaca lagi, kasus ditutup permanen";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const PROOFS = "/api/hris/payroll/payout-proofs";
const PRIVILEGE = "42501";
const GUARD = "23514";
const STUCK = "payroll_payout_proof_backfill_stuck";
const CLOSURES = "payroll_payout_proof_closures";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const hex = () => randomBytes(32).toString("hex");
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");

type Kind = "correction" | "overpaid";
const KINDS: Kind[] = ["correction", "overpaid"];
const TABLE: Record<Kind, string> = {
  correction: "payroll_payout_failed_corrections",
  overpaid: "payroll_payout_overpaid_proposals",
};
const ROUTE: Record<Kind, string> = {
  correction: "correct-failed",
  overpaid: "overpaid",
};
const AUDIT: Record<Kind, string> = {
  correction: "payroll.disbursement.correction_withdrawn",
  overpaid: "payroll.disbursement.overpaid_withdrawn",
};

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
const batchIds: string[] = [];
const allItemIds: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) ---------------------------------

type Person = Awaited<ReturnType<typeof finance>>;

/** Signed in with the approve permission, TOTP enrolled in this session: the password is the real step-up. */
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Withdraw915 ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
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
  return { client, userId, factorId, secretBase32 };
}

/** Finance with a real challenge: the factor is older than the session, so a code stamps `mfa_challenge_verified_at`. */
async function challengedFinance(label: string) {
  const person = await finance(label);
  await mfaOwner.query(
    `UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1`,
    [person.factorId],
  );
  const challenged = await person.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: person.factorId,
      code: totpCode(person.secretBase32, totpStep(new Date()) + 1),
    });
  expect(challenged.status, JSON.stringify(challenged.body)).toBe(200);
  return person;
}

let requester: Person; // requester of every batch of this file: may never withdraw
let one: Person; // proposes, may withdraw its own proposal
let two: Person; // another approver
let three: Person; // a third approver

/** Grants of the fixture grantor stand-in for a person (live session, fresh MFA). */
const grantsOf = (who: Person) => actorOf(who.userId).grants;

// ---- Cleanup ------------------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);
const seededFiles: string[] = [];

afterEach(async () => {
  const keys = trackedKeys.splice(0);
  const files = seededFiles.splice(0);
  await W.asTenant(async (c) => {
    // Insert-only recon rows of this file: every test starts without them.
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    if (files.length > 0) {
      await c.query(
        `DELETE FROM payroll_payout_proof_hash_contests
          WHERE sha256 IN (SELECT f.content_sha256 FROM payroll_payout_evidence_files f
                            WHERE f.tenant_id = $1 AND f.evidence_key = ANY($2::text[]))`,
        [W.tenantId, files],
      );
      await c.query(
        `DELETE FROM payroll_payout_evidence_files
          WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, files],
      );
    }
    if (keys.length > 0) {
      for (const table of [STUCK, CLOSURES])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
          [W.tenantId, keys],
        );
    }
  }, true);
});

const gate = async () =>
  (
    await W.rowsOf(
      `SELECT app.payout_proof_history_pending() AS history_pending`,
    )
  )[0]!.history_pending as boolean;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await finance("Requester");
  one = await finance("One");
  two = await finance("Two");
  three = await finance("Three");
  expect(
    await gate(),
    "premise: no stuck or unaccounted proof history is left in the database",
  ).toBe(false);
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (allItemIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_attestations WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
        [W.tenantId, allItemIds],
      );
    if (batchIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, batchIds],
      );
  }, true);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- legend_app helpers (real COMMIT) ------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** One statement as legend_app of the tenant; real COMMIT unless `commit: false` (ROLLBACK). First error, if any. */
async function appCall(
  sql: string,
  params: unknown[] = [],
  options: { commit?: boolean } = {},
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
      const result = await client.query(sql, params);
      await client.query(options.commit === false ? "ROLLBACK" : "COMMIT");
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

/** Several legend_app transactions that fire their statements at the same moment, each committing on its own. */
async function raceCalls(calls: { sql: string; params: unknown[] }[]) {
  const clients: PoolClient[] = [];
  try {
    for (let i = 0; i < calls.length; i += 1)
      clients.push(await W.owner.connect());
    for (const c of clients) {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE legend_app");
      await c.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
    }
    return await Promise.all(
      clients.map(async (c, i) => {
        try {
          await c.query(calls[i]!.sql, calls[i]!.params);
          await c.query("COMMIT");
          return { code: undefined as string | undefined, message: "" };
        } catch (error) {
          const e = error as { code?: string; message?: string };
          await c.query("ROLLBACK").catch(() => undefined);
          return { code: e.code ?? "unknown", message: e.message ?? "" };
        }
      }),
    );
  } finally {
    for (const c of clients) c.release();
  }
}

function expectGrantRefused(outcome: Outcome, label: string) {
  expect(outcome.code, `${label}: ${outcome.message}`).toBe(PRIVILEGE);
  expect(outcome.message, label).toMatch(/PAYOUT-70:/);
}
function expectNotWithdrawable(outcome: Outcome, label: string) {
  expect(outcome.code, `${label}: must be refused`).toBeDefined();
  expect(outcome.message, label).toMatch(/PAYOUT-63:/);
}

// ---- Worlds ---------------------------------------------------------------------------------

const idOf = (row: Row) => row.id as string;

/** The row ids sorted, so a binding and the call that spends it list the same items. */
const sorted = (ids: string[]) => [...ids].sort();

type World = {
  runId: string;
  batchId: string;
  /** The failed items, in the order of the people. */
  itemIds: string[];
  itemId: string;
};

/**
 * Batch 1 created by the REAL requester, approved by APP, exported; every
 * person's transfer closed `failed` by two people (APP, APP3). `paidSibling`:
 * a follow-up batch pays the slips, so the first transfers are real double
 * payment candidates (what the overpaid route needs).
 */
async function failedWorld(
  options: { people?: Employee[]; paidSibling?: boolean } = {},
): Promise<World> {
  const people = options.people ?? [BUDI];
  const slips = people.map((p) => bank(p, NET));
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [batch] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = batch!.id as string;
  batchIds.push(batchId);
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requester.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const [source] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId: source!.id as string,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const itemIds = people.map((p) =>
    idOf(items.find((i) => i.employee_id === p.id)!),
  );
  allItemIds.push(...itemIds);
  await W.resolve(batchId, itemIds, "failed", APP);
  await W.resolve(batchId, itemIds, "failed", APP3);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is failed").toBe("failed");
  if (options.paidSibling) {
    const followUp = await W.exportedBatch(runId);
    batchIds.push(followUp);
    const followItems = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    expect(followItems, "premise: one retry item per slip").toHaveLength(
      people.length,
    );
    await W.confirm(followUp, W.succeedItems(followUp, followItems));
  }
  return { runId, batchId, itemIds, itemId: itemIds[0]! };
}

// ---- HTTP calls -----------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const errorCodeOf = (res: Res) => res.body.error?.code;

const stepOne = (
  who: Person,
  kind: Kind,
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/${ROUTE[kind]}`)
    .set(originHeader)
    .send({
      itemIds,
      evidenceKey,
      note: NOTE,
      password: PASSWORD,
    }) as unknown as Promise<Res>;

const withdrawCall = (
  who: Person,
  kind: Kind,
  batchId: string,
  itemIds: string[],
  password: string | null = PASSWORD,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/${ROUTE[kind]}/withdraw`)
    .set(originHeader)
    .send({
      itemIds,
      ...(password === null ? {} : { password }),
    }) as unknown as Promise<Res>;

function expectOk(res: Res, label: string) {
  expect(res.status, `${label} ${detail(res)}`).toBe(200);
}

// ---- A proposal waiting for its second person (made over HTTP) ----------------------------------

type Proposal = World & {
  kind: Kind;
  key: string;
  /** Correction: the operation id; overpaid: null. */
  operation: string | null;
  /** Items the operation covers (a correction takes one; an overpaid group may take several). */
  covered: string[];
};

async function proposalWorld(
  kind: Kind,
  options: { people?: Employee[]; proposer?: Person } = {},
): Promise<Proposal> {
  const people = options.people ?? [BUDI];
  const w = await failedWorld({ people, paidSibling: kind === "overpaid" });
  const key = trackKey(uploadEvidence(w.batchId, `wd-${randomUUID()}.pdf`));
  const covered = kind === "correction" ? [w.itemId] : sorted(w.itemIds);
  const res = await stepOne(
    options.proposer ?? one,
    kind,
    w.batchId,
    covered,
    key,
  );
  expectOk(res, `premise: step one (${kind})`);
  expect(res.body.data?.stage, "premise: proposed").toBe("proposed");
  const rows = await proposalRows(kind, w.itemId);
  expect(rows, "premise: one open proposal").toHaveLength(1);
  return {
    ...w,
    kind,
    key,
    covered,
    operation: kind === "correction" ? (rows[0]!.operation_id as string) : null,
  };
}

/** Rows of the proposal table for an item, as JSON (a column that does not exist yet reads undefined). */
async function proposalRows(kind: Kind, itemId: string) {
  return (
    await W.rowsOf(
      `SELECT to_jsonb(t) AS j FROM ${TABLE[kind]} t
        WHERE t.tenant_id = $1 AND t.item_id = $2 ORDER BY t.id`,
      [W.tenantId, itemId],
    )
  ).map((r) => r.j as Row);
}
const statusesOf = async (kind: Kind, itemIds: string[]) =>
  (
    await W.rowsOf(
      `SELECT t.status FROM ${TABLE[kind]} t
        WHERE t.tenant_id = $1 AND t.item_id = ANY($2::uuid[]) ORDER BY t.id`,
      [W.tenantId, itemIds],
    )
  ).map((r) => r.status as string);

// ---- Observations ---------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const itemStatus = async (id: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, id],
    )
  )[0]!.status as string;
const grantRow = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT id, kind, step, actor, consumed_at, consumed_txid::text AS consumed_txid
         FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    )
  )[0];
const grantsOfTenant = () =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1`,
    [W.tenantId],
  );
const spentWithdrawGrants = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND step = 'withdraw' AND consumed_at IS NOT NULL`,
    [W.tenantId, batchId],
  );
const issuedWithdrawGrants = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND step = 'withdraw'`,
    [W.tenantId, batchId],
  );
const withdrawAttestations = (itemId: string) =>
  W.rowsOf(
    `SELECT a.kind, a.step, a.grant_id, a.txid::text AS attestation_txid,
            g.kind AS grant_kind, g.step AS grant_step, g.actor,
            g.consumed_at, g.consumed_txid::text AS grant_txid
       FROM payroll_payout_attestations a
       LEFT JOIN payroll_payout_grants g
         ON g.tenant_id = a.tenant_id AND g.id = a.grant_id
      WHERE a.tenant_id = $1 AND $2::uuid = ANY(a.item_ids) AND a.step = 'withdraw'`,
    [W.tenantId, itemId],
  );

/** What a withdrawal must not move: item rows (whole), postings, payout journals, proposal row count. */
async function untouchedOf(p: { batchId: string; runId: string; kind: Kind }) {
  return {
    items: JSON.stringify(
      (
        await W.rowsOf(
          `SELECT to_jsonb(i) AS j FROM payroll_disbursement_items i
            WHERE i.tenant_id = $1 AND i.payroll_run_id = $2 ORDER BY i.id`,
          [W.tenantId, p.runId],
        )
      ).map((r) => r.j),
    ),
    postings: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id IN
          (SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = $2)`,
      [W.tenantId, p.runId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId, W.entityId()],
    ),
    batches: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, p.runId],
    ),
    proposals: await count(
      `SELECT count(*)::int AS n FROM ${TABLE[p.kind]} WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, p.batchId],
    ),
  };
}

/** Everything a refused withdrawal must not have changed, plus the attestations and the spent grants. */
async function trailOf(p: Proposal) {
  return {
    ...(await untouchedOf(p)),
    statuses: await statusesOf(p.kind, p.covered),
    attestations: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_attestations
        WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
      [W.tenantId, p.covered],
    ),
    spent: await spentWithdrawGrants(p.batchId),
  };
}

async function auditCount(kind: Kind, ids: string[]) {
  return count(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS x WHERE event::text LIKE '%' || x || '%')`,
    [W.tenantId, AUDIT[kind], ids],
  );
}

// ---- SQL withdraw (design 5) --------------------------------------------------------------------

const CORRECTION_WITHDRAW = `SELECT app.payout_correction_withdraw($1::uuid, $2::text) AS n`;
const OVERPAID_WITHDRAW = `SELECT app.payout_overpaid_withdraw($1::uuid, $2::uuid[], $3::varchar, $4::text) AS n`;

function withdrawStatement(p: Proposal, grant: string) {
  return p.kind === "correction"
    ? { sql: CORRECTION_WITHDRAW, params: [p.operation, grant] }
    : {
        sql: OVERPAID_WITHDRAW,
        params: [p.batchId, p.covered, p.key, grant],
      };
}
const sqlWithdraw = (
  p: Proposal,
  grant: string,
  options: { commit?: boolean } = {},
) => {
  const s = withdrawStatement(p, grant);
  return appCall(s.sql, s.params, options);
};

/** The binding of a `withdraw` grant for the proposal; `over` changes exactly one component. */
const withdrawBinding = (
  p: Proposal,
  over: Partial<PayoutGrantBinding> = {},
): PayoutGrantBinding =>
  ({
    kind: p.kind,
    step: "withdraw",
    batchId: p.batchId,
    itemIds: p.covered,
    evidenceKey: p.key,
    refId: p.kind === "correction" ? p.operation : null,
    targetId: null,
    ...over,
  }) as unknown as PayoutGrantBinding;

const issueWithdraw = (
  who: Person,
  p: Proposal,
  over: Partial<PayoutGrantBinding> = {},
) => grantsOf(who).issue(withdrawBinding(p, over));

/** A clean withdrawal: the proposal row is `withdrawn` by `by`, nothing else moved. */
async function expectWithdrawn(
  p: Proposal,
  by: Person,
  before: Awaited<ReturnType<typeof untouchedOf>>,
) {
  for (const id of p.covered) {
    const rows = await proposalRows(p.kind, id);
    expect(rows, "the row is kept, not deleted").toHaveLength(1);
    expect(rows[0]!.status).toBe("withdrawn");
    expect(rows[0]!.withdrawn_by, "who withdrew").toBe(by.userId);
    expect(rows[0]!.withdrawn_at, "when").toBeTruthy();
    expect(
      rows[0]![p.kind === "correction" ? "corrected_by" : "recorded_by"],
    ).toBeNull();
  }
  expect(
    await untouchedOf(p),
    "the items (whole rows), postings, journals and batches did not move",
  ).toEqual(before);
  for (const id of p.covered)
    expect(await itemStatus(id), "the item stays failed").toBe("failed");
}

// ---- SQL world: proof bound to the operation, like 911 grants -------------------------------------

/** The upload record of one proof file of the batch, unbound; `contentHash` lets two files share bytes. */
async function recordUpload(
  batchId: string,
  name = "bukti",
  contentHash = hex(),
) {
  const key = trackKey(
    evidenceKeyFor(W.tenantId, batchId, `${name}-${randomUUID()}.pdf`),
  );
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, 'upload-915')`,
        [W.tenantId, batchId, key, contentHash, contentHash],
      ),
    true,
  );
  seededFiles.push(key);
  return key;
}

const BIND = `SELECT app.payout_bind_proof($1::uuid, $2::text, $3::uuid[], $4::varchar, $5::text) AS id`;
const PROPOSE = `SELECT app.payout_correction_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`;
const APPROVE = `SELECT app.payout_correction_approve($1::uuid, $2::varchar, $3::text) AS n`;

async function boundUpload(w: World, name = "bukti", contentHash = hex()) {
  const key = await recordUpload(w.batchId, name, contentHash);
  const bound = await appCall(BIND, [
    w.batchId,
    "correction",
    [w.itemId],
    key,
    one.userId,
  ]);
  expect(bound.code, `premise: proof bound, ${bound.message}`).toBe(undefined);
  return key;
}

/** A correction proposal made in SQL by `who` over a bound proof; returns it as a Proposal. */
async function sqlProposal(who: Person, w: World, key: string) {
  const grant = await grantsOf(who).issue({
    kind: "correction",
    step: "propose",
    batchId: w.batchId,
    itemIds: [w.itemId],
    evidenceKey: key,
    refId: null,
    targetId: null,
  });
  const proposed = await appCall(PROPOSE, [
    w.batchId,
    [w.itemId],
    key,
    NOTE,
    grant,
  ]);
  expect(proposed.code, `premise: step one, ${proposed.message}`).toBe(
    undefined,
  );
  return {
    ...w,
    kind: "correction" as const,
    key,
    covered: [w.itemId],
    operation: proposed.rows[0]!.id as string,
  };
}

// ---- Stuck proof and closure (as 911 closure-swap) ---------------------------------------------------

async function stuck(batchId: string, key: string) {
  const contentSha = createHash("sha256")
    .update(`fixture proof ${W.tenantId}/${key}`)
    .digest("hex");
  await W.asTenant(async (c) => {
    const inserted = await c.query(
      `INSERT INTO payroll_payout_evidence_files
         (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (tenant_id, evidence_key) DO NOTHING RETURNING id`,
      [W.tenantId, batchId, key, contentSha, APP],
    );
    if (inserted.rowCount) seededFiles.push(key);
    await c.query(
      `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason, attempts)
       VALUES ($1, $2, $3, 'shared_key', 3)`,
      [W.tenantId, batchId, key],
    );
  }, true);
}

async function proposeClosure(who: Person, key: string) {
  const proposed = (await who.client
    .post(`${PROOFS}/closures`)
    .set(originHeader)
    .send({
      evidenceKey: key,
      note: NOTE_CLOSE,
      password: PASSWORD,
    })) as unknown as Res;
  expectOk(proposed, "closure propose");
  return proposed.body.data!.closureId as string;
}
async function approveClosure(who: Person, closureId: string) {
  const approved = (await who.client
    .post(`${PROOFS}/closures/${closureId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD })) as unknown as Res;
  expectOk(approved, "closure approve");
  expect(approved.body.data, "closed").toMatchObject({ stage: "closed" });
}

/** Retry = a new batch for the same run as a fixture requester. */
const retry = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );

// =========================================================================
// 1: the proposer and another approver withdraw
// =========================================================================

describe("915: a waiting proposal is withdrawn by its proposer or by another approver", () => {
  for (const kind of KINDS) {
    for (const [actorName, pick] of [
      ["the proposer", () => one],
      ["another approver", () => two],
    ] as const) {
      it(`[915-withdraw-${kind}-by-${actorName === "the proposer" ? "proposer" : "other"}] ${actorName} withdraws a ${kind} proposal: the row is kept as withdrawn with who and when, the attestation carries a grant spent in its own transaction, the item and the books do not move, one audit event`, async () => {
        const by = pick();
        const p = await proposalWorld(kind);
        const before = await untouchedOf(p);
        const auditIds = [
          p.batchId,
          ...p.covered,
          ...(p.operation ? [p.operation] : []),
          ...(await proposalRows(kind, p.itemId)).map((r) => r.id as string),
        ];
        const auditBefore = await auditCount(kind, auditIds);

        const res = await withdrawCall(by, kind, p.batchId, p.covered);
        expectOk(res, "withdraw");

        await expectWithdrawn(p, by, before);
        const attestations = await withdrawAttestations(p.itemId);
        expect(attestations, "exactly one withdraw attestation").toHaveLength(
          1,
        );
        const a = attestations[0]!;
        expect(a.kind).toBe(kind);
        expect(a.grant_id, "the attestation has a grant_id").not.toBeNull();
        expect(a.grant_kind).toBe(kind);
        expect(a.grant_step).toBe("withdraw");
        expect(a.actor, "the grant names the withdrawer").toBe(by.userId);
        expect(a.consumed_at, "grant spent").not.toBeNull();
        expect(a.grant_txid, "spent in the attesting txid").toBe(
          a.attestation_txid,
        );
        expect(
          await auditCount(kind, auditIds),
          "one audit event of the withdrawal",
        ).toBe(auditBefore + 1);
      });
    }
  }
});

// =========================================================================
// 2: the requester of the batch is refused
// =========================================================================

describe("915: the requester of the batch cannot withdraw", () => {
  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-requester-refused] over HTTP the requester gets 403 PAYOUT_REQUESTER_CANNOT_WITHDRAW; in SQL a valid grant of the requester gives PAYOUT-64, the grant stays unspent, nothing moves`, async () => {
      const p = await proposalWorld(kind);
      const before = await trailOf(p);

      const res = await withdrawCall(requester, kind, p.batchId, p.covered);
      expect(res.status, detail(res)).toBe(403);
      expect(errorCodeOf(res)).toBe("PAYOUT_REQUESTER_CANNOT_WITHDRAW");
      expect(await trailOf(p)).toEqual(before);
      expect((await statusesOf(kind, p.covered))[0]).toBe("proposed");

      const grant = await issueWithdraw(requester, p);
      const refused = await sqlWithdraw(p, grant);
      expect(refused.code, "refused").toBeDefined();
      expect(refused.message).toMatch(/PAYOUT-64:/);
      expect(
        (await grantRow(grant))!.consumed_at,
        "the refused step rolled the spend back",
      ).toBeNull();
      expect(await trailOf(p)).toEqual(before);
      expect(await spentWithdrawGrants(p.batchId)).toBe(0);

      // Control: the same call for another approver works, so the refusal was the requester.
      const ok = await sqlWithdraw(p, await issueWithdraw(two, p));
      expect(ok.code, `control: ${ok.message}`).toBe(undefined);
    });
  }
});

// =========================================================================
// 3: only step one can be withdrawn
// =========================================================================

describe("915: only a proposal that is still step one can be withdrawn", () => {
  it("[915-withdraw-correction-after-corrected] a correction already approved gives PAYOUT-63 in SQL and 409 PAYOUT_PROPOSAL_NOT_WITHDRAWABLE over HTTP; the item stays succeeded", async () => {
    const p = await proposalWorld("correction");
    expectOk(
      await stepOne(two, "correction", p.batchId, p.covered, p.key),
      "second step",
    );
    expect(await itemStatus(p.itemId), "premise: corrected").toBe("succeeded");
    const before = await trailOf(p);

    expectNotWithdrawable(
      await sqlWithdraw(p, await issueWithdraw(three, p)),
      "sql",
    );
    const res = await withdrawCall(three, "correction", p.batchId, p.covered);
    expect(res.status, detail(res)).toBe(409);
    expect(errorCodeOf(res)).toBe("PAYOUT_PROPOSAL_NOT_WITHDRAWABLE");
    expect(await trailOf(p)).toEqual(before);
    expect(await itemStatus(p.itemId)).toBe("succeeded");
  });

  it("[915-withdraw-overpaid-after-recorded] an overpaid group already recorded gives PAYOUT-63 in SQL and 409 PAYOUT_PROPOSAL_NOT_WITHDRAWABLE over HTTP; the items stay overpaid", async () => {
    const p = await proposalWorld("overpaid", { people: [BUDI, SITI] });
    expectOk(
      await stepOne(two, "overpaid", p.batchId, p.covered, p.key),
      "second step",
    );
    for (const id of p.covered)
      expect(await itemStatus(id), "premise: recorded").toBe("overpaid");
    const before = await trailOf(p);

    expectNotWithdrawable(
      await sqlWithdraw(p, await issueWithdraw(three, p)),
      "sql",
    );
    const res = await withdrawCall(three, "overpaid", p.batchId, p.covered);
    expect(res.status, detail(res)).toBe(409);
    expect(errorCodeOf(res)).toBe("PAYOUT_PROPOSAL_NOT_WITHDRAWABLE");
    expect(await trailOf(p)).toEqual(before);
  });

  it("[915-withdraw-overpaid-group-one-recorded] a group of two items where one is already recorded cannot be withdrawn (PAYOUT-63), the whole group stays as it is", async () => {
    const p = await proposalWorld("overpaid", { people: [BUDI, SITI] });
    // Fixture (owner, replica mode, CHECKs on): the first item of the group is recorded.
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_overpaid_proposals
              SET status = 'recorded', recorded_by = $3, recorded_at = now()
            WHERE tenant_id = $1 AND item_id = $2`,
          [W.tenantId, p.covered[0], two.userId],
        ),
      true,
    );
    const before = await trailOf(p);
    expectNotWithdrawable(
      await sqlWithdraw(p, await issueWithdraw(three, p)),
      "group with a recorded item",
    );
    expect(await trailOf(p)).toEqual(before);
    expect((await statusesOf("overpaid", p.covered)).sort()).toEqual([
      "proposed",
      "recorded",
    ]);
  });

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-twice] withdrawing a withdrawn ${kind} proposal gives PAYOUT-63 in SQL and 409 over HTTP, and writes no second attestation or audit event`, async () => {
      const p = await proposalWorld(kind);
      expectOk(await withdrawCall(one, kind, p.batchId, p.covered), "first");
      const before = await trailOf(p);
      const audit = await auditCount(kind, [p.batchId, ...p.covered]);

      expectNotWithdrawable(
        await sqlWithdraw(p, await issueWithdraw(two, p)),
        "sql",
      );
      const res = await withdrawCall(two, kind, p.batchId, p.covered);
      expect(res.status, detail(res)).toBe(409);
      expect(errorCodeOf(res)).toBe("PAYOUT_PROPOSAL_NOT_WITHDRAWABLE");
      expect(await trailOf(p)).toEqual(before);
      expect(await auditCount(kind, [p.batchId, ...p.covered])).toBe(audit);
    });
  }

  it("[915-withdraw-overpaid-partial-group] withdrawing only some items of a group gives PAYOUT-63 in SQL and 409 over HTTP, the group stays open", async () => {
    const p = await proposalWorld("overpaid", { people: [BUDI, SITI] });
    const part: Proposal = { ...p, covered: [p.covered[0]!] };
    const before = await trailOf(p);

    expectNotWithdrawable(
      await sqlWithdraw(part, await issueWithdraw(two, part)),
      "sql",
    );
    const res = await withdrawCall(two, "overpaid", p.batchId, part.covered);
    expect(res.status, detail(res)).toBe(409);
    expect(errorCodeOf(res)).toBe("PAYOUT_PROPOSAL_NOT_WITHDRAWABLE");
    expect(await trailOf(p)).toEqual(before);
    expect(await statusesOf("overpaid", p.covered)).toEqual([
      "proposed",
      "proposed",
    ]);
  });
});

// =========================================================================
// 4: a new proposal after a withdrawal
// =========================================================================

/**
 * 87dur: the night recon after a withdrawal and a new proposal over a NEW proof.
 * The withdrawn K1 binding stays on record (history, never reusable) but is no
 * second completed operation: no recon exception, no finance exception, the
 * K1 binding and the approval log are untouched, and the books are unchanged.
 */
async function expectReconCleanAfterRepropose(p: Proposal, k1: string) {
  const bindingKeys = async () =>
    (
      await W.rowsOf(
        `SELECT evidence_key FROM payroll_payout_proof_bindings
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = $3`,
        [W.tenantId, p.batchId, p.kind],
      )
    )
      .map((r) => String(r.evidence_key))
      .sort();
  const logRows = () =>
    count(
      `SELECT count(*)::int AS n FROM payroll_payout_approval_log
        WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, p.batchId],
    );
  const keysBefore = await bindingKeys();
  const logBefore = await logRows();
  expect(keysBefore, "premise: K1 binding is on record").toContain(k1);
  expect(keysBefore, "premise: K1 and K2 bindings").toHaveLength(2);

  const { storage } = W.proofs();
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await (
      reconcileTrustedPayouts as unknown as (
        context: unknown,
        options: unknown,
      ) => Promise<{ operations: number; last: string | null }>
    )(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) break;
    after = result.last;
  }

  const exceptions = await W.rowsOf(
    `SELECT reason FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, p.itemId],
  );
  expect(
    exceptions.map((r) => String(r.reason)),
    "no recon exception (not binding_duplicate)",
  ).toEqual([]);
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const finance = JSON.stringify(
    (
      await listFinanceExceptions(W.scope(), {
        from: day(-2),
        to: day(2),
        kind: "payout_recon_flag",
      } as never)
    ).items,
  );
  expect(finance, "no finance exception for the item").not.toContain(p.itemId);
  expect(await bindingKeys(), "both bindings stay on record").toEqual(
    keysBefore,
  );
  expect(await logRows(), "the approval log is untouched").toBe(logBefore);
}

describe("915: proposing again after a withdrawal", () => {
  it("[915-withdraw-correction-repropose-new-proof] after a withdrawal a new proposal over a NEW proof goes through both steps: the item is corrected once, one settle journal", async () => {
    const p = await proposalWorld("correction");
    expectOk(
      await withdrawCall(two, "correction", p.batchId, p.covered),
      "withdraw",
    );

    const key2 = trackKey(
      uploadEvidence(p.batchId, `wd-new-${randomUUID()}.pdf`),
    );
    const first = await stepOne(one, "correction", p.batchId, p.covered, key2);
    expectOk(first, "new step one");
    expect(first.body.data?.stage).toBe("proposed");
    const second = await stepOne(two, "correction", p.batchId, p.covered, key2);
    expectOk(second, "new step two");
    expect(second.body.data?.stage).toBe("corrected");

    expect(await itemStatus(p.itemId)).toBe("succeeded");
    expect((await statusesOf("correction", p.covered)).sort()).toEqual([
      "corrected",
      "withdrawn",
    ]);
    const settles = (await W.postingsOf(p.batchId)).filter(
      (x) => x.kind === "settle",
    );
    expect(settles, "one settle posting").toHaveLength(1);
    expect(await W.countJournals(settles[0]!.journal_key as string)).toBe(1);

    // 87dur: recon after the second operation completed.
    await expectReconCleanAfterRepropose(p, p.key);
    expect(
      await W.countJournals(settles[0]!.journal_key as string),
      "still one journal after recon",
    ).toBe(1);
  });

  it("[915-withdraw-overpaid-repropose-new-proof] after a withdrawal a new overpaid proposal over a NEW proof is recorded by another person: the item is overpaid, one receivable journal", async () => {
    const p = await proposalWorld("overpaid");
    expectOk(
      await withdrawCall(one, "overpaid", p.batchId, p.covered),
      "withdraw",
    );

    const key2 = trackKey(
      uploadEvidence(p.batchId, `wd-new-${randomUUID()}.pdf`),
    );
    const first = await stepOne(one, "overpaid", p.batchId, p.covered, key2);
    expectOk(first, "new step one");
    expect(first.body.data?.stage).toBe("proposed");
    const second = await stepOne(two, "overpaid", p.batchId, p.covered, key2);
    expectOk(second, "new step two");
    expect(second.body.data?.stage).toBe("recorded");

    expect(await itemStatus(p.itemId)).toBe("overpaid");
    expect(
      await W.countJournals(`payroll-payout-overpaid:${p.itemId}`),
      "one journal",
    ).toBe(1);

    // 87dur: recon after the second operation completed.
    await expectReconCleanAfterRepropose(p, p.key);
    expect(
      await W.countJournals(`payroll-payout-overpaid:${p.itemId}`),
      "still one journal after recon",
    ).toBe(1);
  });

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-old-proof-refused] the proof of a withdrawn ${kind} proposal can never be used again: the proposer and another person get 409 PAYOUT_PROOF_SPENT_BY_WITHDRAWN and no row is added`, async () => {
      const p = await proposalWorld(kind);
      expectOk(await withdrawCall(one, kind, p.batchId, p.covered), "withdraw");
      const before = await trailOf(p);

      for (const who of [one, two]) {
        const res = await stepOne(who, kind, p.batchId, p.covered, p.key);
        expect(res.status, detail(res)).toBe(409);
        expect(errorCodeOf(res)).toBe("PAYOUT_PROOF_SPENT_BY_WITHDRAWN");
      }
      expect(await trailOf(p)).toEqual(before);
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );
    });
  }

  it("[915-withdraw-same-bytes-new-key-refused] the same file bytes under a NEW key cannot start a new proposal after a withdrawal (refused at the proof bind or at the propose); only the withdrawn row exists", async () => {
    const w = await failedWorld();
    const bytes = hex();
    const k1 = await boundUpload(w, "k1", bytes);
    const p = await sqlProposal(one, w, k1);
    const ok = await sqlWithdraw(p, await issueWithdraw(two, p));
    expect(ok.code, `premise: withdrawn, ${ok.message}`).toBe(undefined);

    const k2 = await recordUpload(w.batchId, "k2", bytes);
    const bound = await appCall(BIND, [
      w.batchId,
      "correction",
      [w.itemId],
      k2,
      one.userId,
    ]);
    let proposed: Outcome | undefined;
    if (bound.code === undefined) {
      const grant = await grantsOf(one).issue({
        kind: "correction",
        step: "propose",
        batchId: w.batchId,
        itemIds: [w.itemId],
        evidenceKey: k2,
        refId: null,
        targetId: null,
      });
      proposed = await appCall(PROPOSE, [
        w.batchId,
        [w.itemId],
        k2,
        NOTE,
        grant,
      ]);
    }
    expect(
      bound.code !== undefined || proposed?.code !== undefined,
      "the same bytes under a new key must be refused",
    ).toBe(true);
    expect(await statusesOf("correction", [w.itemId])).toEqual(["withdrawn"]);
  });
});

// =========================================================================
// 5: the closure hold stays
// =========================================================================

describe("915: withdrawing does not release a slip held by a closed proof key", () => {
  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-closed-key-hold-stays] a ${kind} proposal over a key that two people closed is withdrawn, and the retry of the slip is still refused (409); the item stays failed and no batch, item, posting or journal appears`, async () => {
      const p = await proposalWorld(kind);
      await stuck(p.batchId, p.key);
      await approveClosure(three, await proposeClosure(two, p.key));
      expect(await gate(), "premise: the gate is clear again").toBe(false);
      await W.expectRefused(retry(p.runId), { status: 409 });
      const before = await untouchedOf(p);

      const res = await withdrawCall(two, kind, p.batchId, p.covered);
      expectOk(res, "withdraw over a closed key");

      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );
      expect(await itemStatus(p.itemId)).toBe("failed");
      await W.expectRefused(retry(p.runId), { status: 409 });
      expect(
        await untouchedOf({ ...p }),
        "no batch, item, posting or journal appeared",
      ).toEqual(before);
    });

    it(`[915-withdraw-${kind}-closure-pending] a ${kind} proposal is withdrawn while the closure of its key waits for the approver; the closure is then approved normally`, async () => {
      const p = await proposalWorld(kind);
      await stuck(p.batchId, p.key);
      const closureId = await proposeClosure(two, p.key);

      expectOk(await withdrawCall(one, kind, p.batchId, p.covered), "withdraw");
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );

      await approveClosure(three, closureId);
      expect(await gate(), "the gate is clear after the closure").toBe(false);
      expect(await itemStatus(p.itemId)).toBe("failed");
    });
  }
});

// =========================================================================
// 6 and 7: who can write the rows
// =========================================================================

describe("915: only the payout role writes the proposal rows", () => {
  it("[915-withdraw-app-role-no-write] legend_app cannot INSERT, UPDATE or DELETE the two proposal tables directly (42501), and cannot run the grant issuer for a withdraw", async () => {
    const c = await proposalWorld("correction");
    const o = await proposalWorld("overpaid");
    const id = randomUUID();
    const statements: { name: string; sql: string; params: unknown[] }[] = [
      {
        name: "INSERT correction",
        sql: `INSERT INTO payroll_payout_failed_corrections
                (id, tenant_id, batch_id, item_id, operation_id, evidence_key,
                 content_sha256, stored_sha256, note, status, proposed_by)
              VALUES ($1, $2, $3, $4, $1, $5, $6, $6, 'catatan', 'proposed', 'forged')`,
        params: [id, W.tenantId, c.batchId, c.itemId, c.key, hex()],
      },
      {
        name: "UPDATE correction to withdrawn",
        sql: `UPDATE payroll_payout_failed_corrections
                 SET status = 'withdrawn', withdrawn_by = 'forged', withdrawn_at = now()
               WHERE tenant_id = $1 AND item_id = $2`,
        params: [W.tenantId, c.itemId],
      },
      {
        name: "DELETE correction",
        sql: `DELETE FROM payroll_payout_failed_corrections WHERE tenant_id = $1 AND item_id = $2`,
        params: [W.tenantId, c.itemId],
      },
      {
        name: "INSERT overpaid proposal",
        sql: `INSERT INTO payroll_payout_overpaid_proposals
                (tenant_id, batch_id, item_id, evidence_key, note, proposed_by)
              VALUES ($1, $2, $3, $4, 'catatan', 'forged')`,
        params: [W.tenantId, o.batchId, o.itemId, o.key],
      },
      {
        name: "UPDATE overpaid proposal to withdrawn",
        sql: `UPDATE payroll_payout_overpaid_proposals
                 SET status = 'withdrawn', withdrawn_by = 'forged', withdrawn_at = now()
               WHERE tenant_id = $1 AND item_id = $2`,
        params: [W.tenantId, o.itemId],
      },
      {
        name: "DELETE overpaid proposal",
        sql: `DELETE FROM payroll_payout_overpaid_proposals WHERE tenant_id = $1 AND item_id = $2`,
        params: [W.tenantId, o.itemId],
      },
      {
        name: "grant issue for withdraw",
        sql: `SELECT app.payout_grant_issue('correction', 'withdraw', $1::uuid, $2::uuid[], $3::varchar, $4::uuid, NULL::uuid, NULL::varchar, $5::text, $6::text, 'mfa_challenge')`,
        params: [
          c.batchId,
          c.covered,
          c.key,
          c.operation,
          two.userId,
          actorOf(two.userId).sessionId,
        ],
      },
    ];
    const outcome: Record<string, string | undefined> = {};
    for (const s of statements)
      outcome[s.name] = (
        await appCall(s.sql, s.params, { commit: false })
      ).code;
    expect(outcome).toEqual(
      Object.fromEntries(statements.map((s) => [s.name, PRIVILEGE])),
    );
    expect(await statusesOf("correction", c.covered)).toEqual(["proposed"]);
    expect(await statusesOf("overpaid", o.covered)).toEqual(["proposed"]);
  });

  /** One transaction as legend_payout (the real triggers on), always rolled back; `work` returns what it saw. */
  async function asPayout<T>(work: (c: PoolClient) => Promise<T>) {
    const client = await W.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_payout");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      return await work(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  /** A statement inside a savepoint: its SQLSTATE, or undefined when it worked. */
  async function attempt(c: PoolClient, sql: string, params: unknown[] = []) {
    await c.query("SAVEPOINT attempt");
    try {
      await c.query(sql, params);
      await c.query("RELEASE SAVEPOINT attempt");
      return undefined;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT attempt");
      return (error as { code?: string }).code ?? "unknown";
    }
  }

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-payout-role-shapes] as legend_payout, only proposed to withdrawn with the withdrawn columns and nothing else changed is allowed; every other shape, a revival of a withdrawn row and an INSERT as withdrawn give 23514`, async () => {
      const p = await proposalWorld(kind);
      const table = TABLE[kind];
      const done = kind === "correction" ? "corrected" : "recorded";
      const doneColumns =
        kind === "correction"
          ? `corrected_by = 'x', corrected_at = now()`
          : `recorded_by = 'x', recorded_at = now()`;
      const where = `tenant_id = $1 AND item_id = $2`;
      const args = [W.tenantId, p.itemId];

      const seen = await asPayout(async (c) => {
        const out: Record<string, string | undefined> = {};
        out["withdrawn without who and when"] = await attempt(
          c,
          `UPDATE ${table} SET status = 'withdrawn' WHERE ${where}`,
          args,
        );
        out["withdrawn with another column changed"] = await attempt(
          c,
          `UPDATE ${table} SET status = 'withdrawn', withdrawn_by = 'x', withdrawn_at = now(), note = 'ubah' WHERE ${where}`,
          args,
        );
        out["withdrawn and corrected at once"] = await attempt(
          c,
          `UPDATE ${table} SET status = 'withdrawn', withdrawn_by = 'x', withdrawn_at = now(), ${doneColumns} WHERE ${where}`,
          args,
        );
        // Control: the one allowed shape.
        out["control: the allowed shape"] = await attempt(
          c,
          `UPDATE ${table} SET status = 'withdrawn', withdrawn_by = 'x', withdrawn_at = now() WHERE ${where}`,
          args,
        );
        out["withdrawn back to proposed"] = await attempt(
          c,
          `UPDATE ${table} SET status = 'proposed', withdrawn_by = NULL, withdrawn_at = NULL WHERE ${where}`,
          args,
        );
        out[`withdrawn to ${done}`] = await attempt(
          c,
          `UPDATE ${table} SET status = '${done}', withdrawn_by = NULL, withdrawn_at = NULL, ${doneColumns} WHERE ${where}`,
          args,
        );
        out["any change of a withdrawn row"] = await attempt(
          c,
          `UPDATE ${table} SET note = 'ubah lagi' WHERE ${where}`,
          args,
        );
        // INSERT of a copy of the withdrawn row (status withdrawn): INSERT must be proposed.
        const columns = (
          await c.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'
              ORDER BY ordinal_position`,
            [table],
          )
        ).rows.map((r) => r.column_name as string);
        const fresh: Record<string, string> = {
          id: "gen_random_uuid()",
          operation_id: "gen_random_uuid()",
        };
        out["INSERT as withdrawn"] = await attempt(
          c,
          `INSERT INTO ${table} (${columns.map((n) => `"${n}"`).join(", ")})
           SELECT ${columns.map((n) => fresh[n] ?? `"${n}"`).join(", ")}
             FROM ${table} WHERE ${where}`,
          args,
        );
        return out;
      });

      expect(seen["control: the allowed shape"], "control").toBeUndefined();
      const refused = { ...seen };
      delete refused["control: the allowed shape"];
      expect(refused).toEqual(
        Object.fromEntries(Object.keys(refused).map((name) => [name, GUARD])),
      );
      // The transaction was rolled back: the proposal is still open.
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "proposed"),
      );
    });
  }
});

// =========================================================================
// 8: the grant
// =========================================================================

describe("915: a withdrawal spends a one-time grant of exactly its binding", () => {
  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-grant-binding] a propose grant, a grant for another kind, key, ref, item set or a made-up hex gives PAYOUT-70, the grant stays unspent and nothing moves; the exact grant then works; replaying it gives PAYOUT-70`, async () => {
      const p = await proposalWorld(kind, { people: [BUDI, SITI] });
      const otherKey = await recordUpload(p.batchId, "other");
      // A correction covers only the first of the two failed items.
      const otherItems = [p.itemIds[1]!];
      type Variant = { name: string; over: Partial<PayoutGrantBinding> };
      const variants: Variant[] = [
        {
          name: "a propose grant",
          over: { step: "propose", refId: null },
        },
        {
          name: "another kind",
          over: { kind: kind === "correction" ? "overpaid" : "correction" },
        },
        { name: "another evidence key", over: { evidenceKey: otherKey } },
        { name: "another ref", over: { refId: randomUUID() } },
        { name: "another item set", over: { itemIds: otherItems } },
      ];
      if (kind === "overpaid")
        variants.push({
          name: "a ref where overpaid has none",
          over: { refId: p.itemId },
        });

      for (const v of variants) {
        const grant = await issueWithdraw(three, p, v.over);
        const before = await trailOf(p);
        expectGrantRefused(await sqlWithdraw(p, grant), v.name);
        expect(
          (await grantRow(grant))!.consumed_at,
          `${v.name}: the grant stays unspent`,
        ).toBeNull();
        expect(await trailOf(p), `${v.name}: nothing moved`).toEqual(before);
      }

      const before = await trailOf(p);
      expectGrantRefused(await sqlWithdraw(p, hex()), "a made-up hex");
      expect(await trailOf(p)).toEqual(before);

      const exact = await issueWithdraw(three, p);
      const ok = await sqlWithdraw(p, exact);
      expect(ok.code, `control: ${ok.message}`).toBe(undefined);
      expect((await grantRow(exact))!.consumed_at).not.toBeNull();
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );

      const after = await trailOf(p);
      expectGrantRefused(await sqlWithdraw(p, exact), "replay");
      expect(await trailOf(p)).toEqual(after);
    });
  }

  it("[915-withdraw-grant-expired] a withdraw grant past expires_at gives PAYOUT-70 and stays unspent; the proposal stays open", async () => {
    const p = await proposalWorld("correction");
    const grant = await issueWithdraw(two, p);
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_grants
              SET issued_at = now() - interval '10 minutes',
                  expires_at = now() - interval '8 minutes'
            WHERE secret_sha256 = $1`,
          [sha(grant)],
        ),
      true,
    );
    const before = await trailOf(p);
    expectGrantRefused(await sqlWithdraw(p, grant), "expired");
    expect((await grantRow(grant))!.consumed_at).toBeNull();
    expect(await trailOf(p)).toEqual(before);
  });

  it("[915-withdraw-grant-matrix] the grant issuer accepts step withdraw only for correction and overpaid: return, closure and resolve with step withdraw give PAYOUT-72 and no grant row", async () => {
    const p = await proposalWorld("correction");
    const before = await issuedWithdrawGrants(p.batchId);
    for (const kind of ["return", "closure", "resolve"] as const) {
      const message = await issueWithdraw(two, p, { kind } as never).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect(message, `${kind}/withdraw must be refused`).toMatch(/PAYOUT-72:/);
    }
    expect(await issuedWithdrawGrants(p.batchId)).toBe(before);
    // Control: correction and overpaid are in the matrix.
    await expect(issueWithdraw(two, p)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

// =========================================================================
// 9: proposals from before the grants, and a stuck proof
// =========================================================================

describe("915: a proposal without a step-one grant, over a stuck proof, can still be withdrawn", () => {
  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-pre-cutover-and-stuck-proof] a ${kind} proposal whose step-one attestation has no grant (from before the cutover) and whose proof is stuck is withdrawn with a fresh grant`, async () => {
      const p = await proposalWorld(kind);
      // Fixture (owner, replica mode): step one looks like it was attested before the grants.
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_attestations
                SET grant_id = NULL, attested_at = app.payout_grants_since() - interval '1 day'
              WHERE tenant_id = $1 AND kind = $2 AND step = 'propose' AND item_ids && $3::uuid[]`,
            [W.tenantId, kind, p.covered],
          ),
        true,
      );
      await stuck(p.batchId, p.key);
      const before = await untouchedOf(p);

      const outcome = await sqlWithdraw(p, await issueWithdraw(two, p));
      expect(outcome.code, outcome.message).toBe(undefined);
      await expectWithdrawn(p, two, before);
      const attestations = await withdrawAttestations(p.itemId);
      expect(attestations).toHaveLength(1);
      expect(attestations[0]!.grant_id).not.toBeNull();
    });
  }
});

// =========================================================================
// 10: withdraw against approve, withdraw against withdraw
// =========================================================================

describe("915: withdrawing and approving at the same moment: one wins", () => {
  it("[915-withdraw-vs-approve-race] a withdraw and the second step of the same correction fired together: exactly one succeeds; the loser gets a refusal and the final state is consistent (withdrawn and failed, or corrected and succeeded) in three rounds", async () => {
    for (let round = 0; round < 3; round += 1) {
      const w = await failedWorld();
      const key = await boundUpload(w, `race-${round}`);
      const p = await sqlProposal(one, w, key);
      const approveGrant = await grantsOf(two).issue({
        kind: "correction",
        step: "approve",
        batchId: w.batchId,
        itemIds: [w.itemId],
        evidenceKey: key,
        refId: p.operation,
        targetId: null,
      });
      const withdrawGrant = await issueWithdraw(three, p);
      const w2 = withdrawStatement(p, withdrawGrant);

      const [approved, withdrawn] = await raceCalls([
        { sql: APPROVE, params: [p.operation, key, approveGrant] },
        w2,
      ]);

      const winners = [approved, withdrawn].filter(
        (r) => r!.code === undefined,
      );
      expect(winners, JSON.stringify([approved, withdrawn])).toHaveLength(1);
      const status = (await statusesOf("correction", [w.itemId]))[0];
      if (approved!.code === undefined) {
        expect(status).toBe("corrected");
        expect(await itemStatus(w.itemId)).toBe("succeeded");
        expect(withdrawn!.message).toMatch(/PAYOUT-63:/);
      } else {
        expect(status).toBe("withdrawn");
        expect(await itemStatus(w.itemId)).toBe("failed");
      }
    }
  });

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-race] three withdrawals of one ${kind} proposal fired together, each with its own valid grant: exactly one succeeds, the others get PAYOUT-63, one withdraw attestation, one spent grant`, async () => {
      const p = await proposalWorld(kind);
      const calls = [];
      const grants: string[] = [];
      for (const who of [one, two, three]) {
        const grant = await issueWithdraw(who, p);
        grants.push(grant);
        calls.push(withdrawStatement(p, grant));
      }
      const results = await raceCalls(calls);

      const ok = results.filter((r) => r.code === undefined);
      expect(ok, JSON.stringify(results)).toHaveLength(1);
      for (const r of results.filter((x) => x.code !== undefined))
        expect(r.message).toMatch(/PAYOUT-63:/);
      expect(await withdrawAttestations(p.itemId)).toHaveLength(1);
      expect(await spentWithdrawGrants(p.batchId)).toBe(1);
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );
    });
  }
});

// =========================================================================
// 11: the second step with a withdrawn key
// =========================================================================

describe("915: the second step cannot use the key of a withdrawn proposal", () => {
  it("[915-withdraw-overpaid-record-withdrawn-key] after a withdrawal the second person's overpaid step with the same key is refused (409 PAYOUT_PROOF_SPENT_BY_WITHDRAWN over HTTP) and in SQL the record is refused; the item stays failed, nothing is booked", async () => {
    const p = await proposalWorld("overpaid");
    expectOk(
      await withdrawCall(one, "overpaid", p.batchId, p.covered),
      "withdraw",
    );
    const before = await trailOf(p);

    const res = await stepOne(two, "overpaid", p.batchId, p.covered, p.key);
    expect(res.status, detail(res)).toBe(409);
    expect(errorCodeOf(res)).toBe("PAYOUT_PROOF_SPENT_BY_WITHDRAWN");

    // SQL: app.payout_overpaid_record(item, key, posting, grant) (911 design 3.B.2).
    const grant = await grantsOf(two).issue({
      kind: "overpaid",
      step: "record",
      batchId: p.batchId,
      itemIds: [p.itemId],
      evidenceKey: p.key,
      refId: randomUUID(),
      targetId: null,
    } as PayoutGrantBinding);
    const record = await appCall(
      `SELECT app.payout_overpaid_record($1::uuid, $2::varchar, $3::uuid, $4::text)`,
      [p.itemId, p.key, randomUUID(), grant],
      { commit: false },
    ).catch(() => undefined);
    expect(record?.code, "the record must be refused").toBeDefined();

    expect(await trailOf(p)).toEqual(before);
    expect(await itemStatus(p.itemId)).toBe("failed");
  });
});

// =========================================================================
// 12: the night recon
// =========================================================================

describe("915: the night recon accepts a clean withdrawal and flags a forged grant", () => {
  async function runRecon() {
    const { storage } = W.proofs();
    let after: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
      const result = await (
        reconcileTrustedPayouts as unknown as (
          context: unknown,
          options: unknown,
        ) => Promise<{ operations: number; last: string | null }>
      )(W.scope(), { storage, after });
      if (result.last === null || result.operations === 0) return;
      after = result.last;
    }
    throw new Error("recon did not finish");
  }
  const exceptionsOf = (itemId: string) =>
    W.rowsOf(
      `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
      [W.tenantId, itemId],
    );
  const financeFlags = async () => {
    const day = (shift: number) =>
      new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
    const result = await listFinanceExceptions(W.scope(), {
      from: day(-2),
      to: day(2),
      kind: "payout_recon_flag",
    } as never);
    return JSON.stringify(result.items);
  };

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-recon] a clean withdrawal of a ${kind} proposal gives no recon flag and no finance exception; a withdraw grant whose actor was changed gives grant_mismatch`, async () => {
      const p = await proposalWorld(kind);
      expectOk(await withdrawCall(two, kind, p.batchId, p.covered), "withdraw");

      await runRecon();
      expect(
        await exceptionsOf(p.itemId),
        "clean: no recon exception",
      ).toHaveLength(0);
      expect(await financeFlags(), "clean: no finance exception").not.toContain(
        p.itemId,
      );

      const grantId = (await withdrawAttestations(p.itemId))[0]!
        .grant_id as string;
      const actorOfGrant = async () =>
        (
          await W.rowsOf(
            `SELECT actor FROM payroll_payout_grants WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, grantId],
          )
        )[0]!.actor as string;
      const original = await actorOfGrant();
      try {
        await W.asTenant(
          (c) =>
            c.query(
              `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
              [W.tenantId, grantId, randomUUID()],
            ),
          true,
        );
        await runRecon();
        const rows = await exceptionsOf(p.itemId);
        expect(rows.length, "the forged grant is flagged").toBeGreaterThan(0);
        expect(rows.map((r) => r.reason)).toContain("grant_mismatch");
      } finally {
        await W.asTenant(
          (c) =>
            c.query(
              `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
              [W.tenantId, grantId, original],
            ),
          true,
        );
      }
    });
  }
});

describe("915: a withdraw attestation is checked even when the tenant has no operation", () => {
  it("[915-withdraw-recon-no-operation] a withdraw whose grant was forged gives grant_mismatch although the page has no other operation", async () => {
    const p = await proposalWorld("correction");
    expectOk(
      await withdrawCall(two, "correction", p.batchId, p.covered),
      "withdraw",
    );
    const grantId = (await withdrawAttestations(p.itemId))[0]!
      .grant_id as string;
    const exceptions = () =>
      W.rowsOf(
        `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, p.itemId],
      );
    // A trusted boundary in the future: no operation is listed on the page.
    const run = () =>
      (
        reconcileTrustedPayouts as unknown as (
          context: unknown,
          options: unknown,
        ) => Promise<{ operations: number }>
      )(W.scope(), {
        storage: W.proofs().storage,
        since: new Date(Date.now() + 86_400_000),
      });
    expect((await run()).operations, "no operation on the page").toBe(0);
    expect(await exceptions(), "clean withdrawal: no flag").toHaveLength(0);

    const original = (
      await W.rowsOf(
        `SELECT actor FROM payroll_payout_grants WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, grantId],
      )
    )[0]!.actor as string;
    const setActor = (actor: string) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, grantId, actor],
          ),
        true,
      );
    try {
      await setActor(randomUUID());
      expect((await run()).operations).toBe(0);
      expect((await exceptions()).map((r) => r.reason)).toContain(
        "grant_mismatch",
      );
    } finally {
      await setActor(original);
    }
  });

  it("[915-withdraw-grant-error-mapping] PAYOUT-70 (42501) from a withdraw function, also behind a driver wrapper, is a 409 HttpError, not a raw database error", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("PAYOUT-70: no valid payout grant"), {
        code: "42501",
      }),
    });
    const mapped = withdrawError(wrapped);
    expect(mapped).toBeInstanceOf(HttpError);
    expect((mapped as HttpError).status).toBe(409);
    expect((mapped as HttpError).code).toBe("PAYOUT_STEP_GRANT_INVALID");
  });
});

// =========================================================================
// 13: the list of waiting proposals
// =========================================================================

describe("915: the list of waiting proposals shows corrections and overpaid groups, never withdrawn ones", () => {
  type Listed = {
    itemId: string;
    kind: string;
    groupItemIds?: string[];
    proposedBy: string;
  };
  const list = async (who: Person, batchId: string) => {
    const res = (await who.client
      .get(`${BATCHES}/${batchId}/resolution-proposals`)
      .set(originHeader)) as unknown as Res;
    expectOk(res, "list");
    return res.body.data as unknown as Listed[];
  };

  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-listed] a waiting ${kind} proposal is listed with its kind and the whole group in groupItemIds; after the withdrawal it is gone from the list`, async () => {
      const people = kind === "overpaid" ? [BUDI, SITI] : [BUDI];
      const p = await proposalWorld(kind, { people });

      const rows = (await list(two, p.batchId)).filter((r) => r.kind === kind);
      expect(rows.length, "the proposal is listed").toBeGreaterThan(0);
      for (const r of rows) {
        expect(p.covered).toContain(r.itemId);
        expect(sorted(r.groupItemIds ?? []), "the whole group").toEqual(
          sorted(p.covered),
        );
        expect(r.proposedBy).toBe(one.userId);
      }

      expectOk(await withdrawCall(one, kind, p.batchId, p.covered), "withdraw");
      const after = await list(two, p.batchId);
      expect(
        after.filter((r) => r.kind === kind),
        "a withdrawn proposal is not listed",
      ).toHaveLength(0);
    });
  }
});

// =========================================================================
// 14: the step-up
// =========================================================================

describe("915: withdrawing needs a fresh step-up", () => {
  for (const kind of KINDS) {
    it(`[915-withdraw-${kind}-stepup] a stale challenge and no password gives 401 REAUTH_REQUIRED, no grant is issued and the proposal stays open; with the password the route issues exactly one grant and works`, async () => {
      const p = await proposalWorld(kind);
      const person = await challengedFinance(`Stale ${kind}`);
      const moved = await W.owner.query(
        `UPDATE "session" SET mfa_challenge_verified_at = now() - interval '16 minutes'
          WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
        [person.userId],
      );
      expect(moved.rowCount, "premise: the challenge stamped the session").toBe(
        1,
      );

      const grantsBefore = await grantsOfTenant();
      const before = await trailOf(p);
      const stale = await withdrawCall(
        person,
        kind,
        p.batchId,
        p.covered,
        null,
      );
      expect(stale.status, detail(stale)).toBe(401);
      expect(errorCodeOf(stale)).toBe("REAUTH_REQUIRED");
      expect(await grantsOfTenant(), "no grant issued").toBe(grantsBefore);
      expect(await trailOf(p)).toEqual(before);
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "proposed"),
      );

      const wrong = await withdrawCall(
        person,
        kind,
        p.batchId,
        p.covered,
        "Salah-password-999!",
      );
      expect([401, 403], detail(wrong)).toContain(wrong.status);
      expect(await grantsOfTenant(), "still no grant").toBe(grantsBefore);

      const ok = await withdrawCall(person, kind, p.batchId, p.covered);
      expectOk(ok, "with the password");
      expect(await grantsOfTenant(), "exactly one grant issued").toBe(
        grantsBefore + 1,
      );
      expect(await spentWithdrawGrants(p.batchId)).toBe(1);
      expect(await statusesOf(kind, p.covered)).toEqual(
        p.covered.map(() => "withdrawn"),
      );
    });
  }
});
