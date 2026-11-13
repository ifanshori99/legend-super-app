// Tenant purchasing policy: the three-way match price tolerance (bead
// legend-nz13; design docs/briefs/ws-purchasing-apar-design.md §3, §12 K1).
//
// One row per tenant. A tenant without a row runs on the default of 0 bp (the
// invoice price must equal the PO price exactly). Loosening the tolerance
// raises the risk of paying a supplier too much, so only finance or the owner
// (`accounting.supplier_payment.process`, tenant-wide) may change it, up to
// 1000 bp. A change is guarded by `expectedUpdatedAt` (412 when stale), bound
// to an idempotency key and audited with before and after.

import { eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  PURCHASING_DEFAULT_TOLERANCE_BP,
  purchasingPolicySchema,
  putPurchasingPolicyInputSchema,
  type PurchasingPolicy,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { purchasingPolicies } from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import {
  recordOpsAudit,
  requestFingerprint,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";

const PUT_OPERATION = "purchasing_policy.put";
const PUT_PERMISSION = "accounting.supplier_payment.process";
const POLICY_AUDIT_FIELDS = ["threeWayMatchToleranceBp"] as const;

type PolicyRow = typeof purchasingPolicies.$inferSelect;

function toPolicy(
  tenantId: string,
  row: PolicyRow | undefined,
): PurchasingPolicy {
  return purchasingPolicySchema.parse({
    tenantId,
    threeWayMatchToleranceBp:
      row?.threeWayMatchToleranceBp ?? PURCHASING_DEFAULT_TOLERANCE_BP,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row ? userIdSchema.parse(row.updatedBy) : null,
  });
}

/** Tolerance in force for the tenant: the saved value or the default. */
export async function loadMatchToleranceBpInTransaction(
  tx: Tx,
  tenantId: TenantId,
): Promise<number> {
  const [row] = await tx
    .select({ bp: purchasingPolicies.threeWayMatchToleranceBp })
    .from(purchasingPolicies)
    .where(eq(purchasingPolicies.tenantId, tenantId));
  return row?.bp ?? PURCHASING_DEFAULT_TOLERANCE_BP;
}

/** GET the tenant policy (the route gate decides who may read). */
export async function getPurchasingPolicy(
  context: ScopedTenantContext,
): Promise<PurchasingPolicy> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchasingPolicies)
      .where(eq(purchasingPolicies.tenantId, context.tenant.tenantId));
    return toPolicy(context.tenant.tenantId, row);
  });
}

/**
 * PUT the tolerance. Tenant-wide `accounting.supplier_payment.process` is
 * re-checked here; a stale or missing `expectedUpdatedAt` is a 412 and changes
 * nothing; the same key and body replays the first answer.
 */
export async function putPurchasingPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  rawInput: unknown,
  now = new Date(),
): Promise<PurchasingPolicy> {
  const input = putPurchasingPolicyInputSchema.parse(rawInput);
  const tenantId = context.tenant.tenantId;
  const claim = {
    operation: PUT_OPERATION,
    key: input.idempotencyKey,
    outletId: null,
    fingerprint: requestFingerprint(PUT_OPERATION, actorUserId, {
      threeWayMatchToleranceBp: input.threeWayMatchToleranceBp,
      expectedUpdatedAt: input.expectedUpdatedAt,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const snapshot = await accessSnapshotInTransaction(
        tx,
        context,
        actorUserId,
        now,
      );
      if (!snapshot.allows(PUT_PERMISSION, { type: "tenant" }))
        throw new AccessError("PERMISSION_DENIED");
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchasingPolicySchema.parse(replay.replay);

      const [existing] = await tx
        .select()
        .from(purchasingPolicies)
        .where(eq(purchasingPolicies.tenantId, tenantId))
        .for("update");
      const staleMessage =
        "The policy changed since it was read; reload it and try again.";
      let row: PolicyRow;
      if (!existing) {
        if (input.expectedUpdatedAt !== null)
          throw new CoreError("PRECONDITION_FAILED", staleMessage);
        const [created] = await tx
          .insert(purchasingPolicies)
          .values({
            tenantId,
            threeWayMatchToleranceBp: input.threeWayMatchToleranceBp,
            updatedBy: actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        // Lost a first-save race against another request.
        if (!created) throw new CoreError("PRECONDITION_FAILED", staleMessage);
        row = created;
      } else {
        if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt)
          throw new CoreError("PRECONDITION_FAILED", staleMessage);
        const [updated] = await tx
          .update(purchasingPolicies)
          .set({
            threeWayMatchToleranceBp: input.threeWayMatchToleranceBp,
            updatedBy: actorUserId,
            updatedAt: now,
          })
          .where(eq(purchasingPolicies.tenantId, tenantId))
          .returning();
        row = updated!;
      }
      const policy = toPolicy(tenantId, row);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: null,
        action: "purchasing.policy_updated",
        objectType: "purchasing_policy",
        objectId: tenantId,
        before: existing
          ? { threeWayMatchToleranceBp: existing.threeWayMatchToleranceBp }
          : null,
        after: { threeWayMatchToleranceBp: policy.threeWayMatchToleranceBp },
        safeFields: POLICY_AUDIT_FIELDS,
      });
      await completePurchasingIdempotency(tx, context, claim, policy);
      return policy;
    });
  } catch (error) {
    throw translatePurchasingError(error);
  }
}
