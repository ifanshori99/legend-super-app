// Payout 918 (bead legend-l2zru): "Not me" (disown) freezes a payout batch, and an
// owner or finance user outside the batch unfreezes it. Written fail-first from
// docs/briefs/918/design-l2zru.md, section "Test", cases 1 to 13, and from the
// shared contract (packages/shared/src/hris/payroll/payout-endpoints.ts), NOT from
// the implementation.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): a person whose login signed a payout step they did not take says
// "not me" with their password. The batch is frozen at once: no trusted payout
// step, no batch/item/bank-file/GL write runs, nobody is paid more. Only an owner
// or finance user who took no part in the batch can lift the freeze, with a reason.
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - Routes (shared contract): GET /payout-approval-log/:logId (200 for the actor of
//   the log, 404 for anyone else), POST /payout-approval-log/:logId/disown
//   {reason?, password} -> 200/201 {data:{disputeId,batchId}}, POST
//   /disbursement-batches/:id/unfreeze {reason, password} -> {data:{released}},
//   GET /disbursement-batches/:id carries data.freeze {frozen, disputes[]}.
//   Missing password -> 401 (the other payout steps; the design says 401).
//   Refused unfreeze -> 409 PAYOUT_UNFREEZE_REFUSED (contract comment); a reason
//   shorter than 10 characters -> 422; frozen steps -> 409 PAYOUT_BATCH_FROZEN
//   (design: payoutGuardViolation). A person that may not even reach the unfreeze
//   route (brand-scoped owner) may be answered 403 instead of 409.
// - Disown by somebody else than the actor of the log: HTTP 404 (design 2).
// - SQL: app.payout_approval_disown(log uuid, grant text, reason text) -> uuid and
//   app.payout_batch_unfreeze(batch uuid, grant text, reason text) -> int, called
//   as legend_app with a REAL COMMIT. The disown grant is (kind disown, step
//   record, batch, no items, no key, ref = log id, detail = sha256(reason) as
//   lowercase hex, method `password`), issued by the grantor stand-in (the fixture
//   issuer hard-codes method mfa_challenge, so a local variant passes `password`).
//   Error text: PAYOUT-79 (frozen), PAYOUT-80 (dispute tables append-only),
//   PAYOUT-81 (disown refused), PAYOUT-82 (unfreeze refused), PAYOUT-70 (grant).
// - Case 1 / 5 are proven at the point the design says they bite: any kind/step of
//   app.payout_grant_consume (called with an unknown secret: the freeze check is
//   "at the start", so a frozen batch answers PAYOUT-79 where an unfrozen one
//   answers PAYOUT-70), app.payout_attest, app.payout_run_settle, and direct SQL.
//   One real grant is also issued and shown unspent. The kinds are the ones of the
//   design list plus those named in the 911 suites; consume does not validate the
//   (kind, step) pair before the freeze check.
// - Direct SQL on bank_transfer_files / payroll_payout_gl_postings inserts only
//   (tenant_id, batch_id) as legend_payout: a BEFORE INSERT trigger fires before
//   NOT NULL checks, so the frozen batch answers PAYOUT-79 and the control batch
//   answers something else (a NOT NULL violation).
// - HTTP steps on the frozen batch: correct-failed (step one) and approve; the
//   other routes need heavy worlds and share the same guard (grant consume / trigger).
// - Case 7 "approver" = approved_by and exported_by of the batch; "requester" =
//   requested_by; "actor log" = a person whose grant is in the approval log of the
//   batch. All of them hold an owner/finance template role at tenant scope, so
//   the exclusion rule is what refuses them, not the role.
// - Case 9: the finance exception kind is `payout_batch_disputed` (shared
//   validator); the item is found by the batch id (UUID or ULID form) in the item JSON.
// - Case 10: disown and a step on the same batch race with real commits; both
//   outcomes are serial (the step went through first, or got PAYOUT-79); no
//   deadlock or serialization failure; once the freeze exists the step is refused.
// - Case 11: events payout.batch_disputed {disputeId} and payout.batch_unfrozen
//   {unfreezeId} (aggregate payout, schema ref `<name>.v1`); the sweep is
//   runPayoutApprovalReceiptSweep(context, now) like the 915 suite; recipients are
//   the template owner/finance holders at tenant scope plus the disputant (not an
//   hr person, not a brand-scoped owner); category payout_receipt.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  uuidToUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import { reconcileTrustedPayouts } from "../services/payroll-payout-recon.service.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";
import { originHeader } from "./helpers.ts";
import {
  actorOf,
  bank,
  BUDI,
  evidenceKeyFor,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("918dis");
const NET = 1_000_000;
const NOTE = "Mutasi bank menunjukkan transfer ternyata berhasil";
const REASON =
  "Bukan saya yang menyetujui langkah ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const LOGS = "/api/hris/payroll/payout-approval-log";
const PRIVILEGE = "42501";
const GUARD = "23514";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const hex = () => randomBytes(32).toString("hex");
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const idForms = (uuid: string) => [uuid, uuidToUlid(uuid)];

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const seededFiles: string[] = [];
const batchIds: string[] = [];
let brandId = "";

// ---- People (HTTP, TOTP enrolled in this very session) --------------------------------

type Template = "owner" | "finance" | null;
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
    [W.tenantId, `Template ${key} 918`, key],
  );
  return (await read()).rows[0]!.id;
}

/**
 * A signed-in person. `approve` gives payroll.disburse.approve; `template` adds the
 * owner or finance template role (tenant scope, or brand scope with `scope: "brand"`).
 */
async function makePerson(
  label: string,
  options: {
    approve?: boolean;
    template?: Template;
    scope?: "tenant" | "brand";
  } = {},
) {
  const approve = options.approve ?? true;
  const { client, userId } = await W.signedInClient(`Disown918 ${label}`);
  personIds.push(userId);
  await W.grantRole(
    userId,
    approve
      ? ["payroll.view", "payroll.disburse.approve"]
      : ["access.role.view"],
  );
  if (options.template) {
    const roleId = await templateRoleId(options.template);
    const scope = options.scope ?? "tenant";
    await W.owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId, scope, scope === "brand" ? brandId : null],
    );
  }
  // TOTP enrolled and verified in this very session: stamps the MFA step-up on the
  // real session (what the HTTP routes check), as the 915 suite does.
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

let requester: Person; // owner template: created every batch, may never unfreeze
let approver: Person; // finance template: approved and exported every batch
let a: Person; // finance template: resolves first (the disputant of most tests)
let b: Person; // finance template: resolves second
let outsideOwner: Person; // owner template, tenant scope, took no part
let outsideFinance: Person; // finance template, tenant scope, took no part
let hr: Person; // has the approve permission but no owner/finance role
let brandOwner: Person; // owner template at brand scope only

// ---- Raw SQL helpers ----------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** One statement as `role` (legend_app by default), real COMMIT unless `commit: false`. */
async function runAs(
  role: "legend_app" | "legend_payout" | null,
  sql: string,
  params: unknown[] = [],
  options: { commit?: boolean; tenant?: string } = {},
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [options.tenant ?? W.tenantId],
    );
    try {
      const result = await client.query(sql, params);
      await client.query(options.commit === true ? "COMMIT" : "ROLLBACK");
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
/** legend_app with a real COMMIT. */
const appCall = (sql: string, params: unknown[] = []) =>
  runAs("legend_app", sql, params, { commit: true });
/** Always rolled back (probes). */
const probe = (
  role: "legend_app" | "legend_payout" | null,
  sql: string,
  params: unknown[] = [],
  tenant?: string,
) => runAs(role, sql, params, { commit: false, tenant });

/** Several legend_app transactions that fire at the same moment, each committing on its own. */
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

/** Grant of the grantor stand-in with an explicit method (the fixture issuer hard-codes mfa_challenge). */
async function issueGrant(input: {
  kind: string;
  step: string;
  userId: string;
  batchId: string;
  refId?: string | null;
  itemIds?: string[];
  evidenceKey?: string | null;
  detail?: string | null;
  method: "password" | "mfa_challenge";
}): Promise<{ grant?: string; code?: string; message: string }> {
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
          input.kind,
          input.step,
          input.batchId,
          `{${(input.itemIds ?? []).join(",")}}`,
          input.evidenceKey ?? null,
          input.refId ?? null,
          null,
          input.detail ?? null,
          input.userId,
          actorOf(input.userId).sessionId,
          input.method,
        ],
      );
      await client.query("COMMIT");
      return { grant: (rows[0] as { grant: string }).grant, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

const DISOWN = `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`;
const UNFREEZE = `SELECT app.payout_batch_unfreeze($1::uuid, $2::text, $3::text) AS released`;

/** Disown in SQL: password grant of the actor, then the trusted function. */
async function sqlDisown(
  userId: string,
  w: { batchId: string },
  logId: string,
  reason = REASON,
  grantReason = reason,
) {
  const issued = await issueGrant({
    kind: "disown",
    step: "record",
    userId,
    batchId: w.batchId,
    refId: logId,
    detail: sha256(grantReason),
    method: "password",
  });
  if (!issued.grant)
    return { issued, outcome: undefined as Outcome | undefined };
  return {
    issued,
    outcome: await appCall(DISOWN, [logId, issued.grant, reason]),
  };
}

// ---- Observations ---------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const disputesOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, log_id::text AS log_id, actor, reason, batch_status_at
       FROM ${DISPUTES} WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at, id`,
    [W.tenantId, batchId],
  );
const unfreezesOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, dispute_id::text AS dispute_id, actor, role_template, reason
       FROM ${UNFREEZES} WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at, id`,
    [W.tenantId, batchId],
  );
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );
const grantConsumedAt = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT consumed_at FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [
        W.tenantId,
        createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex"),
      ],
    )
  )[0]?.consumed_at;
const logsOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, actor FROM payroll_payout_approval_log
      WHERE tenant_id = $1 AND batch_id = $2 ORDER BY logged_at, id`,
    [W.tenantId, batchId],
  );
/** What a freeze must never move: paid items, payout journals, batches of the run. */
async function moneyOf(w: World) {
  return {
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'succeeded'`,
      [W.tenantId, w.runId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId, W.entityId()],
    ),
    batches: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, w.runId],
    ),
    statuses: JSON.stringify(
      (
        await W.rowsOf(
          `SELECT id::text AS id, status FROM payroll_disbursement_items
            WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY id`,
          [W.tenantId, w.runId],
        )
      ).map((r) => [r.id, r.status]),
    ),
  };
}

// ---- Worlds ---------------------------------------------------------------------------------

type World = {
  runId: string;
  batchId: string;
  itemIds: string[];
  itemId: string;
  /** Approval-log row of each resolver, by user id. */
  logOf: Record<string, string>;
};

/**
 * Batch created by `requester`, approved and exported by `approver`, every item
 * closed `failed` by two people (`resolvers`): each leaves one approval-log row,
 * and the main approval leaves one for `approver`.
 */
async function failedWorld(
  resolvers: [Person, Person] = [a, b],
): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [row] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = row!.id as string;
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
    approveDisbursementBatch(tx, actorOf(approver.userId), batchId, {
      contentHash: hash,
      sourceBankAccountId: source!.id as string,
    }),
  );
  await W.inTx((tx) =>
    exportManualBatch(tx, actorOf(approver.userId), batchId),
  );
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await W.resolve(batchId, itemIds, "failed", resolvers[0].userId);
  await W.resolve(batchId, itemIds, "failed", resolvers[1].userId);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is failed").toBe("failed");
  const logOf: Record<string, string> = {};
  for (const log of await logsOf(batchId))
    logOf[log.actor as string] = log.id as string;
  expect(
    Object.keys(logOf).sort(),
    "premise: the approver (main approval) and each resolver left one approval-log row",
  ).toEqual([approver.userId, resolvers[0].userId, resolvers[1].userId].sort());
  return { runId, batchId, itemIds, itemId: itemIds[0]!, logOf };
}

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const errorCodeOf = (res: Res) => res.body.error?.code;

const disownHttp = (
  who: Person,
  logId: string,
  body: Record<string, unknown> = { reason: REASON, password: PASSWORD },
) =>
  who.client
    .post(`${LOGS}/${logId}/disown`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const unfreezeHttp = (
  who: Person,
  batchId: string,
  body: Record<string, unknown> = {
    reason: UNFREEZE_REASON,
    password: PASSWORD,
  },
) =>
  who.client
    .post(`${BATCHES}/${batchId}/unfreeze`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const getBatch = (who: Person, batchId: string) =>
  who.client.get(`${BATCHES}/${batchId}`) as unknown as Promise<Res>;
const getLog = (who: Person, logId: string) =>
  who.client.get(`${LOGS}/${logId}`) as unknown as Promise<Res>;

function expectDisowned(res: Res, label: string) {
  expect([200, 201], `${label} ${detail(res)}`).toContain(res.status);
  expect(res.body.data?.disputeId, label).toBeTruthy();
}

/** Disown in SQL as `who` (the actor of the log). Returns the dispute id. */
async function freeze(w: World, who: Person = a) {
  const { issued, outcome } = await sqlDisown(
    who.userId,
    w,
    w.logOf[who.userId]!,
  );
  expect(issued.grant, `premise: disown grant, ${issued.message}`).toBeTruthy();
  expect(outcome!.code, `premise: disown, ${outcome!.message}`).toBe(undefined);
  expect(await openDisputes(w.batchId), "premise: frozen").toBeGreaterThan(0);
  return outcome!.rows[0]!.id as string;
}

/**
 * Unfreeze in SQL. The grant is (unfreeze, approve, batch, detail = sha256 of the
 * reason); the method is not fixed by the design, so mfa_challenge is tried first
 * and password next. `issued.grant` is undefined when the grantor refuses the person.
 */
async function sqlUnfreeze(
  who: Person,
  w: { batchId: string },
  reason = UNFREEZE_REASON,
  grantReason = reason,
) {
  let issued: Awaited<ReturnType<typeof issueGrant>> | undefined;
  for (const method of ["mfa_challenge", "password"] as const) {
    issued = await issueGrant({
      kind: "unfreeze",
      step: "approve",
      userId: who.userId,
      batchId: w.batchId,
      detail: sha256(grantReason),
      method,
    });
    if (issued.grant) break;
  }
  if (!issued!.grant)
    return { issued: issued!, outcome: undefined as Outcome | undefined };
  return {
    issued: issued!,
    outcome: await appCall(UNFREEZE, [w.batchId, issued!.grant, reason]),
  };
}
/** The person is refused: no grant, or the function says PAYOUT-82. Nothing is released. */
async function expectUnfreezeRefused(
  who: Person,
  w: World,
  label: string,
  reason = UNFREEZE_REASON,
) {
  const { issued, outcome } = await sqlUnfreeze(who, w, reason);
  if (outcome) {
    expect(outcome.code, `${label}: must be refused`).toBeDefined();
    expect(outcome.message, label).toMatch(/PAYOUT-82:/);
  } else expect(issued.code, `${label}: grant refused`).toBeDefined();
  expect(
    await unfreezesOf(w.batchId),
    `${label}: nothing released`,
  ).toHaveLength(0);
  expect(
    await openDisputes(w.batchId),
    `${label}: still frozen`,
  ).toBeGreaterThan(0);
}
async function expectUnfrozen(who: Person, w: World, released: number) {
  const { issued, outcome } = await sqlUnfreeze(who, w);
  expect(issued.grant, `unfreeze grant, ${issued.message}`).toBeTruthy();
  expect(outcome!.code, outcome!.message).toBe(undefined);
  expect(Number(outcome!.rows[0]!.released), "released").toBe(released);
  expect(await openDisputes(w.batchId)).toBe(0);
}

let frozenShared: Promise<World> | undefined;
let controlShared: Promise<World> | undefined;
/** One frozen world for the read-only refusals. */
const sharedFrozen = () =>
  (frozenShared ??= (async () => {
    const w = await failedWorld();
    await freeze(w);
    return w;
  })());
/** A world that is never frozen: the control of every refusal. */
const sharedControl = () => (controlShared ??= failedWorld());

// ---- Recon / events -------------------------------------------------------------------------

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

const jobContext = (tenantId: string = W.tenantId): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
function rowEvent(name: string, payload: Record<string, unknown>) {
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId: W.tenantId,
    outletId: null,
    name,
    version: 1,
    aggregateType: "payout",
    aggregateId: createUlid(),
    sequence: 1,
    idempotencyKey: `${name}-${randomUUID()}`,
    payloadSchemaRef: `${name}.v1`,
    payload,
  });
}
const resolveRecipients = (event: ReturnType<typeof rowEvent>) => {
  const context = jobContext();
  return withTenant(database, context, (tx) =>
    createNotificationRecipientResolver({ email: true, push: true })(
      context,
      event,
      tx,
    ),
  );
};
type SweepModule = {
  runPayoutApprovalReceiptSweep: (
    context: ScopedTenantContext,
    now: Date,
  ) => Promise<unknown>;
};
const SWEEP_MODULE = "../worker/payout-approval-receipt.job.ts";
const runSweep = async () => {
  const { runPayoutApprovalReceiptSweep } = (await import(
    /* @vite-ignore */ SWEEP_MODULE
  )) as SweepModule;
  await runPayoutApprovalReceiptSweep(W.scope(), new Date());
};
const eventsOf = (name: string, id: string) =>
  W.rowsOf(
    `SELECT id::text AS id FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
    [W.tenantId, name, ...idForms(id)],
  );

// ---- Evidence / proposals (case 1 real grant, case 7 "steps run again") ----------------------

const PROPOSE = `SELECT app.payout_correction_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`;
async function boundUpload(w: World, who: Person) {
  const key = evidenceKeyFor(W.tenantId, w.batchId, `d918-${randomUUID()}.pdf`);
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, 'upload-918')`,
        [W.tenantId, w.batchId, key, hex(), hex()],
      ),
    true,
  );
  seededFiles.push(key);
  const bound = await appCall(
    `SELECT app.payout_bind_proof($1::uuid, $2::text, $3::uuid[], $4::varchar, $5::text) AS id`,
    [w.batchId, "correction", [w.itemId], key, who.userId],
  );
  expect(bound.code, `premise: proof bound, ${bound.message}`).toBe(undefined);
  return key;
}
const proposeGrant = (w: World, who: Person, key: string) =>
  actorOf(who.userId).grants.issue({
    kind: "correction",
    step: "propose",
    batchId: w.batchId,
    itemIds: [w.itemId],
    evidenceKey: key,
    refId: null,
    targetId: null,
  } as never);
const correctionRows = (w: World) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections
      WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, w.batchId],
  );

// ---- Setup / teardown --------------------------------------------------------------------------

afterEach(async () => {
  const files = seededFiles.splice(0);
  if (files.length === 0) return;
  await W.asTenant(async (c) => {
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
  }, true);
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  brandId = randomUUID();
  await W.owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Uji 918')",
    [brandId, W.tenantId, `uji-918-${brandId.slice(0, 8)}`],
  );
  requester = await makePerson("Requester", { template: "owner" });
  approver = await makePerson("Approver", { template: "finance" });
  a = await makePerson("A", { template: "finance" });
  b = await makePerson("B", { template: "finance" });
  outsideOwner = await makePerson("Outside owner", { template: "owner" });
  outsideFinance = await makePerson("Outside finance", { template: "finance" });
  hr = await makePerson("HR");
  brandOwner = await makePerson("Brand owner", {
    template: "owner",
    scope: "brand",
  });
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
    await c.query(`DELETE FROM brands WHERE tenant_id = $1 AND id = $2`, [
      W.tenantId,
      brandId,
    ]);
    if (batchIds.length > 0) {
      for (const table of [UNFREEZES, DISPUTES])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
          [W.tenantId, batchIds],
        );
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, batchIds],
      );
    }
  }, true).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
  await appPool.end();
});

// The routes are written by another implementer: the HTTP tests below are held
// (skipped) until they exist. Run them with LEGEND_918_HTTP=1.
const httpIt = process.env.LEGEND_918_HTTP === "1" ? it : it.skip;

// =========================================================================
// 1: the actor of the log freezes the batch; every trusted step is refused
// =========================================================================

describe("918 disown: the actor of the log freezes the batch", () => {
  it("[918-disown-freezes-batch] the actor says 'not me', one dispute row is written, the batch is frozen, nothing about the money moves", async () => {
    const w = await failedWorld();
    const logId = w.logOf[a.userId]!;
    const money = await moneyOf(w);
    expect(await openDisputes(w.batchId), "not frozen before").toBe(0);

    const { issued, outcome } = await sqlDisown(a.userId, w, logId);
    expect(issued.grant, issued.message).toBeTruthy();
    expect(outcome!.code, outcome!.message).toBe(undefined);

    const disputes = await disputesOf(w.batchId);
    expect(disputes, "one dispute row").toHaveLength(1);
    expect(disputes[0]).toMatchObject({
      id: outcome!.rows[0]!.id,
      log_id: logId,
      actor: a.userId,
      reason: REASON,
    });
    expect(disputes[0]!.batch_status_at, "status at the time").toBeTruthy();
    expect(await openDisputes(w.batchId)).toBe(1);
    expect(await moneyOf(w), "no item, journal or batch moved").toEqual(money);
  });

  httpIt(
    "[918-http-disown-page-and-batch] the actor reads the step, disowns with the password; everybody sees the freeze on the batch; a stranger gets 404 on the page",
    async () => {
      const w = await failedWorld();
      const logId = w.logOf[a.userId]!;
      const page = await getLog(a, logId);
      expect(page.status, detail(page)).toBe(200);
      expect(page.body.data).toMatchObject({
        id: logId,
        batchId: w.batchId,
        disowned: false,
        batchFrozen: false,
      });
      expect((await getLog(b, logId)).status, "only the actor reads it").toBe(
        404,
      );

      const res = await disownHttp(a, logId);
      expectDisowned(res, "disown");
      expect(res.body.data?.batchId).toBe(w.batchId);
      for (const who of [a, b, outsideOwner]) {
        const batch = await getBatch(who, w.batchId);
        expect(batch.status, detail(batch)).toBe(200);
        const freezeDto = batch.body.data?.freeze as {
          frozen: boolean;
          disputes: { mine: boolean }[];
        };
        expect(freezeDto.frozen).toBe(true);
        expect(freezeDto.disputes).toHaveLength(1);
        expect(freezeDto.disputes[0]!.mine, "mine only for the disputant").toBe(
          who === a,
        );
      }
      expect((await getLog(a, logId)).body.data).toMatchObject({
        disowned: true,
        batchFrozen: true,
      });
    },
  );

  const KINDS: [string, string][] = [
    ["correction", "propose"],
    ["correction", "approve"],
    ["correction", "withdraw"],
    ["overpaid", "propose"],
    ["overpaid", "record"],
    ["overpaid", "withdraw"],
    ["return", "propose"],
    ["return", "confirm"],
    ["closure", "propose"],
    ["closure", "approve"],
    ["posting_source", "record"],
    ["resolve", "propose"],
    ["resolve", "approve"],
    ["bank_confirm", "record"],
  ];
  const CONSUME = `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::uuid[], $7::varchar, NULL::uuid, NULL::uuid, NULL::varchar)`;
  for (const [kind, step] of KINDS) {
    it(`[918-frozen-consume-${kind}-${step}] a ${kind}/${step} grant is refused with PAYOUT-79 on a frozen batch; the unfrozen control only fails on the grant (PAYOUT-70)`, async () => {
      const frozen = await sharedFrozen();
      const control = await sharedControl();
      const args = (w: World) => [
        W.tenantId,
        hex(),
        kind,
        step,
        w.batchId,
        [w.itemId],
        null,
      ];
      const refused = await probe("legend_payout", CONSUME, args(frozen));
      expect(refused.code, "frozen: refused").toBeDefined();
      expect(refused.message, "frozen").toMatch(/PAYOUT-79:/);
      const open = await probe("legend_payout", CONSUME, args(control));
      expect(open.message, "control: not frozen").not.toMatch(/PAYOUT-79:/);
      expect(open.message, "control fails on the unknown grant").toMatch(
        /PAYOUT-70:/,
      );
    });
  }

  it("[918-frozen-attest-and-settle] app.payout_attest and app.payout_run_settle answer PAYOUT-79 on a frozen batch and not on the control", async () => {
    const frozen = await sharedFrozen();
    const control = await sharedControl();
    const ATTEST = `SELECT app.payout_attest($1::uuid, 'correction', $2::uuid, 'propose', $3::uuid, $4::uuid[], NULL::varchar, NULL::uuid, $5::uuid, '{}'::jsonb)`;
    const attestArgs = (w: World) => [
      W.tenantId,
      randomUUID(),
      w.batchId,
      [w.itemId],
      randomUUID(),
    ];
    expect(
      (await probe("legend_payout", ATTEST, attestArgs(frozen))).message,
      "attest, frozen",
    ).toMatch(/PAYOUT-79:/);
    expect(
      (await probe("legend_payout", ATTEST, attestArgs(control))).message,
      "attest, control",
    ).not.toMatch(/PAYOUT-79:/);

    const SETTLE = `SELECT app.payout_run_settle($1::uuid, $2::uuid[]) AS paid`;
    expect(
      (await probe("legend_app", SETTLE, [frozen.batchId, []])).message,
      "run settle, frozen",
    ).toMatch(/PAYOUT-79:/);
    expect(
      (await probe("legend_app", SETTLE, [control.batchId, []])).message,
      "run settle, control",
    ).not.toMatch(/PAYOUT-79:/);
  });

  it("[918-frozen-grant-not-spent] a real grant on a frozen batch is refused with PAYOUT-79 and stays unspent, no proposal row appears", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w, outsideFinance);
    // The grant is issued while the batch is open, then the batch is frozen.
    const grant = await proposeGrant(w, outsideFinance, key);
    await freeze(w);
    const refused = await appCall(PROPOSE, [
      w.batchId,
      [w.itemId],
      key,
      NOTE,
      grant,
    ]);
    expect(refused.code, "must be refused").toBeDefined();
    expect(refused.message).toMatch(/PAYOUT-79:/);
    expect(await grantConsumedAt(grant), "the grant is not spent").toBeNull();
    expect(await correctionRows(w), "no proposal row").toBe(0);
  });

  it("[918-frozen-grant-issue-refused] a new grant cannot even be issued for a frozen batch: the grantor answers PAYOUT-79", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w, outsideFinance);
    await freeze(w);
    const before = await count(
      `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, w.batchId],
    );
    await expect(proposeGrant(w, outsideFinance, key)).rejects.toThrow(
      /PAYOUT-79/,
    );
    expect(
      await count(
        `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, w.batchId],
      ),
      "no grant row was written",
    ).toBe(before);
  });

  httpIt(
    "[918-http-frozen-steps-409] correct-failed and approve on a frozen batch answer 409 PAYOUT_BATCH_FROZEN before any grant is issued",
    async () => {
      const w = await sharedFrozen();
      const grantsBefore = await count(
        `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, w.batchId],
      );
      const key = uploadEvidence(w.batchId, `f918-${randomUUID()}.pdf`);
      const correct = (await outsideFinance.client
        .post(`${BATCHES}/${w.batchId}/correct-failed`)
        .set(originHeader)
        .send({
          itemIds: [w.itemId],
          evidenceKey: key,
          note: NOTE,
          password: PASSWORD,
        })) as unknown as Res;
      expect(correct.status, detail(correct)).toBe(409);
      expect(errorCodeOf(correct)).toBe("PAYOUT_BATCH_FROZEN");
      expect(
        await count(
          `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, w.batchId],
        ),
        "correct-failed issued no grant",
      ).toBe(grantsBefore);
      const approve = (await outsideFinance.client
        .post(`${BATCHES}/${w.batchId}/approve`)
        .set(originHeader)
        .send({
          contentHash: (await W.batchById(w.batchId)).content_hash as string,
          sourceBankAccountId: null,
          password: PASSWORD,
        })) as unknown as Res;
      expect(approve.status, detail(approve)).toBe(409);
      expect(errorCodeOf(approve)).toBe("PAYOUT_BATCH_FROZEN");
      expect(
        await count(
          `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, w.batchId],
        ),
        "approve issued no grant",
      ).toBe(grantsBefore);
    },
  );
});

// =========================================================================
// 2 and 3: who may say "not me"
// =========================================================================

describe("918 disown: only the actor of the log, even without payroll rights", () => {
  it("[918-disown-other-user-refused] somebody else cannot disown your step: no grant for it, the SQL function refuses a crossed grant, the batch stays open", async () => {
    const w = await failedWorld();
    const logId = w.logOf[a.userId]!;
    const issued = await issueGrant({
      kind: "disown",
      step: "record",
      userId: b.userId,
      batchId: w.batchId,
      refId: logId,
      detail: sha256(REASON),
      method: "password",
    });
    expect(issued.grant, "B gets no grant for the log of A").toBeUndefined();
    expect(issued.code).toBeDefined();

    // A grant B holds for B's own log cannot be spent on A's log.
    const own = await issueGrant({
      kind: "disown",
      step: "record",
      userId: b.userId,
      batchId: w.batchId,
      refId: w.logOf[b.userId]!,
      detail: sha256(REASON),
      method: "password",
    });
    expect(
      own.grant,
      `premise: B may disown B's own log, ${own.message}`,
    ).toBeTruthy();
    const crossed = await appCall(DISOWN, [logId, own.grant, REASON]);
    expect(crossed.code, "must be refused").toBeDefined();
    expect(crossed.message).toMatch(/PAYOUT-(70|81):/);

    const elsewhere = await issueGrant({
      kind: "disown",
      step: "record",
      userId: a.userId,
      batchId: w.batchId,
      refId: randomUUID(),
      detail: sha256(REASON),
      method: "password",
    });
    expect(elsewhere.grant, "an unknown log gets no grant").toBeUndefined();

    // Only the password method is accepted for a disown.
    const mfaOnly = await issueGrant({
      kind: "disown",
      step: "record",
      userId: a.userId,
      batchId: w.batchId,
      refId: logId,
      detail: sha256(REASON),
      method: "mfa_challenge",
    });
    expect(mfaOnly.grant, "disown needs the password step-up").toBeUndefined();

    expect(await disputesOf(w.batchId)).toHaveLength(0);
    expect(await openDisputes(w.batchId)).toBe(0);
  });

  httpIt(
    "[918-http-disown-other-user-404] disowning the step of somebody else answers 404",
    async () => {
      const w = await failedWorld();
      const res = await disownHttp(b, w.logOf[a.userId]!);
      expect(res.status, detail(res)).toBe(404);
      expect(await disputesOf(w.batchId)).toHaveLength(0);
    },
  );

  it("[918-disown-revoked-permission] an actor whose payroll rights were revoked can still disown; a blocked user cannot", async () => {
    const c = await makePerson("Revoked");
    await W.grantRole(c.userId, ["access.role.view"]); // still has an assignment, no payroll right
    const w = await failedWorld([c, b]);
    const logId = w.logOf[c.userId]!;
    await W.asTenant(
      (client) =>
        client.query(
          `UPDATE role_assignments ra SET valid_until = now() - interval '10 seconds'
             FROM roles r
            WHERE ra.tenant_id = $1 AND ra.user_id = $2 AND r.id = ra.role_id
              AND r.permissions::jsonb ? 'payroll.disburse.approve'`,
          [W.tenantId, c.userId],
        ),
      true,
    );

    await W.owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      c.userId,
    ]);
    try {
      const blocked = await issueGrant({
        kind: "disown",
        step: "record",
        userId: c.userId,
        batchId: w.batchId,
        refId: logId,
        detail: sha256(REASON),
        method: "password",
      });
      expect(blocked.grant, "a blocked user gets no grant").toBeUndefined();
    } finally {
      await W.owner.query(`UPDATE "user" SET banned = false WHERE id = $1`, [
        c.userId,
      ]);
    }
    expect(await disputesOf(w.batchId)).toHaveLength(0);

    const { issued, outcome } = await sqlDisown(c.userId, w, logId);
    expect(
      issued.grant,
      `revoked actor still gets the grant, ${issued.message}`,
    ).toBeTruthy();
    expect(outcome!.code, outcome!.message).toBe(undefined);
    expect(await openDisputes(w.batchId)).toBe(1);
  });

  httpIt(
    "[918-http-disown-needs-password] disown without a password answers 401; with a wrong password 403 REAUTH_PASSWORD_INVALID (as the other payout steps)",
    async () => {
      const w = await failedWorld();
      const logId = w.logOf[a.userId]!;
      const missing = await disownHttp(a, logId, { reason: REASON });
      expect(missing.status, detail(missing)).toBe(401);
      const wrong = await disownHttp(a, logId, {
        reason: REASON,
        password: "Wrong-password-999!",
      });
      expect(wrong.status, detail(wrong)).toBe(403);
      expect(errorCodeOf(wrong)).toBe("REAUTH_PASSWORD_INVALID");
      expect(await disputesOf(w.batchId)).toHaveLength(0);
    },
  );

  it("[918-disown-reason-bound] a reason changed after the grant was issued is refused with PAYOUT-70 (the grant detail is the sha256 of the reason)", async () => {
    const w = await failedWorld();
    const { issued, outcome } = await sqlDisown(
      a.userId,
      w,
      w.logOf[a.userId]!,
      "Alasan yang berbeda dari yang disetujui",
      REASON,
    );
    expect(issued.grant, issued.message).toBeTruthy();
    expect(outcome!.code, "must be refused").toBeDefined();
    expect(outcome!.message).toMatch(/PAYOUT-70:/);
    expect(await disputesOf(w.batchId)).toHaveLength(0);
  });
});

// =========================================================================
// 4: repeating, two logs
// =========================================================================

describe("918 disown: repeated and many", () => {
  it("[918-disown-idempotent-two-logs] a repeated disown returns the same dispute; two logs make two disputes and one unfreeze releases both", async () => {
    const w = await failedWorld();
    const first = await sqlDisown(a.userId, w, w.logOf[a.userId]!);
    expect(first.outcome!.code, first.outcome!.message).toBe(undefined);
    const id = first.outcome!.rows[0]!.id;
    const again = await sqlDisown(a.userId, w, w.logOf[a.userId]!);
    expect(again.outcome!.code, again.outcome!.message).toBe(undefined);
    expect(again.outcome!.rows[0]!.id, "the same dispute").toBe(id);
    expect(await disputesOf(w.batchId)).toHaveLength(1);

    const second = await sqlDisown(b.userId, w, w.logOf[b.userId]!);
    expect(second.outcome!.code, second.outcome!.message).toBe(undefined);
    expect(second.outcome!.rows[0]!.id).not.toBe(id);
    expect(await disputesOf(w.batchId), "two logs, two disputes").toHaveLength(
      2,
    );

    await expectUnfrozen(outsideOwner, w, 2);
    expect(await unfreezesOf(w.batchId), "one row per dispute").toHaveLength(2);
  });

  it("[918-disown-on-frozen-batch] disown stays possible when the batch is already frozen (a claim is only ever added)", async () => {
    const w = await sharedFrozen();
    const res = await sqlDisown(b.userId, w, w.logOf[b.userId]!);
    expect(res.issued.grant, res.issued.message).toBeTruthy();
    expect(res.outcome!.code, res.outcome!.message).toBe(undefined);
  });
});

// =========================================================================
// 5: direct writes
// =========================================================================

describe("918 freeze: direct SQL and new batches are refused too", () => {
  it("[918-frozen-sql-direct] as legend_app the batch status cannot change; no bank file (legend_app) and no GL posting (legend_app) can be added; the control batch is not refused by the freeze", async () => {
    const frozen = await sharedFrozen();
    const control = await sharedControl();
    const status = (w: World) =>
      probe(
        "legend_app",
        `UPDATE payroll_disbursement_batches SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.batchId],
      );
    expect((await status(frozen)).message, "status update, frozen").toMatch(
      /PAYOUT-79:/,
    );
    expect(
      (await status(control)).message,
      "status update, control",
    ).not.toMatch(/PAYOUT-79:/);

    // bank_transfer_files belongs to a payroll run (every batch of the run is checked).
    const targets: [
      string,
      string,
      (w: World) => string,
      "legend_app" | "legend_payout",
    ][] = [
      ["bank_transfer_files", "payroll_run_id", (w) => w.runId, "legend_app"],
      [
        "payroll_payout_gl_postings",
        "batch_id",
        (w) => w.batchId,
        "legend_app",
      ],
    ];
    for (const [table, column, id, role] of targets) {
      const insert = (w: World) =>
        probe(
          role,
          `INSERT INTO ${table} (tenant_id, ${column}) VALUES ($1, $2)`,
          [W.tenantId, id(w)],
        );
      expect((await insert(frozen)).message, `${table}, frozen`).toMatch(
        /PAYOUT-79:/,
      );
      expect((await insert(control)).message, `${table}, control`).not.toMatch(
        /PAYOUT-79:/,
      );
    }
  });

  it("[918-frozen-item-update] as legend_app an item status cannot change on a frozen batch", async () => {
    const frozen = await sharedFrozen();
    const control = await sharedControl();
    const update = (w: World) =>
      probe(
        "legend_app",
        `UPDATE payroll_disbursement_items SET status = 'succeeded' WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.itemId],
      );
    expect((await update(frozen)).message, "frozen").toMatch(/PAYOUT-79:/);
    expect((await update(control)).message, "control").not.toMatch(
      /PAYOUT-79:/,
    );
  });

  it("[918-frozen-new-batch-same-payslip] a new batch for the payslips of a frozen batch is refused (409 PAYOUT_BATCH_FROZEN or PAYOUT-79), so a failed item cannot be paid twice", async () => {
    const w = await failedWorld();
    await freeze(w);
    const money = await moneyOf(w);
    const error = await W.httpFailure(
      W.inTx((tx) =>
        createDisbursementBatch(tx, actorOf(requester.userId), {
          payrollRunId: w.runId,
          channel: "manual_bank",
        } as never),
      ),
    );
    expect(error, "must be refused").not.toBeNull();
    const cause = (error as { cause?: { message?: string } }).cause;
    const text = `${(error as { code?: string }).code ?? ""} ${(error as Error).message} ${cause?.message ?? ""}`;
    expect(text).toMatch(/PAYOUT_BATCH_FROZEN|PAYOUT-79/);
    expect(await moneyOf(w), "no new batch").toEqual(money);
  });
});

// =========================================================================
// 6: the night recon still works
// =========================================================================

describe("918 freeze: the night recon still flags", () => {
  /**
   * A correction proposal withdrawn by hr (before any freeze), then its withdraw
   * grant forged (actor changed): the recon reasons of the item. The 915 suite
   * shows the recon flags exactly this; `frozen` freezes the batch before the recon.
   */
  async function forgedReasons(frozen: boolean) {
    const w = await failedWorld();
    const key = await boundUpload(w, outsideFinance);
    const grant = await proposeGrant(w, outsideFinance, key);
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
    const withdrawGrant = await actorOf(hr.userId).grants.issue({
      kind: "correction",
      step: "withdraw",
      batchId: w.batchId,
      itemIds: [w.itemId],
      evidenceKey: key,
      refId: proposed.rows[0]!.id as string,
      targetId: null,
    } as never);
    const withdrawn = await appCall(
      `SELECT app.payout_correction_withdraw($1::uuid, $2::text) AS n`,
      [proposed.rows[0]!.id, withdrawGrant],
    );
    expect(withdrawn.code, `premise: withdrawn, ${withdrawn.message}`).toBe(
      undefined,
    );
    if (frozen) await freeze(w);
    const grantRowId = (
      await W.rowsOf(
        `SELECT a.grant_id::text AS id FROM payroll_payout_attestations a
          WHERE a.tenant_id = $1 AND $2::uuid = ANY(a.item_ids) AND a.step = 'withdraw' AND a.kind = 'correction'`,
        [W.tenantId, w.itemId],
      )
    )[0]!.id as string;
    const actorOfGrant = async () =>
      (
        await W.rowsOf(
          `SELECT actor FROM payroll_payout_grants WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, grantRowId],
        )
      )[0]!.actor as string;
    const original = await actorOfGrant();
    const setActor = (actor: string) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, grantRowId, actor],
          ),
        true,
      );
    try {
      await setActor(randomUUID());
      await runRecon();
      return (
        await W.rowsOf(
          `SELECT reason FROM payroll_payout_recon_exceptions WHERE tenant_id = $1 AND item_id = $2`,
          [W.tenantId, w.itemId],
        )
      ).map((r) => r.reason as string);
    } finally {
      await setActor(original);
      await W.asTenant(
        (c) =>
          c.query(
            `DELETE FROM payroll_payout_recon_exceptions WHERE tenant_id = $1 AND item_id = $2`,
            [W.tenantId, w.itemId],
          ),
        true,
      );
    }
  }

  it("[918-frozen-recon-flag] recon still flags a forged grant on a frozen batch exactly as on an unfrozen one (it only limits)", async () => {
    // Control first: the forged withdraw grant is flagged on an open batch.
    expect(await forgedReasons(false), "control: flagged").toContain(
      "grant_mismatch",
    );
    expect(
      await forgedReasons(true),
      "the forged grant is flagged although the batch is frozen",
    ).toContain("grant_mismatch");
  });
});

// =========================================================================
// 7: unfreeze
// =========================================================================

describe("918 unfreeze: who may lift the freeze", () => {
  it("[918-unfreeze-accepted] an owner or finance user outside the batch lifts the freeze with a reason; every step runs again", async () => {
    for (const who of ["owner", "finance"] as const) {
      const w = await failedWorld();
      const key = await boundUpload(w, hr);
      const grant = await proposeGrant(w, hr, key); // issued before the freeze
      await freeze(w);
      expect(
        (await appCall(PROPOSE, [w.batchId, [w.itemId], key, NOTE, grant]))
          .message,
        `${who}: refused while frozen`,
      ).toMatch(/PAYOUT-79:/);

      const person = who === "owner" ? outsideOwner : outsideFinance;
      await expectUnfrozen(person, w, 1);
      const rows = await unfreezesOf(w.batchId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: person.userId,
        role_template: who,
        reason: UNFREEZE_REASON,
      });

      const after = await appCall(PROPOSE, [
        w.batchId,
        [w.itemId],
        key,
        NOTE,
        grant,
      ]);
      expect(
        after.code,
        `${who}: the same grant now works, ${after.message}`,
      ).toBe(undefined);
      expect(await grantConsumedAt(grant), "the grant is spent").not.toBeNull();
      expect(await correctionRows(w)).toBe(1);
    }
  });

  it("[918-unfreeze-disputant-withdraws] the disputant who holds the finance role may withdraw their own claim; not when somebody else also has an open claim", async () => {
    const own = await failedWorld();
    await freeze(own, a);
    await expectUnfrozen(a, own, 1);

    const both = await failedWorld();
    await freeze(both, a);
    await freeze(both, b);
    await expectUnfreezeRefused(a, both, "disputant with another open claim");
    expect(await openDisputes(both.batchId), "still frozen").toBe(2);
  });

  it("[918-unfreeze-refused] hr, a brand-scoped owner, the requester, the approver and an actor of the log are refused; nothing is released", async () => {
    const w = await failedWorld();
    await freeze(w, a);
    await expectUnfreezeRefused(hr, w, "hr (no owner/finance role)");
    await expectUnfreezeRefused(brandOwner, w, "owner at brand scope");
    await expectUnfreezeRefused(requester, w, "requester of the batch");
    await expectUnfreezeRefused(
      approver,
      w,
      "approver and exporter of the batch",
    );
    await expectUnfreezeRefused(b, w, "actor of another log of the batch");
  });

  it("[918-unfreeze-validation] a reason shorter than 10 characters is refused, no open dispute is PAYOUT-82, a reason changed after the grant is PAYOUT-70", async () => {
    const w = await failedWorld();
    const none = await sqlUnfreeze(outsideOwner, w);
    if (none.outcome) {
      expect(none.outcome.code, "no open dispute").toBeDefined();
      expect(none.outcome.message).toMatch(/PAYOUT-82:/);
    } else expect(none.issued.code, "no grant either").toBeDefined();

    await freeze(w);
    const short = await sqlUnfreeze(outsideOwner, w, "terlalu");
    if (short.outcome) expect(short.outcome.code, "short reason").toBeDefined();
    else expect(short.issued.code).toBeDefined();
    expect(await openDisputes(w.batchId), "still frozen").toBe(1);

    const changed = await sqlUnfreeze(
      outsideOwner,
      w,
      "Alasan lain yang tidak disetujui",
      UNFREEZE_REASON,
    );
    expect(changed.issued.grant, changed.issued.message).toBeTruthy();
    expect(changed.outcome!.code, "must be refused").toBeDefined();
    expect(changed.outcome!.message).toMatch(/PAYOUT-70:/);
    expect(await unfreezesOf(w.batchId)).toHaveLength(0);
  });

  httpIt(
    "[918-http-unfreeze] the route lifts the freeze with the password; 422 for a short reason, 401 without password, 409 PAYOUT_UNFREEZE_REFUSED for a person excluded",
    async () => {
      const w = await failedWorld();
      const none = await unfreezeHttp(outsideOwner, w.batchId);
      expect(none.status, detail(none)).toBe(409);
      expect(errorCodeOf(none)).toBe("PAYOUT_UNFREEZE_REFUSED");
      await freeze(w);
      expect(
        (
          await unfreezeHttp(outsideOwner, w.batchId, {
            reason: "terlalu",
            password: PASSWORD,
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await unfreezeHttp(outsideOwner, w.batchId, {
            reason: UNFREEZE_REASON,
          })
        ).status,
      ).toBe(401);
      for (const who of [hr, requester, approver, b]) {
        const res = await unfreezeHttp(who, w.batchId);
        expect(res.status, detail(res)).toBe(409);
        expect(errorCodeOf(res)).toBe("PAYOUT_UNFREEZE_REFUSED");
      }
      const ok = await unfreezeHttp(outsideOwner, w.batchId);
      expect([200, 201], detail(ok)).toContain(ok.status);
      expect(ok.body.data?.released).toBe(1);
      // 1267 F5: a second unfreeze (double tap, replay without the key) finds
      // no open dispute and is refused, so nothing is released or audited twice.
      const again = await unfreezeHttp(outsideOwner, w.batchId);
      expect(again.status, detail(again)).toBe(409);
      expect(errorCodeOf(again)).toBe("PAYOUT_UNFREEZE_REFUSED");
    },
  );
});

// =========================================================================
// 8: append-only tables
// =========================================================================

describe("918 dispute tables are append-only", () => {
  for (const table of [DISPUTES, UNFREEZES]) {
    it(`[918-append-only-${table}] legend_app gets 42501 for INSERT, UPDATE, DELETE and TRUNCATE; the payout role and the owner cannot change or erase (PAYOUT-80); the rows stay; another tenant sees none`, async () => {
      const w = await failedWorld();
      await freeze(w);
      await expectUnfrozen(outsideOwner, w, 1);
      const rows = () =>
        count(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, w.batchId],
        );
      const before = await rows();
      expect(before, "premise: a row exists").toBeGreaterThan(0);

      const statements: [string, string, unknown[]][] = [
        ["insert", `INSERT INTO ${table} (id) VALUES (gen_random_uuid())`, []],
        [
          "update",
          `UPDATE ${table} SET actor = 'someone-else' WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, w.batchId],
        ],
        [
          "delete",
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, w.batchId],
        ],
        ["truncate", `TRUNCATE ${table}`, []],
      ];
      for (const [name, sql, params] of statements) {
        const out = await probe("legend_app", sql, params);
        expect(out.code, `legend_app ${name}: ${out.message}`).toBe(PRIVILEGE);
      }
      for (const [name, sql, params] of statements.filter(
        ([n]) => n !== "insert",
      )) {
        const out = await probe("legend_payout", sql, params);
        expect(out.code, `payout ${name}: ${out.message}`).toBeDefined();
        if (out.code === GUARD) expect(out.message).toMatch(/PAYOUT-80:/);
        else expect(out.code, `payout ${name}`).toBe(PRIVILEGE);
        const owner = await probe(null, sql, params);
        // TRUNCATE of the dispute table is also impossible for a plain reason: the
        // unfreeze table references it (0A000). Either way it cannot be erased.
        if (name === "truncate" && table === DISPUTES && owner.code === "0A000")
          continue;
        expect(owner.code, `owner ${name}: ${owner.message}`).toBe(GUARD);
        expect(owner.message, `owner ${name}`).toMatch(/PAYOUT-80:/);
      }
      expect(await rows(), "nothing was lost").toBe(before);

      const read = await probe(
        "legend_app",
        `SELECT count(*)::int AS n FROM ${table} WHERE batch_id = $1`,
        [w.batchId],
      );
      expect(read.code, read.message).toBe(undefined);
      expect(Number(read.rows[0]!.n), "legend_app can read").toBe(before);
      const other = await probe(
        "legend_app",
        `SELECT count(*)::int AS n FROM ${table}`,
        [],
        randomUUID(),
      );
      expect(Number(other.rows[0]!.n), "another tenant sees none").toBe(0);
    });
  }
});

// =========================================================================
// 9: finance exception
// =========================================================================

describe("918 finance exception for a frozen batch", () => {
  it("[918-finance-exception] a disowned batch is listed as payout_batch_disputed until it is unfrozen", async () => {
    const w = await failedWorld();
    const listed = async () => {
      const day = (shift: number) =>
        new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
      const result = await listFinanceExceptions(W.scope(), {
        from: day(-2),
        to: day(2),
        kind: "payout_batch_disputed",
      } as never);
      const text = JSON.stringify(result.items);
      return idForms(w.batchId).some((form) => text.includes(form));
    };
    expect(await listed(), "not listed before").toBe(false);
    await freeze(w);
    expect(await listed(), "listed while frozen").toBe(true);
    await expectUnfrozen(outsideFinance, w, 1);
    expect(await listed(), "gone after the unfreeze").toBe(false);
  });
});

// =========================================================================
// 10: disown and a step at the same time
// =========================================================================

describe("918 disown races a step on the batch lock", () => {
  it("[918-disown-vs-step-serial] a disown and a step fired together are serial: no deadlock, disown succeeds, a lost step says PAYOUT-79, afterwards every step is refused", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w, outsideFinance);
    const step = await proposeGrant(w, outsideFinance, key);
    const issued = await issueGrant({
      kind: "disown",
      step: "record",
      userId: a.userId,
      batchId: w.batchId,
      refId: w.logOf[a.userId]!,
      detail: sha256(REASON),
      method: "password",
    });
    expect(issued.grant, issued.message).toBeTruthy();
    const [stepResult, disownResult] = await raceCalls([
      { sql: PROPOSE, params: [w.batchId, [w.itemId], key, NOTE, step] },
      { sql: DISOWN, params: [w.logOf[a.userId]!, issued.grant, REASON] },
    ]);
    expect(disownResult!.code, disownResult!.message).toBe(undefined);
    if (stepResult!.code !== undefined)
      expect(stepResult!.message, "the step lost the race").toMatch(
        /PAYOUT-79:/,
      );
    expect(await openDisputes(w.batchId)).toBe(1);
    const late = await probe(
      "legend_payout",
      `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, 'correction', 'propose', $3::uuid, $4::uuid[], NULL::varchar, NULL::uuid, NULL::uuid, NULL::varchar)`,
      [W.tenantId, hex(), w.batchId, [w.itemId]],
    );
    expect(late.message, "after the freeze every step is refused").toMatch(
      /PAYOUT-79:/,
    );
  });
});

// =========================================================================
// 11: notification
// =========================================================================

describe("918 notification: dispute and unfreeze", () => {
  it("[918-notify-dispute-and-unfreeze] one event per dispute and per unfreeze (idempotent); owner/finance at tenant scope and the disputant are told, hr and a brand-scoped owner are not; no amount; email is kept when the preference is off", async () => {
    const w = await failedWorld();
    const disputeId = await freeze(w);

    await runSweep();
    expect(await eventsOf("payout.batch_disputed", disputeId)).toHaveLength(1);
    await runSweep();
    expect(
      await eventsOf("payout.batch_disputed", disputeId),
      "idempotent: still one",
    ).toHaveLength(1);

    const event = rowEvent("payout.batch_disputed", { disputeId });
    const recipients = await resolveRecipients(event);
    const ids = recipients.map((r) => r.userId);
    for (const who of [a, outsideOwner, outsideFinance])
      expect(ids, "told").toContain(who.userId);
    expect(ids, "hr is not told").not.toContain(hr.userId);
    expect(ids, "a brand-scoped owner is not told").not.toContain(
      brandOwner.userId,
    );
    expect(new Set(ids).size, "each person once").toBe(ids.length);
    for (const r of recipients) {
      expect(r.category).toBe("payout_receipt");
      const text = `${r.title}\n${r.body}`;
      expect(text, "no amount").not.toMatch(/Rp/i);
      expect(text, "no long digit run").not.toMatch(/\d{5,}/);
      expect(text, "no payee").not.toContain(BUDI.name);
      expect(text).not.toContain(BUDI.account);
    }
    await expect(
      resolveRecipients(
        rowEvent("payout.batch_disputed", { disputeId, userId: b.userId }),
      ),
    ).rejects.toThrow();
    const nobody = await resolveRecipients(
      rowEvent("payout.batch_disputed", { disputeId: randomUUID() }),
    ).then(
      (rows) => rows,
      () => [] as { userId: string }[],
    );
    expect(nobody, "unknown dispute: fail closed").toEqual([]);

    // Email stays on although every channel is switched off.
    await W.owner.query(
      `UPDATE "user" SET email_verified = true WHERE id = $1`,
      [a.userId],
    );
    await W.owner.query(
      `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2`,
      [W.tenantId, a.userId],
    );
    const off = { web_push: false, email: false, whatsapp: false };
    await W.owner.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'Asia/Jakarta')`,
      [
        W.tenantId,
        a.userId,
        JSON.stringify({ payout_receipt: off }),
        JSON.stringify({ start: "00:00", end: "23:59" }),
      ],
    );
    const context = jobContext();
    const consume = createNotificationConsumer(
      context,
      createNotificationRecipientResolver({ email: true, push: true }),
    );
    await withTenant(database, context, (tx) => consume(event, event.id, tx));
    const attempts = (
      await W.owner.query<{ status: string }>(
        `SELECT d.status FROM delivery_attempts d
           JOIN notifications n ON n.id = d.notification_id AND n.tenant_id = d.tenant_id
          WHERE n.tenant_id = $1 AND n.user_id = $2 AND n.source_event_id = $3
            AND d.channel = 'email'`,
        [W.tenantId, a.userId, ulidToUuid(event.id)],
      )
    ).rows;
    expect(attempts, "one email attempt").toHaveLength(1);
    expect(attempts[0]!.status, "not skipped by the opt-out").not.toBe(
      "skipped",
    );

    await expectUnfrozen(outsideOwner, w, 1);
    const unfreezeId = (await unfreezesOf(w.batchId))[0]!.id as string;
    await runSweep();
    await runSweep();
    expect(await eventsOf("payout.batch_unfrozen", unfreezeId)).toHaveLength(1);
    const told = await resolveRecipients(
      rowEvent("payout.batch_unfrozen", { unfreezeId }),
    );
    expect(
      told.map((r) => r.userId),
      "the disputant learns it was lifted",
    ).toContain(a.userId);
    for (const r of told)
      expect(`${r.title}\n${r.body}`, "no amount").not.toMatch(/Rp|\d{5,}/i);
  });
});
