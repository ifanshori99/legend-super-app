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
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import type { Tx } from "./menu-internals.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import {
  paymentGatewayFor,
  type GatewayPaymentStatus,
} from "./payment-gateway.ts";
import { logger } from "../lib/logger.ts";
import { plausiblePaidAt } from "./payment-paid-at.ts";
import { RELEASE_RECON_UNPROVEN_AFTER_HOURS } from "@starter/shared/validators/finance-exceptions";
import {
  PaymentConfirmationRejected,
  confirmPayment,
  markProviderRefunded,
  recordUnsettledGatewayFundsInTx,
} from "./payment.service.ts";

/** Same margin as the hold check (D-03): an answer before it proves nothing. */
const CLOSE_MARGIN_MS = 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** legend-912 P1-2: no timer closes a row. After this long a still pending
 * code is asked less often (SLOW_CHECK_MS) but never dropped. */
const MAX_WATCH_MS = 7 * 24 * 60 * 60_000;
/** After this long a code the provider answers "paid" for is asked less often
 * too, and the row shows on the finance exception list (the same constant, in
 * hours, as `RELEASE_RECON_UNPROVEN_AFTER_HOURS`). Only the provider's closed
 * answer closes the row. */
export const PAID_WATCH_MS = RELEASE_RECON_UNPROVEN_AFTER_HOURS * 60 * 60_000;
/** Interval of the slowed checks once a row is past its watch mark. */
const SLOW_CHECK_MS = 24 * 60 * 60_000;

/** 2, 4, 8 ... minutes, then every hour for as long as the provider is silent.
 * `slow` (a row past its watch mark): every 24 h, never stopped. */
export function nextReconCheckAt(
  attempts: number,
  now: Date,
  slow = false,
): Date {
  if (slow) return new Date(now.getTime() + SLOW_CHECK_MS);
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

export type Outcome =
  | {
      kind: "resolved";
      resolution: PosQrisReconResolution;
      seen: string;
      /** True only for a real final provider answer (expired / failed after
       * the margin), never for a time based close. */
      final: boolean;
    }
  | { kind: "open"; seen: string; slow?: boolean };

/** Money on record for the code the intent was minted for. Parked extra
 * transactions (other provider refs) do not count. */
async function recordedMoney(
  context: ScopedTenantContext,
  intent: { id: string; providerRef: string | null },
): Promise<boolean> {
  const providerRef = intent.providerRef;
  if (providerRef === null) return false;
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({ id: paymentEvidence.id })
      .from(paymentEvidence)
      .where(
        and(
          eq(paymentEvidence.tenantId, context.tenant.tenantId),
          eq(paymentEvidence.paymentIntentId, intent.id),
          eq(paymentEvidence.providerRef, providerRef),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/**
 * A provider payment on the code other than the one the intent was minted for
 * (legend-xzu4l): parked as unallocated funds, keyed by that provider
 * transaction, so poll and webhook together park it exactly once. It never
 * settles the bill. Staff are alerted only when the money is newly parked.
 * Returns false when parking failed or an extra is paid with a zero or
 * unreadable amount (not recorded: the row stays open and is asked again). A
 * negative amount is not money and needs no recording.
 */
async function parkExtraPayments(
  context: ScopedTenantContext,
  intent: typeof paymentIntents.$inferSelect,
  extras: NonNullable<GatewayPaymentStatus["extraPayments"]>,
  now: Date,
): Promise<boolean> {
  let allRecorded = true;
  try {
    for (const extra of extras) {
      if (!Number.isFinite(extra.amountIdr) || extra.amountIdr === 0) {
        allRecorded = false;
        continue;
      }
      if (extra.amountIdr < 0) continue;
      await withTenant(db, context, async (tx) => {
        const outcome = await recordUnsettledGatewayFundsInTx(
          tx,
          context,
          intent,
          {
            provider: intent.provider,
            providerRef: extra.providerRef,
            source: "gateway_status",
            paidAmountIdr: extra.amountIdr,
            receivedAt: new Date(
              plausiblePaidAt(extra.paidAt, intent.createdAt, now),
            ),
          },
          now,
        );
        if (outcome !== "inserted") return;
        await notifyOutletSupervisors(
          tx,
          context,
          {
            tenantId: context.tenant.tenantId,
            outletId: intent.outletId as OutletId,
            alsoOwners: true,
            alsoUserIds: [],
            id: createUlid(now.getTime()),
            eventName: "payment_intent.extra_funds_parked",
            aggregateType: "payment_intent",
            aggregateId: intent.id,
            payload: { intentId: intent.id, providerRef: extra.providerRef },
            title: "Uang tambahan masuk di kode pembayaran",
            body: `Penyedia mencatat pembayaran tambahan Rp${extra.amountIdr} pada kode yang sama. Uang ditahan di dana belum teralokasi; kembalikan ke pembayar.`,
          },
          now,
        );
      });
    }
    return allRecorded;
  } catch {
    // Identifiers only: never the error or a provider body.
    logger.warn(
      {
        intentId: intent.id,
        providerRefs: extras.map((extra) => extra.providerRef),
      },
      "Payment: parking extra provider payments failed",
    );
    return false;
  }
}

/**
 * Asks the provider once about one queue row and decides. Shared with the VA
 * staff release queue (legend-5wn1e): only the row's intent id is used.
 *
 * legend-xzu4l: for DOIT a recorded payment does NOT close the row. A second
 * payment with a lost webhook can still arrive, and the row opens after the
 * code lapsed, so expiry proves nothing. The row keeps asking (backoff) until
 * the provider answers expired/failed for good. legend-912 P1-2: no timer
 * closes it; past 72 h (paid) or 7 days it is only asked every 24 h. Extra
 * provider transactions are parked, never paid; the row is final only once
 * every positive extra is parked.
 *
 * legend-912 round 2: Duitku has one transaction per order and answers paid
 * forever, so a Duitku paid answer with the money recorded (positive amount)
 * and every extra parked is final proof and closes the row.
 */
export async function decide(
  context: ScopedTenantContext,
  row: {
    paymentIntentId: string;
    createdAt?: Date;
    lastProviderStatus?: string | null;
  },
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
  const openedMs = row.createdAt?.getTime();
  const ageMs = openedMs === undefined ? 0 : now.getTime() - openedMs;
  const stillOpen = (seen: string, slowAfterMs = MAX_WATCH_MS): Outcome => ({
    kind: "open",
    seen,
    slow: ageMs >= slowAfterMs,
  });
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
    return stillOpen("unreachable");
  }
  if (answer.providerRef !== intent.providerRef)
    return stillOpen("other_reference");
  // 952 round 2: the provider gave this code's payment back; recorded whether
  // or not the code is final, so a late `paid` message cannot book or park it.
  if (
    answer.rawStatus === "refunded" &&
    (await markProviderRefunded(context, intent.id, now)) === "retry"
  )
    // A refund of ours is still in flight: nothing recorded yet, look again.
    return stillOpen("refund_in_flight");
  // An extra that could not be recorded must never keep the primary paid
  // answer from being recorded: the primary is settled first, then the row
  // stays open (and staff are warned) until every extra is on record.
  const extrasRecorded =
    !answer.extraPayments ||
    answer.extraPayments.length === 0 ||
    (await parkExtraPayments(outletContext, intent, answer.extraPayments, now));
  const expired = now.getTime() >= intent.expiresAt.getTime() + CLOSE_MARGIN_MS;
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
        if (!(await recordedMoney(context, intent)))
          return { kind: "open", seen: "settlement_failed" };
      }
    }
    if (!(await recordedMoney(context, intent)))
      return { kind: "open", seen: "paid_not_recorded" };
    if (!extrasRecorded)
      return { kind: "open", seen: "extra_funds_not_parked" };
    // Duitku is one transaction per order: a recorded positive paid answer with
    // every extra parked is final (legend-912 round 2).
    if (intent.provider === "duitku")
      return {
        kind: "resolved",
        resolution: "paid_recorded",
        seen: answer.status,
        final: true,
      };
    // DOIT: paid is not proof the code is closed: a later transaction can still
    // arrive. Asked on, less often after 72 h.
    return stillOpen("paid", PAID_WATCH_MS);
  }
  const dead =
    expired &&
    (intent.provider === "duitku"
      ? answer.rawStatus === "02"
      : answer.status === "expired" || answer.status === "failed");
  // Any non-paid answer (pending, expired before the margin, dead) with an
  // unrecorded extra stays open so staff are warned (PAID_UNRECORDED).
  if (!extrasRecorded) return { kind: "open", seen: "extra_funds_not_parked" };
  if (dead) {
    // Money already on record for this code (an earlier paid answer, a webhook)
    // keeps the paid resolution: the code ending later does not undo it.
    if (await recordedMoney(context, intent))
      return {
        kind: "resolved",
        resolution: "paid_recorded",
        seen: answer.status,
        final: true,
      };
    return {
      kind: "resolved",
      resolution:
        answer.status === "failed" ? "provider_failed" : "provider_expired",
      seen: answer.status,
      final: true,
    };
  }
  return stillOpen(answer.status);
}

/** The provider says the QR was paid but no money could be recorded. */
export const PAID_UNRECORDED = new Set([
  "paid_not_recorded",
  "settlement_failed",
  "paid_without_amount",
  "extra_funds_not_parked",
]);

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
          eq(posQrisReleaseReconciliations.tenantId, tenantId),
          eq(posQrisReleaseReconciliations.id, row.id),
          eq(posQrisReleaseReconciliations.status, "open"),
        ),
      )
      .returning({ status: posQrisReleaseReconciliations.status });
    // Paid at the provider, nothing recorded: tell staff once per row, when
    // this state is first seen (the row update and the alert commit together;
    // the notification consumer dedupes on the event id, so it is not the row id).
    if (
      updated &&
      outcome.kind === "open" &&
      PAID_UNRECORDED.has(outcome.seen) &&
      !PAID_UNRECORDED.has(row.lastProviderStatus ?? "")
    ) {
      const [hold] = await tx
        .select({ openedBy: posQrisHolds.openedBy })
        .from(posQrisHolds)
        .where(
          and(
            eq(posQrisHolds.tenantId, tenantId),
            eq(posQrisHolds.id, row.holdId),
          ),
        );
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId,
          outletId: row.outletId as OutletId,
          alsoOwners: true,
          alsoUserIds: hold?.openedBy ? [hold.openedBy] : [],
          id: createUlid(now.getTime()),
          eventName: "pos_qris_release_reconciliation.unrecorded",
          aggregateType: "pos_qris_release_reconciliation",
          aggregateId: row.id,
          payload: { reconciliationId: row.id, holdId: row.holdId },
          title: "QRIS dibayar, uang belum tercatat",
          body: "Penyedia menjawab QRIS yang sudah dirilis ini dibayar, tetapi uangnya belum bisa dicatat. Sistem terus mencoba; periksa antrean rekonsiliasi QRIS.",
        },
        now,
      );
    }
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
