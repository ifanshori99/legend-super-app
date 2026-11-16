// Payout 911, second-opinion finding P1-1 (design: docs/briefs/911/design-p1-1.md
// sections 1 and 5; plan: docs/briefs/911/plan.md). Written fail-first from the
// design, NOT from the implementation. Cases 1 to 14 of design section 5;
// 15 (grantor pool guard), 16 (recon flag), 17 (provisioning audit) and 18 live
// in other files.
//
// Rule proven (founder: nobody is paid on the word of one person; when in doubt,
// limit the payment): a trusted payout step no longer takes an actor and a
// session from the caller. It takes a one-time grant that only the separate
// grantor login can issue, bound to tenant, actor, session, kind, step, batch,
// item set, proof key, reference and target, valid 2 minutes, spent once.
// Everything adversarial runs as `SET LOCAL ROLE legend_app` with a REAL COMMIT
// (never as the owner, no trigger disabled); grants are issued by
// `testGrantIssuer` / `actor.grants` of the fixtures (the grantor stand-in).
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - Error shape. PAYOUT-70 is SQLSTATE 42501 with "PAYOUT-70:" in the message,
//   PAYOUT-71 is 23514 (design 3.A.7, 3.B.2); PAYOUT-64 and PAYOUT-39..42 are
//   asserted by message only (their SQLSTATE is not in the design).
// - New SQL signatures are exactly the ones of design 3.B.2, with the grant as
//   the LAST argument. The return flow is driven in SQL with a `succeeded` item
//   (as 905-recon `returnedWorld` does over HTTP) and an upload record of
//   `payroll_payout_evidence_files` (as 911-binding-batch `recordUpload`).
// - A forged / mismatched call is refused by the grant check BEFORE any other
//   check (design D2 "consume first"), so the other state of the call may be
//   incomplete (for example the batch variant of case 7).
// - Case 7 "batch" is a call for another real batch (with its own item and
//   proof), so that variant differs in more than the batch; every other variant
//   changes exactly one binding component of an otherwise valid call.
// - `payroll_payout_grants.secret_sha256` is sha256 of the raw bytes of the hex
//   secret (design D3); the test finds a grant row through that hash. The
//   column `actor` of the grants and `grant_id`, `txid`, `item_ids`,
//   `attested_at`, `step`, `operation_id` of the attestations exist (design
//   3.A, D7, and the 905 recon suite).
// - Case 10 bans a user with `"user".banned = true` (Better Auth admin column,
//   as access-users-directory.test.ts) and revokes a session with
//   `session.revoked_at`.
// - Case 12 copies an existing attestation row (dynamic column list, new id and
//   operation id, `grant_id` NULL, `attested_at = now()`) and inserts it as
//   `legend_payout`; the refusal must come from the CHECK
//   `payroll_payout_attestations_grant_check` (named by design 3.B.4).
// - Case 14: the correction route takes no `password` when the challenge is
//   fresh; with a stale challenge and no password it answers 401
//   REAUTH_REQUIRED (as the 881/888 step-up suites). A fake request without a
//   step-up record is refused with a 401 HttpError by `issue`; the exact code is
//   not asserted there because the order between `getAuth(req)` and the record
//   lookup is not fixed by the design.
// - The payout transaction stays READ COMMITTED (design section 2): every grant
//   is committed on another connection before the payout call, in all cases.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { payoutGuardViolation } from "../services/payroll-payout.service.ts";
import { payoutGrantIssuerOf } from "../services/payroll-payout-grant.service.ts";
import type { PayoutGrantBinding } from "../services/payroll-payout-grant.service.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  payoutActorSession,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("911grant");
const NET = 1_000_000;
const NOTE = "Mutasi bank menunjukkan transfer ternyata berhasil";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const PRIVILEGE = "42501";
const GUARD = "23514";
const hex = () => randomBytes(32).toString("hex");
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");

const batchIds: string[] = [];
const itemIds: string[] = [];
const refreshSessions: string[] = [];
const enrolledUsers: string[] = [];

// ---- The trusted functions, new signatures (design 3.B.2) -----------------------------

const PROPOSE = `SELECT app.payout_correction_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`;
const APPROVE = `SELECT app.payout_correction_approve($1::uuid, $2::varchar, $3::text) AS n`;
const RETURN_PROPOSE = `SELECT app.payout_return_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`;
const RETURN_CONFIRM = `SELECT app.payout_return_confirm($1::uuid, $2::varchar, $3::text) AS n`;

// ---- legend_app helpers ------------------------------------------------------------------

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

/** `n` legend_app transactions that fire the same statement at the same moment, each committing on its own. */
async function race(n: number, sql: string, params: unknown[]) {
  const clients: PoolClient[] = [];
  try {
    for (let i = 0; i < n; i += 1) clients.push(await W.owner.connect());
    for (const c of clients) {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE legend_app");
      await c.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
    }
    return await Promise.all(
      clients.map(async (c) => {
        try {
          await c.query(sql, params);
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

/** The grant check refused the call (PAYOUT-70, 42501). */
function expectGrantRefused(outcome: Outcome, label: string) {
  expect(outcome.code, `${label}: ${outcome.message}`).toBe(PRIVILEGE);
  expect(outcome.message, label).toMatch(/PAYOUT-70:/);
}

// ---- People ---------------------------------------------------------------------------------

type Finance = Awaited<ReturnType<typeof payoutActorSession>>;

/** A real user with the approve permission and a live session with fresh MFA (grants are issued for it). */
async function sqlFinance(label: string, permit = true): Promise<Finance> {
  const { userId } = await W.signedInClient(`Grant911 ${label}`);
  if (permit) await W.grantRole(userId, ["payroll.disburse.approve"]);
  const actor = await payoutActorSession(W.tenantId, userId);
  refreshSessions.push(actor.sessionId);
  return actor;
}

type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
/** A signed-in finance person over HTTP, TOTP enrolled in this very session (enrollment-only). */
async function webFinance(label: string) {
  const { client, userId } = await W.signedInClient(`Grant911 web ${label}`);
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
  const person = await webFinance(label);
  await W.owner.query(
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

let one: Finance;
let two: Finance;

// ---- Worlds ---------------------------------------------------------------------------------

type World = {
  runId: string;
  batchId: string;
  itemIds: string[];
  itemId: string;
};

/** An exported batch whose items (one per person) were resolved `failed` by two people: where a correction starts. */
async function failedWorld(people = [BUDI]): Promise<World> {
  const slips = people.map((p) => bank(p, NET));
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
         VALUES ($1, $2, $3, $4, $5, 'upload-911-grant')`,
        [W.tenantId, batchId, key, hex(), hex()],
      ),
    true,
  );
  return key;
}

/**
 * An upload record that is also bound to the operation (what the route does
 * through `app.payout_bind_proof` before step one): the proof checks of the
 * trusted functions need a binding of this key, kind and item set.
 */
async function boundUpload(
  w: World,
  name = "bukti",
  kind: "correction" | "return" = "correction",
  items: string[] = [w.itemId],
) {
  const key = await recordUpload(w.batchId, name);
  const bound = await appCall(
    `SELECT app.payout_bind_proof($1::uuid, $2::text, $3::uuid[], $4::varchar, $5::text) AS id`,
    [w.batchId, kind, items, key, one.userId],
  );
  expect(bound.code, `premise: proof bound, ${bound.message}`).toBe(undefined);
  return key;
}

// ---- Bindings (the exact values passed to SQL, design 3.B.2) ------------------------------------

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

/** Step one (correction propose) as legend_app with a real grant of `who`; returns the operation id. */
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

// ---- Observations ---------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const grantRow = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT id, kind, step, actor, session_id, consumed_at, consumed_txid::text AS consumed_txid, expires_at
         FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    )
  )[0];
const grantsOfBatch = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  );
const grantsOfTenant = () =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1`,
    [W.tenantId],
  );
const itemStatus = async (id: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, id],
    )
  )[0]!.status as string;

/** Everything a refused step must not have written for the batch (and the entity's payout journals). */
async function trailOf(batchId: string) {
  return {
    // Whole-row text match: independent of the attestation column names.
    attestations: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_attestations a
        WHERE a.tenant_id = $1 AND a::text LIKE '%' || $2 || '%'`,
      [W.tenantId, batchId],
    ),
    corrections: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, batchId],
    ),
    claims: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_return_claims WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, batchId],
    ),
    postings: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, batchId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId, W.entityId()],
    ),
    spentGrants: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_grants
        WHERE tenant_id = $1 AND batch_id = $2 AND consumed_at IS NOT NULL`,
      [W.tenantId, batchId],
    ),
    items: JSON.stringify(
      (
        await W.rowsOf(
          `SELECT id, status FROM payroll_disbursement_items WHERE tenant_id = $1 AND batch_id = $2 ORDER BY id`,
          [W.tenantId, batchId],
        )
      ).map((r) => [r.id, r.status]),
    ),
  };
}

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await sqlFinance("One");
  two = await sqlFinance("Two");
});

// The step-up must stay fresh (15 minutes) for the whole file; sessions that a
// test ages on purpose (case 10) are not in this list.
beforeEach(async () => {
  await W.owner.query(
    `UPDATE session SET mfa_verified_at = now() WHERE id = ANY($1)`,
    [refreshSessions],
  );
});

// Registered after the world's own hook: runs first (stack order). Triggers and
// FKs are off (replica), as the world does, so order does not matter.
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (itemIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_attestations WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
        [W.tenantId, itemIds],
      );
    if (batchIds.length > 0)
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, batchIds],
      );
  }, true);
  if (enrolledUsers.length > 0)
    await W.owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
});

// =========================================================================
// 1 to 3: the finding, the old doors, the issuer
// =========================================================================

describe("911 P1-1: legend_app can no longer name an actor or a session", () => {
  it("[911-grant-forged-sessions-refused] the scenario of the finding: two real finance users with live, fresh MFA sessions, a failed item with a valid proof; as legend_app, correction propose and approve, then return propose and confirm, each with a made-up 64-hex grant, are refused (PAYOUT-70) and nothing changes", async () => {
    // --- correction ---
    const failed = await failedWorld();
    const key = await boundUpload(failed);
    const forged = hex();

    let before = await trailOf(failed.batchId);
    expectGrantRefused(
      await appCall(PROPOSE, [
        failed.batchId,
        [failed.itemId],
        key,
        NOTE,
        forged,
      ]),
      "correction propose",
    );
    expect(await trailOf(failed.batchId)).toEqual(before);

    // An honest step one, so a real operation exists for the forged step two.
    const { operation } = await proposeCorrection(one, failed, key);
    // Premise: with an honest grant of the second person the step is accepted
    // (rolled back), so the forged refusal below can only come from the grant.
    const honest = await appCall(
      APPROVE,
      [
        operation,
        key,
        await two.grants.issue(stepTwoBinding(failed, key, operation)),
      ],
      { commit: false },
    );
    expect(honest.code, `premise: honest approve, ${honest.message}`).toBe(
      undefined,
    );

    before = await trailOf(failed.batchId);
    expectGrantRefused(
      await appCall(APPROVE, [operation, key, forged]),
      "correction approve",
    );
    expect(await trailOf(failed.batchId)).toEqual(before);
    expect(await itemStatus(failed.itemId)).toBe("failed");

    // --- return ---
    const paid = await succeededWorld();
    const returnKey = await boundUpload(paid, "bukti", "return");
    before = await trailOf(paid.batchId);
    expectGrantRefused(
      await appCall(RETURN_PROPOSE, [
        paid.batchId,
        [paid.itemId],
        returnKey,
        NOTE,
        forged,
      ]),
      "return propose",
    );
    expect(await trailOf(paid.batchId)).toEqual(before);

    const returnGrant = await one.grants.issue(
      proposeBinding(paid, returnKey, "return"),
    );
    const claimed = await appCall(RETURN_PROPOSE, [
      paid.batchId,
      [paid.itemId],
      returnKey,
      NOTE,
      returnGrant,
    ]);
    expect(
      claimed.code,
      `premise: honest return step one, ${claimed.message}`,
    ).toBe(undefined);
    const claim = claimed.rows[0]!.id as string;
    before = await trailOf(paid.batchId);
    expectGrantRefused(
      await appCall(RETURN_CONFIRM, [claim, returnKey, forged]),
      "return confirm",
    );
    expect(await trailOf(paid.batchId)).toEqual(before);
  });

  it("[911-old-signatures-gone] the nine old signatures with (actor, session) text arguments no longer exist, and the new grant-taking ones do", async () => {
    const OLD = [
      "app.payout_correction_propose(uuid, uuid[], character varying, text, text, text)",
      "app.payout_correction_approve(uuid, character varying, text, text)",
      "app.payout_overpaid_propose(uuid, uuid[], character varying, text, text, text)",
      "app.payout_overpaid_record(uuid, character varying, uuid, text, text)",
      "app.payout_return_propose(uuid, uuid[], character varying, text, text, text)",
      "app.payout_return_confirm(uuid, character varying, text, text)",
      "app.payout_proof_closure_propose(character varying, text, text, text)",
      "app.payout_proof_closure_approve(uuid, text, text)",
      "app.payout_posting_record_source(uuid, uuid, uuid, text, text)",
      "app.payout_attest(uuid, text, uuid, text, uuid, uuid[], character varying, uuid, text, text, jsonb)",
    ];
    const NEW = [
      "app.payout_correction_propose(uuid, uuid[], character varying, text, text)",
      "app.payout_correction_approve(uuid, character varying, text)",
      "app.payout_overpaid_propose(uuid, uuid[], character varying, text, text)",
      "app.payout_overpaid_record(uuid, character varying, uuid, text)",
      "app.payout_return_propose(uuid, uuid[], character varying, text, text)",
      "app.payout_return_confirm(uuid, character varying, text)",
      "app.payout_proof_closure_propose(character varying, text, text)",
      "app.payout_proof_closure_approve(uuid, text)",
      "app.payout_posting_record_source(uuid, uuid, uuid, text)",
      "app.payout_grant_issue(text, text, uuid, uuid[], character varying, uuid, uuid, character varying, text, text, text)",
      "app.payout_grant_consume(uuid, text, text, text, uuid, uuid[], character varying, uuid, uuid, character varying)",
    ];
    const present = async (signatures: string[]) =>
      Object.fromEntries(
        await Promise.all(
          signatures.map(async (s) => [
            s,
            (
              await W.rowsOf(
                `SELECT to_regprocedure($1) IS NOT NULL AS found`,
                [s],
              )
            )[0]!.found as boolean,
          ]),
        ),
      );
    expect(await present(OLD)).toEqual(
      Object.fromEntries(OLD.map((s) => [s, false])),
    );
    expect(await present(NEW)).toEqual(
      Object.fromEntries(NEW.map((s) => [s, true])),
    );
  });

  it("[911-app-cannot-issue] legend_app cannot run app.payout_grant_issue (42501) and no grant row appears; it cannot become the grantor role either", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    // The two failure resolutions of failedWorld spend grants of their own on
    // this batch: only this call's effect is compared.
    const grantsBefore = await grantsOfBatch(w.batchId);
    const refused = await appCall(
      `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text)`,
      [
        "correction",
        "propose",
        w.batchId,
        [w.itemId],
        key,
        null,
        null,
        null,
        one.userId,
        one.sessionId,
        "mfa_challenge",
      ],
    );
    expect(refused.code, refused.message).toBe(PRIVILEGE);
    expect(await grantsOfBatch(w.batchId)).toBe(grantsBefore);

    // SET ROLE is checked against the SESSION user: make it legend_app first.
    const client = await W.owner.connect();
    let code: string | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL SESSION AUTHORIZATION legend_app");
      try {
        await client.query(`SET LOCAL ROLE legend_payout_grantor`);
      } catch (error) {
        code = (error as { code?: string }).code ?? "unknown";
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(code, "legend_app must not become the grantor role").toBe(PRIVILEGE);
  });
});

// =========================================================================
// 4: the grant table
// =========================================================================

describe("911 P1-1: the app role holds no secret", () => {
  it("[911-app-cannot-read-or-write-grants] legend_app cannot select secret_sha256 or assertion, cannot insert, update or delete grants, cannot call consume or attest (all 42501); it can still select the non-secret columns", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const secret = await one.grants.issue(proposeBinding(w, key));
    const T = [W.tenantId];

    const refused: [string, string, unknown[]][] = [
      [
        "select secret_sha256",
        `SELECT secret_sha256 FROM payroll_payout_grants WHERE tenant_id = $1`,
        T,
      ],
      [
        "select assertion",
        `SELECT assertion FROM payroll_payout_grants WHERE tenant_id = $1`,
        T,
      ],
      [
        "select *",
        `SELECT * FROM payroll_payout_grants WHERE tenant_id = $1`,
        T,
      ],
      [
        "probe by secret_sha256",
        `SELECT id FROM payroll_payout_grants WHERE secret_sha256 = $1`,
        [sha(secret)],
      ],
      [
        "insert",
        `INSERT INTO payroll_payout_grants (id) VALUES (gen_random_uuid())`,
        [],
      ],
      [
        "update",
        `UPDATE payroll_payout_grants SET consumed_at = now(), consumed_txid = 1 WHERE tenant_id = $1`,
        T,
      ],
      ["delete", `DELETE FROM payroll_payout_grants WHERE tenant_id = $1`, T],
      [
        "payout_grant_consume",
        `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, 'correction', 'propose', $3::uuid, $4::uuid[], $5::varchar, NULL::uuid, NULL::uuid, NULL::varchar)`,
        [W.tenantId, secret, w.batchId, [w.itemId], key],
      ],
      [
        "payout_attest",
        `SELECT app.payout_attest($1::uuid, 'correction', $2::uuid, 'propose', $3::uuid, $4::uuid[], $5::varchar, NULL::uuid, $6::uuid, '{}'::jsonb)`,
        [W.tenantId, randomUUID(), w.batchId, [w.itemId], key, randomUUID()],
      ],
    ];
    const outcome: Record<string, string | undefined> = {};
    for (const [name, sql, params] of refused)
      outcome[name] = (await appCall(sql, params, { commit: false })).code;
    expect(outcome).toEqual(
      Object.fromEntries(refused.map(([name]) => [name, PRIVILEGE])),
    );

    // Recon still reads the non-secret columns.
    const read = await appCall(
      `SELECT id, actor, consumed_at FROM payroll_payout_grants
        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction' AND step = 'propose'`,
      [W.tenantId, w.batchId],
      { commit: false },
    );
    expect(read.code, read.message).toBe(undefined);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.actor).toBe(one.userId);
    expect(read.rows[0]!.consumed_at).toBeNull();
    expect((await grantRow(secret))!.consumed_at, "still unspent").toBeNull();
  });
});

// =========================================================================
// 5 to 9: the grant is one-time, short, bound and atomic
// =========================================================================

describe("911 P1-1: a grant is spent once, in time, on exactly what it was issued for", () => {
  it("[911-grant-replay-refused] a grant spent by a propose cannot be spent again: the second call gives PAYOUT-70", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const { grant } = await proposeCorrection(one, w, key);
    const spent = await grantRow(grant);
    expect(
      spent!.consumed_at,
      "premise: the first call spent it",
    ).not.toBeNull();

    const before = await trailOf(w.batchId);
    expectGrantRefused(
      await appCall(PROPOSE, [w.batchId, [w.itemId], key, NOTE, grant]),
      "replay",
    );
    expect(await trailOf(w.batchId)).toEqual(before);
  });

  it("[911-grant-expired-refused] a grant past expires_at gives PAYOUT-70 and stays unconsumed", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const grant = await one.grants.issue(proposeBinding(w, key));
    // Fixture only: the superuser moves the validity window into the past
    // (replica mode: the update guard of the table is for the payout role).
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
    const before = await trailOf(w.batchId);
    expectGrantRefused(
      await appCall(PROPOSE, [w.batchId, [w.itemId], key, NOTE, grant]),
      "expired",
    );
    expect((await grantRow(grant))!.consumed_at).toBeNull();
    expect(await trailOf(w.batchId)).toEqual(before);
  });

  it("[911-grant-binding-matrix] one valid grant each, spent with another kind, step, batch, item set, evidence key, ref, target, detail or tenant in force: every case gives PAYOUT-70, the grant stays unconsumed, nothing is written; the unchanged call then works", async () => {
    const w = await failedWorld([BUDI, SITI]);
    const [itemA, itemB] = w.itemIds as [string, string];
    const other = await failedWorld();
    const k1 = await boundUpload(w, "k1", "correction", [itemA]);
    const k2 = await recordUpload(w.batchId, "k2");
    const k3 = await recordUpload(other.batchId, "k3");
    const base = { ...proposeBinding(w, k1), itemIds: [itemA] };

    type Variant = {
      name: string;
      /** What the grant is issued for (default: the base binding). */
      issued?: Partial<PayoutGrantBinding>;
      /** What the call spends it on. */
      call?: { sql?: string; args?: unknown[]; tenant?: string };
    };
    const args = (over: unknown[] = []) => {
      const a: unknown[] = [w.batchId, [itemA], k1, NOTE];
      over.forEach((v, i) => {
        if (v !== undefined) a[i] = v;
      });
      return a;
    };
    const variants: Variant[] = [
      { name: "another kind", issued: { kind: "overpaid" } },
      { name: "another step", issued: { step: "approve" } },
      {
        name: "another batch (with its own item and proof)",
        call: { args: [other.batchId, [other.itemId], k3, NOTE] },
      },
      { name: "another item set", call: { args: args([undefined, [itemB]]) } },
      {
        name: "another evidence key",
        call: { args: args([undefined, undefined, k2]) },
      },
      { name: "another ref", issued: { refId: randomUUID() } },
      { name: "another target", issued: { targetId: randomUUID() } },
      { name: "another tenant in force", call: { tenant: randomUUID() } },
    ];

    for (const v of variants) {
      const grant = await one.grants.issue({ ...base, ...v.issued });
      const before = await trailOf(w.batchId);
      const outcome = await appCall(
        v.call?.sql ?? PROPOSE,
        [...(v.call?.args ?? args()), grant],
        { tenant: v.call?.tenant },
      );
      expectGrantRefused(outcome, v.name);
      expect(
        (await grantRow(grant))!.consumed_at,
        `${v.name}: the grant stays unconsumed`,
      ).toBeNull();
      expect(await trailOf(w.batchId), `${v.name}: nothing written`).toEqual(
        before,
      );
    }

    // Detail: a correction grant carries none (the issuer refuses one, PAYOUT-72,
    // and writes no row), so the detail component is proven on a resolve grant
    // (outcome `failed`) spent by the payout role on the other outcome.
    const detailIssue = await one.grants
      .issue({
        ...base,
        kind: "correction",
        detail: "succeeded",
      })
      .then(
        () => undefined,
        (error: Error) => error.message,
      );
    expect(detailIssue, "a correction grant takes no detail").toMatch(
      /PAYOUT-72:/,
    );
    const resolveGrant = await one.grants.issue({
      ...base,
      kind: "resolve",
      detail: "failed",
    } as PayoutGrantBinding);
    const consume = async (detail: string) => {
      const client = await W.owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_payout");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          W.tenantId,
        ]);
        try {
          await client.query(
            `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, 'resolve', 'propose', $3::uuid, $4::uuid[], $5::varchar, NULL::uuid, NULL::uuid, $6::varchar)`,
            [W.tenantId, resolveGrant, w.batchId, [itemA], k1, detail],
          );
          return {
            code: undefined as string | undefined,
            message: "",
            rows: [] as Row[],
          };
        } catch (error) {
          const e = error as { code?: string; message?: string };
          return { code: e.code, message: e.message ?? "", rows: [] as Row[] };
        }
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };
    expectGrantRefused(await consume("not_sent"), "another detail");
    expect(
      (await grantRow(resolveGrant))!.consumed_at,
      "another detail: the grant stays unconsumed",
    ).toBeNull();
    const sameDetail = await consume("failed");
    expect(sameDetail.code, `control: ${sameDetail.message}`).toBe(undefined);

    // Control: the same call with a grant for exactly this binding is accepted.
    const exact = await one.grants.issue(base);
    const ok = await appCall(PROPOSE, [...args(), exact]);
    expect(ok.code, `control: ${ok.message}`).toBe(undefined);
    expect((await grantRow(exact))!.consumed_at).not.toBeNull();
  });

  it("[911-grant-same-actor-refused] the proposer with a valid approve grant of their own: approve gives PAYOUT-64, nothing moves, and the grant stays unconsumed (rolled back)", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const { operation } = await proposeCorrection(one, w, key);
    const grant = await one.grants.issue(stepTwoBinding(w, key, operation));

    const before = await trailOf(w.batchId);
    const refused = await appCall(APPROVE, [operation, key, grant]);
    expect(refused.code, "refused").toBeDefined();
    expect(refused.message).toMatch(/PAYOUT-64:/);
    expect(await trailOf(w.batchId)).toEqual(before);
    expect(await itemStatus(w.itemId)).toBe("failed");
    expect(
      (await grantRow(grant))!.consumed_at,
      "the refused step rolled the spend back",
    ).toBeNull();
  });

  it("[911-grant-concurrent-consume] three connections spend one grant at the same moment: exactly one succeeds, the others get PAYOUT-70", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const grant = await one.grants.issue(proposeBinding(w, key));
    // The two failure resolutions of failedWorld left attestations of their own.
    const attestationsBefore = (await trailOf(w.batchId)).attestations;

    const results = await race(3, PROPOSE, [
      w.batchId,
      [w.itemId],
      key,
      NOTE,
      grant,
    ]);

    const ok = results.filter((r) => r.code === undefined);
    const refused = results.filter((r) => r.code !== undefined);
    expect(ok, JSON.stringify(results)).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.code, r.message).toBe(PRIVILEGE);
      expect(r.message).toMatch(/PAYOUT-70:/);
    }
    expect((await grantRow(grant))!.consumed_at).not.toBeNull();
    expect((await trailOf(w.batchId)).attestations).toBe(
      attestationsBefore + 1,
    );
  });
});

// =========================================================================
// 10: the issuer checks who it issues for
// =========================================================================

describe("911 P1-1: the grantor checks the actor before it issues", () => {
  it("[911-issue-checks-actor] a revoked session, MFA older than 15 minutes, no payroll.disburse.approve, or a banned user: issue is refused (PAYOUT-40, 41, 42, 39) and no grant row is created", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const binding = proposeBinding(w, key);
    const grantsOf = (actor: string) =>
      count(
        `SELECT count(*)::int AS n FROM payroll_payout_grants WHERE tenant_id = $1 AND actor = $2`,
        [W.tenantId, actor],
      );
    const refusedWith = async (who: Finance, code: string) => {
      const error = (await who.grants.issue(binding).then(
        () => null,
        (e: unknown) => e,
      )) as { message?: string } | null;
      expect(error, `${code}: issue must be refused`).not.toBeNull();
      expect(error!.message).toMatch(new RegExp(`${code}:`));
      expect(await grantsOf(who.userId), `${code}: no grant row`).toBe(0);
    };

    // Control: an untouched actor gets a grant.
    const fine = await sqlFinance("Issue control");
    await expect(fine.grants.issue(binding)).resolves.toMatch(/^[0-9a-f]{64}$/);

    const revoked = await sqlFinance("Issue revoked");
    await W.owner.query(`UPDATE session SET revoked_at = now() WHERE id = $1`, [
      revoked.sessionId,
    ]);
    await refusedWith(revoked, "PAYOUT-40");

    const staleMfa = await sqlFinance("Issue stale mfa");
    refreshSessions.splice(refreshSessions.indexOf(staleMfa.sessionId), 1);
    await W.owner.query(
      `UPDATE session SET mfa_verified_at = now() - interval '16 minutes' WHERE id = $1`,
      [staleMfa.sessionId],
    );
    await refusedWith(staleMfa, "PAYOUT-41");

    const noPermission = await sqlFinance("Issue no permission", false);
    await refusedWith(noPermission, "PAYOUT-42");

    const banned = await sqlFinance("Issue banned");
    await W.owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      banned.userId,
    ]);
    try {
      await refusedWith(banned, "PAYOUT-39");
    } finally {
      await W.owner.query(`UPDATE "user" SET banned = false WHERE id = $1`, [
        banned.userId,
      ]);
    }
  });
});

// =========================================================================
// 11: the happy path through the real route and the real issuer
// =========================================================================

describe("911 P1-1: two people correct an item with real grants", () => {
  it("[911-grant-happy-path] over HTTP (real issuer, READ COMMITTED): both attestations carry a grant_id; each grant is consumed with consumed_txid = the attestation's txid; the item is corrected and its journal posted once", async () => {
    const w = await failedWorld();
    const key = uploadEvidence(w.batchId, `grant-${randomUUID()}.pdf`);
    const first = await webFinance("Happy one");
    const second = await webFinance("Happy two");
    const call = (who: { client: Client }) =>
      who.client
        .post(`${BATCHES}/${w.batchId}/correct-failed`)
        .set(originHeader)
        .send({
          itemIds: [w.itemId],
          evidenceKey: key,
          note: NOTE,
          password: PASSWORD,
        });

    const one1 = await call(first);
    expect([200, 201], JSON.stringify(one1.body)).toContain(one1.status);
    const two2 = await call(second);
    expect([200, 201], JSON.stringify(two2.body)).toContain(two2.status);

    expect(await itemStatus(w.itemId)).toBe("succeeded");
    const rows = await W.rowsOf(
      `SELECT a.step, a.grant_id, a.txid::text AS attestation_txid,
              g.kind, g.step AS grant_step, g.actor, g.consumed_at,
              g.consumed_txid::text AS grant_txid
         FROM payroll_payout_attestations a
         LEFT JOIN payroll_payout_grants g
           ON g.tenant_id = a.tenant_id AND g.id = a.grant_id
        WHERE a.tenant_id = $1 AND $2::uuid = ANY(a.item_ids)
          AND a.kind = 'correction'
        ORDER BY a.attested_at, a.step`,
      [W.tenantId, w.itemId],
    );
    expect(rows.map((r) => r.step).sort()).toEqual(["approve", "propose"]);
    for (const row of rows) {
      expect(row.grant_id, `${row.step}: attestation has a grant_id`).not.toBe(
        null,
      );
      expect(row.kind).toBe("correction");
      expect(row.grant_step).toBe(row.step);
      expect(row.consumed_at, `${row.step}: grant spent`).not.toBeNull();
      expect(row.grant_txid, `${row.step}: spent in the attesting txid`).toBe(
        row.attestation_txid,
      );
    }
    expect(new Set(rows.map((r) => r.grant_id)).size, "two grants").toBe(2);
    expect(new Set(rows.map((r) => r.actor)).size, "two people").toBe(2);

    const settles = (await W.postingsOf(w.batchId)).filter(
      (p) => p.kind === "settle",
    );
    expect(settles, "one settle posting").toHaveLength(1);
    expect(await W.countJournals(settles[0]!.journal_key as string)).toBe(1);
  });
});

// =========================================================================
// 12 and 13: the structural backstops
// =========================================================================

describe("911 P1-1: the database refuses what a later function could forget", () => {
  it("[911-attestation-needs-grant] as legend_payout, an attestation after the cutover with grant_id NULL is refused by the grant check (23514)", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const { operation } = await proposeCorrection(one, w, key);
    const columns = (
      await W.rowsOf(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payroll_payout_attestations'
            AND is_generated = 'NEVER' ORDER BY ordinal_position`,
      )
    ).map((r) => r.column_name as string);
    expect(columns, "premise: the grant_id column exists").toContain(
      "grant_id",
    );
    const override: Record<string, string> = {
      id: "gen_random_uuid()",
      operation_id: "gen_random_uuid()",
      grant_id: "NULL",
      attested_at: "now()",
    };

    const client = await W.owner.connect();
    let failure: { code?: string; constraint?: string; message?: string } = {};
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_payout");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        W.tenantId,
      ]);
      try {
        await client.query(
          `INSERT INTO payroll_payout_attestations (${columns.map((c) => `"${c}"`).join(", ")})
           SELECT ${columns.map((c) => override[c] ?? `"${c}"`).join(", ")}
             FROM payroll_payout_attestations
            WHERE tenant_id = $1 AND operation_id = $2 AND step = 'propose'`,
          [W.tenantId, operation],
        );
        failure = {};
      } catch (error) {
        failure = error as typeof failure;
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(failure.code, failure.message).toBe(GUARD);
    expect(failure.constraint).toBe("payroll_payout_attestations_grant_check");
  });

  it("[911-step-two-needs-granted-step-one] a step-one attestation from before the boundary (no grant) followed by a granted approve gives PAYOUT-71 and nothing moves", async () => {
    const w = await failedWorld();
    const key = await boundUpload(w);
    const { operation } = await proposeCorrection(one, w, key);
    // Fixture: make step one look like it was attested before the grant
    // boundary (owner, replica: the CHECK still holds, the old row has no grant).
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_attestations
              SET grant_id = NULL, attested_at = app.payout_grants_since() - interval '1 day'
            WHERE tenant_id = $1 AND operation_id = $2 AND step = 'propose'`,
          [W.tenantId, operation],
        ),
      true,
    );
    const grant = await two.grants.issue(stepTwoBinding(w, key, operation));

    const before = await trailOf(w.batchId);
    const refused = await appCall(APPROVE, [operation, key, grant]);
    expect(refused.code, refused.message).toBe(GUARD);
    expect(refused.message).toMatch(/PAYOUT-71:/);
    expect(await trailOf(w.batchId)).toEqual(before);
    expect(await itemStatus(w.itemId)).toBe("failed");
    expect((await grantRow(grant))!.consumed_at).toBeNull();
  });
});

// =========================================================================
// 14: the issuer exists only behind the step-up
// =========================================================================

describe("911 P1-1: a grant needs the step-up of the same request", () => {
  it("[911-issuer-requires-step-up] a stale challenge and no password gives 401 REAUTH_REQUIRED and no grant; an issuer taken from a request without a step-up record refuses too; with the password the route issues exactly one grant and works", async () => {
    const w = await failedWorld();
    const key = uploadEvidence(w.batchId, `grant-${randomUUID()}.pdf`);
    const person = await challengedFinance("Stale challenge");
    const moved = await W.owner.query(
      `UPDATE "session" SET mfa_challenge_verified_at = now() - interval '16 minutes'
        WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
      [person.userId],
    );
    expect(moved.rowCount, "premise: the challenge stamped the session").toBe(
      1,
    );
    const send = (password?: string) =>
      person.client
        .post(`${BATCHES}/${w.batchId}/correct-failed`)
        .set(originHeader)
        .send({
          itemIds: [w.itemId],
          evidenceKey: key,
          note: NOTE,
          ...(password === undefined ? {} : { password }),
        });

    const grantsBefore = await grantsOfTenant();
    const before = await trailOf(w.batchId);
    const stale = await send();
    expect(stale.status, JSON.stringify(stale.body)).toBe(401);
    expect(stale.body.error?.code).toBe("REAUTH_REQUIRED");
    expect(await grantsOfTenant(), "no grant issued").toBe(grantsBefore);
    expect(await trailOf(w.batchId)).toEqual(before);

    // The issuer of a request that never passed the step-up refuses by itself.
    const fakeRequest = { headers: {} } as unknown as Request;
    const error = await W.httpFailure(
      Promise.resolve().then(() =>
        payoutGrantIssuerOf(fakeRequest).issue(proposeBinding(w, key)),
      ),
    );
    expect(error, "the issuer must refuse").toBeInstanceOf(HttpError);
    expect(error!.status).toBe(401);
    expect(await grantsOfTenant(), "still no grant").toBe(grantsBefore);

    // Control: with the password the route passes the step-up, issues one
    // grant for step one and records the proposal.
    const ok = await send(PASSWORD);
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
    expect(await grantsOfTenant(), "exactly one grant issued").toBe(
      grantsBefore + 1,
    );
    expect(
      await count(
        `SELECT count(*)::int AS n FROM payroll_payout_grants
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction'
            AND step = 'propose' AND consumed_at IS NOT NULL`,
        [W.tenantId, w.batchId],
      ),
    ).toBe(1);
  });
});

describe("911: database refusals of the grant steps answer 409, not 500", () => {
  const dbError = (code: string, message: string) =>
    Object.assign(new Error(message), { code });

  it("[911-grant-error-mapping] PAYOUT-70 (42501) gives 409 PAYOUT_STEP_GRANT_INVALID; PAYOUT-69 and PAYOUT-77 (P0002) give 409; a wrapped error maps too; other errors stay unmapped", () => {
    const invalid = payoutGuardViolation(
      dbError("42501", "PAYOUT-70: no valid grant"),
    );
    expect(invalid).toBeInstanceOf(HttpError);
    expect(invalid?.status).toBe(409);
    expect(invalid?.code).toBe("PAYOUT_STEP_GRANT_INVALID");

    for (const text of [
      "PAYOUT-69: payout batch not found",
      "PAYOUT-77: payout batch not found",
    ]) {
      const gone = payoutGuardViolation(dbError("P0002", text));
      expect(gone?.status, text).toBe(409);
    }

    const wrapped = payoutGuardViolation(
      Object.assign(new Error("Failed query"), {
        cause: dbError("42501", "PAYOUT-70: no valid grant"),
      }),
    );
    expect(wrapped?.code).toBe("PAYOUT_STEP_GRANT_INVALID");

    // A plain permission error is not a grant refusal.
    expect(
      payoutGuardViolation(dbError("42501", "permission denied for table x")),
    ).toBeNull();
    expect(payoutGuardViolation(new Error("boom"))).toBeNull();
  });
});
