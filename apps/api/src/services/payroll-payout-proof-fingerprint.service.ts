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
// 0631) lack hashes. `backfillProofFingerprints` reads their stored objects and
// fills the hashes in (a claim or file row only goes from NULL to a value; an
// item evidence key without a record gets one). The state "backfill not
// finished" is derived from the data, not stored (`countFingerprintTargets`):
// a return claim lacking a hash, a proof record lacking the stored hash, or an
// item evidence key without a record. While any exists, a RETURN with a proof
// that carries a fingerprint is refused (fail closed;
// payroll-payout-manual.service.ts); confirm and resolve are never held. A
// target that cannot be completed (object missing, or a claim hash that already
// belongs to another claim) stays on purpose: the tenant stays closed and the
// job names the counts, for a human to settle.

import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
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

/**
 * SHA-256 of zero bytes. An upload refuses an empty file, so an empty object is
 * no proof and this hash never identifies one: it is recorded (a claim over an
 * object that has no content still carries both hashes) but never matched, and
 * the unique indexes on the claim hashes skip it.
 */
export const EMPTY_CONTENT_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Transaction-scoped lock on one proof content, so two operations cannot both pass the reuse checks. */
export async function lockProofFingerprint(
  tx: Tx,
  tenantId: TenantId,
  sha: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`payout-proof:${tenantId}:${sha}`}))`,
  );
}

/** Locks every hash once, in ascending order (two operations over shared files cannot deadlock). */
export async function lockProofFingerprints(
  tx: Tx,
  tenantId: TenantId,
  shas: Iterable<string>,
): Promise<void> {
  for (const sha of [...new Set(shas)].sort())
    await lockProofFingerprint(tx, tenantId, sha);
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
  readonly total: number;
};

/** Counts are capped: the gate only needs to know "none or some", the job log a size. */
const TARGET_COUNT_CAP = 1000;

/**
 * The gate and the backfill job use the same three sets: a return claim without
 * a hash, a proof record without the stored hash, an item evidence key without a
 * record. A return with a fingerprinted proof waits while any is non-empty.
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
  return {
    claimsWithoutHash,
    filesWithoutStoredHash,
    itemKeysWithoutRecord,
    total: claimsWithoutHash + filesWithoutStoredHash + itemKeysWithoutRecord,
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

const sha256Of = (content: Uint8Array | string): string =>
  createHash("sha256").update(content).digest("hex");

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
async function completeKey(
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
async function writeFileRecord(
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

/**
 * Before a return claim is made for a proof (legend-8vcsg): a proof without a
 * complete record (a key uploaded before the fingerprints, or a fixture) is
 * read from the storage and recorded now, so the claim ALWAYS carries both
 * hashes and a later re-upload is recognised. An object that cannot be read
 * leaves the record as it is. Never changes an existing hash.
 */
export async function ensureProofFingerprintRecord(
  tx: Tx,
  store: {
    readonly storage: ObjectStorage | null | undefined;
    readonly context: ScopedTenantContext;
  },
  tenantId: TenantId,
  batchId: string,
  key: string,
  now: Date,
): Promise<void> {
  const record = await proofFingerprintRecord(tx, tenantId, key);
  if (record?.stored || !store.storage) return;
  let storedSha: string;
  try {
    const object = await store.storage.get(store.context, {
      tenantId,
      outletId: null,
      reference: "payout-evidence-fingerprint",
      key,
      visibility: "private",
    });
    storedSha = sha256Of(object.content);
  } catch {
    return;
  }
  await writeFileRecord(tx, tenantId, batchId, key, storedSha, now);
}
