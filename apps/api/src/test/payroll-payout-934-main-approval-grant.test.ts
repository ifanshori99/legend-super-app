// Payout 934 (bead legend-xp8mc): the MAIN approval of a payout batch
// (`payroll_disbursement_batches.approved_by`) needs a one-time step-up grant
// and leaves a row in the append-only `payroll_payout_approval_log`, like the
// steps of 911/915 do, so that the receipt notification and "Bukan saya" (918)
// also cover it. Written fail-first from the brief
// (scratchpad brief-xp8mc.md) and the sibling suites 911/915/918, NOT from the
// implementation.
//
// Rule proven (founder: nobody is paid on the word of one person; when in
// doubt, limit the payment): no approval without a grant; a grant is spent
// once; the approval is logged; "not me" on that log row freezes the batch;
// the two-person rule (requester != approver) stays.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The service `approveDisbursementBatch(tx, actor, batchId, input)` takes its
//   grant from `actor.grants.issue(binding)` like the other steps; the test
//   observes the grant through a wrapper of that issuer. The grant kind name
//   is NOT assumed: the test reads it from the binding the service issues.
//   The step is assumed to be `approve`; the grant is bound to the batch.
// - Case 1 has two doors: (a) a raw UPDATE of the batch to `approved` as
//   `legend_app` (no grant at all) is refused with any database error (a
//   trigger, a missing privilege, whichever the implementer picks) and the
//   batch stays pending; (b) the service with an issuer that cannot issue
//   (grantor down) throws and the batch stays pending.
// - Case 2 replays the grant of a real approval through
//   `app.payout_grant_consume` as `legend_payout` (signature as the 918
//   suite): PAYOUT-70, and the grant row stays spent exactly once.
// - Case 3: the log row carries tenant, batch_id, actor = approver, step
//   `approve`, grant_id of the spent grant and the same kind as the grant.
//   attestation_id / operation_id / item_count are not asserted (a main
//   approval has no attestation).
// - Case 4 uses the SQL of 918 (`app.payout_approval_disown`, password grant
//   of the actor, ref = log id, detail = sha256(reason)); the freeze is seen
//   as one open dispute row and a refused trusted step (409) on the batch.
// - Case 5: a refused self-approval (PAYOUT_SELF_APPROVAL) leaves no log row
//   and no spent grant; the second person is logged as the actor.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import type { PayoutGrantBinding } from "../services/payroll-payout-grant.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import {
  APP,
  BUDI,
  REQ,
  actorOf,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("934main");
const LOG = "payroll_payout_approval_log";
const REASON = "Bukan saya yang menyetujui batch ini, akun saya dipakai orang";
const hex = () => randomBytes(32).toString("hex");
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
const sha256Text = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const batchIds: string[] = [];

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** One statement as `role`, real COMMIT unless `commit: false`. First error, if any. */
async function runAs(
  role: "legend_app" | "legend_payout",
  sql: string,
  params: unknown[] = [],
  commit = true,
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

/** Grant of the grantor stand-in with the `password` method (what "not me" uses). */
async function passwordGrant(input: {
  kind: string;
  step: string;
  userId: string;
  batchId: string;
  refId: string;
  detail: string;
}): Promise<string> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_payout_grantor");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      W.tenantId,
    ]);
    const { rows } = await client.query(
      `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text) AS grant`,
      [
        input.kind,
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
    return (rows[0] as { grant: string }).grant;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---- Observations -----------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const logsOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, grant_id::text AS grant_id, kind, step, actor
       FROM ${LOG} WHERE tenant_id = $1 AND batch_id = $2 ORDER BY logged_at, id`,
    [W.tenantId, batchId],
  );
const grantRow = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT id::text AS id, kind, step, actor, consumed_at
         FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    )
  )[0];
const spentGrantsOf = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND consumed_at IS NOT NULL`,
    [W.tenantId, batchId],
  );
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_batch_disputes d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM payroll_payout_batch_unfreezes u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );

// ---- Worlds ---------------------------------------------------------------------------------

/** A manual_bank batch requested by REQ and submitted: it waits for its approver. */
async function pendingBatch() {
  const runId = await W.seedRun([bank(BUDI, 4_000_000)]);
  const batchId = await W.createBatch(runId);
  batchIds.push(batchId);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const batch = await W.batchById(batchId);
  const [source] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  return {
    batchId,
    hash: batch.content_hash as string,
    source: source!.id as string,
  };
}

type Issued = { binding: PayoutGrantBinding; secret: string };

/** `actorOf(userId)` whose issuer remembers every grant it hands out. */
function spyActor(userId: string) {
  const actor = actorOf(userId);
  const issued: Issued[] = [];
  return {
    issued,
    actor: {
      ...actor,
      grants: {
        async issue(binding: PayoutGrantBinding) {
          const secret = await actor.grants.issue(binding);
          issued.push({ binding, secret });
          return secret;
        },
      },
    },
  };
}

const approveAs = (
  actor: ReturnType<typeof actorOf>,
  w: Awaited<ReturnType<typeof pendingBatch>>,
) =>
  W.inTx((tx) =>
    approveDisbursementBatch(tx, actor, w.batchId, {
      contentHash: w.hash,
      sourceBankAccountId: w.source,
    } as never),
  );

async function expectStillPending(batchId: string) {
  const batch = await W.batchById(batchId);
  expect(batch.status, "the batch stays pending").toBe("pending_approval");
  expect(batch.approved_by, "no approver").toBeNull();
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

// Registered after the world's own hook: runs first. Triggers and FKs are off.
afterAll(async () => {
  if (batchIds.length === 0) return;
  await W.asTenant(async (c) => {
    for (const table of [
      "payroll_payout_batch_unfreezes",
      "payroll_payout_batch_disputes",
      LOG,
      "payroll_payout_grants",
    ])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`,
        [W.tenantId, batchIds],
      );
  }, true);
});

describe("934 main approval needs a one-time grant", () => {
  it("[934-no-grant-refused] a raw UPDATE to approved as legend_app is refused, and the service with an issuer that cannot issue throws: the batch stays pending, no log row", async () => {
    const w = await pendingBatch();

    // (a) no grant at all: the approval is not something legend_app can write alone.
    const raw = await runAs(
      "legend_app",
      `UPDATE payroll_disbursement_batches
          SET status = 'approved', approved_by = $3, approved_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, w.batchId, APP],
    );
    expect(
      raw.code,
      "a main approval without a grant must be refused by the database",
    ).toBeDefined();
    await expectStillPending(w.batchId);

    // (b) the grantor is down: no grant, no approval.
    const noGrant = {
      ...actorOf(APP),
      grants: {
        issue: async () => {
          throw new HttpError(
            503,
            "PAYOUT_STEP_GRANT_UNAVAILABLE",
            "Izin langkah tidak tersedia.",
          );
        },
      },
    };
    await expect(approveAs(noGrant, w)).rejects.toBeDefined();
    await expectStillPending(w.batchId);
    expect(await logsOf(w.batchId), "no log row").toHaveLength(0);
    expect(await spentGrantsOf(w.batchId), "no grant spent").toBe(0);
  });

  it("[934-grant-replay-refused] the grant of a real approval is spent once: spending it again is PAYOUT-70", async () => {
    const w = await pendingBatch();
    const { actor, issued } = spyActor(APP);
    await approveAs(actor, w);

    expect(
      issued,
      "approve asks the grantor for exactly one grant, bound to the batch",
    ).toHaveLength(1);
    const { binding, secret } = issued[0]!;
    expect(binding.batchId).toBe(w.batchId);
    expect(binding.step).toBe("approve");
    const spent = await grantRow(secret);
    expect(spent, "the grant row exists").toBeDefined();
    expect(spent!.consumed_at, "and is spent by the approval").not.toBeNull();
    const batch = await W.batchById(w.batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(APP);

    const replay = await runAs(
      "legend_payout",
      `SELECT * FROM app.payout_grant_consume($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::uuid[], $7::varchar, NULL::uuid, NULL::uuid, NULL::varchar)`,
      [
        W.tenantId,
        secret,
        binding.kind,
        binding.step,
        binding.batchId,
        [...binding.itemIds],
        binding.evidenceKey,
      ],
      false,
    );
    expect(replay.code, "the replay is refused").toBeDefined();
    expect(replay.message).toMatch(/PAYOUT-70:/);
    expect(await spentGrantsOf(w.batchId), "still one spent grant").toBe(1);
  });
});

describe("934 main approval is logged", () => {
  it("[934-approval-log-row] the approval writes one append-only log row: the approver, the batch, the step and the spent grant", async () => {
    const w = await pendingBatch();
    const { actor, issued } = spyActor(APP);
    await approveAs(actor, w);

    expect(issued, "premise: approve used a grant").toHaveLength(1);
    const grant = await grantRow(issued[0]!.secret);
    const logs = await logsOf(w.batchId);
    expect(logs, "one log row for the main approval").toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: APP,
      step: "approve",
      grant_id: grant!.id,
      kind: grant!.kind,
    });

    // The log stays append-only for the app role.
    const tamper = await runAs(
      "legend_app",
      `UPDATE ${LOG} SET actor = 'someone-else' WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, w.batchId],
      false,
    );
    expect(tamper.code, "legend_app cannot rewrite the log").toBeDefined();
    expect((await logsOf(w.batchId))[0]!.actor).toBe(APP);
  });
});

describe("934 'Bukan saya' on the main approval", () => {
  it("[934-not-me-freezes-batch] the approver disowns the main approval: one open dispute, and a later trusted step (bank file download) on the batch is refused", async () => {
    const w = await pendingBatch();
    const { actor } = spyActor(APP);
    await approveAs(actor, w);
    const logs = await logsOf(w.batchId);
    expect(logs, "premise: the approval is in the log").toHaveLength(1);
    const logId = logs[0]!.id;
    expect(await openDisputes(w.batchId), "not frozen before").toBe(0);

    const grant = await passwordGrant({
      kind: "disown",
      step: "record",
      userId: APP,
      batchId: w.batchId,
      refId: logId,
      detail: sha256Text(REASON),
    });
    const disown = await runAs(
      "legend_app",
      `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`,
      [logId, grant, REASON],
    );
    expect(disown.code, disown.message).toBeUndefined();
    expect(await openDisputes(w.batchId), "one open dispute").toBe(1);

    await W.expectRefused(
      W.inTx((tx) => exportManualBatch(tx, actorOf(APP), w.batchId)),
      { status: 409 },
    );
    expect((await W.batchById(w.batchId)).status, "not exported").toBe(
      "approved",
    );
  });
});

describe("934 the two-person rule stays", () => {
  it("[934-two-people-stay] the requester cannot approve their own batch (PAYOUT_SELF_APPROVAL, no log row, no spent grant); a second person can and is the logged actor", async () => {
    const w = await pendingBatch();
    expect((await W.batchById(w.batchId)).requested_by).toBe(REQ);

    const self = spyActor(REQ);
    await W.expectRefused(approveAs(self.actor, w), {
      code: "PAYOUT_SELF_APPROVAL",
    });
    await expectStillPending(w.batchId);
    expect(await logsOf(w.batchId), "no log row for a refusal").toHaveLength(0);
    expect(await spentGrantsOf(w.batchId), "no grant spent").toBe(0);

    // The database still refuses approver = requester on its own.
    const raw = await runAs(
      "legend_app",
      `UPDATE payroll_disbursement_batches
          SET approved_by = requested_by, approved_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, w.batchId],
      false,
    );
    expect(raw.code, raw.message).toBeDefined();

    const second = spyActor(APP);
    await approveAs(second.actor, w);
    const batch = await W.batchById(w.batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(APP);
    expect(batch.approved_by).not.toBe(batch.requested_by);
    const logs = await logsOf(w.batchId);
    expect(logs, "the second person's approval is logged").toHaveLength(1);
    expect(logs[0]!.actor).toBe(APP);
    expect(second.issued, "with a grant of its own").toHaveLength(1);
  });
});
