// Worker job: sends queued purchase order emails (bead legend-9yz; PRD v1.7
// §3.18 "Kirim PO"). Not registered here: the lead wires
// `runPurchasingPoEmailJob` into the worker runtime (a schedule every 30 s).
//
// Per tenant, up to PURCHASING_PO_EMAIL_BATCH times, one `withTenant`
// transaction per delivery: claim one queued row `FOR UPDATE SKIP LOCKED` so
// two workers never send the same one, issue a share link for the PDF, send
// through the EmailProvider port (reference = delivery id) and mark the row
// sent, all committed together. The port carries no attachment, so the email
// holds the 7-day PDF link. A failed attempt counts and waits
// PURCHASING_PO_EMAIL_BACKOFF_SECONDS (1 min, 5 min, 30 min, 2 h, 6 h) via
// `next_attempt_at`; after PURCHASING_PO_EMAIL_MAX_ATTEMPTS the row is
// `failed`. With no provider nothing is claimed or counted: rows stay queued
// until one is configured (fail closed, nothing is sent). The job logs
// nothing; `lastError` is a short fixed reason and never holds the address.

import { and, asc, eq, isNull, lte, notInArray, or } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EmailProvider } from "@starter/shared/adapters";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  purchaseOrderEmailDeliveries,
  purchaseOrders,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { ensurePurchaseOrderShareLink } from "../services/purchasing-send.service.ts";

export const PURCHASING_PO_EMAIL_QUEUE = "purchasing-po-email";
export const PURCHASING_PO_EMAIL_INTERVAL_SECONDS = 30;
export const PURCHASING_PO_EMAIL_BATCH = 50;
export const PURCHASING_PO_EMAIL_MAX_ATTEMPTS = 6;
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

async function sendOne(
  context: ScopedTenantContext,
  email: EmailProvider,
  now: Date,
  skip: readonly string[],
): Promise<{ id: string; outcome: Outcome } | null> {
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
    if (!row) return null;

    let failure: string | null = null;
    try {
      // A savepoint: a database error while preparing one email must not
      // abort the transaction that still has to record its outcome.
      const accepted = await tx.transaction(async (sp) => {
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
          );
        if (!order || order.status === "cancelled")
          throw new CoreError("NOT_FOUND", "Purchase order tidak tersedia.");
        const [outlet] = await sp
          .select({ name: outlets.name })
          .from(outlets)
          .where(
            and(eq(outlets.tenantId, tenantId), eq(outlets.id, order.outletId)),
          );
        const link = await ensurePurchaseOrderShareLink(
          sp,
          context,
          order,
          `email:${row.id}`,
          row.createdBy,
          now,
        );
        const { subject, body } = renderEmail({
          number: order.number,
          outletName: outlet?.name ?? "Legend",
          linkUrl: link.url,
        });
        const result = await email.send(context, {
          tenantId,
          outletId: outletIdSchema.parse(row.outletId),
          // The delivery id is the provider's idempotency key.
          reference: row.id,
          to: row.recipientEmail,
          subject,
          body,
        });
        return result.accepted;
      });
      if (!accepted) failure = REJECTED;
    } catch (error) {
      failure = reasonOf(error);
    }

    const attempts = row.attempts + 1;
    const where = and(
      eq(purchaseOrderEmailDeliveries.tenantId, tenantId),
      eq(purchaseOrderEmailDeliveries.id, row.id),
    );
    if (failure === null) {
      await tx
        .update(purchaseOrderEmailDeliveries)
        .set({ status: "sent", sentAt: now, attempts, lastError: null })
        .where(where);
      return { id: row.id, outcome: "sent" };
    }
    const final = attempts >= PURCHASING_PO_EMAIL_MAX_ATTEMPTS;
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
      })
      .where(where);
    return { id: row.id, outcome: final ? "failed" : "retried" };
  });
}

async function sendBatch(
  context: ScopedTenantContext,
  email: EmailProvider,
  now: Date,
): Promise<PurchasingPoEmailResult> {
  const total: PurchasingPoEmailResult = { sent: 0, retried: 0, failed: 0 };
  const tried: string[] = [];
  // One transaction per row: a send that already left for the provider is
  // committed with its mark, never rolled back by a later row's failure.
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
