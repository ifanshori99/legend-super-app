// Payout 900 (card legend-p2v4s; design scratchpad b900/design.md F6 and F7;
// findings "phase 2 of the backfill is unfair to later operations" and
// "confirm, resolve and backfill take the proof locks in different orders" in
// docs/qa/second-opinion-payout-897.md). Written fail-first from the findings
// and the CTO decisions, not from the implementation.
//
// Rules proven here:
// - F6 fairness. Phase 2 takes at most 200 operations per sweep. When the
//   oldest 200 cannot be bound (the binder throws), the next sweep (same clock,
//   they are backed off) still reaches the valid ones behind them. The failing
//   ones are listed as stuck rows with reason `bind_failed`, and the global
//   gate still counts them (fail closed).
// - F7 one lock order: batch row, then the advisory hash locks (sorted, the
//   union of all keys of the call), then the evidence_files row. Confirm and
//   resolve already hold the batch row (FOR UPDATE) when they reach the hash
//   locks; the backfill locks the batch row FOR UPDATE before the hash locks
//   (CTO decision, option b: an evidence_files insert takes FOR KEY SHARE on
//   its batch through the foreign key, so a rival holding a hash lock without
//   the batch row deadlocks against a confirmation). A rival in the backfill's
//   order and a service call therefore queue on the batch row instead of
//   deadlocking: no 40P01, both sides commit, exactly one record per key.
//   Proven for a confirmation, a resolution and a confirmation with several
//   proofs.
//
// Assumptions (the design names them, stated so they can be contested):
// - Stuck reason `bind_failed` (mode retry, backed off by `next_attempt_at`).
// - The 250 "historical operations" are return claims that already carry both
//   hashes and an upload record but have no binding (what phase 2 selects);
//   historical corrections would need full correction worlds, which add
//   nothing to the fairness rule being proven. Built as the table owner.
// - The rival is a raw pg client, no service hook, in the backfill's order:
//   BEGIN, the proof's batch row FOR UPDATE, advisory lock
//   `pg_advisory_xact_lock(hashtextextended('payout-proof:' || sha, 0))`
//   (documented in payroll-payout-877-proof-lock-order), wait until the service
//   is blocked by the rival (pg_blocking_pids), then INSERT the
//   evidence_files row of the proof and COMMIT. A rival holding only the
//   hash lock (the backfill before the CTO decision) deadlocks with the
//   service's batch row lock: 40P01.
// - A legacy proof is an uploaded object whose evidence_files record was
//   removed (no fingerprint yet).
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import {
  bindHistoricalOperation,
  bindHistoricalOperations,
  type HistoricalProofBinder,
} from "../services/payroll-payout-proof-backfill.service.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("900lock");
const STUCK = "payroll_payout_proof_backfill_stuck";
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const idOf = (row: Row) => row.id as string;

const storage = new FakeObjectStorage();
const store = () => ({ storage, context: W.scope() });
const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });
const uploadTo = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;

const usedKeys: string[] = [];
afterEach(async () => {
  const keys = usedKeys.splice(0);
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND evidence_key = ANY($2::text[]))`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_proof_bindings
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_return_claims
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    await c.query(`DELETE FROM ${STUCK} WHERE evidence_key = ANY($1::text[])`, [
      keys,
    ]);
  }, true);
});

/** Budi and Siti paid in one batch (to hang historical claims on). */
async function paidBatch() {
  const slips = [bank(BUDI, 4_250_000), bank(SITI, 3_100_500)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return batchId;
}

// =========================================================================
// F6: phase 2 reaches the valid operations behind failing ones
// =========================================================================

describe("900 phase 2 of the backfill is fair (F6)", () => {
  it("[900-phase2-fair] 250 historical operations, the binder throws for the oldest 200: after 2 sweeps at the same clock the 50 valid ones are bound, the 200 failing ones are stuck rows with reason bind_failed, and the global gate still counts them", async () => {
    const batchId = await paidBatch();
    const prefix = `tenants/${W.tenantId}/payroll-payout/${batchId}/900-fair-${randomUUID()}`;
    const keyOf = (kind: "bad" | "ok", i: number) =>
      `${prefix}-${kind}-${i}.pdf`;
    const bad = Array.from({ length: 200 }, (_, i) => keyOf("bad", i));
    const ok = Array.from({ length: 50 }, (_, i) => keyOf("ok", i));
    usedKeys.push(...bad, ...ok);

    // History: claim with both hashes and an upload record, no binding. The bad
    // ones are the oldest.
    await W.asTenant(async (c) => {
      for (const [keys, age] of [
        [bad, 200_000],
        [ok, 100_000],
      ] as const)
        for (const [i, key] of keys.entries()) {
          const hash = sha256(Buffer.from(`900-fair-${key}`));
          await c.query(
            `INSERT INTO payroll_payout_evidence_files
               (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
             VALUES ($1, $2, $3, $4, $4, 'legacy-900')`,
            [W.tenantId, batchId, key, hash],
          );
          await c.query(
            `INSERT INTO payroll_payout_return_claims
               (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by,
                created_at, content_sha256, stored_sha256)
             VALUES ($1, $2, $3, $4, 'open', 'legacy-900',
                     now() - ($5::int || ' seconds')::interval, $6, $6)`,
            [
              W.tenantId,
              batchId,
              key,
              sha256(Buffer.from(`900-set-${key}`)),
              age - i,
              hash,
            ],
          );
        }
    }, true);

    const badKeys = new Set(bad);
    const binder: HistoricalProofBinder = async (tx, tenantId, op, at) => {
      if (badKeys.has(op.evidenceKey))
        throw new Error("PAYOUT-35 guard mismatch");
      return bindHistoricalOperation(tx, tenantId, op, at);
    };
    const now = new Date();
    await bindHistoricalOperations(W.scope(), now, { binder });
    await bindHistoricalOperations(W.scope(), now, { binder });

    const bound = await W.rowsOf(
      `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, ok],
    );
    expect(
      bound[0]!.n,
      "the 50 valid operations behind the failing 200 are bound",
    ).toBe(50);
    const unboundBad = await W.rowsOf(
      `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, bad],
    );
    expect(unboundBad[0]!.n).toBe(0);

    const stuck = await W.rowsOf(
      `SELECT evidence_key, reason FROM ${STUCK}
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[]) AND resolved_at IS NULL`,
      [W.tenantId, bad],
    );
    expect(stuck, "every failing operation is listed").toHaveLength(200);
    for (const row of stuck) expect(row.reason).toBe("bind_failed");
    const okStuck = await W.rowsOf(
      `SELECT 1 FROM ${STUCK}
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[]) AND resolved_at IS NULL`,
      [W.tenantId, ok],
    );
    expect(okStuck).toHaveLength(0);

    const [gate] = await W.rowsOf(
      `SELECT app.payout_proof_tenant_pending() AS tenant_pending,
              app.payout_proof_history_pending() AS history_pending`,
    );
    expect(gate, "fail closed: unbound operations keep the gate shut").toEqual({
      tenant_pending: true,
      history_pending: true,
    });
  });
});

// =========================================================================
// F7: one lock order for confirm, resolve and backfill
// =========================================================================

type Proof = { key: string; bytes: Uint8Array };

/** An uploaded proof with its upload record removed: a legacy proof without fingerprint. */
async function legacyProof(batchId: string, label: string): Promise<Proof> {
  const bytes = await pdf(label);
  const key = await uploadTo(batchId, bytes);
  usedKeys.push(key);
  await W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM payroll_payout_evidence_files
          WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, key],
      ),
    true,
  );
  return { key, bytes };
}

const recordsOf = async (keys: string[]) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM payroll_payout_evidence_files
          WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, keys],
      )
    )[0]!.n,
  );

/**
 * Rival raw client (the backfill's lock order): the batch row FOR UPDATE, the
 * hash locks, then, once the service waits for a lock, the fingerprint rows;
 * then commit. Runs `work` (the service call) in parallel and returns how
 * both sides ended.
 */
async function barrier(proofs: Proof[], work: () => Promise<unknown>) {
  const raw: PoolClient = await W.owner.connect();
  let rival: { code?: string; message?: string } | null = null;
  let service: { code?: string; message?: string } | null = null;
  let settled = false;
  let waiting = false;
  try {
    await raw.query("BEGIN");
    await raw.query("SELECT set_config('app.tenant_id', $1, true)", [
      W.tenantId,
    ]);
    // The backfill's order: the batch row before the hash locks.
    await raw.query(
      `SELECT b.id FROM payroll_disbursement_batches b
        WHERE b.tenant_id = $1::uuid
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS k(key)
                       WHERE k.key LIKE '%/' || b.id::text || '/%')
        ORDER BY b.id
        FOR UPDATE`,
      [W.tenantId, proofs.map((p) => p.key)],
    );
    const shas = [...new Set(proofs.map((p) => sha256(p.bytes)))].sort();
    for (const sha of shas)
      await raw.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payout-proof:${sha}`,
      ]);
    const rawPid = Number(
      (await raw.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    );

    const running = work()
      .then(
        () => undefined,
        (error: unknown) => {
          service = error as { code?: string; message?: string };
        },
      )
      .finally(() => {
        settled = true;
      });
    for (let i = 0; i < 200 && !waiting && !settled; i++) {
      waiting =
        Number(
          (
            await W.owner.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [rawPid],
            )
          ).rows[0].n,
        ) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }

    try {
      for (const proof of proofs) {
        const sha = sha256(proof.bytes);
        await raw.query(
          `INSERT INTO payroll_payout_evidence_files
             (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
           SELECT $1::uuid, b.id, $2::text, $3::text, $3::text, 'backfill-900'
             FROM payroll_disbursement_batches b
            WHERE b.tenant_id = $1::uuid AND $2::text LIKE '%/' || b.id::text || '/%'`,
          [W.tenantId, proof.key, sha],
        );
      }
      await raw.query("COMMIT");
    } catch (error) {
      rival = error as { code?: string; message?: string };
      await raw.query("ROLLBACK").catch(() => undefined);
    }
    await running;
  } finally {
    raw.release();
  }
  return { rival, service, waiting };
}

function expectNoDeadlock(outcome: Awaited<ReturnType<typeof barrier>>) {
  expect(
    outcome.waiting,
    "premise: the service waits for the rival before it writes",
  ).toBe(true);
  expect(
    outcome.rival,
    `the rival must commit: ${outcome.rival?.message}`,
  ).toBeNull();
  expect(
    outcome.service,
    `the service must commit, no 40P01: ${(outcome.service as { message?: string } | null)?.message}`,
  ).toBeNull();
}

describe("900 hash locks come before the fingerprint rows on every path (F7)", () => {
  it("[900-lock-order-confirm-vs-backfill] a confirmation of an item whose proof has no fingerprint, against a backfill-style rival holding the hash lock: no deadlock, both commit, exactly one record", async () => {
    const slips = [bank(BUDI, 4_250_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    const proof = await legacyProof(batchId, "konfirmasi-vs-backfill");

    const outcome = await barrier([proof], () =>
      W.confirm(
        batchId,
        items.map((item, index) => ({
          itemId: idOf(item),
          result: "succeeded" as const,
          bankRef: `BCA-900-${index}`,
          evidenceKey: proof.key,
        })),
        APP2,
        store(),
      ),
    );

    expectNoDeadlock(outcome);
    expect(await recordsOf([proof.key]), "exactly one record").toBe(1);
    expect((await W.itemsOf(batchId))[0]!.status).toBe("succeeded");
  });

  it("[900-lock-order-resolve-vs-backfill] a resolution (failed) with a proof that has no fingerprint, against the same rival: no deadlock, both commit, exactly one record", async () => {
    const slips = [bank(BUDI, 4_250_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    const proof = await legacyProof(batchId, "resolusi-vs-backfill");

    const outcome = await barrier([proof], () =>
      W.resolve(batchId, [idOf(items[0]!)], "failed", APP, proof.key, store()),
    );

    expectNoDeadlock(outcome);
    expect(await recordsOf([proof.key]), "exactly one record").toBe(1);
  });

  it("[900-lock-order-multi-proof-confirm] a confirmation with two items and two different legacy proofs, against a rival holding both hash locks and writing both rows: the locks of all proofs are taken first, no deadlock, one record per proof", async () => {
    const slips = [bank(BUDI, 4_250_000), bank(SITI, 3_100_500)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    const proofs = [
      await legacyProof(batchId, "multi-satu"),
      await legacyProof(batchId, "multi-dua"),
    ];

    const outcome = await barrier(proofs, () =>
      W.confirm(
        batchId,
        items.map((item, index) => ({
          itemId: idOf(item),
          result: "succeeded" as const,
          bankRef: `BCA-900-m${index}`,
          evidenceKey: proofs[index]!.key,
        })),
        APP3,
        store(),
      ),
    );

    expectNoDeadlock(outcome);
    expect(await recordsOf(proofs.map((p) => p.key))).toBe(2);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
  });
});
