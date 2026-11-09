// Worker job: sends queued e-receipt emails (bead legend-93a; PRD v1.7 §3 F11).
// Registered in worker-main.ts' per-tenant sweep (legend-v3vo).
//
// Per tenant, up to 50 times, one `withTenant` transaction (outlet `*`) per
// delivery: claim one queued email `FOR UPDATE SKIP LOCKED` so two workers
// never send the same one, open the sealed address, build the document,
// create/reuse the e-receipt link, send through the EmailProvider (reference =
// delivery id) and mark the row sent, all committed together. A sent or finally
// failed row drops its sealed address. A failed attempt counts; after 5 the
// row is `failed`.

import { and, asc, eq, notInArray, or, sql } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import type { EmailProvider } from "@starter/shared/adapters";
import { db } from "../db/index.ts";
import { posReceiptDeliveries } from "../db/schema/pos-receipt.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret } from "../lib/secrets.ts";
import { ensureReceiptLink } from "../services/pos-receipt-delivery.service.ts";
import { buildReceiptDocument } from "../services/pos-receipt-document.ts";
import { renderReceiptEmail } from "../services/pos-receipt-email.ts";
import { findReceiptById } from "../services/pos-receipt.service.ts";

export const POS_RECEIPT_EMAIL_QUEUE = "pos-receipt-email";
export const POS_RECEIPT_EMAIL_INTERVAL_SECONDS = 30;
export const POS_RECEIPT_EMAIL_BATCH = 50;
export const POS_RECEIPT_EMAIL_MAX_ATTEMPTS = 5;
export const POS_RECEIPT_EMAIL_BACKOFF_SECONDS = 120;

/** `email: null` means the adapter is not configured: rows stay queued (legend-v3vo). */
export type PosReceiptEmailDeps = { email: EmailProvider | null };

/** Safe, short reason for the row: never the address or a provider payload. */
function reasonOf(error: unknown): string {
  if (error instanceof CoreError) return error.message.slice(0, 200);
  return "Pengiriman email gagal.";
}

type Outcome = "sent" | "retried" | "failed";

/**
 * Claims one queued email (`FOR UPDATE SKIP LOCKED`), sends it and records the
 * outcome in the same transaction. `null` when nothing is left to claim.
 * `skip` holds the rows already tried in this run so a retry waits for the
 * next run instead of being sent again at once.
 */
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
      .from(posReceiptDeliveries)
      .where(
        and(
          eq(posReceiptDeliveries.tenantId, tenantId),
          eq(posReceiptDeliveries.channel, "email"),
          eq(posReceiptDeliveries.status, "queued"),
          // Backoff: a failed email waits 2, 4, 8, 16 min (about 30 min in all)
          // so a short provider outage does not burn every attempt.
          or(
            eq(posReceiptDeliveries.attempts, 0),
            sql`${posReceiptDeliveries.updatedAt} <= ${now.toISOString()}::timestamptz
              - make_interval(secs => ${POS_RECEIPT_EMAIL_BACKOFF_SECONDS} * power(2, ${posReceiptDeliveries.attempts} - 1))`,
          ),
          skip.length === 0
            ? undefined
            : notInArray(posReceiptDeliveries.id, [...skip]),
        ),
      )
      .orderBy(asc(posReceiptDeliveries.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;

    let failure: string | null = null;
    try {
      // A savepoint: a database error while preparing one email must not
      // abort the transaction that still has to record its outcome.
      const accepted = await tx.transaction(async (sp) => {
        if (!row.destinationSealed)
          throw new CoreError("CONFLICT", "Alamat email tidak tersedia.");
        const to = openSecret(
          row.destinationSealed,
          `pos_receipt_delivery:${tenantId}:${row.receiptId}`,
        );
        const receipt = await findReceiptById(sp, context, row.receiptId);
        if (!receipt)
          throw new CoreError("NOT_FOUND", "Struk tidak ditemukan.");
        const document = await buildReceiptDocument(sp, context, receipt);
        const link = await ensureReceiptLink(
          sp,
          context,
          receipt,
          `email:${row.id}`,
          null,
          now,
        );
        const { subject, body } = renderReceiptEmail(document, link.url);
        const result = await email.send(context, {
          tenantId,
          outletId: row.outletId,
          // The delivery id is the provider's idempotency key.
          reference: row.id,
          to,
          subject,
          body,
        });
        return result.accepted;
      });
      if (!accepted) failure = "Penyedia email menolak pengiriman.";
    } catch (error) {
      failure = reasonOf(error);
    }

    const attempts = row.attempts + 1;
    const where = and(
      eq(posReceiptDeliveries.tenantId, tenantId),
      eq(posReceiptDeliveries.id, row.id),
    );
    if (failure === null) {
      // The raw address is not kept once it is sent (the mask stays).
      await tx
        .update(posReceiptDeliveries)
        .set({
          status: "sent",
          sentAt: now,
          attempts,
          failureReason: null,
          destinationSealed: null,
          updatedAt: now,
        })
        .where(where);
      return { id: row.id, outcome: "sent" };
    }
    const terminal = attempts >= POS_RECEIPT_EMAIL_MAX_ATTEMPTS;
    await tx
      .update(posReceiptDeliveries)
      .set({
        status: terminal ? "failed" : "queued",
        attempts,
        failureReason: failure,
        ...(terminal ? { destinationSealed: null } : {}),
        updatedAt: now,
      })
      .where(where);
    return { id: row.id, outcome: terminal ? "failed" : "retried" };
  });
}

async function sendBatch(
  context: ScopedTenantContext,
  email: EmailProvider,
  now: Date,
): Promise<{ sent: number; retried: number; failed: number }> {
  const total = { sent: 0, retried: 0, failed: 0 };
  const tried: string[] = [];
  // One transaction per row: a send that already left for the provider is
  // committed with its mark, never rolled back by a later row's failure.
  for (let n = 0; n < POS_RECEIPT_EMAIL_BATCH; n += 1) {
    const done = await sendOne(context, email, now, tried);
    if (!done) break;
    tried.push(done.id);
    total[done.outcome] += 1;
  }
  return total;
}

/** `contexts` must be trusted tenant-scope contexts from the tenant registry. */
export async function runPosReceiptEmailJob(
  contexts: readonly ScopedTenantContext[],
  deps: PosReceiptEmailDeps,
  now = new Date(),
): Promise<{ sent: number; retried: number; failed: number }> {
  const total = { sent: 0, retried: 0, failed: 0 };
  // No provider: leave every row queued (fail closed, nothing counted), as the
  // PO email job does (legend-v3vo).
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
