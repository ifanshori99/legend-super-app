// Payout proof fingerprint backfill (bead legend-8vcsg; design in
// services/payroll-payout-proof-fingerprint.service.ts).
//
// Proofs that existed before the fingerprints (migration 0382 and the stored
// hash of 0631) lack hashes, and a byte-identical re-upload of one would not be
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
//   closed) and is counted in the result for a human;
// - fair (legend-so897): such a key is listed in the stuck table with a growing
//   retry delay, so the next sweeps reach the keys behind it; finance sees the
//   list as the exception kind `payout_proof_stuck`; the log below carries
//   counts only, no keys;
// - phase 2 then binds the operations from before the proof bindings (overpaid,
//   return, correction), so one proof cannot back a second operation.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  backfillProofFingerprints,
  bindHistoricalOperations,
  type HistoricalBindingResult,
  type ProofFingerprintBackfillResult,
} from "../services/payroll-payout-proof-backfill.service.ts";
import { countFingerprintTargets } from "../services/payroll-payout-proof-fingerprint.service.ts";

export type PayoutEvidenceBackfillResult = ProofFingerprintBackfillResult & {
  /** Phase 2: historical operations bound this run. */
  readonly binding: HistoricalBindingResult;
};

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
    stuck: 0,
    binding: { operations: 0, bound: 0, legacyDuplicates: 0, failed: 0 },
    held: {
      claimsWithoutHash: 0,
      filesWithoutStoredHash: 0,
      itemKeysWithoutRecord: 0,
      opKeysWithoutBinding: 0,
      total: 0,
    },
  };
  // Without object storage nothing can be read: the tenants stay closed.
  if (!options.storage) return empty;
  const fingerprints = await backfillProofFingerprints(
    context,
    options.storage,
    now,
  );
  const binding = await bindHistoricalOperations(context, now);
  // Phase 2 changed the operation keys without a binding: count them again.
  const held = await withTenant(db, context, (tx) =>
    countFingerprintTargets(tx, context.tenant.tenantId),
  );
  const result = { ...fingerprints, binding, held };
  // The tenant stays closed for returns with a new proof (CTO, legend-8vcsg).
  // The log carries counts only: the keys and their reasons are on the finance
  // list (exception kind payout_proof_stuck), not in the log.
  if (result.held.total > 0 || result.stuck > 0 || binding.failed > 0)
    console.error(
      `Payout evidence backfill: returns with a new proof are held (claims without hash ${result.held.claimsWithoutHash}, proof records without stored hash ${result.held.filesWithoutStoredHash}, item proof keys without record ${result.held.itemKeysWithoutRecord}, operation proofs without binding ${result.held.opKeysWithoutBinding}; unreadable objects ${result.unreadable}, hash conflicts ${result.conflicts}, stuck ${result.stuck}, bindings failed ${binding.failed})`,
    );
  return result;
}
