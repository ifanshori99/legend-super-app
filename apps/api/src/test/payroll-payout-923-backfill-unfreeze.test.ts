// 923 / legend-yd9u2: real SQL unfreeze held before catch-up versus phase 2's
// historical shared-key binder. Manual pg transactions choose the interleaving;
// pg_blocking_pids observes the barrier, no elapsed delay decides the outcome.
// The baseline holds run+B, the worker holds A and waits B, catch-up waits A:
// PostgreSQL reports 40P01. Both paths must instead take run, sorted batches.
// Historical returned clones represent pre-0381 records, not new payments.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  bindHistoricalOperation,
  bindHistoricalOperations,
  completeKey,
  lockBatchesBeforeHashes,
} from "../services/payroll-payout-proof-backfill.service.ts";
import {
  actorOf,
  APP2,
  bank,
  BUDI,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("923deadlock");
const REASON = "Bukan saya yang mengonfirmasi transfer ini, mohon periksa";
const UNFREEZE_REASON = "Bank sudah diperiksa, tidak ada pembayaran tambahan";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const histories: { batchId: string; key: string; realBatchId: string }[] = [];
const lockOnlyBatches: string[] = [];
let ownerId: string;

beforeAll(async () => {
  ownerId = (await W.signedInClient("Outside owner 923")).userId;
  await W.grantRole(ownerId, ["payroll.view", "payroll.disburse.approve"]);
  await W.owner.query(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Owner 923', true, 'owner', '[]'::jsonb, false, '["tenant","brand"]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [W.tenantId],
  );
  await W.owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', NULL, now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = 'owner'`,
    [W.tenantId, ownerId],
  );
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [W.tenantId, lockOnlyBatches.splice(0)],
    );
  }, true);
  for (const history of histories.splice(0))
    await W.asTenant(async (c) => {
      for (const table of [
        "payroll_payout_batch_unfreezes",
        "payroll_payout_batch_disputes",
        "payroll_payout_grants",
      ])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`,
          [W.tenantId, [history.batchId, history.realBatchId]],
        );
      await c.query(
        `DELETE FROM payroll_payout_proof_hashes WHERE binding_id IN
      (SELECT id FROM payroll_payout_proof_bindings WHERE tenant_id = $1 AND evidence_key = $2)`,
        [W.tenantId, history.key],
      );
      await c.query(
        `DELETE FROM payroll_payout_proof_hash_contests WHERE sha256 = $1`,
        [sha(history.key)],
      );
      for (const table of [
        "payroll_payout_proof_backfill_stuck",
        "payroll_payout_proof_bindings",
        "payroll_payout_evidence_files",
      ])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND evidence_key = $2`,
          [W.tenantId, history.key],
        );
      await c.query(
        `DELETE FROM payroll_disbursement_items WHERE tenant_id = $1 AND return_evidence_key = $2`,
        [W.tenantId, history.key],
      );
      await c.query(
        `DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, history.batchId],
      );
    }, true);
});

async function grant(
  kind: "disown" | "unfreeze",
  actor: string,
  batchId: string,
  reason: string,
  logId: string | null = null,
) {
  const c = await W.owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE legend_payout_grantor");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [W.tenantId]);
    const result = await c.query(
      `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, '{}'::uuid[], NULL::varchar,
         $4::uuid, NULL::uuid, $5::varchar, $6::text, $7::text, 'password'::text) AS token`,
      [
        kind,
        kind === "disown" ? "record" : "approve",
        batchId,
        logId,
        sha(reason),
        actor,
        actorOf(actor).sessionId,
      ],
    );
    await c.query("COMMIT");
    return result.rows[0]!.token as string;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

async function world() {
  const slips = [bank(BUDI, 1_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const bId = await W.exportedBatch(runId);
  const items = await W.itemsOf(bId);
  await W.confirm(bId, W.succeedItems(bId, items), APP2);
  const aId = `00000000-${randomUUID().slice(9)}`;
  expect(aId < bId, "fixture: A precedes B").toBe(true);
  const key = `tenants/${W.tenantId}/payroll-payout/${bId}/shared-923-${randomUUID()}.pdf`;
  histories.push({ batchId: aId, key, realBatchId: bId });
  await W.legacyReturnItem(items[0]!.id as string, key);
  await W.asTenant(async (c) => {
    await c.query(
      `CREATE TEMP TABLE batch_923 ON COMMIT DROP AS SELECT * FROM payroll_disbursement_batches WHERE id = $1`,
      [bId],
    );
    await c.query(`UPDATE batch_923 SET id = $1`, [aId]);
    await c.query(
      `INSERT INTO payroll_disbursement_batches SELECT * FROM batch_923`,
    );
    await c.query(
      `CREATE TEMP TABLE item_923 ON COMMIT DROP AS SELECT * FROM payroll_disbursement_items WHERE return_evidence_key = $1`,
      [key],
    );
    await c.query(
      `UPDATE item_923 SET id = gen_random_uuid(), batch_id = $1, attempt_no = attempt_no + 1000001`,
      [aId],
    );
    await c.query(
      `UPDATE item_923 SET idempotency_key = 'payslip:' || payslip_id::text || ':attempt:' || attempt_no::text`,
    );
    await c.query(
      `INSERT INTO payroll_disbursement_items SELECT * FROM item_923`,
    );
    await c.query(
      `INSERT INTO payroll_payout_evidence_files
      (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
      VALUES ($1, $2, $3, $4, $4, 'legacy-923')`,
      [W.tenantId, bId, key, sha(key)],
    );
  }, true);
  const [log] = await W.rowsOf(
    `SELECT id FROM payroll_payout_approval_log WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3 ORDER BY logged_at LIMIT 1`,
    [W.tenantId, bId, APP2],
  );
  expect(log, "real confirmation produced the disowned log").toBeTruthy();
  const disown = await grant("disown", APP2, bId, REASON, log!.id as string);
  await W.asTenant((c) =>
    c.query(`SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text)`, [
      log!.id,
      disown,
      REASON,
    ]),
  );
  const token = await grant("unfreeze", ownerId, bId, UNFREEZE_REASON);
  return { runId, aId, bId, key, token };
}
type World = Awaited<ReturnType<typeof world>>;

async function raw() {
  const c = await W.owner.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL statement_timeout = '15s'");
  await c.query("SET LOCAL deadlock_timeout = '100ms'");
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [W.tenantId]);
  return c;
}
const unfreeze = (c: PoolClient, w: World) =>
  c.query(
    `SELECT app.payout_batch_unfreeze($1::uuid, $2::text, $3::text) AS released`,
    [w.bId, w.token, UNFREEZE_REASON],
  );
async function blockedBy(pid: number, finished: () => boolean) {
  const until = Date.now() + 10_000;
  while (Date.now() < until && !finished()) {
    const found = await W.owner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting`,
      [pid],
    );
    if (found.rows[0]!.waiting) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}
const pidOf = async (c: PoolClient) =>
  Number((await c.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
const message = (error: unknown): string => {
  if (!error || typeof error !== "object") return String(error);
  const e = error as { code?: string; message?: string; cause?: unknown };
  return `${e.code ?? ""} ${e.message ?? ""} ${e.cause ? message(e.cause) : ""}`;
};
async function money(w: World) {
  return JSON.stringify({
    items: await W.rowsOf(
      `SELECT id, status, amount_encrypted, fee_idr_encrypted FROM payroll_disbursement_items WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY id`,
      [W.tenantId, w.runId],
    ),
    postings: await W.rowsOf(
      `SELECT p.* FROM payroll_payout_gl_postings p JOIN payroll_disbursement_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id WHERE b.tenant_id = $1 AND b.payroll_run_id = $2 ORDER BY p.id`,
      [W.tenantId, w.runId],
    ),
    journals: await W.rowsOf(
      `SELECT j.* FROM journal_entries j WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY id`,
      [W.tenantId, W.entityId()],
    ),
    lines: await W.rowsOf(
      `SELECT l.* FROM journal_lines l JOIN journal_entries j ON j.tenant_id = l.tenant_id AND j.id = l.entry_id WHERE j.tenant_id = $1 AND j.legal_entity_id = $2 ORDER BY l.id`,
      [W.tenantId, W.entityId()],
    ),
  });
}
async function expectReleasedOnce(w: World, before: string) {
  const [count] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM payroll_payout_batch_unfreezes WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, w.bId],
  );
  expect(count!.n, "one committed opening").toBe(1);
  expect(
    await money(w),
    "no new payment, net or fee posting, or account movement",
  ).toBe(before);
  const [binding] = await W.rowsOf(
    `SELECT app.payout_proof_contested(ARRAY[content_sha256, stored_sha256]::varchar[]) AS contested FROM payroll_payout_proof_bindings WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, w.key],
  );
  expect(binding?.contested, "shared history is contested, never reused").toBe(
    true,
  );
}

describe("923 historical proof worker and unfreeze use the same run-first lock order", () => {
  it("[923-unfreeze-first] SQL unfreeze B held before catch-up, shared-key worker A then B: no 40P01; both commit once with unchanged net/fee money", async () => {
    const w = await world();
    const before = await money(w);
    const c = await raw();
    let error: unknown;
    let finished = false;
    let worker: ReturnType<typeof bindHistoricalOperations> | undefined;
    try {
      expect((await unfreeze(c, w)).rows[0]!.released).toBe(1);
      worker = bindHistoricalOperations(W.scope(), new Date()).finally(() => {
        finished = true;
      });
      expect(
        await blockedBy(await pidOf(c), () => finished),
        "worker reaches database lock barrier",
      ).toBe(true);
      try {
        // The first operation recoverPayoutGlOfBatch performs on sibling A.
        await c.query(
          `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [W.tenantId, w.aId],
        );
        await c.query("COMMIT");
      } catch (caught) {
        error = caught;
        await c.query("ROLLBACK");
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    const result = await worker;
    expect(
      error,
      `catch-up must commit without SQLSTATE 40P01: ${message(error)}`,
    ).toBeUndefined();
    expect(
      result?.failed,
      "worker must not hide a deadlock as bind_failed",
    ).toBe(0);
    await expectReleasedOnce(w, before);
  }, 120_000);

  it("[923-worker-first] shared-key worker holds its run/batches before SQL unfreeze: opening queues, then both commit with no extra payout", async () => {
    const w = await world();
    const before = await money(w);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const worker = bindHistoricalOperations(W.scope(), new Date(), {
      binder: async (tx, tenantId, op, now) => {
        reached(
          Number(
            (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!
              .pid,
          ),
        );
        await gate;
        return bindHistoricalOperation(tx, tenantId, op, now);
      },
    });
    const workerPid = await ready;
    const c = await raw();
    let finished = false;
    const opening = unfreeze(c, w).finally(() => {
      finished = true;
    });
    try {
      expect(
        await blockedBy(workerPid, () => finished),
        "unfreeze waits for worker's commit",
      ).toBe(true);
      release();
      expect((await worker).failed).toBe(0);
      expect((await opening).rows[0]!.released).toBe(1);
      await c.query("COMMIT");
    } finally {
      release();
      await c.query("ROLLBACK");
      c.release();
    }
    await expectReleasedOnce(w, before);
  }, 120_000);

  it("[923-unfreeze-sorted-batches] unfreeze of high B waits on low A before taking B", async () => {
    const w = await world();
    const holder = await raw();
    const opener = await raw();
    let finished = false;
    let opening: ReturnType<typeof unfreeze> | undefined;
    try {
      await holder.query(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [W.tenantId, w.aId],
      );
      opening = unfreeze(opener, w).finally(() => {
        finished = true;
      });
      expect(
        await blockedBy(await pidOf(holder), () => finished),
        "low batch is the first batch barrier",
      ).toBe(true);
      // NOWAIT is a database assertion: the unfreeze has not locked target B.
      await holder.query(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
        [W.tenantId, w.bId],
      );
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await opening;
      await opener.query("ROLLBACK");
      opener.release();
    }
  }, 120_000);

  it("[923-worker-run-before-batch] helper passed B,A,A queues on run before taking any batch", async () => {
    const w = await world();
    const c = await raw();
    let finished = false;
    let worker: Promise<void> | undefined;
    try {
      await c.query(
        `SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [W.tenantId, w.runId],
      );
      worker = W.inTx((tx) =>
        lockBatchesBeforeHashes(tx, W.scope().tenant.tenantId, [
          w.bId,
          w.aId,
          w.aId,
        ]),
      ).finally(() => {
        finished = true;
      });
      expect(
        await blockedBy(await pidOf(c), () => finished),
        "worker waits for run",
      ).toBe(true);
      await c.query(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,
        [W.tenantId, [w.aId, w.bId]],
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await worker;
    }
  }, 120_000);

  it("[923-phase1-run-before-batch] fingerprint completion also waits for run before locking batch", async () => {
    const w = await world();
    const c = await raw();
    let finished = false;
    let worker: Promise<unknown> | undefined;
    try {
      await c.query(
        `SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [W.tenantId, w.runId],
      );
      worker = W.inTx((tx) =>
        completeKey(
          tx,
          W.scope().tenant.tenantId,
          w.bId,
          w.key,
          sha(w.key),
          new Date(),
        ),
      ).finally(() => {
        finished = true;
      });
      expect(
        await blockedBy(await pidOf(c), () => finished),
        "phase 1 waits for run",
      ).toBe(true);
      await c.query(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
        [W.tenantId, w.bId],
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await worker;
    }
  }, 120_000);

  it("[923-multiple-runs-sorted] reverse batch input spanning runs queues on lowest run before locking the higher run", async () => {
    const w = await world();
    const otherRun = await W.seedRun([bank(BUDI, 1_000_000)]);
    const otherBatch = randomUUID();
    lockOnlyBatches.push(otherBatch);
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO payroll_disbursement_batches
      SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'payroll_run_id', $2::uuid))).*
      FROM payroll_disbursement_batches b WHERE b.tenant_id = $3 AND b.id = $4`,
          [otherBatch, otherRun, W.tenantId, w.bId],
        ),
      true,
    );
    const runs = [
      { run: w.runId, batch: w.bId },
      { run: otherRun, batch: otherBatch },
    ].sort((a, b) => a.run.localeCompare(b.run));
    const c = await raw();
    let finished = false;
    let worker: Promise<void> | undefined;
    try {
      await c.query(
        `SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [W.tenantId, runs[0]!.run],
      );
      worker = W.inTx((tx) =>
        lockBatchesBeforeHashes(tx, W.scope().tenant.tenantId, [
          runs[1]!.batch,
          runs[0]!.batch,
        ]),
      ).finally(() => {
        finished = true;
      });
      expect(
        await blockedBy(await pidOf(c), () => finished),
        "worker waits on lowest run despite reverse input",
      ).toBe(true);
      await c.query(
        `SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
        [W.tenantId, runs[1]!.run],
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await worker;
    }
  }, 120_000);

  it("[923-other-tenant] locked tenant A cannot block tenant B's run and batch; foreign batch IDs are ignored", async () => {
    const w = await world();
    const tenant = randomUUID();
    const run = randomUUID();
    const batch = randomUUID();
    const scope = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
        SELECT $1, $2, 'PT B 923', plan, status, deployment_mode, feature_flags, limits, created_by FROM tenants WHERE id = $3`,
        [tenant, `pt-b-923-${tenant}`, W.tenantId],
      );
      await c.query(
        `INSERT INTO payroll_runs SELECT (jsonb_populate_record(r, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid))).* FROM payroll_runs r WHERE id = $3`,
        [run, tenant, w.runId],
      );
      await c.query(
        `INSERT INTO payroll_disbursement_batches SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid, 'payroll_run_id', $3::uuid))).* FROM payroll_disbursement_batches b WHERE id = $4`,
        [batch, tenant, run, w.bId],
      );
    }, true);
    const c = await raw();
    try {
      await c.query(
        `SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [W.tenantId, w.runId],
      );
      await c.query(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [W.tenantId, [w.aId, w.bId]],
      );
      await withTenant(db, scope, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await lockBatchesBeforeHashes(tx, scope.tenant.tenantId, [
          w.aId,
          batch,
          w.bId,
        ]);
      });
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await W.asTenant(async (cleanup) => {
        await cleanup.query(
          `DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1`,
          [tenant],
        );
        await cleanup.query(`DELETE FROM payroll_runs WHERE tenant_id = $1`, [
          tenant,
        ]);
        await cleanup.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      }, true);
    }
  }, 120_000);
});
