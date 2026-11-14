// Payout payment-proof read path and proposal list (bead legend-t58lr; brief
// "Payout evidence hardening"). The second approver needs to SEE the proof the
// first person attached before confirming it.
//
// - readPayoutEvidence: a short-lived signed URL for one stored proof. The key
//   must lie in this tenant's folder of this batch (assertEvidenceKeyForBatch)
//   and the object must exist; a key of another batch or tenant is 422, a
//   never-uploaded one is 404. Nothing is written.
// - listPayoutProposals: items of this batch waiting for their second person
//   (resolve step 1 done, or return step 1 done), with the proposed outcome,
//   proof key, proposer and time. `proposedAt` is the item's `updatedAt`: no
//   migration adds a dedicated column, and an item that waits for its second
//   person is not touched again.
// Both only read; neither moves a batch, an item or a journal.

import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type {
  PayrollPayoutEvidenceReadDto,
  PayrollPayoutProposalDto,
} from "@starter/shared/types";
import { db } from "../db/index.ts";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
} from "../db/schema/payroll-payout.ts";
import { roleAssignments, user } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertEvidenceKeyForBatch } from "./payroll-payout-evidence.ts";

/** Short on purpose: the approver opens the proof right away. */
export const PAYOUT_EVIDENCE_READ_SECONDS = 60;

const batchNotFound = () =>
  new HttpError(
    404,
    "PAYOUT_BATCH_NOT_FOUND",
    "Batch pembayaran tidak ditemukan.",
  );

/** Same 404 as another tenant's batch: the batch must be this tenant's. */
async function assertBatchInTenant(
  context: ScopedTenantContext,
  batchId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [batch] = await withTenant(db, context, (tx) =>
    tx
      .select({ id: payrollDisbursementBatches.id })
      .from(payrollDisbursementBatches)
      .where(
        and(
          eq(payrollDisbursementBatches.tenantId, tenantId),
          eq(payrollDisbursementBatches.id, batchId),
        ),
      ),
  );
  if (!batch) throw batchNotFound();
}

export async function readPayoutEvidence(
  context: ScopedTenantContext,
  batchId: string,
  evidenceKey: string,
  deps: { storage: ObjectStorage },
): Promise<PayrollPayoutEvidenceReadDto> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  await assertBatchInTenant(context, batchId);
  const key = assertEvidenceKeyForBatch({ tenantId, batchId }, evidenceKey);
  const lookup = {
    tenantId,
    outletId: null,
    reference: batchId,
    key,
    visibility: "private" as const,
  };
  // The object must really be stored before a link is handed out.
  try {
    await deps.storage.get(context, lookup);
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND")
      throw new HttpError(
        404,
        "PAYOUT_EVIDENCE_NOT_FOUND",
        "Bukti tidak ditemukan.",
      );
    throw error;
  }
  const url = await deps.storage.signedGetUrl(context, {
    ...lookup,
    expiresInSeconds: PAYOUT_EVIDENCE_READ_SECONDS,
  });
  return {
    evidenceKey: key,
    url,
    expiresAt: new Date(
      Date.now() + PAYOUT_EVIDENCE_READ_SECONDS * 1000,
    ).toISOString(),
  };
}

export async function listPayoutProposals(
  context: ScopedTenantContext,
  batchId: string,
): Promise<PayrollPayoutProposalDto[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  await assertBatchInTenant(context, batchId);
  const { rows, names } = await withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          eq(payrollDisbursementItems.batchId, batchId),
          or(
            // Resolve step 1 done, step 2 open.
            and(
              eq(payrollDisbursementItems.status, "exported"),
              isNotNull(payrollDisbursementItems.resolvedBy),
              isNull(payrollDisbursementItems.resolvedBy2),
            ),
            // Return step 1 done, step 2 open.
            and(
              eq(payrollDisbursementItems.status, "succeeded"),
              isNotNull(payrollDisbursementItems.returnedBy),
              isNull(payrollDisbursementItems.returnedBy2),
            ),
          ),
        ),
      )
      .orderBy(
        asc(payrollDisbursementItems.updatedAt),
        asc(payrollDisbursementItems.id),
      );
    // Proposer names (legend-eszso): only users with a role assignment in THIS
    // tenant; anyone else stays null so no other tenant's user name leaks.
    const proposerIds = [
      ...new Set(
        rows.map(
          (row) =>
            (row.status === "succeeded"
              ? row.returnedBy
              : row.resolvedBy) as string,
        ),
      ),
    ];
    const names = new Map<string, string>();
    if (proposerIds.length > 0) {
      const named = await tx
        .selectDistinct({ id: user.id, name: user.name })
        .from(roleAssignments)
        .innerJoin(user, eq(user.id, roleAssignments.userId))
        .where(
          and(
            eq(roleAssignments.tenantId, tenantId),
            inArray(roleAssignments.userId, proposerIds),
          ),
        );
      for (const { id, name } of named) names.set(id, name);
    }
    return { rows, names };
  });
  return rows.map((row): PayrollPayoutProposalDto => {
    const isReturn = row.status === "succeeded";
    const proposedBy = (isReturn ? row.returnedBy : row.resolvedBy) as string;
    return {
      itemId: row.id,
      employeeId: row.employeeId,
      kind: isReturn ? "return" : "resolve",
      outcome: isReturn ? null : row.resolutionOutcome,
      evidenceKey: isReturn ? row.returnEvidenceKey : row.resolutionEvidenceKey,
      note: isReturn ? row.returnNote : row.resolutionNote,
      proposedBy,
      proposedByName: names.get(proposedBy) ?? null,
      proposedAt: row.updatedAt.toISOString(),
    };
  });
}
