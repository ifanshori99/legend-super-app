// Payout proof fingerprint backfill (bead legend-8vcsg; moved out of
// payroll-payout-proof-fingerprint.service.ts for legend-so897, no behaviour
// change). `backfillProofFingerprints` reads the stored objects of proofs that
// lack a hash and fills the hashes in (a claim or file row only goes from NULL
// to a value; an item evidence key without a record gets one). See the header
// of payroll-payout-proof-fingerprint.service.ts for the gate it feeds.

import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
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
  payrollPayoutReturnClaims,
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
  /** Keys whose object could not be read (left as they are, retried next run). */
  readonly unreadable: number;
  /** Claims whose hash already belongs to another claim (left for a human). */
  readonly conflicts: number;
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
          ),
        )
        .orderBy(asc(payrollPayoutReturnClaims.createdAt))
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
          ),
        )
        .orderBy(asc(payrollPayoutEvidenceFiles.createdAt))
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
      continue;
    }
    const outcome = await withTenant(db, context, (tx) =>
      completeKey(tx, tenantId, batchId, key, storedSha, now),
    );
    files += outcome.file ? 1 : 0;
    claims += outcome.claim ? 1 : 0;
    conflicts += outcome.conflict ? 1 : 0;
  }
  const held = await withTenant(db, context, (tx) =>
    countFingerprintTargets(tx, tenantId),
  );
  return {
    keys: targets.length,
    files,
    claims,
    unreadable,
    conflicts,
    held,
  };
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
