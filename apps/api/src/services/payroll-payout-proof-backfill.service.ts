// Payout proof fingerprint backfill (bead legend-8vcsg; moved out of
// payroll-payout-proof-fingerprint.service.ts for legend-so897, no behaviour
// change). `backfillProofFingerprints` reads the stored objects of proofs that
// lack a hash and fills the hashes in (a claim or file row only goes from NULL
// to a value; an item evidence key without a record gets one). See the header
// of payroll-payout-proof-fingerprint.service.ts for the gate it feeds.
//
// Fair (legend-so897 F4): a key that fails (object unreadable, hash already held
// by another claim) gets a row in `payroll_payout_proof_backfill_stuck` with a
// retry time that backs off (15 min, doubling, at most 24 h). Target selection
// skips keys that are backed off and tries the never-attempted ones first, so
// failing keys leave the per-run window and the targets behind them are reached.
// The gate does not change: a stuck target still holds the tenant (fail closed).
//
// Phase 2 (`bindHistoricalOperations`) writes the proof binding of the
// operations that existed before bindings (overpaid, return, correction). It
// works on the unaccounted operations of `app.payout_proof_operations()`, one
// proof key at a time, and respects the backoff of the stuck table (legend-p2v4s).

import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ObjectStorage } from "@starter/shared/adapters";
import type {
  ScopedTenantContext,
  TenantId,
  UserId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  payrollDisbursementItems,
  payrollPayoutEvidenceFiles,
  payrollPayoutOverpaidProposals,
  payrollPayoutProofBackfillStuck,
  payrollPayoutReturnClaims,
  type PayoutProofBindingKind,
  type PayoutProofStuckReason,
} from "../db/schema/payroll-payout.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "./hris-access.ts";
import {
  claimHoldingFingerprint,
  countFingerprintTargets,
  type FingerprintTargetCounts,
  lockProofFingerprints,
  proofFingerprints,
  sha256Of,
} from "./payroll-payout-proof-fingerprint.service.ts";

export type ProofFingerprintBackfillResult = {
  /** Proof keys looked at this run. */
  readonly keys: number;
  /** Evidence-file rows written or completed. */
  readonly files: number;
  /** Return claims that now carry both hashes. */
  readonly claims: number;
  /** Keys whose object could not be read (listed as stuck, retried after a growing delay). */
  readonly unreadable: number;
  /** Claims whose hash already belongs to another claim (left for a human). */
  readonly conflicts: number;
  /** Proof keys listed as stuck after this run (unresolved rows of the stuck table). */
  readonly stuck: number;
  /** What is still waiting after this run; non-zero total = returns with a new proof stay held. */
  readonly held: FingerprintTargetCounts;
};

/** Proof keys handled per run and tenant; the rest wait for the next run. */
export const PROOF_FINGERPRINT_KEYS_PER_RUN = 200;

/**
 * One tenant. Fingerprints, from the stored object, every proof key that a
 * return claim or an item points at and that lacks a hash. Idempotent: a row or
 * claim that already has its hashes is not touched, so a repeat or an overlap of
 * two runs adds nothing.
 */
export async function backfillProofFingerprints(
  context: ScopedTenantContext,
  storage: ObjectStorage,
  now: Date,
  limit: number = PROOF_FINGERPRINT_KEYS_PER_RUN,
): Promise<ProofFingerprintBackfillResult> {
  const tenantId = context.tenant.tenantId;
  const at = now.toISOString();
  // A key whose unresolved stuck row is not due yet is skipped; the keys never
  // attempted come first, then the ones tried longest ago.
  const notBackedOff = (key: SQL | AnyColumn) =>
    sql`NOT EXISTS (SELECT 1 FROM ${payrollPayoutProofBackfillStuck} s WHERE s.tenant_id = ${tenantId} AND s.evidence_key = ${key} AND s.resolved_at IS NULL AND s.next_attempt_at > ${at}::timestamptz)`;
  const lastTried = (key: SQL | AnyColumn) =>
    sql`(SELECT s.last_attempt_at FROM ${payrollPayoutProofBackfillStuck} s WHERE s.tenant_id = ${tenantId} AND s.evidence_key = ${key} AND s.resolved_at IS NULL) ASC NULLS FIRST`;
  const targets = await withTenant(db, context, async (tx) => {
    const found = new Map<string, string>();
    const add = (rows: { key: string | null; batchId: string }[]) => {
      for (const row of rows)
        if (row.key !== null && !found.has(row.key))
          found.set(row.key, row.batchId);
    };
    // Claims first: they decide whether returns stay held.
    add(
      await tx
        .select({
          key: payrollPayoutReturnClaims.evidenceKey,
          batchId: payrollPayoutReturnClaims.batchId,
        })
        .from(payrollPayoutReturnClaims)
        .where(
          and(
            eq(payrollPayoutReturnClaims.tenantId, tenantId),
            or(
              isNull(payrollPayoutReturnClaims.contentSha256),
              isNull(payrollPayoutReturnClaims.storedSha256),
            ),
            notBackedOff(payrollPayoutReturnClaims.evidenceKey),
          ),
        )
        .orderBy(
          lastTried(payrollPayoutReturnClaims.evidenceKey),
          asc(payrollPayoutReturnClaims.createdAt),
        )
        .limit(limit),
    );
    add(
      await tx
        .select({
          key: payrollPayoutEvidenceFiles.evidenceKey,
          batchId: payrollPayoutEvidenceFiles.batchId,
        })
        .from(payrollPayoutEvidenceFiles)
        .where(
          and(
            eq(payrollPayoutEvidenceFiles.tenantId, tenantId),
            isNull(payrollPayoutEvidenceFiles.storedSha256),
            notBackedOff(payrollPayoutEvidenceFiles.evidenceKey),
          ),
        )
        .orderBy(
          lastTried(payrollPayoutEvidenceFiles.evidenceKey),
          asc(payrollPayoutEvidenceFiles.createdAt),
        )
        .limit(limit),
    );
    // Keys an item points at (resolution, confirmation, return proof) that have
    // no record yet: a re-upload of one of them must be found as its twin.
    for (const column of [
      payrollDisbursementItems.resolutionEvidenceKey,
      payrollDisbursementItems.confirmationEvidenceKey,
      payrollDisbursementItems.returnEvidenceKey,
    ])
      add(
        await tx
          .selectDistinct({
            key: column,
            batchId: payrollDisbursementItems.batchId,
          })
          .from(payrollDisbursementItems)
          .where(
            and(
              eq(payrollDisbursementItems.tenantId, tenantId),
              isNotNull(column),
              sql`NOT EXISTS (SELECT 1 FROM payroll_payout_evidence_files f WHERE f.tenant_id = ${payrollDisbursementItems.tenantId} AND f.evidence_key = ${column})`,
              notBackedOff(column),
            ),
          )
          .limit(limit),
      );
    // Proposed overpaid proofs without a record: their binding needs the hashes.
    add(
      await tx
        .selectDistinct({
          key: payrollPayoutOverpaidProposals.evidenceKey,
          batchId: payrollPayoutOverpaidProposals.batchId,
        })
        .from(payrollPayoutOverpaidProposals)
        .where(
          and(
            eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
            sql`NOT EXISTS (SELECT 1 FROM payroll_payout_evidence_files f WHERE f.tenant_id = ${payrollPayoutOverpaidProposals.tenantId} AND f.evidence_key = ${payrollPayoutOverpaidProposals.evidenceKey})`,
            notBackedOff(payrollPayoutOverpaidProposals.evidenceKey),
          ),
        )
        .limit(limit),
    );
    return [...found.entries()].slice(0, limit);
  });

  let files = 0;
  let claims = 0;
  let unreadable = 0;
  let conflicts = 0;
  for (const [key, batchId] of targets) {
    let storedSha: string;
    try {
      const object = await storage.get(context, {
        tenantId,
        outletId: null,
        reference: "payout-evidence-backfill",
        key,
        visibility: "private",
      });
      storedSha = sha256Of(object.content);
    } catch {
      unreadable += 1;
      await withTenant(db, context, (tx) =>
        markStuck(tx, tenantId, batchId, key, "unreadable", now, "retry"),
      );
      continue;
    }
    const outcome = await withTenant(db, context, async (tx) => {
      const done = await completeKey(
        tx,
        tenantId,
        batchId,
        key,
        storedSha,
        now,
      );
      if (done.conflict)
        await markStuck(
          tx,
          tenantId,
          batchId,
          key,
          "hash_conflict",
          now,
          "retry",
        );
      else await resolveStuck(tx, tenantId, key, now);
      return done;
    });
    files += outcome.file ? 1 : 0;
    claims += outcome.claim ? 1 : 0;
    conflicts += outcome.conflict ? 1 : 0;
  }
  const { held, stuck } = await withTenant(db, context, async (tx) => ({
    held: await countFingerprintTargets(tx, tenantId),
    stuck: await countStuck(tx, tenantId),
  }));
  return {
    keys: targets.length,
    files,
    claims,
    unreadable,
    conflicts,
    stuck,
    held,
  };
}

const RETRY_DELAY = sql.raw("interval '15 minutes'");
/** The retry delay doubles per failed attempt, at most 24 h (96 x 15 min). */
const RETRY_MAX_FACTOR = 96;

/**
 * Lists a proof key as stuck. "retry": a failed attempt of the backfill (the
 * attempt count goes up and the next try is pushed back, 15 min x 2^attempts,
 * at most 24 h; a row resolved earlier starts again). "listed": a fact found by
 * phase 2 (a legacy duplicate), written once and never overwriting an
 * unresolved row, so the reason that holds the key stays. A `shared_key` row
 * keeps its reason in both modes (only `listSharedKey` writes it).
 */
async function markStuck(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  key: string,
  reason: PayoutProofStuckReason,
  now: Date,
  mode: "retry" | "listed",
): Promise<void> {
  const at = now.toISOString();
  const first = sql`${at}::timestamptz + ${RETRY_DELAY}`;
  const settle =
    mode === "retry"
      ? sql`${at}::timestamptz + ${RETRY_DELAY} * LEAST(power(2, LEAST(CASE WHEN s.resolved_at IS NULL THEN s.attempts ELSE 0 END, 10)), ${RETRY_MAX_FACTOR})`
      : sql`${at}::timestamptz`;
  await tx.execute(sql`
    INSERT INTO payroll_payout_proof_backfill_stuck AS s
      (tenant_id, batch_id, evidence_key, reason, attempts, first_seen_at, last_attempt_at, next_attempt_at)
    VALUES (${tenantId}::uuid, ${batchId}::uuid, ${key}, ${reason}, 1, ${at}::timestamptz, ${at}::timestamptz,
            ${mode === "retry" ? first : sql`${at}::timestamptz`})
    ON CONFLICT (tenant_id, evidence_key) DO UPDATE SET
      reason = CASE WHEN s.resolved_at IS NULL AND s.reason = 'shared_key' THEN s.reason ELSE EXCLUDED.reason END,
      attempts = CASE WHEN s.resolved_at IS NULL THEN s.attempts + 1 ELSE 1 END,
      first_seen_at = CASE WHEN s.resolved_at IS NULL THEN s.first_seen_at ELSE EXCLUDED.first_seen_at END,
      last_attempt_at = EXCLUDED.last_attempt_at,
      next_attempt_at = ${settle},
      resolved_at = NULL
    ${mode === "listed" ? sql`WHERE s.resolved_at IS NOT NULL` : sql``}`);
}

/** A later sweep completed the key: its unresolved stuck row is kept, marked resolved. */
async function resolveStuck(
  tx: Tx,
  tenantId: TenantId,
  key: string,
  now: Date,
): Promise<void> {
  await tx
    .update(payrollPayoutProofBackfillStuck)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(payrollPayoutProofBackfillStuck.tenantId, tenantId),
        eq(payrollPayoutProofBackfillStuck.evidenceKey, key),
        isNull(payrollPayoutProofBackfillStuck.resolvedAt),
        ne(payrollPayoutProofBackfillStuck.reason, "legacy_duplicate"),
        ne(payrollPayoutProofBackfillStuck.reason, "shared_key"),
      ),
    );
}

async function countStuck(tx: Tx, tenantId: TenantId): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payrollPayoutProofBackfillStuck)
    .where(
      and(
        eq(payrollPayoutProofBackfillStuck.tenantId, tenantId),
        isNull(payrollPayoutProofBackfillStuck.resolvedAt),
      ),
    );
  return row?.n ?? 0;
}

/** The unresolved stuck proofs of one tenant, oldest first (for the job log). */
export async function listStuckProofs(
  context: ScopedTenantContext,
  limit = 20,
): Promise<
  { evidenceKey: string; reason: PayoutProofStuckReason; attempts: number }[]
> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, (tx) =>
    tx
      .select({
        evidenceKey: payrollPayoutProofBackfillStuck.evidenceKey,
        reason: payrollPayoutProofBackfillStuck.reason,
        attempts: payrollPayoutProofBackfillStuck.attempts,
      })
      .from(payrollPayoutProofBackfillStuck)
      .where(
        and(
          eq(payrollPayoutProofBackfillStuck.tenantId, tenantId),
          isNull(payrollPayoutProofBackfillStuck.resolvedAt),
        ),
      )
      .orderBy(
        asc(payrollPayoutProofBackfillStuck.firstSeenAt),
        asc(payrollPayoutProofBackfillStuck.evidenceKey),
      )
      .limit(limit),
  );
}

/**
 * Lock order (legend-p2v4s F7): run, batch, items, proof advisory locks, rows.
 * The confirm and resolve paths hold their batch row FOR UPDATE and then wait
 * for the hash locks; a row that points at the batch (the proof record, a
 * binding, a stuck row) needs a key share lock on it. So every backfill path
 * takes the batch rows (sorted by id) BEFORE the hash locks, never after.
 * Re-entrant inside one transaction.
 */
export async function lockBatchesBeforeHashes(
  tx: Tx,
  tenantId: TenantId,
  batchIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(batchIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM payroll_disbursement_batches
     WHERE tenant_id = ${tenantId}::uuid
       AND id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY id
       FOR UPDATE`);
}

/** Fills the missing hashes of one key's file row and claim, under its hash locks. */
export async function completeKey(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  key: string,
  storedSha: string,
  now: Date,
): Promise<{ file: boolean; claim: boolean; conflict: boolean }> {
  // The stored bytes are the one hash every case has; the upload hash of an
  // old image is unknown (only the stored copy is left), so it takes the same.
  await lockBatchesBeforeHashes(tx, tenantId, [batchId]);
  const known = await proofFingerprints(tx, tenantId, key);
  await lockProofFingerprints(tx, tenantId, [storedSha, ...known]);
  const file = await writeFileRecord(
    tx,
    tenantId,
    batchId,
    key,
    storedSha,
    now,
  );
  const [record] = await tx
    .select({
      content: payrollPayoutEvidenceFiles.contentSha256,
      stored: payrollPayoutEvidenceFiles.storedSha256,
    })
    .from(payrollPayoutEvidenceFiles)
    .where(
      and(
        eq(payrollPayoutEvidenceFiles.tenantId, tenantId),
        eq(payrollPayoutEvidenceFiles.evidenceKey, key),
      ),
    );
  if (!record?.stored) return { file, claim: false, conflict: false };
  const [claim] = await tx
    .select({
      id: payrollPayoutReturnClaims.id,
      content: payrollPayoutReturnClaims.contentSha256,
      stored: payrollPayoutReturnClaims.storedSha256,
    })
    .from(payrollPayoutReturnClaims)
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        eq(payrollPayoutReturnClaims.evidenceKey, key),
      ),
    );
  if (!claim || (claim.content !== null && claim.stored !== null))
    return { file, claim: false, conflict: false };
  const content = claim.content ?? record.content;
  const stored = claim.stored ?? record.stored;
  // Another claim already holding one of these hashes is the very reuse this
  // fixes: leave the claim open to a human, never guess which one is right.
  if (await claimHoldingFingerprint(tx, tenantId, [content, stored], key))
    return { file, claim: false, conflict: true };
  // The claim's hashes are filled by the trusted function from the stored
  // record (legend-i01jp); the application role cannot update return claims.
  const filled = await tx.execute<{ filled: boolean }>(
    sql`SELECT app.payout_backfill_claim_hashes(${claim.id}::uuid) AS filled`,
  );
  if (filled.rows[0]?.filled !== true)
    return { file, claim: false, conflict: false };
  return { file, claim: true, conflict: false };
}

/**
 * Writes the record of a proof key from its stored bytes: a new row when there
 * is none (both hashes are then the stored bytes), else fills in the stored hash
 * of a row that lacks it. True when a row was written or completed. Needs no
 * lock: the unique key makes a race harmless and a value is only ever set once.
 */
export async function writeFileRecord(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  key: string,
  storedSha: string,
  now: Date,
): Promise<boolean> {
  const inserted = await tx
    .insert(payrollPayoutEvidenceFiles)
    .values({
      tenantId,
      batchId,
      evidenceKey: key,
      contentSha256: storedSha,
      storedSha256: storedSha,
      createdBy: "system" as UserId,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: payrollPayoutEvidenceFiles.id });
  if (inserted.length === 1) return true;
  const stamped = await tx
    .update(payrollPayoutEvidenceFiles)
    .set({ storedSha256: storedSha })
    .where(
      and(
        eq(payrollPayoutEvidenceFiles.tenantId, tenantId),
        eq(payrollPayoutEvidenceFiles.evidenceKey, key),
        isNull(payrollPayoutEvidenceFiles.storedSha256),
      ),
    )
    .returning({ id: payrollPayoutEvidenceFiles.id });
  return stamped.length === 1;
}

// ------------------------------------------------ phase 2: historical operations

/** One operation of before the bindings: a proof, the operation it backs, its hashes. */
export type HistoricalOperation = {
  readonly kind: PayoutProofBindingKind;
  readonly batchId: string;
  /** SHA-256 of the sorted item ids joined by "\n" (the formula of bindReturnClaim). */
  readonly itemSetHash: string;
  readonly evidenceKey: string;
  readonly contentSha256: string;
  readonly storedSha256: string;
  readonly createdBy: string;
};

/**
 * `bound`: a binding row was written. `already_bound`: the key already has a
 * binding (this or another operation holds it; safe, nothing to do).
 * `legacy_duplicate`: a hash was already held by another binding, so the row
 * was written with legacy_duplicate = true (the operation is refused at its
 * next step).
 */
export type HistoricalBindOutcome =
  "bound" | "already_bound" | "legacy_duplicate";

/**
 * Writes the binding of one historical operation inside the caller's
 * transaction and its hash locks. The default is `bindHistoricalOperation`;
 * a caller may pass another (the interactive binder of the services).
 */
export type HistoricalProofBinder = (
  tx: Tx,
  tenantId: TenantId,
  operation: HistoricalOperation,
  now: Date,
) => Promise<HistoricalBindOutcome>;

const BINDING_KEY_CONSTRAINT = "payroll_payout_proof_bindings_evidence_key";
const HASH_HELD_CONSTRAINT = "payroll_payout_proof_hashes_pkey";

function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const itemSetHashOf = (itemIds: readonly string[]): string =>
  createHash("sha256")
    .update([...itemIds].sort().join("\n"))
    .digest("hex");

/**
 * The item ids of one historical operation, read where the operation lives
 * (the same sources as `app.payout_proof_operations()`). Fail closed: ids
 * whose set hash differs from the operation's mean the data moved, so nothing
 * is bound (the key is listed as bind_failed).
 */
async function historicalItemIds(
  tx: Tx,
  tenantId: TenantId,
  operation: HistoricalOperation,
): Promise<string[]> {
  const key = operation.evidenceKey;
  const batch = operation.batchId;
  const result =
    operation.kind === "return"
      ? await tx.execute<{ id: string }>(
          sql`SELECT i.id::text AS id FROM payroll_disbursement_items i
               WHERE i.tenant_id = ${tenantId}::uuid AND i.batch_id = ${batch}::uuid
                 AND i.return_evidence_key = ${key}`,
        )
      : operation.kind === "correction"
        ? await tx.execute<{ id: string }>(
            sql`SELECT o.item_id::text AS id
                  FROM payroll_payout_failed_corrections r
                  JOIN payroll_payout_failed_corrections o
                    ON o.tenant_id = r.tenant_id AND o.operation_id = r.id
                 WHERE r.tenant_id = ${tenantId}::uuid AND r.batch_id = ${batch}::uuid
                   AND r.evidence_key = ${key} AND r.operation_id = r.id`,
          )
        : await tx.execute<{ id: string }>(
            sql`SELECT p.item_id::text AS id FROM payroll_payout_overpaid_proposals p
                 WHERE p.tenant_id = ${tenantId}::uuid AND p.batch_id = ${batch}::uuid
                   AND p.evidence_key = ${key}`,
          );
  const ids = result.rows.map((row) => row.id);
  if (ids.length === 0 || itemSetHashOf(ids) !== operation.itemSetHash)
    throw new Error("historical operation item set not found");
  return ids;
}

/**
 * The default binder. The insert runs in a savepoint so a refusal does not
 * poison the transaction: a taken evidence key means it is already bound; a
 * hash held by another binding (the global hash table) is retried once as a
 * legacy duplicate, which the database accepts only for a hash that is held.
 */
export const bindHistoricalOperation: HistoricalProofBinder = async (
  tx,
  tenantId,
  operation,
) => {
  await lockBatchesBeforeHashes(tx, tenantId, [operation.batchId]);
  await lockProofFingerprints(tx, tenantId, [
    operation.contentSha256,
    operation.storedSha256,
  ]);
  // The trusted function (legend-i01jp) writes the binding. It takes the item
  // ids (the operation must exist in app.payout_proof_operations()) and
  // recomputes the item set hash; the hashes come from the evidence record.
  const itemIds = await historicalItemIds(tx, tenantId, operation);
  const insert = (legacyDuplicate: boolean) =>
    tx.transaction((savepoint) =>
      savepoint.execute(
        sql`SELECT app.payout_backfill_bind(${operation.batchId}::uuid, ${operation.kind}::varchar, ${`{${itemIds.join(",")}}`}::uuid[], ${operation.evidenceKey}::varchar, ${legacyDuplicate})`,
      ),
    );
  try {
    await insert(false);
    return "bound";
  } catch (error) {
    const constraint = violatedConstraint(error);
    if (constraint === BINDING_KEY_CONSTRAINT) return "already_bound";
    if (constraint !== HASH_HELD_CONSTRAINT) throw error;
  }
  try {
    await insert(true);
    return "legacy_duplicate";
  } catch (error) {
    if (violatedConstraint(error) === BINDING_KEY_CONSTRAINT)
      return "already_bound";
    throw error;
  }
};

export type HistoricalBindingResult = {
  /** Proof keys looked at this run (each key is one unit: all its operations together). */
  readonly operations: number;
  readonly bound: number;
  /** Operations whose proof was already held by another one (listed as stuck). */
  readonly legacyDuplicates: number;
  /** Keys that more than one operation uses (contested and listed, never auto-resolved). */
  readonly sharedKeys: number;
  /** Keys the binder could not write (listed as bind_failed, retried after a growing delay). */
  readonly failed: number;
};

/** One row of `app.payout_proof_operations()`. */
type OperationRow = {
  readonly kind: PayoutProofBindingKind;
  readonly batchId: string;
  readonly itemSetHash: string;
  readonly evidenceKey: string;
  readonly contentSha256: string | null;
  readonly storedSha256: string | null;
  readonly firstAt: number;
  readonly createdBy: string;
};

const identityOf = (o: {
  kind: string;
  batchId: string;
  itemSetHash: string;
}): string => `${o.kind}|${o.batchId}|${o.itemSetHash}`;

/**
 * One tenant, phase 2. Binds the overpaid, return and correction operations
 * that are not accounted for yet, so their proof cannot back a second
 * operation. An operation is accounted for when its key has a binding that
 * names it or holds a contested hash (`app.payout_proof_operations()` is the
 * one SQL source of operation identity). Only an operation whose proof has both
 * hashes in its record is bound (the rest wait for phase 1). Idempotent: the
 * unique key backs a race.
 * - A key conflict means it is already bound (safe).
 * - A hash conflict writes a legacy duplicate and lists the key as stuck
 *   (reason legacy_duplicate).
 * - A key used by more than one operation (legend-p2v4s F2) is never guessed:
 *   the earliest identity is bound if the key has no binding, the bytes are
 *   contested (every later step over them is refused, in any tenant) and the
 *   key is listed as `shared_key` with every identity. The gate stays clear.
 * - A binder that throws lists the key as `bind_failed` with a growing retry
 *   delay, so failing keys leave the window and the ones behind them are
 *   reached (F6); the global gate still counts them.
 */
export async function bindHistoricalOperations(
  context: ScopedTenantContext,
  now: Date,
  options: {
    binder?: HistoricalProofBinder;
    limit?: number;
  } = {},
): Promise<HistoricalBindingResult> {
  const tenantId = context.tenant.tenantId;
  const binder = options.binder ?? bindHistoricalOperation;
  const limit = options.limit ?? PROOF_FINGERPRINT_KEYS_PER_RUN;
  const groups = await withTenant(db, context, (tx) =>
    unaccountedOperations(tx, tenantId, now, limit),
  );
  let bound = 0;
  let legacyDuplicates = 0;
  let sharedKeys = 0;
  let failed = 0;
  for (const group of groups) {
    const first = group[0]!;
    try {
      const outcome = await withTenant(db, context, (tx) =>
        bindKey(tx, tenantId, group, binder, now),
      );
      bound += outcome === "bound" ? 1 : 0;
      legacyDuplicates += outcome === "legacy_duplicate" ? 1 : 0;
      sharedKeys += outcome === "shared_key" ? 1 : 0;
    } catch {
      // Left unbound (the global gate stays closed); the next keys still run.
      // The key is listed (retry mode: attempts and a growing delay) so finance
      // sees it; a failing list write must not stop the other keys.
      failed += 1;
      await withTenant(db, context, (tx) =>
        markStuck(
          tx,
          tenantId,
          first.batchId,
          first.evidenceKey,
          "bind_failed",
          now,
          "retry",
        ),
      ).catch(() => undefined);
    }
  }
  return {
    operations: groups.length,
    bound,
    legacyDuplicates,
    sharedKeys,
    failed,
  };
}

/** Binds one key (all its operations, earliest first) inside one transaction. */
async function bindKey(
  tx: Tx,
  tenantId: TenantId,
  group: readonly OperationRow[],
  binder: HistoricalProofBinder,
  now: Date,
): Promise<HistoricalBindOutcome | "shared_key"> {
  const key = group[0]!.evidenceKey;
  // Batch rows first (sorted), then the hash locks of the binder, then rows.
  await lockBatchesBeforeHashes(
    tx,
    tenantId,
    group.map((o) => o.batchId),
  );
  // The earliest operation that can be bound (both hashes known) gets the key.
  const candidate = group.find(
    (o) => o.contentSha256 !== null && o.storedSha256 !== null,
  );
  let result: HistoricalBindOutcome = "already_bound";
  if (candidate)
    result = await binder(
      tx,
      tenantId,
      {
        kind: candidate.kind,
        batchId: candidate.batchId,
        itemSetHash: candidate.itemSetHash,
        evidenceKey: key,
        contentSha256: candidate.contentSha256!,
        storedSha256: candidate.storedSha256!,
        createdBy: candidate.createdBy,
      },
      now,
    );
  // Every identity that uses the key: the operations and the binding itself.
  const identities = new Map<
    string,
    { kind: string; batch_id: string; item_set_hash: string }
  >();
  for (const o of group)
    identities.set(identityOf(o), {
      kind: o.kind,
      batch_id: o.batchId,
      item_set_hash: o.itemSetHash,
    });
  const binding = (
    await tx.execute(
      sql`SELECT kind, batch_id, item_set_hash FROM payroll_payout_proof_bindings
           WHERE tenant_id = ${tenantId}::uuid AND evidence_key = ${key}`,
    )
  ).rows[0] as
    { kind: string; batch_id: string; item_set_hash: string } | undefined;
  if (binding)
    identities.set(
      identityOf({
        kind: binding.kind,
        batchId: binding.batch_id,
        itemSetHash: binding.item_set_hash,
      }),
      {
        kind: binding.kind,
        batch_id: binding.batch_id,
        item_set_hash: binding.item_set_hash,
      },
    );
  if (identities.size > 1 && binding) {
    // Same transaction as the binding: the key is never bound and uncontested
    // while the gate could read it as accounted.
    // The trusted function decides from the stored rows of this PT alone and
    // answers whether it contested. A "no" is never listed as a shared key
    // with the hashes uncontested: fail closed, the key is retried as
    // bind_failed (legend-i01jp).
    const contested = await tx.execute<{ contested: boolean }>(
      sql`SELECT app.payout_proof_contest_own(${key}::varchar) AS contested`,
    );
    if (contested.rows[0]?.contested !== true)
      throw new Error("shared key could not be contested");
    await listSharedKey(
      tx,
      tenantId,
      group[0]!.batchId,
      key,
      [...identities.values()],
      now,
    );
    return "shared_key";
  }
  if (result === "legacy_duplicate")
    await markStuck(
      tx,
      tenantId,
      group[0]!.batchId,
      key,
      "legacy_duplicate",
      now,
      "listed",
    );
  else await resolveStuck(tx, tenantId, key, now);
  return result;
}

/**
 * Lists a key that more than one operation uses. Overwrites any other unresolved
 * reason (it says more); `resolveStuck` never closes it.
 */
async function listSharedKey(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  key: string,
  operations: readonly {
    kind: string;
    batch_id: string;
    item_set_hash: string;
  }[],
  now: Date,
): Promise<void> {
  const at = now.toISOString();
  const sorted = [...operations].sort((a, b) =>
    identityOf({
      kind: a.kind,
      batchId: a.batch_id,
      itemSetHash: a.item_set_hash,
    }).localeCompare(
      identityOf({
        kind: b.kind,
        batchId: b.batch_id,
        itemSetHash: b.item_set_hash,
      }),
    ),
  );
  await tx.execute(sql`
    INSERT INTO payroll_payout_proof_backfill_stuck AS s
      (tenant_id, batch_id, evidence_key, reason, attempts, first_seen_at, last_attempt_at, next_attempt_at, operations)
    VALUES (${tenantId}::uuid, ${batchId}::uuid, ${key}, 'shared_key', 1, ${at}::timestamptz, ${at}::timestamptz,
            ${at}::timestamptz, ${JSON.stringify(sorted)}::jsonb)
    ON CONFLICT (tenant_id, evidence_key) DO UPDATE SET
      reason = 'shared_key',
      attempts = CASE WHEN s.resolved_at IS NULL THEN s.attempts + 1 ELSE 1 END,
      first_seen_at = CASE WHEN s.resolved_at IS NULL THEN s.first_seen_at ELSE EXCLUDED.first_seen_at END,
      last_attempt_at = EXCLUDED.last_attempt_at,
      next_attempt_at = EXCLUDED.next_attempt_at,
      operations = EXCLUDED.operations,
      resolved_at = NULL`);
}

/**
 * The operations that are not accounted for yet, grouped by proof key (F2, F6).
 * One query over `app.payout_proof_operations()` picks the keys: an operation
 * is unaccounted when no binding of its key names it or holds a contested hash;
 * keys whose stuck row is backed off are skipped; the never-attempted keys come
 * first, then the ones tried longest ago (so a failing key does not starve the
 * ones behind it), then the oldest. A second query loads every identity of the
 * selected keys, earliest first.
 */
async function unaccountedOperations(
  tx: Tx,
  tenantId: TenantId,
  now: Date,
  limit: number,
): Promise<OperationRow[][]> {
  const at = now.toISOString();
  const picked = (
    await tx.execute(sql`
      SELECT o.evidence_key
        FROM app.payout_proof_operations() o
       WHERE o.content_sha256 IS NOT NULL
         AND o.stored_sha256 IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM payroll_payout_proof_bindings b
            WHERE b.tenant_id = ${tenantId}::uuid AND b.evidence_key = o.evidence_key
              AND ((b.kind = o.kind AND b.batch_id = o.batch_id AND b.item_set_hash = o.item_set_hash)
                   OR app.payout_proof_contested(ARRAY[b.content_sha256, b.stored_sha256]::varchar[])))
         AND NOT EXISTS (
           SELECT 1 FROM payroll_payout_return_claims c
            WHERE c.tenant_id = ${tenantId}::uuid AND c.evidence_key = o.evidence_key
              AND (c.content_sha256 IS NULL OR c.stored_sha256 IS NULL))
         AND NOT EXISTS (
           SELECT 1 FROM payroll_payout_proof_backfill_stuck s
            WHERE s.tenant_id = ${tenantId}::uuid AND s.evidence_key = o.evidence_key
              AND s.resolved_at IS NULL AND s.next_attempt_at > ${at}::timestamptz)
       GROUP BY o.evidence_key
       ORDER BY (SELECT s.last_attempt_at FROM payroll_payout_proof_backfill_stuck s
                  WHERE s.tenant_id = ${tenantId}::uuid AND s.evidence_key = o.evidence_key
                    AND s.resolved_at IS NULL) ASC NULLS FIRST,
                min(o.first_at), o.evidence_key
       LIMIT ${limit}`)
  ).rows as { evidence_key: string }[];
  if (picked.length === 0) return [];
  const rows = (
    await tx.execute(sql`
      SELECT o.kind, o.batch_id, o.item_set_hash, o.evidence_key, o.content_sha256,
             o.stored_sha256, o.first_at, o.created_by
        FROM app.payout_proof_operations() o
       WHERE o.evidence_key IN (${sql.join(
         picked.map((row) => sql`${row.evidence_key}`),
         sql`, `,
       )})`)
  ).rows as {
    kind: PayoutProofBindingKind;
    batch_id: string;
    item_set_hash: string;
    evidence_key: string;
    content_sha256: string | null;
    stored_sha256: string | null;
    first_at: Date | string;
    created_by: string;
  }[];
  const byKey = new Map<string, OperationRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.evidence_key) ?? [];
    list.push({
      kind: row.kind,
      batchId: row.batch_id,
      itemSetHash: row.item_set_hash,
      evidenceKey: row.evidence_key,
      contentSha256: row.content_sha256,
      storedSha256: row.stored_sha256,
      firstAt: new Date(row.first_at).getTime(),
      createdBy: row.created_by,
    });
    byKey.set(row.evidence_key, list);
  }
  return picked.flatMap(({ evidence_key }) => {
    const list = byKey.get(evidence_key);
    if (!list) return [];
    list.sort(
      (a, b) =>
        a.firstAt - b.firstAt || identityOf(a).localeCompare(identityOf(b)),
    );
    return [list];
  });
}
