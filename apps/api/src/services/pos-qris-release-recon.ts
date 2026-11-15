// QRIS release reconciliation (legend-adiov, so-879 P1). A manager force
// release (founder Q93) closes a hold without provider proof, so the QR may
// still be paid at the provider while the webhook is lost. Every release opens
// one durable row; the worker asks the provider until it answers for good, no
// matter what the payment poller or the 24 h intent timeout say. Money found is
// recorded through `confirmPayment`: the closed hold parks it as unallocated
// funds (evidence, fund, event, audit, staff alert), keyed by the provider
// transaction, so a replay of the webhook or the poll adds nothing.
// Lock order is untouched: the provider call is outside any transaction and
// `confirmPayment` takes its own locks.

import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import {
  paymentEvidence,
  paymentIntents,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import {
  posQrisReleaseReconciliations,
  type PosQrisReconResolution,
  type PosQrisReconStatus,
} from "../db/schema/pos-qris-release-recon.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "./menu-internals.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
import { plausiblePaidAt } from "./payment-paid-at.ts";
import {
  PaymentConfirmationRejected,
  confirmPayment,
} from "./payment.service.ts";

/** Same margin as the hold check (D-03): an answer before it proves nothing. */
const CLOSE_MARGIN_MS = 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** 2, 4, 8 ... minutes, then every hour for as long as the provider is silent. */
export function nextReconCheckAt(attempts: number, now: Date): Date {
  const minutes = Math.min(2 ** Math.max(attempts, 1), MAX_BACKOFF_MS / 60_000);
  return new Date(now.getTime() + minutes * 60_000);
}

type HoldRef = {
  id: string;
  paymentIntentId: string;
  outletId: string;
  openedBy: string | null;
};

/**
 * Opens the queue row for a force released hold, in the release transaction,
 * and alerts the outlet staff. A repeat for the same hold writes nothing.
 */
export async function openReleaseReconciliationTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    hold: HoldRef;
    reason: string;
    callerUserId: string;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .insert(posQrisReleaseReconciliations)
    .values({
      tenantId,
      id: createUlid(input.now.getTime()),
      outletId: input.hold.outletId as OutletId,
      holdId: input.hold.id,
      paymentIntentId: input.hold.paymentIntentId,
      status: "open",
      reason: input.reason,
      nextCheckAt: new Date(input.now.getTime() + FIRST_CHECK_MS),
    })
    .onConflictDoNothing({
      target: [
        posQrisReleaseReconciliations.tenantId,
        posQrisReleaseReconciliations.holdId,
      ],
    })
    .returning({ id: posQrisReleaseReconciliations.id });
  if (!row) return;
  // Money of this QR is already parked: staff were alerted when it was, so the
  // release adds no second alert (the row still opens and the worker resolves it).
  const [parked] = await tx
    .select({ id: paymentUnallocatedFunds.id })
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentUnallocatedFunds.paymentIntentId, input.hold.paymentIntentId),
      ),
    )
    .limit(1);
  if (parked) return;
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId,
      outletId: input.hold.outletId as OutletId,
      alsoOwners: true,
      alsoUserIds: [
        ...new Set(
          [input.callerUserId, input.hold.openedBy].filter(
            (id): id is string => id !== null,
          ),
        ),
      ],
      id: row.id,
      eventName: "pos_qris_release_reconciliation.opened",
      aggregateType: "pos_qris_release_reconciliation",
      aggregateId: row.id,
      payload: { reconciliationId: row.id, holdId: input.hold.id },
      title: "QRIS dirilis, uang belum terkonfirmasi",
      body: "QRIS dirilis tanpa bukti penyedia. Sistem terus menanyai penyedia; bila uang masuk, uang ditahan di dana belum teralokasi untuk dikembalikan ke pembayar.",
    },
    input.now,
  );
}

type ReconRow = typeof posQrisReleaseReconciliations.$inferSelect;

type Outcome =
  | { kind: "resolved"; resolution: PosQrisReconResolution; seen: string }
  | { kind: "open"; seen: string };

async function recordedMoney(
  context: ScopedTenantContext,
  intentId: string,
): Promise<boolean> {
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({ id: paymentEvidence.id })
      .from(paymentEvidence)
      .where(
        and(
          eq(paymentEvidence.tenantId, context.tenant.tenantId),
          eq(paymentEvidence.paymentIntentId, intentId),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** Asks the provider once about one queue row and decides. */
async function decide(
  context: ScopedTenantContext,
  row: ReconRow,
  now: Date,
): Promise<Outcome> {
  const [intent] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, row.paymentIntentId),
        ),
      ),
  );
  if (!intent || intent.providerRef === null)
    return { kind: "open", seen: "no_provider_ref" };
  const outletContext =
    context.outletScope.kind === "tenant"
      ? establishScopedTenantContext(context.tenant, {
          kind: "outlets",
          outletIds: [intent.outletId],
        })
      : context;
  let answer;
  try {
    answer = await paymentGatewayFor(intent.provider).getStatus({
      context: outletContext,
      outletId: intent.outletId,
      integrationId: intent.gatewayIntegrationId,
      providerRef: intent.providerRef,
      intentId: intent.id,
    });
  } catch {
    return { kind: "open", seen: "unreachable" };
  }
  if (answer.providerRef !== intent.providerRef)
    return { kind: "open", seen: "other_reference" };
  if (answer.status === "paid") {
    if (answer.amountIdr === null)
      return { kind: "open", seen: "paid_without_amount" };
    try {
      await confirmPayment(
        outletContext,
        intent.id,
        {
          source: "gateway_status",
          method: intent.method,
          amountIdr: answer.amountIdr,
          providerRef: answer.providerRef,
          at: plausiblePaidAt(answer.paidAt, intent.createdAt, now),
        },
        { type: "system" },
        now,
      );
    } catch (error) {
      // A refusal after the money was parked is the expected outcome for a
      // closed hold; anything else is retried (the check below decides).
      if (!(error instanceof PaymentConfirmationRejected)) {
        if (!(await recordedMoney(context, intent.id)))
          return { kind: "open", seen: "settlement_failed" };
      }
    }
    return (await recordedMoney(context, intent.id))
      ? { kind: "resolved", resolution: "paid_recorded", seen: "paid" }
      : { kind: "open", seen: "paid_not_recorded" };
  }
  const dead =
    now.getTime() >= intent.expiresAt.getTime() + CLOSE_MARGIN_MS &&
    (intent.provider === "duitku"
      ? answer.rawStatus === "02"
      : answer.status === "expired" || answer.status === "failed");
  if (dead)
    return {
      kind: "resolved",
      resolution:
        answer.status === "failed" ? "provider_failed" : "provider_expired",
      seen: answer.status,
    };
  return { kind: "open", seen: answer.status };
}

/** Checks one queue row now. Returns its status afterwards (null: gone). */
export async function reconcileReleasedQris(
  context: ScopedTenantContext,
  reconId: string,
  now: Date,
): Promise<PosQrisReconStatus | null> {
  const tenantId = context.tenant.tenantId;
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(posQrisReleaseReconciliations)
      .where(
        and(
          eq(posQrisReleaseReconciliations.tenantId, tenantId),
          eq(posQrisReleaseReconciliations.id, reconId),
        ),
      ),
  );
  if (!row) return null;
  if (row.status !== "open") return row.status;
  const outcome = await decide(context, row, now);
  return withTenant(db, context, async (tx) => {
    const resolved = outcome.kind === "resolved";
    const [updated] = await tx
      .update(posQrisReleaseReconciliations)
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
          : { nextCheckAt: nextReconCheckAt(row.attempts + 1, now) }),
      })
      .where(
        and(
          eq(posQrisReleaseReconciliations.tenantId, tenantId),
          eq(posQrisReleaseReconciliations.id, row.id),
          eq(posQrisReleaseReconciliations.status, "open"),
        ),
      )
      .returning({ status: posQrisReleaseReconciliations.status });
    return updated?.status ?? "resolved";
  });
}

/** Ids of the open rows that are due (oldest first). `force`: all open rows. */
export async function dueReleaseReconciliations(
  context: ScopedTenantContext,
  now: Date,
  options: { force?: boolean; limit: number },
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ id: posQrisReleaseReconciliations.id })
      .from(posQrisReleaseReconciliations)
      .where(
        and(
          eq(posQrisReleaseReconciliations.tenantId, tenantId),
          eq(posQrisReleaseReconciliations.status, "open"),
          options.force
            ? undefined
            : lte(posQrisReleaseReconciliations.nextCheckAt, now),
        ),
      )
      .orderBy(asc(posQrisReleaseReconciliations.nextCheckAt))
      .limit(options.limit),
  );
  return rows.map((row) => row.id);
}

export type PosQrisReconciliationDto = {
  id: string;
  outletId: string;
  holdId: string;
  paymentIntentId: string;
  status: PosQrisReconStatus;
  reason: string;
  attempts: number;
  nextCheckAt: string;
  lastCheckedAt: string | null;
  lastProviderStatus: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: PosQrisReconResolution | null;
};

/** The staff view of the queue for one outlet (newest first, at most 200). */
export async function listPosQrisReconciliations(
  context: ScopedTenantContext,
  outletId: OutletId,
  status: PosQrisReconStatus = "open",
): Promise<PosQrisReconciliationDto[]> {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(posQrisReleaseReconciliations)
      .where(
        and(
          eq(posQrisReleaseReconciliations.tenantId, context.tenant.tenantId),
          eq(posQrisReleaseReconciliations.outletId, outletId),
          eq(posQrisReleaseReconciliations.status, status),
        ),
      )
      .orderBy(
        desc(posQrisReleaseReconciliations.createdAt),
        sql`${posQrisReleaseReconciliations.id} desc`,
      )
      .limit(200),
  );
  return rows.map((row) => ({
    id: row.id,
    outletId: row.outletId,
    holdId: row.holdId,
    paymentIntentId: row.paymentIntentId,
    status: row.status,
    reason: row.reason,
    attempts: row.attempts,
    nextCheckAt: row.nextCheckAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastProviderStatus: row.lastProviderStatus,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution,
  }));
}
