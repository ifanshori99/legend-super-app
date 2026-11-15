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
// operations that existed before bindings (overpaid, return, correction).

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
  payrollPayoutFailedCorrections,
  payrollPayoutOverpaidProposals,
  payrollPayoutProofBackfillStuck,
  payrollPayoutProofBindings,
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
 * unresolved row, so the reason that holds the key stays.
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
      reason = EXCLUDED.reason,
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
  await tx
    .update(payrollPayoutReturnClaims)
    .set({ contentSha256: content, storedSha256: stored })
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        eq(payrollPayoutReturnClaims.id, claim.id),
      ),
    );
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
 * The default binder. The insert runs in a savepoint so a refusal does not
 * poison the transaction: a taken evidence key means it is already bound; a
 * hash held by another binding (the global hash table) is retried once as a
 * legacy duplicate, which the database accepts only for a hash that is held.
 */
export const bindHistoricalOperation: HistoricalProofBinder = async (
  tx,
  tenantId,
  operation,
  now,
) => {
  await lockProofFingerprints(tx, tenantId, [
    operation.contentSha256,
    operation.storedSha256,
  ]);
  const insert = (legacyDuplicate: boolean) =>
    tx.transaction((savepoint) =>
      savepoint.insert(payrollPayoutProofBindings).values({
        tenantId,
        batchId: operation.batchId,
        kind: operation.kind,
        itemSetHash: operation.itemSetHash,
        evidenceKey: operation.evidenceKey,
        contentSha256: operation.contentSha256,
        storedSha256: operation.storedSha256,
        legacyDuplicate,
        createdBy: operation.createdBy as UserId,
        createdAt: now,
      }),
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
  /** Operations looked at this run. */
  readonly operations: number;
  readonly bound: number;
  /** Operations whose proof was already held by another one (listed as stuck). */
  readonly legacyDuplicates: number;
  /** Operations the binder could not write (left unbound, retried next run). */
  readonly failed: number;
};

/**
 * One tenant, phase 2. Binds the overpaid, return and correction operations
 * that have no binding yet, so their proof cannot back a second operation.
 * Only an operation whose proof has both hashes in its upload record is bound
 * (the rest wait for phase 1; a return claim must carry both hashes too). The
 * item set hash is computed here from the item ids. Idempotent: an operation
 * whose key has a binding is not selected, and the unique key backs a race.
 * A key conflict means it is already bound (safe). A hash conflict writes a
 * legacy duplicate and lists the key as stuck (reason legacy_duplicate).
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
  const operations = await withTenant(db, context, (tx) =>
    unboundOperations(tx, tenantId, limit),
  );
  let bound = 0;
  let legacyDuplicates = 0;
  let failed = 0;
  for (const operation of operations) {
    try {
      const outcome = await withTenant(db, context, async (tx) => {
        const result = await binder(tx, tenantId, operation, now);
        if (result === "legacy_duplicate")
          await markStuck(
            tx,
            tenantId,
            operation.batchId,
            operation.evidenceKey,
            "legacy_duplicate",
            now,
            "listed",
          );
        else await resolveStuck(tx, tenantId, operation.evidenceKey, now);
        return result;
      });
      bound += outcome === "bound" ? 1 : 0;
      legacyDuplicates += outcome === "legacy_duplicate" ? 1 : 0;
    } catch {
      // Left unbound (the tenant stays held); the next operations still run.
      // The key is listed (retry mode: attempts and a growing delay) so finance
      // sees it; a failing list write must not stop the other operations. The
      // schema has no reason of its own for a failed binding, so it is listed
      // as "unreadable": the proof could not be processed.
      failed += 1;
      await withTenant(db, context, (tx) =>
        markStuck(
          tx,
          tenantId,
          operation.batchId,
          operation.evidenceKey,
          "unreadable",
          now,
          "retry",
        ),
      ).catch(() => undefined);
    }
  }
  return { operations: operations.length, bound, legacyDuplicates, failed };
}

/** Operations without a binding, one per proof key (returns, corrections, then overpaid). */
async function unboundOperations(
  tx: Tx,
  tenantId: TenantId,
  limit: number,
): Promise<HistoricalOperation[]> {
  const unbound = (table: string, key: string) =>
    sql`NOT EXISTS (SELECT 1 FROM ${sql.raw(
      "payroll_payout_proof_bindings",
    )} b WHERE b.tenant_id = ${sql.raw(table)}.tenant_id AND b.evidence_key = ${sql.raw(table)}.${sql.raw(key)})`;
  const found = new Map<string, HistoricalOperation>();
  const add = (operation: HistoricalOperation) => {
    if (!found.has(operation.evidenceKey))
      found.set(operation.evidenceKey, operation);
  };
  // Returns: the claim carries the item set hash; the hashes must be filled in
  // (phase 1 done) and be those of the upload record, which the database checks.
  const claims = await tx
    .select({
      batchId: payrollPayoutReturnClaims.batchId,
      itemSetHash: payrollPayoutReturnClaims.itemSetHash,
      evidenceKey: payrollPayoutReturnClaims.evidenceKey,
      content: payrollPayoutEvidenceFiles.contentSha256,
      stored: payrollPayoutEvidenceFiles.storedSha256,
      createdBy: payrollPayoutReturnClaims.createdBy,
    })
    .from(payrollPayoutReturnClaims)
    .innerJoin(
      payrollPayoutEvidenceFiles,
      and(
        eq(
          payrollPayoutEvidenceFiles.tenantId,
          payrollPayoutReturnClaims.tenantId,
        ),
        eq(
          payrollPayoutEvidenceFiles.evidenceKey,
          payrollPayoutReturnClaims.evidenceKey,
        ),
      ),
    )
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        isNotNull(payrollPayoutReturnClaims.contentSha256),
        isNotNull(payrollPayoutReturnClaims.storedSha256),
        isNotNull(payrollPayoutEvidenceFiles.storedSha256),
        unbound("payroll_payout_return_claims", "evidence_key"),
      ),
    )
    .orderBy(asc(payrollPayoutReturnClaims.createdAt))
    .limit(limit);
  for (const claim of claims)
    if (claim.stored !== null)
      add({
        kind: "return",
        batchId: claim.batchId,
        itemSetHash: claim.itemSetHash,
        evidenceKey: claim.evidenceKey,
        contentSha256: claim.content,
        storedSha256: claim.stored,
        createdBy: claim.createdBy,
      });
  // Item returns from before the claims (pre-0381): the item carries the proof
  // key and no claim row exists. The items that share the key and batch are one
  // operation; the proof record must have its stored hash (phase 1 done).
  const legacyReturns = await tx
    .select({
      batchId: payrollDisbursementItems.batchId,
      evidenceKey: sql<string>`${payrollDisbursementItems.returnEvidenceKey}`,
      content: payrollPayoutEvidenceFiles.contentSha256,
      stored: payrollPayoutEvidenceFiles.storedSha256,
      createdBy: sql<string>`min(coalesce(${payrollDisbursementItems.returnedBy}, ${payrollDisbursementItems.returnedBy2}, 'legacy-backfill'))`,
      itemIds: sql<string[]>`array_agg(${payrollDisbursementItems.id}::text)`,
      firstAt: sql<Date>`min(${payrollDisbursementItems.createdAt})`,
    })
    .from(payrollDisbursementItems)
    .innerJoin(
      payrollPayoutEvidenceFiles,
      and(
        eq(
          payrollPayoutEvidenceFiles.tenantId,
          payrollDisbursementItems.tenantId,
        ),
        eq(
          payrollPayoutEvidenceFiles.evidenceKey,
          payrollDisbursementItems.returnEvidenceKey,
        ),
      ),
    )
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        isNotNull(payrollDisbursementItems.returnEvidenceKey),
        isNotNull(payrollPayoutEvidenceFiles.storedSha256),
        sql`NOT EXISTS (SELECT 1 FROM payroll_payout_return_claims c WHERE c.tenant_id = ${payrollDisbursementItems.tenantId} AND c.evidence_key = ${payrollDisbursementItems.returnEvidenceKey})`,
        unbound("payroll_disbursement_items", "return_evidence_key"),
      ),
    )
    .groupBy(
      payrollDisbursementItems.batchId,
      payrollDisbursementItems.returnEvidenceKey,
      payrollPayoutEvidenceFiles.contentSha256,
      payrollPayoutEvidenceFiles.storedSha256,
    )
    .orderBy(sql`min(${payrollDisbursementItems.createdAt})`)
    .limit(limit);
  for (const group of legacyReturns)
    if (group.stored !== null)
      add({
        kind: "return",
        batchId: group.batchId,
        itemSetHash: itemSetHashOf(group.itemIds),
        evidenceKey: group.evidenceKey,
        contentSha256: group.content,
        storedSha256: group.stored,
        createdBy: group.createdBy,
      });
  // Corrections: the first row of a request holds the proof and its hashes; the
  // items of the request are the rows that share its operation id.
  const firstRows = await tx
    .select({
      id: payrollPayoutFailedCorrections.id,
      batchId: payrollPayoutFailedCorrections.batchId,
      evidenceKey: payrollPayoutFailedCorrections.evidenceKey,
      content: payrollPayoutFailedCorrections.contentSha256,
      stored: payrollPayoutFailedCorrections.storedSha256,
      createdBy: payrollPayoutFailedCorrections.proposedBy,
    })
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        sql`${payrollPayoutFailedCorrections.operationId} = ${payrollPayoutFailedCorrections.id}`,
        unbound("payroll_payout_failed_corrections", "evidence_key"),
      ),
    )
    .orderBy(asc(payrollPayoutFailedCorrections.proposedAt))
    .limit(limit);
  for (const first of firstRows) {
    const items = await tx
      .select({ itemId: payrollPayoutFailedCorrections.itemId })
      .from(payrollPayoutFailedCorrections)
      .where(
        and(
          eq(payrollPayoutFailedCorrections.tenantId, tenantId),
          eq(payrollPayoutFailedCorrections.operationId, first.id),
        ),
      );
    add({
      kind: "correction",
      batchId: first.batchId,
      itemSetHash: itemSetHashOf(items.map((item) => item.itemId)),
      evidenceKey: first.evidenceKey,
      contentSha256: first.content,
      storedSha256: first.stored,
      createdBy: first.createdBy,
    });
  }
  // Overpaid: the proposals of one batch that share a proof are one operation.
  const proposalGroups = await tx
    .select({
      batchId: payrollPayoutOverpaidProposals.batchId,
      evidenceKey: payrollPayoutOverpaidProposals.evidenceKey,
      content: payrollPayoutEvidenceFiles.contentSha256,
      stored: payrollPayoutEvidenceFiles.storedSha256,
      createdBy: sql<string>`(array_agg(${payrollPayoutOverpaidProposals.proposedBy} ORDER BY ${payrollPayoutOverpaidProposals.proposedAt}, ${payrollPayoutOverpaidProposals.id}))[1]`,
      firstAt: sql<Date>`min(${payrollPayoutOverpaidProposals.proposedAt})`,
    })
    .from(payrollPayoutOverpaidProposals)
    .innerJoin(
      payrollPayoutEvidenceFiles,
      and(
        eq(
          payrollPayoutEvidenceFiles.tenantId,
          payrollPayoutOverpaidProposals.tenantId,
        ),
        eq(
          payrollPayoutEvidenceFiles.evidenceKey,
          payrollPayoutOverpaidProposals.evidenceKey,
        ),
      ),
    )
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        isNotNull(payrollPayoutEvidenceFiles.storedSha256),
        unbound("payroll_payout_overpaid_proposals", "evidence_key"),
      ),
    )
    .groupBy(
      payrollPayoutOverpaidProposals.batchId,
      payrollPayoutOverpaidProposals.evidenceKey,
      payrollPayoutEvidenceFiles.contentSha256,
      payrollPayoutEvidenceFiles.storedSha256,
    )
    .orderBy(sql`min(${payrollPayoutOverpaidProposals.proposedAt})`)
    .limit(limit);
  for (const group of proposalGroups) {
    if (group.stored === null) continue;
    const items = await tx
      .select({ itemId: payrollPayoutOverpaidProposals.itemId })
      .from(payrollPayoutOverpaidProposals)
      .where(
        and(
          eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
          eq(payrollPayoutOverpaidProposals.batchId, group.batchId),
          eq(payrollPayoutOverpaidProposals.evidenceKey, group.evidenceKey),
        ),
      );
    add({
      kind: "overpaid",
      batchId: group.batchId,
      itemSetHash: itemSetHashOf(items.map((item) => item.itemId)),
      evidenceKey: group.evidenceKey,
      contentSha256: group.content,
      storedSha256: group.stored,
      createdBy: group.createdBy,
    });
  }
  return [...found.values()].slice(0, limit);
}
