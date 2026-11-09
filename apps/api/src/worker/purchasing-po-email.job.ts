// Worker job: sends queued purchase order emails (bead legend-9yz; PRD v1.7
// §3.18 "Kirim PO"). Not registered here: the lead wires
// `runPurchasingPoEmailJob` into the worker runtime (a schedule every 30 s).
//
// Per tenant, up to PURCHASING_PO_EMAIL_BATCH times, one delivery in three
// steps. (1) A `withTenant` transaction claims one queued row `FOR UPDATE SKIP
// LOCKED`, checks the order is still `sent` / `partially_received`, resolves
// the share link for the PDF and bumps `next_attempt_at` by a lease
// (PURCHASING_PO_EMAIL_LEASE_SECONDS) so no other worker claims it, then
// commits. (2) The EmailProvider port is called OUTSIDE any transaction
// (reference = delivery id, the provider's idempotency key). (3) A new
// transaction records the outcome. The port carries no attachment, so the email
// holds the 7-day PDF link (key `email:<delivery id>`). A live link for that
// key is reused; a revoked or expired one fails the delivery for good; only
// when none exists (the first attempt, or one that rolled back) is it issued.
// The order is read `FOR SHARE NOWAIT` after the delivery row is locked: close,
// cancel and revoke lock the order and then update the queued deliveries, so a
// plain read plus the link insert (a KEY SHARE on the order) could deadlock
// (40P01). When the order is locked (55P03) the attempt is a plain transient
// retry and the revoke goes first. A crash between (1)
// and (3) leaves the row marked `send_started_at` (set with the lease, cleared
// by every recorded outcome). After the lease such a row is NOT resent: the
// provider may already hold the email and its dedup window (Brevo: 30 min) can
// be over, and the port has no lookup to reconcile. It is failed for good with
// an "uncertain" reason, for manual review and a manual resend. A failed attempt counts and waits
// PURCHASING_PO_EMAIL_BACKOFF_SECONDS (1 min, 5 min, 30 min, 2 h, 6 h) via
// `next_attempt_at`; after PURCHASING_PO_EMAIL_MAX_ATTEMPTS the row is
// `failed`. An order that is no longer sent (closed, cancelled, missing) or a
// dead link fails the row at once, with no retry. With no provider nothing is
// claimed or counted: rows stay queued until one is configured (fail closed,
// nothing is sent). The job logs nothing; `lastError` is a short fixed reason
// and never holds the address.

import { and, asc, eq, isNull, lte, notInArray, or } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EmailProvider } from "@starter/shared/adapters";
import { PurchasingError } from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  purchaseOrderEmailDeliveries,
  purchaseOrders,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "../services/inventory-ops.shared.ts";
import {
  ensurePurchaseOrderShareLink,
  findPurchaseOrderShareLink,
} from "../services/purchasing-send.service.ts";

export const PURCHASING_PO_EMAIL_QUEUE = "purchasing-po-email";
export const PURCHASING_PO_EMAIL_INTERVAL_SECONDS = 30;
export const PURCHASING_PO_EMAIL_BATCH = 50;
export const PURCHASING_PO_EMAIL_MAX_ATTEMPTS = 6;
/** How long a claimed row is hidden from other workers while it is sent. */
export const PURCHASING_PO_EMAIL_LEASE_SECONDS = 600;
/** Wait after failed attempt n (1-based); 5 waits for 6 attempts. */
export const PURCHASING_PO_EMAIL_BACKOFF_SECONDS = [
  60, 300, 1800, 7200, 21600,
] as const;

/** `email: null` means the adapter is not configured: deliveries fail closed. */
export type PurchasingPoEmailDeps = { email: EmailProvider | null };

export type PurchasingPoEmailResult = {
  sent: number;
  retried: number;
  failed: number;
};

type Outcome = keyof PurchasingPoEmailResult;

const REJECTED = "Penyedia email menolak pengiriman.";
const GENERIC = "Pengiriman email gagal.";
const ORDER_NOT_SENDABLE = "Purchase order tidak lagi dikirim.";
const LINK_UNAVAILABLE = "Tautan PDF tidak tersedia lagi.";
const ORDER_BUSY = "Purchase order sedang diproses, dicoba lagi.";
const AMBIGUOUS =
  "Status pengiriman tidak pasti (proses berhenti saat mengirim). Periksa penyedia email, lalu kirim ulang manual.";

/** A failure no retry can fix: the delivery is `failed` at once. */
class PermanentFailure extends Error {}

type DeliveryRow = typeof purchaseOrderEmailDeliveries.$inferSelect;

/** SQLSTATE 55P03: the NOWAIT lock was not available (driver errors nest). */
function isLockNotAvailable(error: unknown): boolean {
  for (let e = error, i = 0; e && typeof e === "object" && i < 5; i += 1) {
    if ((e as { code?: unknown }).code === "55P03") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Safe, short reason: never the address or a provider payload. */
function reasonOf(error: unknown): string {
  if (error instanceof CoreError) return error.message.slice(0, 200);
  return GENERIC;
}

function renderEmail(input: {
  number: string;
  outletName: string;
  linkUrl: string;
}): { subject: string; body: string } {
  return {
    subject: `Purchase Order ${input.number} - ${input.outletName}`,
    body: [
      "Halo,",
      "",
      `Berikut Purchase Order ${input.number} dari ${input.outletName}.`,
      "Lihat dan unduh PDF-nya di tautan berikut (berlaku 7 hari):",
      input.linkUrl,
      "",
      "Salam,",
      input.outletName,
    ].join("\n"),
  };
}

type Claimed =
  | { kind: "none" }
  | { kind: "done"; id: string; outcome: Outcome }
  | {
      kind: "send";
      row: DeliveryRow;
      subject: string;
      body: string;
    };

/** Records a failed attempt; `permanent` skips the retries. */
async function recordFailure(
  tx: Tx,
  row: DeliveryRow,
  now: Date,
  failure: string,
  permanent: boolean,
): Promise<Outcome> {
  const attempts = row.attempts + 1;
  const final = permanent || attempts >= PURCHASING_PO_EMAIL_MAX_ATTEMPTS;
  const wait =
    PURCHASING_PO_EMAIL_BACKOFF_SECONDS[
      Math.min(attempts, PURCHASING_PO_EMAIL_BACKOFF_SECONDS.length) - 1
    ]!;
  await tx
    .update(purchaseOrderEmailDeliveries)
    .set({
      status: final ? "failed" : "queued",
      attempts,
      lastError: failure,
      nextAttemptAt: final ? null : new Date(now.getTime() + wait * 1000),
      sendStartedAt: null,
    })
    .where(
      and(
        eq(purchaseOrderEmailDeliveries.tenantId, row.tenantId),
        eq(purchaseOrderEmailDeliveries.id, row.id),
        // A revoke that failed the row meanwhile stays failed.
        eq(purchaseOrderEmailDeliveries.status, "queued"),
      ),
    );
  return final ? "failed" : "retried";
}

/** Step 1: claim one row, prepare the payload, take the lease. */
async function claimOne(
  context: ScopedTenantContext,
  now: Date,
  skip: readonly string[],
): Promise<Claimed> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [row] = await tx
      .select()
      .from(purchaseOrderEmailDeliveries)
      .where(
        and(
          eq(purchaseOrderEmailDeliveries.tenantId, tenantId),
          eq(purchaseOrderEmailDeliveries.status, "queued"),
          or(
            isNull(purchaseOrderEmailDeliveries.nextAttemptAt),
            lte(purchaseOrderEmailDeliveries.nextAttemptAt, now),
          ),
          skip.length === 0
            ? undefined
            : notInArray(purchaseOrderEmailDeliveries.id, [...skip]),
        ),
      )
      .orderBy(
        asc(purchaseOrderEmailDeliveries.createdAt),
        asc(purchaseOrderEmailDeliveries.id),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return { kind: "none" };

    // The previous attempt marked "sending" and never recorded an outcome: the
    // worker died around the provider call, which may have taken the email.
    // The port has no lookup to reconcile and the provider's dedup window is
    // short, so do not resend: fail for manual review.
    if (row.sendStartedAt !== null) {
      const outcome = await recordFailure(tx, row, now, AMBIGUOUS, true);
      return { kind: "done", id: row.id, outcome };
    }

    let failure: string | null = null;
    let permanent = false;
    try {
      // A savepoint: a database error while preparing one email must not
      // abort the transaction that still has to record its outcome.
      const prepared = await tx.transaction(async (sp) => {
        const [order] = await sp
          .select({
            id: purchaseOrders.id,
            outletId: purchaseOrders.outletId,
            number: purchaseOrders.number,
            status: purchaseOrders.status,
          })
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.tenantId, tenantId),
              eq(purchaseOrders.id, row.purchaseOrderId),
            ),
          )
          .for("share", { noWait: true });
        if (
          !order ||
          (order.status !== "sent" && order.status !== "partially_received")
        )
          throw new PermanentFailure(ORDER_NOT_SENDABLE);
        const [outlet] = await sp
          .select({ name: outlets.name })
          .from(outlets)
          .where(
            and(eq(outlets.tenantId, tenantId), eq(outlets.id, order.outletId)),
          );
        const linkKey = `email:${row.id}`;
        // Reuse the live link; a dead one (revoked, expired) is permanent;
        // none at all (first attempt, or one that rolled back) is issued.
        let link: { url: string } | null = await findPurchaseOrderShareLink(
          sp,
          context,
          order,
          linkKey,
          now,
        );
        if (!link) {
          try {
            link = await ensurePurchaseOrderShareLink(
              sp,
              context,
              order,
              linkKey,
              row.createdBy,
              now,
            );
          } catch (error) {
            if (error instanceof PurchasingError)
              throw new PermanentFailure(LINK_UNAVAILABLE);
            throw error;
          }
        }
        return renderEmail({
          number: order.number,
          outletName: outlet?.name ?? "Legend",
          linkUrl: link.url,
        });
      });
      // The lease: hide the row from other workers until step 3 records the
      // outcome (or the lease runs out after a crash). Measured from the
      // wall clock at claim time, not the run's `now`: a long run (many
      // tenants, slow provider) would otherwise hand out a lease that has
      // already expired, and an overlapping run could claim the row again.
      // The same commit marks the attempt as "sending" (see sendStartedAt).
      await tx
        .update(purchaseOrderEmailDeliveries)
        .set({
          nextAttemptAt: new Date(
            Math.max(now.getTime(), Date.now()) +
              PURCHASING_PO_EMAIL_LEASE_SECONDS * 1000,
          ),
          sendStartedAt: new Date(),
        })
        .where(
          and(
            eq(purchaseOrderEmailDeliveries.tenantId, tenantId),
            eq(purchaseOrderEmailDeliveries.id, row.id),
          ),
        );
      return { kind: "send", row, ...prepared };
    } catch (error) {
      permanent = error instanceof PermanentFailure;
      failure = permanent
        ? (error as Error).message
        : isLockNotAvailable(error)
          ? ORDER_BUSY
          : reasonOf(error);
    }
    const outcome = await recordFailure(tx, row, now, failure, permanent);
    return { kind: "done", id: row.id, outcome };
  });
}

async function sendOne(
  context: ScopedTenantContext,
  email: EmailProvider,
  now: Date,
  skip: readonly string[],
): Promise<{ id: string; outcome: Outcome } | null> {
  const claimed = await claimOne(context, now, skip);
  if (claimed.kind === "none") return null;
  if (claimed.kind === "done") return claimed;

  const { row, subject, body } = claimed;
  const tenantId = context.tenant.tenantId;
  // Step 2: the provider call, outside any database transaction.
  let failure: string | null = null;
  try {
    const result = await email.send(context, {
      tenantId,
      outletId: outletIdSchema.parse(row.outletId),
      // The delivery id is the provider's idempotency key.
      reference: row.id,
      to: row.recipientEmail,
      subject,
      body,
    });
    if (!result.accepted) failure = REJECTED;
  } catch (error) {
    failure = reasonOf(error);
  }

  // Step 3: record the outcome.
  return withTenant(db, context, async (tx) => {
    if (failure !== null) {
      const outcome = await recordFailure(tx, row, now, failure, false);
      return { id: row.id, outcome };
    }
    // The provider took it: mark sent even if a revoke failed the row meanwhile.
    await tx
      .update(purchaseOrderEmailDeliveries)
      .set({
        status: "sent",
        sentAt: now,
        attempts: row.attempts + 1,
        lastError: null,
        nextAttemptAt: null,
        sendStartedAt: null,
      })
      .where(
        and(
          eq(purchaseOrderEmailDeliveries.tenantId, tenantId),
          eq(purchaseOrderEmailDeliveries.id, row.id),
        ),
      );
    return { id: row.id, outcome: "sent" as const };
  });
}

async function sendBatch(
  context: ScopedTenantContext,
  email: EmailProvider,
  now: Date,
): Promise<PurchasingPoEmailResult> {
  const total: PurchasingPoEmailResult = { sent: 0, retried: 0, failed: 0 };
  const tried: string[] = [];
  // Each row has its own transactions: a send that already left for the
  // provider is recorded on its own, never rolled back by a later row.
  for (let n = 0; n < PURCHASING_PO_EMAIL_BATCH; n += 1) {
    const done = await sendOne(context, email, now, tried);
    if (!done) break;
    tried.push(done.id);
    total[done.outcome] += 1;
  }
  return total;
}

/** `contexts` must be trusted tenant-scope contexts from the tenant registry. */
export async function runPurchasingPoEmailJob(
  contexts: readonly ScopedTenantContext[],
  deps: PurchasingPoEmailDeps,
  now = new Date(),
): Promise<PurchasingPoEmailResult> {
  const total: PurchasingPoEmailResult = { sent: 0, retried: 0, failed: 0 };
  // No provider: leave every row queued (fail closed, nothing counted).
  const email = deps.email;
  if (email === null) return total;
  for (const context of contexts) {
    // One tenant's failure (DB error, bad context) must not stop the others.
    try {
      const result = await sendBatch(context, email, now);
      total.sent += result.sent;
      total.retried += result.retried;
      total.failed += result.failed;
    } catch {
      total.failed += 1;
    }
  }
  return total;
}
