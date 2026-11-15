// Payout proof fingerprint backfill (bead legend-8vcsg; design in
// services/payroll-payout-proof-fingerprint.service.ts).
//
// Proofs that existed before the fingerprints (migration 0382 and the stored
// hash of 0389) lack hashes, and a byte-identical re-upload of one would not be
// recognised as the same proof. This sweep (one tenant per call, tenant-wide
// worker context) reads the stored objects of the proof keys that a return
// claim or an item points at and fills the hashes in. Until a tenant's claims
// all carry both hashes, the services refuse a proof that carries a fingerprint
// for that tenant (fail closed), so the sweep is what reopens it.
// - idempotent: only NULL becomes a value, under the proof advisory locks, so a
//   repeat or two overlapping runs add nothing;
// - bounded: at most 200 proof keys per tick per tenant; the rest wait;
// - fail closed per key: an object that cannot be read, or a claim whose hash
//   already belongs to another claim, is left as it is (the tenant stays
//   closed) and is counted in the result for a human. Logs carry no tenant data.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  backfillProofFingerprints,
  type ProofFingerprintBackfillResult,
} from "../services/payroll-payout-proof-fingerprint.service.ts";

export type PayoutEvidenceBackfillResult = ProofFingerprintBackfillResult;

export async function runPayoutEvidenceBackfillSweep(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { storage: ObjectStorage | null | undefined },
): Promise<PayoutEvidenceBackfillResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Payout evidence backfill requires tenant-wide scope");
  const empty = {
    keys: 0,
    files: 0,
    claims: 0,
    unreadable: 0,
    conflicts: 0,
    held: {
      claimsWithoutHash: 0,
      filesWithoutStoredHash: 0,
      itemKeysWithoutRecord: 0,
      total: 0,
    },
  };
  // Without object storage nothing can be read: the tenants stay closed.
  if (!options.storage) return empty;
  const result = await backfillProofFingerprints(context, options.storage, now);
  // The tenant stays closed for returns with a new proof (CTO, legend-8vcsg).
  // The log names the reasons by count only; a screen for finance to see which
  // proofs wait is a follow-up (no UI in this change).
  if (result.held.total > 0)
    console.error(
      `Payout evidence backfill: returns with a new proof are held (claims without hash ${result.held.claimsWithoutHash}, proof records without stored hash ${result.held.filesWithoutStoredHash}, item proof keys without record ${result.held.itemKeysWithoutRecord}; unreadable objects ${result.unreadable}, hash conflicts ${result.conflicts})`,
    );
  return result;
}
