// Payout proof fingerprints (bead legend-8vcsg; second opinion payout area
// final, two P2 proof findings).
//
// A proof (an object under `tenants/<t>/payroll-payout/<batch>/`) carries two
// SHA-256 hashes in `payroll_payout_evidence_files`: of the bytes as uploaded
// (`content_sha256`) and of the bytes as stored (`stored_sha256`; a JPEG or PNG
// is re-encoded, a PDF is stored as is). A proof is the SAME proof as a used one
// when any of its hashes equals any hash of the used one, so the stored copy of
// an image can be neither downloaded and uploaded again nor used under a new key.
//
// Proofs from before the fingerprints (migration 0382, or the stored hash of
// 0631) lack hashes. `backfillProofFingerprints`
// (payroll-payout-proof-backfill.service.ts) reads their stored objects and
// fills the hashes in (a claim or file row only goes from NULL to a value; an
// item evidence key without a record gets one). The state "backfill not
// finished" is derived from the data, not stored (`countFingerprintTargets`):
// a return claim lacking a hash, a proof record lacking the stored hash, or an
// item evidence key without a record, or an operation proof key without a
// binding (legend-so897). While any exists, a return, an overpaid record or a
// correction is refused (fail closed; payroll-payout-proof-binding.service.ts);
// confirm and resolve are never held. A
// target that cannot be completed (object missing, or a claim hash that already
// belongs to another claim) stays on purpose: the tenant stays closed and the
// job names the counts, for a human to settle.

import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { ObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext, TenantId } from "@starter/shared/core";
import {
  payrollPayoutEvidenceFiles,
  payrollPayoutFailedCorrections,
  payrollPayoutReturnClaims,
} from "../db/schema/payroll-payout.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./hris-access.ts";
import { writeFileRecord } from "./payroll-payout-proof-backfill.service.ts";

/**
 * SHA-256 of zero bytes. An upload refuses an empty file, so an empty object is
 * no proof and this hash never identifies one: it is recorded (a claim over an
 * object that has no content still carries both hashes) but never matched, and
 * the unique indexes on the claim hashes skip it.
 */
export const EMPTY_CONTENT_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Transaction-scoped lock on one proof content, so two operations cannot both
 * pass the reuse checks. The key carries no tenant (legend-so897 F2): a proof
 * hash belongs to one binding across all tenants, and advisory locks are
 * cluster-wide, so two PTs using the same bytes serialize here too.
 */
export async function lockProofFingerprint(tx: Tx, sha: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout-proof:${sha}`}, 0))`,
  );
}

/**
 * Locks every hash once, in ascending order (two operations over shared files
 * cannot deadlock). `tenantId` is kept for the callers; it is not in the key.
 */
export async function lockProofFingerprints(
  tx: Tx,
  tenantId: TenantId,
  shas: Iterable<string>,
): Promise<void> {
  for (const sha of [...new Set(shas)].sort())
    await lockProofFingerprint(tx, sha);
}

/** The recorded hashes of an evidence key; null for a proof without a record (a legacy key nothing has read yet). */
export async function proofFingerprintRecord(
  tx: Tx,
  tenantId: TenantId,
  evidence: string,
): Promise<{ content: string; stored: string | null } | null> {
  const [file] = await tx
    .select({
      content: payrollPayoutEvidenceFiles.contentSha256,
      stored: payrollPayoutEvidenceFiles.storedSha256,
    })
    .from(payrollPayoutEvidenceFiles)
    .where(
      and(
        eq(payrollPayoutEvidenceFiles.tenantId, tenantId),
        eq(payrollPayoutEvidenceFiles.evidenceKey, evidence),
      ),
    );
  return file ?? null;
}

/** The distinct hashes (uploaded bytes, stored bytes) of an evidence key; empty without a record. */
export async function proofFingerprints(
  tx: Tx,
  tenantId: TenantId,
  evidence: string,
): Promise<string[]> {
  const record = await proofFingerprintRecord(tx, tenantId, evidence);
  if (!record) return [];
  return [...new Set([record.content, record.stored].filter(isMatchable))];
}

const isMatchable = (value: string | null): value is string =>
  value !== null && value !== EMPTY_CONTENT_SHA256;

/** Other evidence keys whose record holds any of these hashes (the same proof under a new key). */
export async function twinEvidenceKeys(
  tx: Tx,
  tenantId: TenantId,
  shas: readonly string[],
  exceptEvidence: string,
): Promise<string[]> {
  if (shas.length === 0) return [];
  const twins = await tx
    .select({ key: payrollPayoutEvidenceFiles.evidenceKey })
    .from(payrollPayoutEvidenceFiles)
    .where(
      and(
        eq(payrollPayoutEvidenceFiles.tenantId, tenantId),
        ne(payrollPayoutEvidenceFiles.evidenceKey, exceptEvidence),
        or(
          inArray(payrollPayoutEvidenceFiles.contentSha256, [...shas]),
          inArray(payrollPayoutEvidenceFiles.storedSha256, [...shas]),
        ),
      ),
    );
  return twins.map((twin) => twin.key);
}

/** What still waits for a fingerprint in one tenant (the targets of the backfill job). */
export type FingerprintTargetCounts = {
  /** Return claims lacking the uploaded or the stored hash. */
  readonly claimsWithoutHash: number;
  /** Proof records lacking the stored hash (written before 0631). */
  readonly filesWithoutStoredHash: number;
  /** Evidence keys of items (resolve, confirm, return) without any proof record. */
  readonly itemKeysWithoutRecord: number;
  /**
   * Evidence keys of operations (return claims, item return proofs, corrections,
   * overpaid proposals) without a proof binding of that key (legend-so897 F1).
   */
  readonly opKeysWithoutBinding: number;
  readonly total: number;
};

/** Counts are capped: the gate only needs to know "none or some", the job log a size. */
const TARGET_COUNT_CAP = 1000;

/**
 * The gate and the backfill job use the same four sets: a return claim without
 * a hash, a proof record without the stored hash, an item evidence key without a
 * record, an operation proof key without a binding. A return, overpaid record or
 * correction waits while any is non-empty
 * (payroll-payout-proof-binding.service.ts).
 */
export async function countFingerprintTargets(
  tx: Tx,
  tenantId: TenantId,
): Promise<FingerprintTargetCounts> {
  const count = async (query: ReturnType<typeof sql>) => {
    const result = await tx.execute(query);
    return Number((result.rows[0] as { n: number | string }).n);
  };
  const claimsWithoutHash = await count(
    sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM payroll_payout_return_claims WHERE tenant_id = ${tenantId} AND (content_sha256 IS NULL OR stored_sha256 IS NULL) LIMIT ${TARGET_COUNT_CAP}) t`,
  );
  const filesWithoutStoredHash = await count(
    sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM payroll_payout_evidence_files WHERE tenant_id = ${tenantId} AND stored_sha256 IS NULL LIMIT ${TARGET_COUNT_CAP}) t`,
  );
  const itemKeysWithoutRecord = await count(
    sql`SELECT count(*)::int AS n FROM (
      SELECT k FROM (
        SELECT resolution_evidence_key AS k FROM payroll_disbursement_items WHERE tenant_id = ${tenantId} AND resolution_evidence_key IS NOT NULL
        UNION SELECT confirmation_evidence_key FROM payroll_disbursement_items WHERE tenant_id = ${tenantId} AND confirmation_evidence_key IS NOT NULL
        UNION SELECT return_evidence_key FROM payroll_disbursement_items WHERE tenant_id = ${tenantId} AND return_evidence_key IS NOT NULL
      ) keys
      WHERE NOT EXISTS (SELECT 1 FROM payroll_payout_evidence_files f WHERE f.tenant_id = ${tenantId} AND f.evidence_key = keys.k)
      LIMIT ${TARGET_COUNT_CAP}
    ) t`,
  );
  const opKeysWithoutBinding = await count(
    sql`SELECT count(*)::int AS n FROM (
      SELECT k FROM (
        SELECT evidence_key AS k FROM payroll_payout_return_claims WHERE tenant_id = ${tenantId}
        UNION SELECT return_evidence_key FROM payroll_disbursement_items WHERE tenant_id = ${tenantId} AND return_evidence_key IS NOT NULL
        UNION SELECT evidence_key FROM payroll_payout_failed_corrections WHERE tenant_id = ${tenantId}
        UNION SELECT evidence_key FROM payroll_payout_overpaid_proposals WHERE tenant_id = ${tenantId}
      ) keys
      WHERE NOT EXISTS (SELECT 1 FROM payroll_payout_proof_bindings b WHERE b.tenant_id = ${tenantId} AND b.evidence_key = keys.k)
      LIMIT ${TARGET_COUNT_CAP}
    ) t`,
  );
  return {
    claimsWithoutHash,
    filesWithoutStoredHash,
    itemKeysWithoutRecord,
    opKeysWithoutBinding,
    total:
      claimsWithoutHash +
      filesWithoutStoredHash +
      itemKeysWithoutRecord +
      opKeysWithoutBinding,
  };
}

/** A claim of ANOTHER proof key holding any of these hashes (either column). */
export async function claimHoldingFingerprint(
  tx: Tx,
  tenantId: TenantId,
  shas: readonly string[],
  exceptEvidence: string,
): Promise<boolean> {
  if (shas.length === 0) return false;
  const [claim] = await tx
    .select({ id: payrollPayoutReturnClaims.id })
    .from(payrollPayoutReturnClaims)
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        ne(payrollPayoutReturnClaims.evidenceKey, exceptEvidence),
        or(
          inArray(payrollPayoutReturnClaims.contentSha256, [...shas]),
          inArray(payrollPayoutReturnClaims.storedSha256, [...shas]),
        ),
      ),
    )
    .limit(1);
  return claim !== undefined;
}

/**
 * True when a failed-item correction (legend-mejr2), proposed or approved,
 * already holds this proof: by its key, or by either hash (the same file under
 * a new key). A proof bound to one correction backs nothing else.
 */
export async function correctionHoldingProof(
  tx: Tx,
  tenantId: TenantId,
  evidence: string,
  shas: readonly string[],
): Promise<boolean> {
  const [row] = await tx
    .select({ id: payrollPayoutFailedCorrections.id })
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        or(
          eq(payrollPayoutFailedCorrections.evidenceKey, evidence),
          shas.length > 0
            ? inArray(payrollPayoutFailedCorrections.contentSha256, [...shas])
            : undefined,
          shas.length > 0
            ? inArray(payrollPayoutFailedCorrections.storedSha256, [...shas])
            : undefined,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// The sweep itself lives in payroll-payout-proof-backfill.service.ts; it is
// re-exported here so existing imports keep working.
export {
  backfillProofFingerprints,
  completeKey,
  PROOF_FINGERPRINT_KEYS_PER_RUN,
  type ProofFingerprintBackfillResult,
  writeFileRecord,
} from "./payroll-payout-proof-backfill.service.ts";

/** SHA-256 (hex) of a proof's bytes. */
export const sha256Of = (content: Uint8Array | string): string =>
  createHash("sha256").update(content).digest("hex");

/** 409 PAYOUT_PROOF_FINGERPRINT_PENDING: the proof's hashes cannot be read or settled now (retryable). */
export const proofFingerprintPending = () =>
  new HttpError(
    409,
    "PAYOUT_PROOF_FINGERPRINT_PENDING",
    "Bukti ini belum bisa diperiksa sidik jarinya. Coba lagi sebentar lagi.",
  );

type ProofStore = {
  readonly storage: ObjectStorage | null | undefined;
  readonly context: ScopedTenantContext;
};

type ProofRecord = { content: string; stored: string | null };

/**
 * Records the fingerprints of several proofs in ONE lock order (legend-so900
 * F7): the advisory hash locks of every proof of the call (sorted) first, then
 * the record rows. The backfill takes the same order, so the two never deadlock.
 *
 * 1. reads the records; 2. reads the storage for the keys without a stored hash
 * (strict: a missing storage or a failed read is 409 PENDING; lenient: the key
 * is skipped); 3. locks the union of the known and read hashes; 4. writes the
 * records (a NULL only goes to a value); 5. re-reads them: a hash outside the
 * locked set (a rival wrote another record in between) is 409 PENDING, strict
 * and lenient. Returns the records after the write (null: still none).
 */
export async function recordProofFingerprints(
  tx: Tx,
  store: ProofStore,
  tenantId: TenantId,
  batchId: string,
  keys: Iterable<string>,
  now: Date,
  options: { readonly strict: boolean },
): Promise<Map<string, ProofRecord | null>> {
  const unique = [...new Set(keys)];
  const before = new Map<string, ProofRecord | null>();
  for (const key of unique)
    before.set(key, await proofFingerprintRecord(tx, tenantId, key));

  const read = new Map<string, string>();
  for (const [key, record] of before) {
    if (record?.stored) continue;
    if (!store.storage) {
      if (options.strict) throw proofFingerprintPending();
      continue;
    }
    try {
      const object = await store.storage.get(store.context, {
        tenantId,
        outletId: null,
        reference: "payout-evidence-fingerprint",
        key,
        visibility: "private",
      });
      read.set(key, sha256Of(object.content));
    } catch {
      if (options.strict) throw proofFingerprintPending();
    }
  }

  const locked = new Set<string>(read.values());
  for (const record of before.values())
    for (const sha of [record?.content ?? null, record?.stored ?? null])
      if (sha !== null) locked.add(sha);
  locked.delete(EMPTY_CONTENT_SHA256);
  await lockProofFingerprints(tx, tenantId, locked);

  for (const [key, storedSha] of read)
    await writeFileRecord(tx, tenantId, batchId, key, storedSha, now);

  const after = new Map<string, ProofRecord | null>();
  for (const key of unique) {
    // Every key, written or not: a record a rival added meanwhile is held too.
    const record = await proofFingerprintRecord(tx, tenantId, key);
    for (const sha of [record?.content ?? null, record?.stored ?? null])
      if (sha !== null && sha !== EMPTY_CONTENT_SHA256 && !locked.has(sha))
        throw proofFingerprintPending();
    after.set(key, record);
  }
  return after;
}

/**
 * Before a return claim is made for a proof (legend-8vcsg): a proof without a
 * complete record (a key uploaded before the fingerprints, or a fixture) is
 * read from the storage and recorded now, so the claim ALWAYS carries both
 * hashes and a later re-upload is recognised. An object that cannot be read
 * leaves the record as it is. Never changes an existing hash. The lenient
 * one-key form of `recordProofFingerprints` (hash locks before the row).
 */
export async function ensureProofFingerprintRecord(
  tx: Tx,
  store: ProofStore,
  tenantId: TenantId,
  batchId: string,
  key: string,
  now: Date,
): Promise<void> {
  await recordProofFingerprints(tx, store, tenantId, batchId, [key], now, {
    strict: false,
  });
}
