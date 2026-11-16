// Payout 915, card legend-7gghu: append-only approval log + receipt
// notification (design: docs/briefs/915/design-7gghu.md, section "Test", cases
// 1 to 10). Written fail-first from the design, NOT from the implementation.
// Pattern of payroll-payout-911-grants.test.ts: everything adversarial runs as
// `SET LOCAL ROLE legend_app` / `legend_payout` (never the superuser, no
// trigger disabled) with a REAL COMMIT; grants come from the grantor stand-in
// (`actor.grants` of the fixtures).
//
// Rule proven (founder: nobody is paid on the word of one person; when in
// doubt, limit the payment): every grant spent for a payout step leaves one
// append-only row in `payroll_payout_approval_log`, written by the payout role
// only, and the REAL actor of the grant is told about it by a notification.
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - Log columns are exactly those of the design: id, tenant_id, grant_id,
//   attestation_id, kind, step, operation_id, batch_id, item_count, actor,
//   session_id, logged_at, txid. `txid` is compared with the attestation's
//   `txid` as text.
// - Case 1 is driven through the trusted functions that are cheap to reach:
//   resolve, bank_confirm, correction (propose + approve), return (propose +
//   confirm) and overpaid (propose + record). The closure and posting_source
//   functions need heavy worlds (stuck proof keys, a pending GL posting) and
//   are NOT driven here; they share `app.payout_attest`, which the rows of the
//   other kinds already prove, and the check "one log row per granted
//   attestation of these batches" is generic in `kind`.
// - Case 2 calls `app.payout_grant_consume` + `app.payout_attest` directly as
//   `legend_payout` (signature of 0654, as case "payout_attest" of the 911
//   grants suite) twice for the same operation and step `propose`: the second
//   attest overwrites the first (upsert), the log still holds two rows. The
//   grant id passed to attest is read from `payroll_payout_grants` by the hash
//   of the secret (sha256 of the raw bytes of the hex secret, as in 911).
// - Case 4: the owner table role is a superuser in tests; the trigger fires for
//   it as well (no replica mode), so UPDATE/DELETE/TRUNCATE as owner prove the
//   trigger itself (23514, message "PAYOUT-7x:"). `legend_payout` may be
//   refused either by missing privilege (42501) or by the trigger (23514 with
//   PAYOUT-7x): both are "cannot". `legend_app` must get 42501 on
//   INSERT/UPDATE/DELETE/TRUNCATE and may SELECT.
// - Case 6: the sweep is exported as
//   `runPayoutApprovalReceiptSweep(context, now)` from
//   `worker/payout-approval-receipt.job.ts` (naming of the sibling
//   `runPayoutGlRecoverySweep` / `runPayoutTrustedReconSweep`). The module is
//   imported dynamically so only this case, not the whole file, fails while it
//   is missing. An event for a log is found in `domain_event_outbox`
//   (destination `cloud-sync` (what appendNotificationEvent writes), name `payout.step_attested`) by the log id
//   appearing in the event text, as UUID or as ULID.
// - Cases 7 to 9: the event envelope is built by hand (name
//   `payout.step_attested`, aggregate `payout` (the envelope rule requires the
//   aggregate to be the name prefix), payloadSchemaRef
//   `payout.step_attested.v1`, version 1, payload `{ logId }` with the log id
//   as UUID, as the other payroll events). A strict-schema violation or an
//   unknown log makes the recipient resolver throw (outbox retries; sibling
//   6c6 suite); for a log of another tenant "throws or returns no recipient"
//   are both accepted (fail closed).
// - Case 8: no "Rp", no thousand-separated number, no run of 5+ digits, no
//   payee name or bank account; the text names verb, "batch gaji", period,
//   item count, "WIB" and the "Bukan Anda?" line. Verb for step `propose` of a
//   correction: "mengusulkan". The link must contain the batch id (UUID or
//   ULID form).
// - Case 9: email is mandatory for `payout_receipt` (planDelivery, shared) and
//   survives a stored preference with every channel off and quiet hours that
//   cover the whole day; through the real consumer a non-skipped, non-deferred
//   `email` delivery attempt exists for the notification.
// - Case 10 re-points the session row of user A to user B as the superuser
//   (a stand-in for what the residual risk allows `legend_app` to do), issues
//   a grant "for B" on that session, spends it, and expects the log to say B
//   and the notification to go to B only.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import {
  cafeLegendNotificationFixtures,
  categoryMeta,
  isEmailMandatory,
  notificationPolicySchema,
  notificationPreferenceSchema,
  planDelivery,
} from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import type { PayoutGrantBinding } from "../services/payroll-payout-grant.service.ts";
import { recordOverpaidItems } from "../services/payroll-payout-overpaid-route.service.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";
import {
  APP,
  APP3,
  BUDI,
  actorOf,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  payoutActorSession,
  testGrantIssuer,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";
import { originHeader } from "./helpers.ts";

const W = installPayoutWorld("915log");
const NET = 1_000_000;
const NOTE = "Mutasi bank menunjukkan transfer ternyata berhasil";
const LOG = "payroll_payout_approval_log";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const PRIVILEGE = "42501";
const GUARD = "23514";
const EVENT = "payout.step_attested";
const hex = () => randomBytes(32).toString("hex");
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");

const batchIds: string[] = [];
const itemIds: string[] = [];
const refreshSessions: string[] = [];
const touchedUsers: string[] = [];
const enrolledUsers: string[] = [];

// ---- The trusted functions (signatures of the 911 grants design) --------------------------

const PROPOSE = `SELECT app.payout_correction_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`;
const APPROVE = `SELECT app.payout_correction_approve($1::uuid, $2::varchar, $3::text) AS n`;

// ---- DB helpers --------------------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** One statement as legend_app of `tenant`; real COMMIT unless `commit: false` (ROLLBACK). First error, if any. */
async function appCall(
  sql: string,
  params: unknown[] = [],
  options: { commit?: boolean; tenant?: string } = {},
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [options.tenant ?? W.tenantId],
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

/** One statement as `role` (null = the owner login itself), tenant set, ALWAYS rolled back. */
async function rolledBack(
  role: "legend_payout" | null,
  sql: string,
  params: unknown[] = [],
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      const result = await client.query(sql, params);
      return { code: undefined, message: "", rows: result.rows as Row[] };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code ?? "unknown", message: e.message ?? "", rows: [] };
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const grantRow = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT id::text AS id, kind, step, actor, session_id, consumed_at
         FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    )
  )[0];
const logCountOfBatch = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${LOG} WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  );
const logOfGrant = async (grantId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, kind, step, actor, session_id, batch_id::text AS batch_id,
            item_count, operation_id::text AS operation_id
       FROM ${LOG} WHERE tenant_id = $1 AND grant_id = $2`,
    [W.tenantId, grantId],
  );

// ---- People -----------------------------------------------------------------------------------

type Finance = Awaited<ReturnType<typeof payoutActorSession>>;

/** A real user with the approve permission and a live session with fresh MFA (grants are issued for it). */
async function sqlFinance(label: string): Promise<Finance> {
  const { userId } = await W.signedInClient(`Log915 ${label}`);
  await W.grantRole(userId, ["payroll.disburse.approve"]);
  touchedUsers.push(userId);
  const actor = await payoutActorSession(W.tenantId, userId);
  refreshSessions.push(actor.sessionId);
  return actor;
}

/** A signed-in finance person over HTTP, TOTP enrolled in this very session (enrollment-only step-up). */
async function webFinance(label: string) {
  const { client, userId } = await W.signedInClient(`Log915 web ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  touchedUsers.push(userId);
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

let one: Finance;
let two: Finance;

// ---- Worlds ---------------------------------------------------------------------------------

type World = {
  runId: string;
  batchId: string;
  itemIds: string[];
  itemId: string;
};

/** An exported batch whose item was resolved `failed` by two people: where a correction starts. */
async function failedWorld(): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  batchIds.push(batchId);
  const ids = (await W.itemsOf(batchId)).map((i) => i.id as string);
  itemIds.push(...ids);
  await W.resolve(batchId, ids, "failed", APP);
  await W.resolve(batchId, ids, "failed", APP3);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is failed").toBe("failed");
  return { runId, batchId, itemIds: ids, itemId: ids[0]! };
}

/** An exported batch whose only item was paid (`succeeded`): where a return starts. */
async function succeededWorld(): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  batchIds.push(batchId);
  await W.confirm(batchId, W.succeedItems(batchId, await W.itemsOf(batchId)));
  const ids = (await W.itemsOf(batchId)).map((i) => i.id as string);
  itemIds.push(...ids);
  expect((await W.itemsOf(batchId))[0]!.status, "premise: succeeded").toBe(
    "succeeded",
  );
  return { runId, batchId, itemIds: ids, itemId: ids[0]! };
}

/** The upload record of one proof file of the batch (what a real upload leaves), unbound. */
async function recordUpload(batchId: string, name = "bukti") {
  const key = evidenceKeyFor(
    W.tenantId,
    batchId,
    `${name}-${randomUUID()}.pdf`,
  );
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, 'upload-915-log')`,
        [W.tenantId, batchId, key, hex(), hex()],
      ),
    true,
  );
  return key;
}

/** An upload record also bound to the operation (what the route does before step one). */
async function boundUpload(
  w: World,
  kind: "correction" | "return" = "correction",
) {
  const key = await recordUpload(w.batchId);
  const bound = await appCall(
    `SELECT app.payout_bind_proof($1::uuid, $2::text, $3::uuid[], $4::varchar, $5::text) AS id`,
    [w.batchId, kind, [w.itemId], key, one.userId],
  );
  expect(bound.code, `premise: proof bound, ${bound.message}`).toBe(undefined);
  return key;
}

const proposeBinding = (
  w: World,
  key: string,
  kind: "correction" | "return" = "correction",
): PayoutGrantBinding => ({
  kind,
  step: "propose",
  batchId: w.batchId,
  itemIds: [w.itemId],
  evidenceKey: key,
  refId: null,
  targetId: null,
});
const stepTwoBinding = (
  w: World,
  key: string,
  operation: string,
  kind: "correction" | "return" = "correction",
): PayoutGrantBinding => ({
  kind,
  step: kind === "correction" ? "approve" : "confirm",
  batchId: w.batchId,
  itemIds: [w.itemId],
  evidenceKey: key,
  refId: operation,
  targetId: null,
});

/** Correction step one by `who`, committed; returns the operation id and the spent grant. */
async function proposeCorrection(who: Finance, w: World, key: string) {
  const grant = await who.grants.issue(proposeBinding(w, key));
  const result = await appCall(PROPOSE, [
    w.batchId,
    [w.itemId],
    key,
    NOTE,
    grant,
  ]);
  expect(result.code, `premise: step one accepted, ${result.message}`).toBe(
    undefined,
  );
  return { operation: result.rows[0]!.id as string, grant };
}

/** One shared world with an open correction proposal by `one`: exactly one log row. */
let receiptWorld:
  | Promise<{
      w: World;
      key: string;
      operation: string;
      grant: string;
      logId: string;
    }>
  | undefined;
function receipt() {
  receiptWorld ??= (async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const { operation, grant } = await proposeCorrection(one, w, key);
    const spent = await grantRow(grant);
    const rows = await logOfGrant(String(spent!.id));
    expect(rows, "premise: the propose left one log row").toHaveLength(1);
    return { w, key, operation, grant, logId: rows[0]!.id as string };
  })();
  return receiptWorld;
}

// ---- Event / notification helpers ---------------------------------------------------------------

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

function receiptEvent(
  payload: Record<string, unknown>,
  tenantId: string = W.tenantId,
) {
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId,
    outletId: null,
    name: EVENT,
    version: 1,
    aggregateType: "payout",
    aggregateId: createUlid(),
    sequence: 1,
    idempotencyKey: `${EVENT}-${randomUUID()}`,
    payloadSchemaRef: `${EVENT}.v1`,
    payload,
  });
}

/** The real resolver, run as the worker would (tenant context of the job). */
function resolveReceipt(
  event: ReturnType<typeof receiptEvent>,
  context: ScopedTenantContext = jobContext(),
) {
  return withTenant(database, context, (tx) =>
    createNotificationRecipientResolver({ email: true, push: true })(
      context,
      event,
      tx,
    ),
  );
}

const idForms = (uuid: string) => [uuid, uuidToUlid(uuid)];
const looksLike = (text: string, uuid: string) =>
  idForms(uuid).some((form) => text.includes(form));

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await sqlFinance("One");
  two = await sqlFinance("Two");
});

// The step-up must stay fresh (15 minutes) for the whole file.
beforeEach(async () => {
  await W.owner.query(
    `UPDATE session SET mfa_verified_at = now() WHERE id = ANY($1)`,
    [refreshSessions],
  );
});

// Registered after the world's own hook: runs first (stack order). Triggers and
// FKs are off (replica): the log is append-only for every role, the fixture
// removes its rows the way the world removes its other payout rows.
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (batchIds.length > 0)
      await c.query(
        `DELETE FROM ${LOG} WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`,
        [W.tenantId, batchIds],
      );
    await c.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2`,
      [W.tenantId, EVENT],
    );
    if (touchedUsers.length > 0) {
      await c.query(
        `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN
           (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]))`,
        [W.tenantId, touchedUsers],
      );
      await c.query(
        `DELETE FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
        [W.tenantId, touchedUsers],
      );
      await c.query(
        `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
        [W.tenantId, touchedUsers],
      );
    }
    if (itemIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_attestations WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
        [W.tenantId, itemIds],
      );
    if (batchIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`,
        [W.tenantId, batchIds],
      );
  }, true);
  if (enrolledUsers.length > 0)
    await W.owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await appPool.end();
});

// =========================================================================
// 1 to 3: what is written, and when
// =========================================================================

/**
 * Every granted attestation of the batches has exactly one log row, and each
 * row repeats what the grant and the attestation say. Returns the rows.
 */
async function expectLogMatchesAttestations(batches: string[]) {
  const logs = await W.rowsOf(
    `SELECT l.attestation_id::text AS attestation_id, l.kind, l.step,
            l.operation_id::text AS operation_id, l.item_count, l.actor,
            l.session_id, l.logged_at, l.txid::text AS log_txid,
            g.actor AS grant_actor, g.session_id AS grant_session,
            g.kind AS grant_kind, g.step AS grant_step,
            a.step AS att_step, a.operation_id::text AS att_operation,
            a.txid::text AS att_txid, cardinality(a.item_ids) AS att_items
       FROM ${LOG} l
       JOIN payroll_payout_grants g ON g.tenant_id = l.tenant_id AND g.id = l.grant_id
       LEFT JOIN payroll_payout_attestations a ON a.tenant_id = l.tenant_id AND a.id = l.attestation_id
      WHERE l.tenant_id = $1 AND l.batch_id = ANY($2::uuid[])`,
    [W.tenantId, batches],
  );
  const attestations = await W.rowsOf(
    `SELECT a.id::text AS id
       FROM payroll_payout_attestations a
       JOIN payroll_payout_grants g ON g.tenant_id = a.tenant_id AND g.id = a.grant_id
      WHERE a.tenant_id = $1 AND g.batch_id = ANY($2::uuid[])`,
    [W.tenantId, batches],
  );
  expect(
    attestations.length,
    "premise: granted attestations exist",
  ).toBeGreaterThan(0);
  expect(
    logs.map((l) => l.attestation_id).sort(),
    "exactly one log row per granted attestation",
  ).toEqual(attestations.map((a) => a.id).sort());
  for (const l of logs) {
    const label = `${l.kind}/${l.step}`;
    expect(l.actor, `${label}: actor is the grant's actor`).toBe(l.grant_actor);
    expect(l.session_id, `${label}: session is the grant's`).toBe(
      l.grant_session,
    );
    expect(l.kind, `${label}: kind of the grant`).toBe(l.grant_kind);
    expect(l.step, `${label}: step of the grant`).toBe(l.grant_step);
    expect(l.att_step, `${label}: step of the attestation`).toBe(l.step);
    expect(l.operation_id, `${label}: operation`).toBe(l.att_operation);
    expect(Number(l.item_count), `${label}: item count`).toBe(
      Number(l.att_items),
    );
    expect(l.log_txid, `${label}: written in the attesting txid`).toBe(
      l.att_txid,
    );
    expect(l.logged_at, `${label}: logged_at`).not.toBeNull();
  }
  return logs;
}
const kindCount = (logs: Row[], kind: string) =>
  logs.filter((l) => l.kind === kind).length;

describe("915 log: a spent grant leaves a log row", () => {
  it("[915-log-one-row-per-step] resolve, bank confirm, correction, return and overpaid each write exactly one log row per step, with actor = the grant's actor", async () => {
    // --- failed item -> correction (two people, over HTTP: the route also posts the settlement) ---
    const failed = await failedWorld();
    const correctionKey = uploadEvidence(
      failed.batchId,
      `log-${randomUUID()}.pdf`,
    );
    const webOne = await webFinance("Correction one");
    const webTwo = await webFinance("Correction two");
    for (const who of [webOne, webTwo]) {
      const sent = await who.client
        .post(`${BATCHES}/${failed.batchId}/correct-failed`)
        .set(originHeader)
        .send({
          itemIds: [failed.itemId],
          evidenceKey: correctionKey,
          note: NOTE,
          password: PASSWORD,
        });
      expect(
        [200, 201],
        `premise: correction step, ${JSON.stringify(sent.body)}`,
      ).toContain(sent.status);
    }
    const correctionLogs = await expectLogMatchesAttestations([failed.batchId]);
    expect(kindCount(correctionLogs, "resolve"), "failure resolutions").toBe(2);
    expect(kindCount(correctionLogs, "correction")).toBe(2);
    expect(
      correctionLogs
        .filter((l) => l.kind === "correction")
        .map((l) => l.step)
        .sort(),
    ).toEqual(["approve", "propose"]);
    expect(
      correctionLogs
        .filter((l) => l.kind === "correction")
        .map((l) => l.actor)
        .sort(),
    ).toEqual([webOne.userId, webTwo.userId].sort());

    // --- paid item -> bank confirm, then return (two people) ---
    const paid = await succeededWorld();
    // Over HTTP: the route also posts the return journal that step two needs.
    const returnKey = uploadEvidence(paid.batchId, `log-${randomUUID()}.pdf`);
    const retOne = await webFinance("Return one");
    const retTwo = await webFinance("Return two");
    for (const who of [retOne, retTwo]) {
      const sent = await who.client
        .post(`${BATCHES}/${paid.batchId}/return`)
        .set(originHeader)
        .send({
          itemIds: [paid.itemId],
          evidenceKey: returnKey,
          note: NOTE,
          password: PASSWORD,
        });
      expect(
        [200, 201],
        `premise: return step, ${JSON.stringify(sent.body)}`,
      ).toContain(sent.status);
    }
    const returnLogs = await expectLogMatchesAttestations([paid.batchId]);
    expect(
      kindCount(returnLogs, "bank_confirm"),
      "bank confirm",
    ).toBeGreaterThan(0);
    expect(kindCount(returnLogs, "return")).toBe(2);
    expect(
      returnLogs
        .filter((l) => l.kind === "return")
        .map((l) => l.step)
        .sort(),
    ).toEqual(["confirm", "propose"]);

    // --- overpaid: a failed attempt, a paid retry, then two people record it ---
    const first = await failedWorld();
    const retryBatch = await W.exportedBatch(first.runId);
    batchIds.push(retryBatch);
    await W.confirm(
      retryBatch,
      W.succeedItems(
        retryBatch,
        (await W.itemsOf(retryBatch)).filter((i) => i.status === "exported"),
      ),
    );
    const overpaidKey = uploadEvidence(first.batchId, "mutasi-915.pdf");
    await W.proposeOverpaid(
      first.batchId,
      first.itemId,
      overpaidKey,
      NOTE,
      APP,
    );
    await W.inTx((tx) =>
      recordOverpaidItems(
        tx,
        actorOf(APP),
        first.batchId,
        { itemIds: [first.itemId], evidenceKey: overpaidKey, note: NOTE },
        W.proofs(),
      ),
    );
    const overpaidLogs = await expectLogMatchesAttestations([
      first.batchId,
      retryBatch,
    ]);
    expect(
      kindCount(overpaidLogs, "overpaid"),
      "overpaid propose + record",
    ).toBe(2);
    expect(kindCount(overpaidLogs, "resolve")).toBe(2);
    expect(kindCount(overpaidLogs, "bank_confirm")).toBeGreaterThan(0);
  }, 120_000);

  it("[915-log-propose-repeat] a propose repeated for the same operation overwrites the attestation, but both grants stay in the log (2 rows)", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const operation = randomUUID();
    const spent: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const secret = await one.grants.issue(proposeBinding(w, key));
      const grantId = (await grantRow(secret))!.id;
      // Direct, as the payout role: consume the grant, then attest in the same transaction.
      const client = await W.owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_payout");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          W.tenantId,
        ]);
        await client.query(
          `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, 'correction', 'propose', $3::uuid, $4::uuid[], $5::varchar, NULL::uuid, NULL::uuid, NULL::varchar)`,
          [W.tenantId, secret, w.batchId, [w.itemId], key],
        );
        await client.query(
          `SELECT app.payout_attest($1::uuid, 'correction', $2::uuid, 'propose', $3::uuid, $4::uuid[], $5::varchar, NULL::uuid, $6::uuid, '{}'::jsonb)`,
          [W.tenantId, operation, w.batchId, [w.itemId], key, grantId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`premise: attest round ${round}: ${String(error)}`);
      } finally {
        client.release();
      }
      spent.push(String(grantId));
    }
    const rows = await W.rowsOf(
      `SELECT grant_id::text AS grant_id, step, operation_id::text AS operation_id
         FROM ${LOG} WHERE tenant_id = $1 AND operation_id = $2`,
      [W.tenantId, operation],
    );
    expect(
      rows,
      "one log row per propose, the overwritten one included",
    ).toHaveLength(2);
    expect(rows.map((r) => r.grant_id).sort()).toEqual([...spent].sort());
    for (const r of rows) expect(r.step).toBe("propose");
  });

  it("[915-log-rollback-writes-nothing] a step that is rolled back or refused leaves no log row", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const baseline = await logCountOfBatch(w.batchId);

    // Rolled back after the function finished: the log insert is part of the same transaction.
    const grant = await one.grants.issue(proposeBinding(w, key));
    const dry = await appCall(
      PROPOSE,
      [w.batchId, [w.itemId], key, NOTE, grant],
      {
        commit: false,
      },
    );
    expect(dry.code, `premise: the step itself works, ${dry.message}`).toBe(
      undefined,
    );
    expect(await logCountOfBatch(w.batchId), "rollback: no row").toBe(baseline);
    expect(
      (await grantRow(grant))!.consumed_at,
      "premise: the grant spend was rolled back too",
    ).toBeNull();

    // Refused: the proposer approving their own proposal (PAYOUT-64).
    const { operation } = await proposeCorrection(one, w, key);
    expect(await logCountOfBatch(w.batchId), "the real propose logs once").toBe(
      baseline + 1,
    );
    const own = await one.grants.issue(stepTwoBinding(w, key, operation));
    const refused = await appCall(APPROVE, [operation, key, own]);
    expect(refused.message, "premise: refused as the same person").toMatch(
      /PAYOUT-64:/,
    );
    expect(await logCountOfBatch(w.batchId), "refused: still one new row").toBe(
      baseline + 1,
    );
  });
});

// =========================================================================
// 4 and 5: nobody can change or hide the log
// =========================================================================

describe("915 log: append-only and tenant-isolated", () => {
  it("[915-log-append-only] legend_app cannot INSERT, UPDATE, DELETE or TRUNCATE (42501); legend_payout cannot UPDATE, DELETE or TRUNCATE; the trigger refuses the owner as well; the rows stay", async () => {
    const { w, logId } = await receipt();
    const before = await logCountOfBatch(w.batchId);
    expect(before, "premise: a log row exists").toBeGreaterThan(0);

    const statements: [string, string, unknown[]][] = [
      ["insert", `INSERT INTO ${LOG} (id) VALUES (gen_random_uuid())`, []],
      [
        "update",
        `UPDATE ${LOG} SET actor = 'someone-else' WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, logId],
      ],
      [
        "delete",
        `DELETE FROM ${LOG} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, logId],
      ],
      ["truncate", `TRUNCATE ${LOG}`, []],
    ];

    // legend_app: no privilege at all.
    const app: Record<string, string | undefined> = {};
    for (const [name, sql, params] of statements)
      app[name] = (await appCall(sql, params, { commit: false })).code;
    expect(app).toEqual({
      insert: PRIVILEGE,
      update: PRIVILEGE,
      delete: PRIVILEGE,
      truncate: PRIVILEGE,
    });

    // legend_payout: may insert (through the attest function) but not change or erase.
    for (const [name, sql, params] of statements.filter(
      ([n]) => n !== "insert",
    )) {
      const outcome = await rolledBack("legend_payout", sql, params);
      expect(
        outcome.code,
        `payout role ${name}: ${outcome.message}`,
      ).toBeDefined();
      if (outcome.code === GUARD)
        expect(outcome.message, `payout role ${name}`).toMatch(/PAYOUT-7\d:/);
      else expect(outcome.code, `payout role ${name}`).toBe(PRIVILEGE);
    }

    // The trigger itself: even the table owner (a superuser here) is refused.
    for (const [name, sql, params] of statements.filter(
      ([n]) => n !== "insert",
    )) {
      const outcome = await rolledBack(null, sql, params);
      expect(outcome.code, `owner ${name}: ${outcome.message}`).toBe(GUARD);
      expect(outcome.message, `owner ${name}`).toMatch(/PAYOUT-7\d:/);
    }

    expect(await logCountOfBatch(w.batchId), "nothing was lost").toBe(before);
    const row = (
      await W.rowsOf(
        `SELECT actor FROM ${LOG} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, logId],
      )
    )[0];
    expect(row?.actor, "nothing was changed").toBe(one.userId);

    // legend_app may still read (recon / notification).
    const read = await appCall(
      `SELECT count(*)::int AS n FROM ${LOG} WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, w.batchId],
      { commit: false },
    );
    expect(read.code, read.message).toBe(undefined);
    expect(Number(read.rows[0]!.n)).toBe(before);
  });

  it("[915-log-rls-tenant] a session of another tenant sees none of the rows", async () => {
    const { w } = await receipt();
    const own = await appCall(
      `SELECT count(*)::int AS n FROM ${LOG} WHERE batch_id = $1`,
      [w.batchId],
      { commit: false },
    );
    expect(own.code, own.message).toBe(undefined);
    expect(
      Number(own.rows[0]!.n),
      "premise: own tenant sees its row",
    ).toBeGreaterThan(0);
    const other = await appCall(`SELECT count(*)::int AS n FROM ${LOG}`, [], {
      commit: false,
      tenant: randomUUID(),
    });
    expect(other.code, other.message).toBe(undefined);
    expect(Number(other.rows[0]!.n), "another tenant sees nothing").toBe(0);
    const byBatch = await appCall(
      `SELECT count(*)::int AS n FROM ${LOG} WHERE batch_id = $1`,
      [w.batchId],
      { commit: false, tenant: randomUUID() },
    );
    expect(Number(byBatch.rows[0]!.n)).toBe(0);
  });
});

// =========================================================================
// 6: the sweep turns log rows into events
// =========================================================================

type SweepModule = {
  runPayoutApprovalReceiptSweep: (
    context: ScopedTenantContext,
    now: Date,
  ) => Promise<unknown>;
};
const SWEEP_MODULE = "../worker/payout-approval-receipt.job.ts";

describe("915 receipt: the sweep", () => {
  it("[915-receipt-sweep-idempotent] a log row gets exactly one payout.step_attested event, a second sweep adds none, and the event is made again when the outbox row was deleted before delivery", async () => {
    const { logId } = await receipt();
    const { runPayoutApprovalReceiptSweep } = (await import(
      /* @vite-ignore */ SWEEP_MODULE
    )) as SweepModule;
    const eventsOf = (id: string) =>
      W.rowsOf(
        `SELECT id::text AS id FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = $2
            AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
        [W.tenantId, EVENT, ...idForms(id)],
      );
    expect(
      await eventsOf(logId),
      "premise: no event before the sweep",
    ).toHaveLength(0);

    await runPayoutApprovalReceiptSweep(W.scope(), new Date());
    const first = await eventsOf(logId);
    expect(first, "one event after the first sweep").toHaveLength(1);
    const text = JSON.stringify(
      (
        await W.rowsOf(
          `SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, first[0]!.id],
        )
      )[0]!.event,
    );
    expect(
      text,
      "the payload carries the log id and nothing about the person",
    ).not.toContain(one.userId);

    await runPayoutApprovalReceiptSweep(W.scope(), new Date());
    expect(await eventsOf(logId), "idempotent: still one").toHaveLength(1);
    expect((await eventsOf(logId))[0]!.id, "the same event").toBe(first[0]!.id);

    // The outbox row is lost before delivery: the next sweep makes it again.
    await W.asTenant(
      (c) =>
        c.query(
          `DELETE FROM domain_event_outbox
            WHERE tenant_id = $1 AND event->>'name' = $2
              AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
          [W.tenantId, EVENT, ...idForms(logId)],
        ),
      true,
    );
    expect(await eventsOf(logId), "premise: deleted").toHaveLength(0);
    await runPayoutApprovalReceiptSweep(W.scope(), new Date());
    expect(await eventsOf(logId), "made again").toHaveLength(1);
  });
});

// =========================================================================
// 7 to 9: who is told, what they read, and that email cannot be switched off
// =========================================================================

describe("915 receipt: recipient and text", () => {
  it("[915-receipt-recipient-from-log] the recipient is the log's actor; a payload with an extra userId, a missing log id or a log of another tenant gets nobody", async () => {
    const { logId } = await receipt();

    const recipients = await resolveReceipt(receiptEvent({ logId }));
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.userId, "the actor of the log").toBe(one.userId);
    expect(recipients[0]!.category).toBe("payout_receipt");

    // Strict payload: a userId smuggled into the event is refused (the outbox retries).
    await expect(
      resolveReceipt(receiptEvent({ logId, userId: two.userId })),
    ).rejects.toThrow();
    await expect(resolveReceipt(receiptEvent({}))).rejects.toThrow();

    // Unknown log, or an event of another tenant pointing at this tenant's log: fail closed.
    const nobody = async (work: Promise<{ userId: string }[]>) =>
      work.then(
        (rows) => rows,
        () => [] as { userId: string }[],
      );
    expect(
      await nobody(resolveReceipt(receiptEvent({ logId: randomUUID() }))),
    ).toEqual([]);
    const stranger = randomUUID();
    expect(
      await nobody(
        resolveReceipt(receiptEvent({ logId }, stranger), jobContext()),
      ),
      "event tenant differs from the log's tenant",
    ).toEqual([]);
    expect(
      await nobody(
        resolveReceipt(receiptEvent({ logId }, stranger), jobContext(stranger)),
      ),
      "log of another tenant",
    ).toEqual([]);
  });

  it("[915-receipt-text-no-amounts] the notification names the verb, the batch period, the item count and the time, links to the batch, and carries no Rp, amount, payee name or bank account", async () => {
    const { w, logId } = await receipt();
    const recipients = await resolveReceipt(receiptEvent({ logId }));
    expect(recipients).toHaveLength(1);
    const r = recipients[0]!;
    const text = `${r.title}\n${r.body}`;

    expect(text).toMatch(/Anda mengusulkan/);
    expect(text).toMatch(/batch gaji/);
    expect(text).toMatch(/periode/);
    expect(text).toMatch(/\b1 item\b/);
    expect(text).toMatch(/WIB/);
    expect(text).toMatch(/Bukan Anda\?/);
    expect(text).toMatch(/pemilik usaha/);
    expect(text).toMatch(/ganti kata sandi/);

    expect(text).not.toMatch(/Rp/i);
    expect(text, "no thousand-separated amount").not.toMatch(
      /\d{1,3}([.,]\d{3})+/,
    );
    expect(text, "no long digit run (amount, account)").not.toMatch(/\d{5,}/);
    expect(text).not.toContain(String(NET));
    expect(text).not.toContain(BUDI.name);
    expect(text).not.toContain(BUDI.account);

    expect(r.link, "a link to the batch page").toBeTruthy();
    expect(looksLike(String(r.link), w.batchId)).toBe(true);
  });

  it("[915-receipt-email-mandatory] email goes out even when the person switched every channel off and set quiet hours over the whole day", async () => {
    // Pure plan (shared): the category is mandatory-email and ignores quiet hours.
    expect(isEmailMandatory("payout_receipt")).toBe(true);
    expect(categoryMeta("payout_receipt").bypassQuietHours).toBe(true);
    const tenant = W.tenantId;
    const user = randomUUID();
    const policy = notificationPolicySchema.parse({
      ...cafeLegendNotificationFixtures.policy,
      tenantId: tenant,
      webPushEnabled: true,
      emailEnabled: false,
    });
    const off = { web_push: false, email: false, whatsapp: false };
    const preference = notificationPreferenceSchema.parse({
      tenantId: tenant,
      userId: user,
      categories: { payout_receipt: off },
      quietHours: { start: "22:00", end: "07:00" },
      timeZone: "Asia/Jakarta",
      updatedAt: "2026-11-01T02:00:00.000Z",
    });
    const plan = planDelivery({
      category: "payout_receipt",
      policy,
      preference,
      reachability: {
        hasPushSubscription: true,
        hasVerifiedEmail: true,
        whatsappOptIn: false,
      },
      whatsappSentThisMonth: 0,
      now: new Date("2026-11-16T16:00:00.000Z"), // 23:00 WIB, inside quiet hours
      defaultTimeZone: "Asia/Jakarta",
    });
    expect(plan.channels.find((c) => c.channel === "email")).toMatchObject({
      decision: "send",
      notBefore: null,
    });

    // Through the real resolver and consumer, with the stored preference of the actor.
    const { logId } = await receipt();
    await W.owner.query(
      `UPDATE "user" SET email_verified = true WHERE id = $1`,
      [one.userId],
    );
    await W.owner.query(
      `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2`,
      [W.tenantId, one.userId],
    );
    await W.owner.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'Asia/Jakarta')`,
      [
        W.tenantId,
        one.userId,
        JSON.stringify({ payout_receipt: off }),
        JSON.stringify({ start: "00:00", end: "23:59" }),
      ],
    );
    const context = jobContext();
    const event = receiptEvent({ logId });
    const consume = createNotificationConsumer(
      context,
      createNotificationRecipientResolver({ email: true, push: true }),
    );
    await withTenant(database, context, (tx) => consume(event, event.id, tx));
    const attempts = (
      await W.owner.query<{ status: string; due_in_seconds: string }>(
        `SELECT a.status, extract(epoch FROM (a.next_attempt_at - now()))::text AS due_in_seconds
           FROM delivery_attempts a
           JOIN notifications n ON n.id = a.notification_id AND n.tenant_id = a.tenant_id
          WHERE n.tenant_id = $1 AND n.user_id = $2 AND n.source_event_id = $3
            AND a.channel = 'email'`,
        [W.tenantId, one.userId, ulidToUuid(event.id)],
      )
    ).rows;
    expect(attempts, "one email delivery attempt").toHaveLength(1);
    expect(attempts[0]!.status, "not skipped by the opt-out").not.toBe(
      "skipped",
    );
    expect(
      Number(attempts[0]!.due_in_seconds),
      "not deferred by quiet hours",
    ).toBeLessThan(120);
  });
});

// =========================================================================
// 10: a re-pointed session cannot hide the real person
// =========================================================================

describe("915 receipt: a forged session row does not hide the person", () => {
  it("[915-receipt-repointed-session] the grant of a session re-pointed to user B is logged as B, and the notification goes to B", async () => {
    const victim = await sqlFinance("Repointed A");
    const person = await sqlFinance("Repointed B");
    const w = await failedWorld();
    const key = await boundUpload(w);
    try {
      // Stand-in for the accepted residual risk (legend_app can rewrite a
      // session row): the session of A now says B.
      await W.owner.query(`UPDATE session SET user_id = $2 WHERE id = $1`, [
        victim.sessionId,
        person.userId,
      ]);
      const grant = await testGrantIssuer({
        tenantId: W.tenantId,
        userId: person.userId,
        sessionId: victim.sessionId,
      }).issue(proposeBinding(w, key));
      const result = await appCall(PROPOSE, [
        w.batchId,
        [w.itemId],
        key,
        NOTE,
        grant,
      ]);
      expect(result.code, `premise: step accepted, ${result.message}`).toBe(
        undefined,
      );

      const spent = await grantRow(grant);
      const rows = await logOfGrant(String(spent!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor, "the log names B").toBe(person.userId);
      expect(rows[0]!.actor).not.toBe(victim.userId);
      expect(rows[0]!.session_id).toBe(victim.sessionId);

      const recipients = await resolveReceipt(
        receiptEvent({ logId: rows[0]!.id as string }),
      );
      expect(recipients.map((r) => r.userId)).toEqual([person.userId]);
    } finally {
      await W.owner.query(`UPDATE session SET user_id = $2 WHERE id = $1`, [
        victim.sessionId,
        victim.userId,
      ]);
    }
  });
});
