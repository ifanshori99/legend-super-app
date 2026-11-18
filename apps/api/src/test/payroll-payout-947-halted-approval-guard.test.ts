// Payout 947 (bead legend-dz8ci): the approval columns of a payout batch
// (approved_by, approved_at, approval_expires_at, source_bank_account_id) can be
// changed by direct SQL while the batch is `halted` (and, as the brief says, in
// any status) without the one-time grant that PAYOUT-83 (934) demands for the
// approval itself. Written fail-first from the brief (scratchpad brief-947.md) and
// 934-main-approval-grant, NOT from the implementation.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): changing who approved a batch, when, until when, or from which
// bank account, is refused for the app role and for the table owner (guards on),
// whatever the batch status, unless it goes through the trusted path. A normal
// approval through the service (grant spent in the same transaction) still works.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - A `halted` batch is built by approving a batch through the service and then
//   forcing its status to `halted` with the triggers off (the fixture owner,
//   `session_replication_role = replica`); no halt reason is assumed to be
//   required. The guard is then probed with the triggers ON: once as `legend_app`
//   and once as the table owner (superuser login of the test database).
// - The refusal for the owner carries a PAYOUT-nn message (the guard, like
//   PAYOUT-83); for `legend_app` any database error counts (a missing privilege
//   is as good as the trigger). Every refused statement leaves the row as it was.
// - The probed statements change one approval column at a time, to values that
//   are valid by themselves (an existing other user, a later time, NULL source),
//   so a refusal comes from the guard and not from a check or foreign key.
// - The trusted path (grant consumed in the same txid, or the unfreeze/reopen
//   function) cannot be driven by a raw statement; it is covered by the control
//   below (a normal approval through the service) and by the 934 and 947-unfreeze
//   suites.
// - Same guard for `approved` (the brief: "atau status apa pun"). A pending batch
//   is not probed: the existing check constraint already forbids approval columns
//   there, so a refusal would not prove the new guard. The `approved` case may
//   already pass today (an older trigger); it is kept as a regression guard.
// - The forced `halted` row carries halt_reason `kill_switch` (check constraint).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  APP,
  APP2,
  BUDI,
  REQ,
  actorOf,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("947halt");
const batchIds: string[] = [];

type Outcome = { code: string | undefined; message: string };

/** One statement as `role` (null: the owner login itself), triggers on, rolled back. */
async function probe(
  role: "legend_app" | null,
  sql: string,
  params: unknown[],
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
      await client.query(sql, params);
      return { code: undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    } finally {
      // Never commit: a statement that is wrongly allowed must not leak.
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

type Status = "pending_approval" | "approved" | "halted";

/** A batch of one slip, requested by REQ; `approved` by APP unless pending; forced to `halted` if asked. */
async function batchIn(status: Status) {
  const runId = await W.seedRun([bank(BUDI, 4_000_000)]);
  const batchId = await W.createBatch(runId);
  batchIds.push(batchId);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  if (status !== "pending_approval") {
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
      } as never),
    );
  }
  if (status === "halted")
    await W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_disbursement_batches SET status = 'halted', halt_reason = 'kill_switch'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, batchId],
      );
    }, true);
  const batch = await W.batchById(batchId);
  expect(batch.status, `premise: ${status}`).toBe(status);
  return { batchId, before: batch };
}

const approvalColumns = (batch: Row) => ({
  approved_by: batch.approved_by,
  approved_at: batch.approved_at,
  approval_expires_at: batch.approval_expires_at,
  source_bank_account_id: batch.source_bank_account_id,
});

/** One statement per approval column: a valid value, no status change. */
const CHANGES: { column: string; set: string; control?: true }[] = [
  { column: "approved_by", set: "approved_by = $3" },
  { column: "approved_at", set: "approved_at = now() + interval '1 hour'" },
  {
    column: "approval_expires_at",
    set: "approval_expires_at = now() + interval '30 days'",
  },
  // Control, not fail-first: PAYOUT-07 (0355) already froze the source account
  // before this card; kept so the whole set of approval columns stays covered.
  {
    column: "source_bank_account_id",
    set: "source_bank_account_id = NULL",
    control: true,
  },
];

async function expectGuarded(status: Status) {
  const { batchId, before } = await batchIn(status);
  for (const { column, set, control } of CHANGES) {
    // Without a $3 in the SET list the parameter would be unused: always bind it.
    const sql = `UPDATE payroll_disbursement_batches SET ${set}
                  WHERE tenant_id = $1 AND id = $2 AND $3::text IS NOT NULL`;
    for (const role of ["legend_app", null] as const) {
      const who = role ?? "owner";
      const outcome = await probe(role, sql, [W.tenantId, batchId, APP2]);
      expect(
        outcome.code,
        `${status} / ${who}: changing ${column} without the grant must be refused${control ? " (control: PAYOUT-07)" : ""}`,
      ).toBeDefined();
      if (role === null)
        expect(
          outcome.message,
          `${status} / owner / ${column}: refused by the guard, not by a check`,
        ).toMatch(/PAYOUT-\d+/);
    }
    expect(
      approvalColumns(await W.batchById(batchId)),
      `${status}: ${column} is unchanged`,
    ).toEqual(approvalColumns(before));
  }
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
      "payroll_payout_approval_log",
      "payroll_payout_grants",
    ])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`,
        [W.tenantId, batchIds],
      );
  }, true);
});

describe("947 approval columns need the trusted path", () => {
  it("[947-halted-approval-columns-guarded] on a halted batch, approved_by, approved_at, approval_expires_at and source_bank_account_id cannot be changed by direct SQL (legend_app or owner); the row stays as it was", async () => {
    await expectGuarded("halted");
  });

  it("[947-approved-approval-columns-guarded] same guard on an approved batch (any status, not only halted)", async () => {
    await expectGuarded("approved");
  });

  it("[947-approved-reopen-without-unfreeze-refused] direct SQL approved -> pending_approval with the approval columns cleared, with no unfreeze, is refused for legend_app and for the owner (PAYOUT-83); the row stays", async () => {
    const { batchId, before } = await batchIn("approved");
    const sql = `UPDATE payroll_disbursement_batches
                    SET status = 'pending_approval', approved_by = NULL, approved_at = NULL,
                        approval_expires_at = NULL, source_bank_account_id = NULL
                  WHERE tenant_id = $1 AND id = $2`;
    for (const role of ["legend_app", null] as const) {
      const outcome = await probe(role, sql, [W.tenantId, batchId]);
      expect(
        outcome.code,
        `${role ?? "owner"}: reopening without an unfreeze must be refused`,
      ).toBeDefined();
      if (role === null)
        expect(outcome.message, "owner: refused by PAYOUT-83").toMatch(
          /PAYOUT-83/,
        );
    }
    const after = await W.batchById(batchId);
    expect(after.status).toBe("approved");
    expect(approvalColumns(after)).toEqual(approvalColumns(before));
  });

  it("[947-normal-approval-still-works] control: a normal approval through the service (grant spent in the same transaction) is not blocked by the guard", async () => {
    const { batchId } = await batchIn("pending_approval");
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
      } as never),
    );
    const batch = await W.batchById(batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(APP);
    expect(batch.approved_at).not.toBeNull();
    expect(batch.source_bank_account_id).toBe(source!.id);
  });
});
