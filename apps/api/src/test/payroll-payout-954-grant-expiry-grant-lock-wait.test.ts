// Payout 954 (bead legend-lf0oj, follow-up of legend-628t9): a batch_approve grant
// whose ROW is locked by another transaction must not be accepted if it expires
// while its caller waits for that row lock. Written from the bead text and the
// 0436 migration comment, NOT by bending it to pass.
//
// Rule proven (founder: nobody is paid on one person's word, the step-up lasts two
// minutes; when in doubt, limit the payment): the grant's lifetime is judged at the
// moment it is spent, after every wait. Here the wait is for the grant row itself:
// a first consumer holds the row (FOR UPDATE) and later rolls back, so the grant is
// still unspent. The second caller started before expiry, waited past it, and is
// refused with PAYOUT-70; the grant stays unspent, the batch stays pending, no
// approval log row, no approved item, no money out.
//
// Assumptions (stated so they can be contested):
// - Direct SQL as `legend_app` calls `app.payout_batch_approve_attest(batch uuid,
//   grant text)`, as the service does, with the real grant of the grantor stand-in APP.
// - The first consumer is an owner connection A that holds `SELECT ... FOR UPDATE`
//   on the grant row only (NOT the run lock) and ROLLBACKs after the expiry: a
//   stand-in for a first consumer that failed later and rolled back.
// - The test proves B waits on a Lock blocked by A (pg_stat_activity and
//   pg_blocking_pids) before it lets the grant expire; a missing wait is a setup
//   error, never a silent pass.
// - To avoid a two-minute wait, the grant row's expires_at is moved ~8 seconds
//   ahead with the triggers off (owner); everything else is real.
// - If B succeeds, its transaction is committed so the state checks see the damage.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitDisbursementBatch } from "../services/payroll-payout.service.ts";
import {
  APP,
  BUDI,
  REQ,
  actorOf,
  bank,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("954glk");
const LOG = "payroll_payout_approval_log";
const batchIds: string[] = [];
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

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

describe("954 a grant that expires while waiting for the grant row lock is refused", () => {
  it("[954-grant-expired-while-grant-lock-wait] attest starts before expiry, waits for the grant row lock past expiry, first consumer rolls back: PAYOUT-70, grant unspent, batch pending, no log, no approved items, no money out", async () => {
    // World: a submitted batch requested by REQ, waiting for its approver.
    const runId = await W.seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await W.createBatch(runId);
    batchIds.push(batchId);
    await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
    expect((await W.batchById(batchId)).status, "premise: pending").toBe(
      "pending_approval",
    );

    // A real batch_approve grant of APP, then its expiry moved a few seconds ahead.
    const secret = await actorOf(APP).grants.issue({
      kind: "batch_approve",
      step: "approve",
      batchId,
      itemIds: [],
      evidenceKey: null,
      refId: null,
      targetId: null,
    });
    const EXPIRY_SECONDS = 8;
    const moved = await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_grants
              SET expires_at = clock_timestamp() + make_interval(secs => $3)
            WHERE tenant_id = $1 AND secret_sha256 = $2`,
          [W.tenantId, sha(secret), EXPIRY_SECONDS],
        ),
      true,
    );
    expect(moved.rowCount, "premise: grant row found").toBe(1);

    // Connection A: first consumer, holds the GRANT row lock (not the run lock).
    const a = await W.owner.connect();
    let b: PoolClient | undefined;
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      await a.query(
        `SELECT id FROM payroll_payout_grants
          WHERE tenant_id = $1 AND secret_sha256 = $2 FOR UPDATE`,
        [W.tenantId, sha(secret)],
      );
      const aPid = Number(
        (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );

      // Connection B: legend_app, valid grant, starts before expiry.
      b = await W.owner.connect();
      await b.query("BEGIN");
      await b.query("SET LOCAL ROLE legend_app");
      await b.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      const bPid = Number(
        (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );
      const startedBeforeExpiry = (
        await W.rowsOf(
          `SELECT clock_timestamp() < expires_at AS ok FROM payroll_payout_grants
            WHERE tenant_id = $1 AND secret_sha256 = $2`,
          [W.tenantId, sha(secret)],
        )
      )[0]!.ok;
      expect(startedBeforeExpiry, "premise: B starts before expiry").toBe(true);

      const attest = b
        .query(
          `SELECT app.payout_batch_approve_attest($1::uuid, $2::text) AS id`,
          [batchId, secret],
        )
        .then(
          () => ({ error: null as null | { code?: string; message?: string } }),
          (error: { code?: string; message?: string }) => ({ error }),
        );

      // B must really be waiting on a lock held by A before the grant expires.
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i++) {
        await sleep(100);
        waiting =
          (
            await W.owner.query(
              `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
              [bPid],
            )
          ).rowCount === 1;
      }
      expect(waiting, "premise: B waits for the grant row lock held by A").toBe(
        true,
      );
      const blockers = (
        await W.owner.query(`SELECT pg_blocking_pids($1) AS pids`, [bPid])
      ).rows[0].pids as number[];
      expect(blockers, "premise: A (grant row holder) blocks B").toContain(
        aPid,
      );
      const stillValid = (
        await W.rowsOf(
          `SELECT clock_timestamp() < expires_at AS ok FROM payroll_payout_grants
            WHERE tenant_id = $1 AND secret_sha256 = $2`,
          [W.tenantId, sha(secret)],
        )
      )[0]!.ok;
      expect(stillValid, "premise: grant still valid while B waits").toBe(true);

      // Let the grant expire while B waits, then A rolls back: grant still unspent.
      for (let i = 0; i < 200; i++) {
        const expired = (
          await W.rowsOf(
            `SELECT clock_timestamp() > expires_at + interval '300 milliseconds' AS gone
               FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
            [W.tenantId, sha(secret)],
          )
        )[0]!.gone;
        if (expired) break;
        await sleep(100);
      }
      await a.query("ROLLBACK");

      const outcome = await attest;
      await b.query(outcome.error ? "ROLLBACK" : "COMMIT");

      // The call is refused as an invalid / expired grant.
      expect(
        outcome.error?.message ?? "attest succeeded",
        "an expired grant must be refused with PAYOUT-70",
      ).toContain("PAYOUT-70");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release();
      if (b) {
        await b.query("ROLLBACK").catch(() => undefined);
        b.release();
      }
    }

    // The real approval door: since B's attest was refused, no consumed grant
    // exists, so the batch UPDATE pending_approval -> approved (as legend_app, in
    // its own transaction, as the service does) must be refused by the trigger.
    const approver = await W.owner.connect();
    let approveError: { code?: string; message?: string } | undefined;
    try {
      await approver.query("BEGIN");
      await approver.query("SET LOCAL ROLE legend_app");
      await approver.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [W.tenantId],
      );
      try {
        await approver.query(
          `UPDATE payroll_disbursement_batches
              SET status = 'approved', approved_by = $3, approved_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, batchId, APP],
        );
        await approver.query("COMMIT");
      } catch (error) {
        approveError = error as { code?: string; message?: string };
        await approver.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      approver.release();
    }
    expect(
      approveError?.code,
      "approving the batch without a consumed grant must be refused by the database",
    ).toBeDefined();

    // Nothing was spent, logged, approved or paid.
    const [grant] = await W.rowsOf(
      `SELECT consumed_at FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    );
    expect(grant!.consumed_at, "grant stays unspent").toBeNull();
    const batch = await W.batchById(batchId);
    expect(batch.status, "batch stays pending").toBe("pending_approval");
    expect(batch.approved_by, "no approver").toBeNull();
    expect(
      await count(
        `SELECT count(*)::int AS n FROM ${LOG} WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, batchId],
      ),
      "no approval log row",
    ).toBe(0);
    for (const item of await W.itemsOf(batchId))
      expect(item.status, "no item approved").not.toBe("approved");
    expect(
      await count(
        `SELECT count(*)::int AS n FROM payroll_disbursement_items
          WHERE tenant_id = $1 AND batch_id = $2 AND status IN ('succeeded', 'sending', 'exported')`,
        [W.tenantId, batchId],
      ),
      "no money out",
    ).toBe(0);
  }, 60_000);
});
