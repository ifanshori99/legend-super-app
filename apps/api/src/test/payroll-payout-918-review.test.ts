// Payout 918 review follow-ups (bead legend-l2zru, architect review of 0660/0661):
// P1 a retry batch that shares a payslip with a disputed batch is frozen too (no
// double payment); P2a a claim reopens after an unfreeze and is withdrawn only
// from the session that filed it; P2b two steps on different items of one batch
// do not deadlock; P3 postings of a frozen batch do not change.
//
// SQL level on purpose: the people hold real users and the fixture sessions
// (fresh MFA), the trusted functions are called as legend_app with real commits,
// as in payroll-payout-918-disown.test.ts (which this file does not touch).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  actorOf,
  APP,
  APP2,
  bank,
  BUDI,
  installPayoutWorld,
  SITI,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("918rev");
const NET = 1_000_000;
const REASON =
  "Bukan saya yang menyetujui langkah ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const personIds: string[] = [];
const batchIds: string[] = [];
const extraSessions: string[] = [];

type Person = { userId: string };

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
    [W.tenantId, `Template ${key} 918rev`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A real user with the approve permission and, optionally, a tenant-wide template role. */
async function makePerson(
  label: string,
  template?: "owner" | "finance",
): Promise<Person> {
  const { userId } = await W.signedInClient(`Review918 ${label}`);
  personIds.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  if (template) {
    const roleId = await templateRoleId(template);
    await W.owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId],
    );
  }
  return { userId };
}

let a: Person; // finance: resolves first, the disputant
let b: Person; // finance: resolves second
let outsideFinance: Person; // finance, took no part in any batch

// ---- SQL helpers -----------------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

async function runAs(
  role: "legend_app" | "legend_payout",
  sql: string,
  params: unknown[] = [],
  commit = false,
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      const result = await client.query(sql, params);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
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
const appCall = (sql: string, params: unknown[] = []) =>
  runAs("legend_app", sql, params, true);
const probe = (sql: string, params: unknown[] = []) =>
  runAs("legend_app", sql, params, false);

/** Grant of the grantor stand-in for `userId` in `sessionId`. */
async function issueGrant(input: {
  kind: "disown" | "unfreeze";
  step: "record" | "approve";
  userId: string;
  sessionId: string;
  batchId: string;
  refId?: string | null;
  detail: string;
  method: "password" | "mfa_challenge";
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
        `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, '{}'::uuid[], NULL::varchar, $4::uuid, NULL::uuid, $5::varchar, $6::text, $7::text, $8::text) AS grant`,
        [
          input.kind,
          input.step,
          input.batchId,
          input.refId ?? null,
          input.detail,
          input.userId,
          input.sessionId,
          input.method,
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

const sessionOf = (userId: string) => actorOf(userId).sessionId!;

async function disown(
  userId: string,
  batchId: string,
  logId: string,
): Promise<string> {
  const issued = await issueGrant({
    kind: "disown",
    step: "record",
    userId,
    sessionId: sessionOf(userId),
    batchId,
    refId: logId,
    detail: sha256(REASON),
    method: "password",
  });
  expect(issued.grant, `premise: disown grant, ${issued.message}`).toBeTruthy();
  const outcome = await appCall(
    `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`,
    [logId, issued.grant, REASON],
  );
  expect(outcome.code, `premise: disown, ${outcome.message}`).toBe(undefined);
  return outcome.rows[0]!.id as string;
}

async function unfreeze(
  userId: string,
  sessionId: string,
  batchId: string,
): Promise<{ grant: boolean; outcome?: Outcome; message: string }> {
  const issued = await issueGrant({
    kind: "unfreeze",
    step: "approve",
    userId,
    sessionId,
    batchId,
    detail: sha256(UNFREEZE_REASON),
    method: "mfa_challenge",
  });
  if (!issued.grant)
    return { grant: false, message: issued.message, outcome: undefined };
  return {
    grant: true,
    message: "",
    outcome: await appCall(
      `SELECT app.payout_batch_unfreeze($1::uuid, $2::text, $3::text) AS released`,
      [batchId, issued.grant, UNFREEZE_REASON],
    ),
  };
}

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );
const disputeCount = (logId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} WHERE tenant_id = $1 AND log_id = $2`,
    [W.tenantId, logId],
  );
const logOf = async (batchId: string, userId: string) =>
  (
    await W.rowsOf(
      `SELECT id::text AS id FROM payroll_payout_approval_log
        WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3 ORDER BY logged_at LIMIT 1`,
      [W.tenantId, batchId, userId],
    )
  )[0]!.id as string;

function messageChain(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== "object" || error === null) return "";
  const e = error as { message?: unknown; cause?: unknown };
  return `${typeof e.message === "string" ? e.message : ""} ${messageChain(e.cause, depth + 1)}`;
}

type World = { runId: string; batchId: string; itemIds: string[] };

/** One exported batch whose items two people (a, b) closed `failed`. */
async function failedWorld(
  slips = [bank(BUDI, NET)],
  resolvers: [Person, Person] = [a, b],
): Promise<World> {
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  batchIds.push(batchId);
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await W.resolve(batchId, itemIds, "failed", resolvers[0].userId);
  await W.resolve(batchId, itemIds, "failed", resolvers[1].userId);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is failed").toBe("failed");
  return { runId, batchId, itemIds };
}

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await makePerson("A", "finance");
  b = await makePerson("B", "finance");
  outsideFinance = await makePerson("Outside finance", "finance");
});

afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
    if (extraSessions.length > 0)
      await c.query(`DELETE FROM session WHERE id = ANY($1::text[])`, [
        extraSessions,
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
});

// =========================================================================
// P1: a retry batch made BEFORE the disown shares payslips with the disputed one
// =========================================================================

describe("918 review P1: a retry batch of a disputed payslip is frozen too", () => {
  it("[918r-sibling-retry] batch C (draft, same payslip, made before the disown) is refused with PAYOUT-79 while B is disputed, and works again after the unfreeze", async () => {
    const w = await failedWorld();
    // C: the retry of the same payslip, a draft made before anybody disowns B.
    await W.inTx((tx) =>
      createDisbursementBatch(tx, actorOf(APP), {
        payrollRunId: w.runId,
        channel: "manual_bank",
      } as never),
    );
    const [c] = await W.rowsOf(
      `SELECT id FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND id <> $3`,
      [W.tenantId, w.runId, w.batchId],
    );
    const cId = c!.id as string;
    batchIds.push(cId);
    expect(
      await openDisputes(cId),
      "premise: C has no dispute of its own",
    ).toBe(0);

    await disown(a.userId, w.batchId, await logOf(w.batchId, a.userId));
    expect(await openDisputes(cId), "C has no dispute row of its own").toBe(0);

    const touch = () =>
      probe(
        `UPDATE payroll_disbursement_batches SET content_hash = $3
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, cId, randomBytes(32).toString("hex")],
      );
    const refusedSql = await touch();
    expect(refusedSql.code, "C: the batch row is frozen").toBeDefined();
    expect(refusedSql.message).toMatch(/PAYOUT-79:/);
    const gate = await probe(
      `SELECT app.payout_batch_assert_open($1::uuid, $2::uuid)`,
      [W.tenantId, cId],
    );
    expect(gate.message, "the locked helper says it too").toMatch(/PAYOUT-79:/);
    const submit = await W.inTx((tx) =>
      submitDisbursementBatch(tx, actorOf(APP), cId),
    ).then(
      () => "",
      (error: unknown) => messageChain(error),
    );
    expect(submit, "C cannot be submitted").toMatch(/PAYOUT-79:/);

    const released = await unfreeze(
      outsideFinance.userId,
      sessionOf(outsideFinance.userId),
      w.batchId,
    );
    expect(released.outcome?.code, released.message).toBe(undefined);
    expect((await touch()).message, "C is free once B is").not.toMatch(
      /PAYOUT-79:/,
    );
  });
});

// =========================================================================
// P2a: reopen after an unfreeze; withdraw only from the filing session
// =========================================================================

describe("918 review P2a: reopening and withdrawing a claim", () => {
  it("[918r-reopen] a disown after an unfreeze writes a NEW dispute; a repeat while it is open returns the same id", async () => {
    const w = await failedWorld();
    const logId = await logOf(w.batchId, a.userId);
    const first = await disown(a.userId, w.batchId, logId);
    expect(await disown(a.userId, w.batchId, logId), "repeat while open").toBe(
      first,
    );
    expect(await disputeCount(logId)).toBe(1);

    const lifted = await unfreeze(
      outsideFinance.userId,
      sessionOf(outsideFinance.userId),
      w.batchId,
    );
    expect(lifted.outcome?.code, lifted.message).toBe(undefined);
    expect(await openDisputes(w.batchId)).toBe(0);

    const second = await disown(a.userId, w.batchId, logId);
    expect(second, "a new dispute row").not.toBe(first);
    expect(await disputeCount(logId)).toBe(2);
    expect(await openDisputes(w.batchId), "frozen again").toBe(1);
  });

  it("[918r-withdraw-own-session] the disputant withdraws the claim only from the session that filed it", async () => {
    const w = await failedWorld();
    await disown(a.userId, w.batchId, await logOf(w.batchId, a.userId));

    // The same login on another session (a stolen cookie).
    const other = `review-918-${randomUUID()}`;
    extraSessions.push(other);
    await W.owner.query(
      `INSERT INTO session (id, expires_at, token, user_id, tenant_id, mfa_verified_at)
       VALUES ($1, now() + interval '1 day', $2, $3, $4, now())`,
      [other, randomBytes(16).toString("hex"), a.userId, W.tenantId],
    );
    const stolen = await unfreeze(a.userId, other, w.batchId);
    if (stolen.outcome) {
      expect(stolen.outcome.code, "must be refused").toBeDefined();
      expect(stolen.outcome.message).toMatch(/PAYOUT-82:/);
    } else
      expect(stolen.message).toMatch(
        /PAYOUT-8[0-9]:|PAYOUT-39:|PAYOUT-4[0-9]:/,
      );
    expect(await openDisputes(w.batchId), "still frozen").toBe(1);

    const own = await unfreeze(a.userId, sessionOf(a.userId), w.batchId);
    expect(own.outcome?.code, own.message).toBe(undefined);
    expect(Number(own.outcome!.rows[0]!.released)).toBe(1);
    expect(await openDisputes(w.batchId)).toBe(0);
  });
});

// =========================================================================
// P2b: two steps on different items of one batch do not deadlock
// =========================================================================

describe("918 review P2b: lock order", () => {
  it("[918r-two-steps-no-deadlock] two people closing different items of one batch at the same moment both succeed, no deadlock", async () => {
    const slips = [bank(BUDI, NET), bank(SITI, NET)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    batchIds.push(batchId);
    const [first, second] = (await W.itemsOf(batchId)).map(
      (i) => i.id as string,
    );
    const results = await Promise.allSettled([
      W.resolve(batchId, [first!], "failed", a.userId),
      W.resolve(batchId, [second!], "failed", b.userId),
    ]);
    expect(
      results.map((r) =>
        r.status === "rejected" ? messageChain(r.reason) : "ok",
      ),
      "no deadlock, no refusal",
    ).toEqual(["ok", "ok"]);
  });
});

// =========================================================================
// P3: the postings of a frozen batch do not change
// =========================================================================

describe("918 review P3: postings", () => {
  it("[918r-postings-update] an existing GL posting of a frozen batch cannot be updated", async () => {
    const slips = [bank(BUDI, NET)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    batchIds.push(batchId);
    await W.confirm(batchId, W.succeedItems(batchId, await W.itemsOf(batchId)));
    expect(
      (await W.postingsOf(batchId)).length,
      "premise: the batch has a posting",
    ).toBeGreaterThan(0);

    const touch = () =>
      probe(
        `UPDATE payroll_payout_gl_postings SET posted_at = posted_at
          WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, batchId],
      );
    expect(
      (await touch()).message,
      "control: free before the disown",
    ).not.toMatch(/PAYOUT-79:/);
    await disown(APP2, batchId, await logOf(batchId, APP2));
    const frozen = await touch();
    expect(frozen.code, "frozen: refused").toBeDefined();
    expect(frozen.message).toMatch(/PAYOUT-79:/);
  });
});
