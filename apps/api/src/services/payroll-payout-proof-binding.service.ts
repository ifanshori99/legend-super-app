// Payout proof binding: one bank proof backs ONE operation (legend-so897 F1,
// F2 and F3; migration 0395).
//
// An operation is (kind, batch, item set): an overpaid record, a return or a
// failed-item correction over one set of items. Both steps of every operation
// call `bindProofToOperation` before they write anything. The first call writes
// one `payroll_payout_proof_bindings` row for the proof key; a later call with
// the same key and the same operation (step two) reuses it. Any other operation
// meeting that proof (by key, by uploaded bytes or by stored bytes, either hash
// against either hash) is refused 409 PAYOUT_PROOF_REUSED and changes nothing.
//
// The hashes are global: an AFTER INSERT trigger claims them in
// `payroll_payout_proof_hashes` (no tenant, no app privilege), so the same bytes
// cannot back an operation in another PT either. That refusal is a unique
// violation on the hash table's key, mapped here to the same text as a reuse
// inside the tenant: it says nothing about the holder.
//
// Fail closed (F3): the proof's record must carry both hashes. A proof without
// one is read from the storage now; when that read fails the operation waits
// (409 PAYOUT_PROOF_FINGERPRINT_PENDING) and nothing is written.

import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import {
  payrollPayoutProofBindings,
  type PayoutProofBindingKind,
} from "../db/schema/payroll-payout.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./hris-access.ts";
import type { PayoutEvidenceStore } from "./payroll-payout-evidence.ts";
import {
  EMPTY_CONTENT_SHA256,
  lockProofFingerprints,
  proofFingerprintPending,
  recordProofFingerprints,
} from "./payroll-payout-proof-fingerprint.service.ts";

export const PROOF_REUSED_TEXT = "Bukti ini sudah dipakai untuk operasi lain.";

/** 409 PAYOUT_PROOF_REUSED: the same text inside the tenant and across tenants. */
export const refuseProofReused = () =>
  new HttpError(409, "PAYOUT_PROOF_REUSED", PROOF_REUSED_TEXT);

const fingerprintsHeld = () =>
  new HttpError(
    409,
    "PAYOUT_PROOF_FINGERPRINT_PENDING",
    "Bukti lama sedang diperiksa sidik jarinya. Pencatatan dengan bukti baru ditahan sampai selesai; coba lagi sebentar lagi.",
  );

/** SHA-256 of the sorted item ids joined by "\n" (the same formula as the return claim). */
export function itemSetHashOf(itemIds: readonly string[]): string {
  return createHash("sha256")
    .update([...itemIds].sort().join("\n"))
    .digest("hex");
}

export type ProofFingerprint = {
  readonly content: string;
  readonly stored: string;
};

/**
 * The proof's two hashes, both present (return, overpaid and correction; confirm
 * and resolve keep the lenient `ensureProofFingerprintRecord`). A proof without
 * a complete record is read from the storage and recorded now. No storage, a
 * failed read, or a record still incomplete after the write: 409
 * PAYOUT_PROOF_FINGERPRINT_PENDING, nothing written. An empty object (both
 * hashes of zero bytes) is no proof: 422 PAYOUT_EVIDENCE_INVALID.
 */
export async function requireProofFingerprintRecord(
  tx: Tx,
  store: PayoutEvidenceStore,
  tenantId: TenantId,
  batchId: string,
  key: string,
  now: Date,
): Promise<ProofFingerprint> {
  // Strict form of the one lock order (legend-so900 F7): the hash locks
  // (sorted) before the record's unique key, as in the backfill's completeKey.
  const record = (
    await recordProofFingerprints(tx, store, tenantId, batchId, [key], now, {
      strict: true,
    })
  ).get(key);
  if (!record?.content || !record.stored) throw proofFingerprintPending();
  if (
    record.content === EMPTY_CONTENT_SHA256 &&
    record.stored === EMPTY_CONTENT_SHA256
  )
    throw new HttpError(
      422,
      "PAYOUT_EVIDENCE_INVALID",
      "Berkas bukti kosong. Unggah bukti transfer bank yang sebenarnya.",
    );
  return { content: record.content, stored: record.stored };
}

function isProofClaimViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      code === "23505" &&
      (constraint === "payroll_payout_proof_hashes_pkey" ||
        constraint === "payroll_payout_proof_bindings_evidence_key")
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True while any tenant has unfinished proof history (migration 0399; one boolean, nothing of the tenant). */
async function proofHistoryPending(tx: Tx): Promise<boolean> {
  const result = await tx.execute<{ pending: boolean }>(
    sql`SELECT app.payout_proof_history_pending() AS pending`,
  );
  return result.rows[0]?.pending === true;
}

/** True when a legacy duplicate in any tenant contested one of these hashes (migration 0398; says nothing about the holder). */
async function proofContested(
  tx: Tx,
  shas: readonly string[],
): Promise<boolean> {
  if (shas.length === 0) return false;
  const result = await tx.execute<{ contested: boolean }>(
    sql`SELECT app.payout_proof_contested(${`{${shas.join(",")}}`}::varchar[]) AS contested`,
  );
  return result.rows[0]?.contested === true;
}

export type ProofOperation = {
  readonly kind: PayoutProofBindingKind;
  readonly batchId: string;
  readonly evidenceKey: string;
  readonly itemIds: readonly string[];
  readonly actorId: UserId;
  readonly now: Date;
};

export type BoundProof = ProofFingerprint & {
  readonly bindingId: string;
  /** The distinct hashes that identify the proof (zero-byte hash left out); all locked. */
  readonly shas: readonly string[];
};

/**
 * Binds the proof to this operation, or confirms it is already bound to it
 * (see the file header). Call under the run, batch and item row locks; takes
 * the proof's advisory locks itself (sorted), then holds every tenant while
 * older operations in any tenant still lack a binding or a fingerprint (409
 * PENDING). Throws 409
 * PAYOUT_PROOF_REUSED when the proof backs any other operation, here or in
 * another tenant, or a historical duplicate, or a legacy duplicate contested
 * its hashes in any tenant.
 */
export async function bindProofToOperation(
  tx: Tx,
  store: PayoutEvidenceStore,
  tenantId: TenantId,
  op: ProofOperation,
): Promise<BoundProof> {
  const record = await requireProofFingerprintRecord(
    tx,
    store,
    tenantId,
    op.batchId,
    op.evidenceKey,
    op.now,
  );
  const shas = [
    ...new Set(
      [record.content, record.stored].filter(
        (sha) => sha !== EMPTY_CONTENT_SHA256,
      ),
    ),
  ];
  // Two operations over the same bytes serialize here, in every tenant (lock
  // order: run row, batch row, item rows, proof advisory).
  await lockProofFingerprints(tx, tenantId, shas);
  // Fail closed, globally (legend-so900 F1): while any PT still has a proof or
  // an operation without a fingerprint or an accounted binding, the checks
  // below cannot see it, so a new operation waits. Read AFTER the hash locks:
  // a sweep that claims these bytes either has committed (seen as REUSED
  // below) or still counts as pending here. One boolean, the same text for the
  // caller's own history and another PT's.
  if (await proofHistoryPending(tx)) throw fingerprintsHeld();
  // A legacy duplicate somewhere (any tenant) found these bytes already held:
  // the proof backed two operations before the bindings, so no step of any
  // operation over it goes on, the holder's own included (review P2-1).
  if (await proofContested(tx, shas)) throw refuseProofReused();

  const itemSetHash = itemSetHashOf(op.itemIds);
  const held = await tx
    .select()
    .from(payrollPayoutProofBindings)
    .where(
      and(
        eq(payrollPayoutProofBindings.tenantId, tenantId),
        or(
          eq(payrollPayoutProofBindings.evidenceKey, op.evidenceKey),
          inArray(payrollPayoutProofBindings.contentSha256, shas),
          inArray(payrollPayoutProofBindings.storedSha256, shas),
        ),
      ),
    );
  for (const binding of held)
    if (
      binding.legacyDuplicate ||
      binding.kind !== op.kind ||
      binding.batchId !== op.batchId ||
      binding.itemSetHash !== itemSetHash
    )
      throw refuseProofReused();
  const own = held.find((binding) => binding.evidenceKey === op.evidenceKey);
  if (own) return { ...record, shas, bindingId: own.id };

  try {
    // The binding is written by the trusted function (legend-i01jp): it reads
    // the hashes from the stored evidence record, re-checks the kind, batch and
    // item set, and the application role has no INSERT on the table. The
    // savepoint keeps a refusal from poisoning the caller's transaction.
    const inserted = await tx.transaction(async (savepoint) => {
      const result = await savepoint.execute<{ id: string }>(
        sql`SELECT app.payout_bind_proof(${op.batchId}::uuid, ${op.kind}::varchar, ${`{${[...op.itemIds].join(",")}}`}::uuid[], ${op.evidenceKey}::varchar, ${op.actorId}) AS id`,
      );
      return result.rows[0];
    });
    if (!inserted?.id) throw refuseProofReused();
    return { ...record, shas, bindingId: inserted.id };
  } catch (error) {
    // A hash held by another binding (another key here, or another tenant).
    if (isProofClaimViolation(error)) throw refuseProofReused();
    throw error;
  }
}
