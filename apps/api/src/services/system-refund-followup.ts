// legend-weuo2: a refund filed by the system (`system:facility`: breakfast
// cancel, late or double payment; `system:qr`: late QR payment) that ended
// `failed` leaves the guest owed money. Two rules live here, in one place:
// - how often it is filed again (bounded, never after a person's rejection);
// - what happens when it is NOT filed again: an alarm to the outlet's
//   supervisors, an audit row and an entry in the follow-up list, which is
//   derived (no table) and shrinks as soon as a refund completes or a live one
//   covers the money.
// Called from `failRefund` (payment-refund.service.ts) inside its transaction,
// which already holds the intent row lock; nothing here locks a row.
import { and, desc, eq, sql } from "drizzle-orm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import * as contract from "@starter/shared/payment/admin";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  paymentIntents,
  paymentRefunds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { recordAudit } from "./core-audit.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import {
  authorize,
  refundableBalance,
  refundViewFor,
} from "./payment-admin.service.ts";
import type { Tx } from "./permission-resolver.ts";

type Refund = typeof paymentRefunds.$inferSelect;

/**
 * How many failed refunds of one payment by the same system requester are
 * filed again. The refund that fails the 3rd time is the last one: after it
 * only a person acts (follow-up list and alarm).
 */
export const MAX_SYSTEM_REFUND_REFILE_ATTEMPTS = 3;

/** Most rows whose balance one list request computes (cost bound per call). */
export const MAX_FOLLOWUP_SCAN = 500;

/** Requesters whose failed refunds are filed again or followed up. */
const FOLLOWUP_ACTORS = ["system:facility", "system:qr"] as const;

/**
 * Failures a new request can fix: an expired approval and an approver who lost
 * the right. Same rule as `refileRecoveryRefundAfterFailure`
 * (order-recovery-refund.ts, CTO decision 15 Nov: rules that limit payment).
 * `provider_declined`, `cap_exceeded`, `source_document`, a rejection (a
 * person's decision) and an unknown reason go straight to the follow-up list
 * and alarm: a new request could pay twice or would repeat.
 */
const REFILE_FAILURE_REASONS: readonly string[] = [
  "approval_expired",
  "approver_unauthorized",
];

export const isFollowupActor = (requestedBy: string): boolean =>
  (FOLLOWUP_ACTORS as readonly string[]).includes(requestedBy);

/**
 * Failed refunds of the payment filed by the same system requester (this one
 * counts). legend-9pz0m: a refund of a parked fund is counted per fund (a
 * payment can park several funds, each with its own budget).
 */
async function failedAttempts(tx: Tx, refund: Refund): Promise<number> {
  const scope = refund.unallocatedFundId
    ? sql`unallocated_fund_id = ${refund.unallocatedFundId}::uuid`
    : sql`payment_intent_id = ${refund.paymentIntentId}::uuid
       AND unallocated_fund_id IS NULL`;
  const result = await tx.execute(sql`
    SELECT count(*)::int AS attempts
      FROM payment_refunds
     WHERE tenant_id = ${refund.tenantId}
       AND ${scope}
       AND requested_by = ${refund.requestedBy}
       AND status = 'failed'
  `);
  return Number(result.rows[0]?.attempts ?? 0);
}

function blockedReason(
  refund: Pick<Refund, "failureReason">,
  attempts: number,
): z.infer<typeof contract.refundFollowupBlockedReasonSchema> {
  if (refund.failureReason === "rejected") return "person_rejection";
  if (!REFILE_FAILURE_REASONS.includes(refund.failureReason ?? ""))
    return "failure_needs_person";
  if (attempts >= MAX_SYSTEM_REFUND_REFILE_ATTEMPTS) return "refile_limit";
  return "no_refile";
}

/**
 * Whether a failed refund of a follow-up requester is filed again: its failure
 * is one a new request can fix and the payment has not failed
 * `MAX_SYSTEM_REFUND_REFILE_ATTEMPTS` times. Read under the intent row lock
 * the caller holds, so two failures cannot both see room for one more try.
 */
export async function systemRefundMayRefile(
  tx: Tx,
  refund: Refund,
): Promise<boolean> {
  return (
    isFollowupActor(refund.requestedBy) &&
    REFILE_FAILURE_REASONS.includes(refund.failureReason ?? "") &&
    (await failedAttempts(tx, refund)) < MAX_SYSTEM_REFUND_REFILE_ATTEMPTS
  );
}

/**
 * legend-9pz0m: whether a parked fund must not get another system refund: it
 * has used up its budget of failed system refunds, or one of them failed for a
 * reason a new request cannot fix (a person's rejection, `provider_declined`,
 * ...). Checked by the event consumers before they file a refund for the fund,
 * so a re-delivered `payment.funds_unallocated` cannot open a refund beyond
 * `MAX_SYSTEM_REFUND_REFILE_ATTEMPTS` or after a decision of a person.
 */
export async function parkedFundRefileBudgetSpent(
  tx: Tx,
  tenantId: string,
  fundId: string,
): Promise<boolean> {
  const actors = sql.join(
    FOLLOWUP_ACTORS.map((name) => sql`${name}`),
    sql`, `,
  );
  const fixable = sql.join(
    REFILE_FAILURE_REASONS.map((name) => sql`${name}`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    SELECT count(*)::int AS attempts,
           count(*) FILTER (
             WHERE failure_reason IS NULL OR failure_reason NOT IN (${fixable})
           )::int AS final_failures
      FROM payment_refunds
     WHERE tenant_id = ${tenantId}
       AND unallocated_fund_id = ${fundId}::uuid
       AND requested_by IN (${actors})
       AND status = 'failed'
  `);
  const row = result.rows[0];
  return (
    Number(row?.final_failures ?? 0) > 0 ||
    Number(row?.attempts ?? 0) >= MAX_SYSTEM_REFUND_REFILE_ATTEMPTS
  );
}

/**
 * legend-9pz0m: a failed system refund of a PARKED fund is filed again for the
 * fund, when `systemRefundMayRefile` allows. The fund row is locked by the
 * caller; `requestQrDoublePaymentRefund` files at most one live refund per
 * fund, for the fund's own amount, and only while the fund is unresolved.
 * Returns the money still owed on the fund (0n when settled or covered by a
 * live refund).
 */
async function refileParkedFund(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<bigint> {
  const tenantId = refund.tenantId;
  const fundId = refund.unallocatedFundId;
  if (fundId === null) return 0n;
  const [fund] = await tx
    .select()
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentUnallocatedFunds.id, fundId),
      ),
    );
  if (!fund || fund.resolution !== null) return 0n;
  if (await systemRefundMayRefile(tx, refund)) {
    // Lazy import: qr-order-late-payment imports this module (cycle).
    const { requestQrDoublePaymentRefund } =
      await import("./qr-order-late-payment.ts");
    const [intent] = await tx
      .select({ paymentLinkId: paymentIntents.paymentLinkId })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, fund.paymentIntentId),
        ),
      );
    if (intent) {
      const filed = await requestQrDoublePaymentRefund(tx, context, {
        paymentLinkId: intent.paymentLinkId,
        intentId: fund.paymentIntentId,
        now,
        fundId: fund.id,
        source: {
          requestedBy: refund.requestedBy as SystemRefundActor,
          reason: refund.reason,
        },
      });
      if (filed.length > 0) return 0n;
    }
  }
  const live = await tx.execute(sql`
    SELECT 1 FROM payment_refunds
     WHERE tenant_id = ${tenantId}
       AND unallocated_fund_id = ${fundId}::uuid
       AND status <> 'failed'
     LIMIT 1
  `);
  return live.rows.length > 0 ? 0n : BigInt(fund.amountIdr);
}

/**
 * Last step of `failRefund`, after every re-file path ran: when a failed system
 * refund leaves money owed with no live refund to cover it, record the audit
 * row `payment.refund_followup_required` and alert the outlet's supervisors and
 * owners. Idempotent: one alarm per refund id (the event id is the refund id)
 * and a refund fails once. The balance is a read-only estimate (no deposit
 * lock): the caller holds the intent lock, which is what the figures need.
 */
export async function settleSystemRefundFailure(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<void> {
  if (!isFollowupActor(refund.requestedBy) || refund.status !== "failed")
    return;
  let remaining: bigint;
  if (refund.unallocatedFundId !== null) {
    // legend-9pz0m: parked money is re-filed here (bounded per fund); only
    // what no live refund covers after that is raised to a person.
    remaining = await refileParkedFund(tx, context, refund, now);
  } else {
    // No "any live refund" shortcut: a pending refund of another part (e.g. the
    // late refund of the same payment) does not cover what THIS one held. The
    // exact remaining balance below (pending and approved are reserved) decides.
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, refund.tenantId),
          eq(paymentIntents.id, refund.paymentIntentId),
        ),
      );
    if (!intent) return;
    const { cap, reserved } = await refundableBalance(tx, intent, {
      lockDeposit: false,
    });
    remaining = cap - reserved;
  }
  if (remaining <= 0n) return;
  const attempts = await failedAttempts(tx, refund);
  const blocked = blockedReason(refund, attempts);
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: refund.tenantId,
      outletId: refund.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "payment.refund_followup_required",
      objectType: "payment_refund",
      objectId: refund.id,
      reason: "Refund sistem gagal dan tidak diajukan ulang",
      maskedChanges: {
        before: null,
        after: {
          refundId: refund.id,
          paymentIntentId: refund.paymentIntentId,
          amountIdr: refund.amountIdr,
          remainingIdr: Number(remaining),
          failureReason: refund.failureReason ?? "unknown",
          blockedReason: blocked,
          attempts,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    [
      "refundId",
      "paymentIntentId",
      "amountIdr",
      "remainingIdr",
      "failureReason",
      "blockedReason",
      "attempts",
    ],
  );
  // The alert id is the refund's id: the notification consumer ignores an
  // event id it has seen, so a retry never alerts twice. The event name's
  // first part equals the aggregate type (checkEnvelopeRules). A savepoint
  // keeps a failed alarm from aborting the refund failure; the audit row above
  // and the follow-up list still carry the item.
  const id = uuidToUlid(refund.id);
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(refund.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          id,
          eventName: "payment.refund_followup_required",
          aggregateType: "payment",
          aggregateId: id,
          payload: { refundId: refund.id, blockedReason: blocked },
          title: "Refund tamu perlu ditindaklanjuti",
          body: `Refund otomatis untuk tamu gagal dan tidak diajukan ulang. Rp ${Number(remaining).toLocaleString("id-ID")} masih menjadi hak tamu. Ajukan refund baru untuk pembayaran ini di layar refund; orang lain harus menyetujuinya.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId: refund.tenantId, refundId: refund.id },
      "Refund follow-up alarm failed",
    );
  }
}

/**
 * Failed system refunds that still leave the guest owed money, newest first.
 * Derived on every read: the latest failed refund of a payment by a follow-up
 * requester, while the payment still has a refundable balance above zero
 * (pending and approved refunds are reserved, so a live refund that covers the
 * money removes it, and so does a completed one). Needs the refund read permission,
 * tenant-wide or at the outlet asked for. The balance cannot be filtered in
 * SQL, so rows are scanned in batches until the page is full.
 */
export async function listRefundFollowups(
  context: ScopedTenantContext,
  actor: string,
  query: z.infer<typeof contract.listRefundFollowups.query>,
) {
  return withTenant(db, context, async (tx) => {
    await authorize(
      tx,
      context,
      actor,
      "payment.transaction.view",
      query.outletId,
    );
    const tenantId = context.tenant.tenantId;
    const actors = sql.join(
      FOLLOWUP_ACTORS.map((name) => sql`${name}`),
      sql`, `,
    );
    let after: [string, string] | null = null;
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      if (typeof at !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      after = [at, id];
    }
    const found: { refund: Refund; remaining: bigint; attempts: number }[] = [];
    const batch = Math.max(query.limit + 1, 50);
    // Rows whose balance was computed this request; the cursor of the last one
    // lets the caller continue when the cap ends the scan early.
    let scanned = 0;
    let lastScanned: Refund | null = null;
    let exhausted = false;
    while (scanned < MAX_FOLLOWUP_SCAN && found.length <= query.limit) {
      const take = Math.min(batch, MAX_FOLLOWUP_SCAN - scanned);
      const rows: Refund[] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            query.outletId
              ? eq(paymentRefunds.outletId, query.outletId)
              : undefined,
            eq(paymentRefunds.status, "failed"),
            sql`${paymentRefunds.unallocatedFundId} IS NULL`,
            sql`${paymentRefunds.requestedBy} IN (${actors})`,
            after
              ? sql`(${paymentRefunds.createdAt}, ${paymentRefunds.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
              : undefined,
            // The latest failed refund of its payment speaks for it.
            sql`NOT EXISTS (
              SELECT 1 FROM payment_refunds later
               WHERE later.tenant_id = ${paymentRefunds.tenantId}
                 AND later.payment_intent_id = ${paymentRefunds.paymentIntentId}
                 AND later.unallocated_fund_id IS NULL
                 AND later.status = 'failed'
                 AND later.requested_by IN (${actors})
                 AND (later.created_at, later.id) > (${paymentRefunds.createdAt}, ${paymentRefunds.id}))`,
            // Cheap pre-filter of the balance: a payment that is not paid any
            // more, or whose refunds already add up to what was paid, owes
            // nothing (the exact balance below can only be lower).
            sql`EXISTS (
              SELECT 1 FROM payment_intents pi
               WHERE pi.tenant_id = ${paymentRefunds.tenantId}
                 AND pi.id = ${paymentRefunds.paymentIntentId}
                 AND pi.paid_at IS NOT NULL
                 AND pi.status IN ('paid', 'partially_refunded')
                 AND pi.amount_idr > coalesce((
                   SELECT sum(done.amount_idr) FROM payment_refunds done
                    WHERE done.tenant_id = pi.tenant_id
                      AND done.payment_intent_id = pi.id
                      AND done.unallocated_fund_id IS NULL
                      AND done.status <> 'failed'), 0))`,
          ),
        )
        .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id))
        .limit(take);
      for (const refund of rows) {
        scanned += 1;
        lastScanned = refund;
        const [intent] = await tx
          .select()
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, tenantId),
              eq(paymentIntents.id, refund.paymentIntentId),
            ),
          );
        if (!intent) continue;
        const { cap, reserved } = await refundableBalance(tx, intent, {
          lockDeposit: false,
        });
        if (cap - reserved > 0n)
          found.push({
            refund,
            remaining: cap - reserved,
            attempts: await failedAttempts(tx, refund),
          });
        if (found.length > query.limit) break;
      }
      const last = rows.at(-1);
      if (!last || rows.length < take) {
        exhausted = true;
        break;
      }
      after = [last.createdAt.toISOString(), last.id];
    }
    const page = found.slice(0, query.limit);
    const lastOfPage = page.at(-1);
    const data = [];
    for (const { refund, remaining, attempts } of page)
      data.push(
        contract.refundFollowupViewSchema.parse({
          ...(await refundViewFor(tx, context, refund, actor)),
          attempts,
          remainingIdr: Number(remaining),
          blockedReason: blockedReason(refund, attempts),
        }),
      );
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          found.length > query.limit && lastOfPage
            ? encodeCursor([
                lastOfPage.refund.createdAt.toISOString(),
                lastOfPage.refund.id,
              ])
            : // The scan cap ended the walk with rows left: continue after
              // the last row scanned (the page may be short or empty).
              !exhausted && lastScanned
              ? encodeCursor([
                  lastScanned.createdAt.toISOString(),
                  lastScanned.id,
                ])
              : null,
      },
    };
  });
}
