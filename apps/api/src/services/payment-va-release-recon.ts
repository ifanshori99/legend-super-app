// VA release reconciliation (legend-5wn1e). A supervisor release of a VA code
// that has no provider-final answer (`payment-va-release.ts`) frees the bill
// without provider proof, so the code may still be paid at the provider while
// the webhook is lost. Every release is one durable queue row
// (`payment_va_releases`); the worker asks the provider until it answers for
// good, no matter what the payment poller or the 24 h intent timeout say. Money
// found goes through `confirmPayment`: the release row makes it park as
// unallocated funds (never settles the bill), keyed by the provider
// transaction, so a replay of the webhook or the poll adds nothing. Same
// decision as the QRIS release queue (`decide`); lock order is untouched: the
// provider call is outside any transaction.

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import {
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { paymentVaReleases } from "../db/schema/payment-va-release.ts";
import { withTenant } from "../db/tenant.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import {
  PAID_UNRECORDED,
  decide,
  nextReconCheckAt,
} from "./pos-qris-release-recon.ts";

/** Checks one queue row now. Returns its status afterwards (null: gone). */
export async function reconcileReleasedVa(
  context: ScopedTenantContext,
  releaseId: string,
  now: Date,
): Promise<"open" | "resolved" | null> {
  const tenantId = context.tenant.tenantId;
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(paymentVaReleases)
      .where(
        and(
          eq(paymentVaReleases.tenantId, tenantId),
          eq(paymentVaReleases.id, releaseId),
        ),
      ),
  );
  if (!row) return null;
  if (row.status !== "open") return row.status;
  const outcome = await decide(context, row, now);
  const status = await withTenant(db, context, async (tx) => {
    const resolved = outcome.kind === "resolved";
    const [updated] = await tx
      .update(paymentVaReleases)
      .set({
        attempts: row.attempts + 1,
        lastCheckedAt: now,
        lastProviderStatus: outcome.seen,
        ...(resolved
          ? {
              status: "resolved" as const,
              resolvedAt: now,
              resolution: outcome.resolution,
            }
          : {
              nextCheckAt: nextReconCheckAt(
                row.attempts + 1,
                now,
                outcome.slow === true,
              ),
            }),
      })
      .where(
        and(
          eq(paymentVaReleases.tenantId, tenantId),
          eq(paymentVaReleases.id, row.id),
          eq(paymentVaReleases.status, "open"),
        ),
      )
      .returning({ status: paymentVaReleases.status });
    // Paid at the provider, nothing recorded: tell staff once per row, when
    // this state is first seen (the row update and the alert commit together).
    if (
      updated &&
      outcome.kind === "open" &&
      PAID_UNRECORDED.has(outcome.seen) &&
      !PAID_UNRECORDED.has(row.lastProviderStatus ?? "")
    ) {
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId,
          outletId: row.outletId as OutletId,
          alsoOwners: true,
          alsoUserIds: row.releasedBy ? [row.releasedBy] : [],
          id: createUlid(now.getTime()),
          eventName: "payment_va_release.unrecorded",
          aggregateType: "payment_va_release",
          aggregateId: row.id,
          payload: { releaseId: row.id, paymentIntentId: row.paymentIntentId },
          title:
            row.kind === "guest_method_change"
              ? "Kode lama dibayar, uang belum tercatat"
              : "VA dibayar, uang belum tercatat",
          body:
            row.kind === "guest_method_change"
              ? "Penyedia menjawab kode pembayaran lama yang sudah diganti tamu ini dibayar, tetapi uangnya belum bisa dicatat. Sistem terus mencoba; periksa antrean rekonsiliasi."
              : "Penyedia menjawab kode VA yang sudah dirilis ini dibayar, tetapi uangnya belum bisa dicatat. Sistem terus mencoba; periksa antrean rekonsiliasi VA.",
        },
        now,
      );
    }
    return updated?.status ?? "resolved";
  });
  // The provider answered expired / failed for good: the code is final, as the
  // gateway poll marks it (`provider_final_at`). No timer closes a row (legend-912
  // P1-2), so only such an answer, with every positive extra parked, gets here.
  if (outcome.kind === "resolved" && outcome.final) {
    // The code may still be `pending` locally (a release does not need it to
    // have lapsed in our books), which `markGatewayReconciled` leaves alone.
    await withTenant(db, context, (tx) =>
      tx
        .update(paymentIntents)
        .set({ providerFinalAt: now })
        .where(
          and(
            eq(paymentIntents.tenantId, tenantId),
            eq(paymentIntents.id, row.paymentIntentId),
            inArray(paymentIntents.status, [
              "pending",
              "paid",
              "expired",
              "failed",
            ]),
            isNull(paymentIntents.providerFinalAt),
          ),
        ),
    );
  }
  return status;
}

/** Ids of the open rows that are due (oldest first). `force`: all open rows. */
export async function dueVaReleaseReconciliations(
  context: ScopedTenantContext,
  now: Date,
  options: { force?: boolean; limit: number },
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ id: paymentVaReleases.id })
      .from(paymentVaReleases)
      .where(
        and(
          eq(paymentVaReleases.tenantId, tenantId),
          eq(paymentVaReleases.status, "open"),
          options.force ? undefined : lte(paymentVaReleases.nextCheckAt, now),
        ),
      )
      .orderBy(asc(paymentVaReleases.nextCheckAt))
      .limit(options.limit),
  );
  return rows.map((row) => row.id);
}
