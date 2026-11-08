// Send a purchase order (PRD v1.7 §3.18 "Kirim PO"; bead legend-9yz): email it
// to the supplier or hand out a shareable PDF link.
//
// - Allowed when the PO is `approved` (moves to `sent`, stamps sentAt and, for
//   email, sentTo) or already `sent` / `partially_received` (a resend: a new
//   link or email, no state change). Anything else is a 409
//   PURCHASE_ORDER_NOT_SENDABLE.
// - Share link: the token is an HMAC of (tenant, order, idempotency key), so a
//   replay recomputes the same URL and the idempotency table never holds a
//   token. Only the SHA-256 of the token is stored. It expires after 7 days.
// - Public read: the tenant comes from the request host (TEN-02); the token is
//   looked up by its hash inside that tenant. An unknown, malformed, expired or
//   revoked token is one and the same 404.
// - Email: a queued delivery row; the worker job
//   (worker/purchasing-po-email.job.ts) sends it. Audit rows and DTOs never
//   carry the address, only the mask.

import { createHash, createHmac, scryptSync } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  CoreError,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PurchasingError,
  purchaseOrderLineSchema,
  purchaseOrderSchema,
  purchaseOrderSendResultSchema,
  transitionPurchaseOrder,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderSendResult,
  type sendPurchaseOrderInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { inventoryItems, uoms } from "../db/schema/inventory.ts";
import { tenantDomains } from "../db/schema/platform-domains.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import {
  purchaseOrderEmailDeliveries,
  purchaseOrderLines,
  purchaseOrderShareLinks,
  purchaseOrders,
  purchasingIdempotency,
  suppliers,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  loadPurchaseOrder,
  translatePurchasingError,
  type PurchaseOrderRow,
} from "./purchasing-flow.shared.ts";
import { renderPurchaseOrderPdf } from "./purchasing-po-pdf.ts";

export type SendPurchaseOrderInput = z.infer<
  typeof sendPurchaseOrderInputSchema
>;

/** PO create/update/submit/close/cancel/send share one permission. */
export const PURCHASE_ORDER_SEND_PERMISSION = "purchasing.order.create";
export const PURCHASE_ORDER_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OPERATION = "purchase_order.send";
const LINK_KEY_CONTEXT = "legend:purchase-order-link:v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const AUDIT_FIELDS = ["channel", "status", "resend"] as const;

// ---- Link token -----------------------------------------------------------

let cachedLinkKey: Buffer | undefined;

function linkKey(): Buffer {
  if (cachedLinkKey) return cachedLinkKey;
  cachedLinkKey = scryptSync(
    env.DATA_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET,
    LINK_KEY_CONTEXT,
    32,
  );
  return cachedLinkKey;
}

/** Deterministic: the same (tenant, order, key) always yields one token. */
export function purchaseOrderLinkToken(
  tenantId: string,
  purchaseOrderId: string,
  linkKeyValue: string,
): string {
  return createHmac("sha256", linkKey())
    .update(`po-link:${tenantId}:${purchaseOrderId}:${linkKeyValue}`, "utf8")
    .digest("base64url");
}

export function purchaseOrderLinkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Origin a supplier can open without a session: the tenant's verified primary
 * host (a custom domain first, else the platform subdomain). Caddy sends every
 * `/api/*` request on a tenant host to the API, and the API resolves the tenant
 * from that host, so a cookieless click lands in the right tenant. Without a
 * verified host (development) it falls back to the API origin.
 */
async function publicOrigin(tx: Tx, tenantId: string): Promise<string> {
  const [domain] = await tx
    .select({ hostname: tenantDomains.hostname })
    .from(tenantDomains)
    .where(
      and(
        eq(tenantDomains.tenantId, tenantId),
        isNotNull(tenantDomains.verifiedAt),
        eq(tenantDomains.tlsStatus, "active"),
      ),
    )
    // 'custom' sorts before 'platform_subdomain'.
    .orderBy(asc(tenantDomains.kind), asc(tenantDomains.createdAt))
    .limit(1);
  if (!domain) return env.BETTER_AUTH_URL.replace(/\/+$/, "");
  return `${new URL(env.WEB_URL).protocol}//${domain.hostname}`;
}

async function purchaseOrderLinkUrl(
  tx: Tx,
  tenantId: string,
  token: string,
): Promise<string> {
  return `${await publicOrigin(tx, tenantId)}/api/public/purchase-orders/${token}`;
}

/**
 * Creates (or finds, on a replay) the share link for `linkKeyValue` inside the
 * caller's transaction. The raw token is returned to the caller only.
 */
export async function ensurePurchaseOrderShareLink(
  tx: Tx,
  context: ScopedTenantContext,
  order: { id: string; outletId: string },
  linkKeyValue: string,
  createdBy: string,
  now: Date,
): Promise<{ token: string; url: string; expiresAt: Date }> {
  const tenantId = context.tenant.tenantId;
  const token = purchaseOrderLinkToken(tenantId, order.id, linkKeyValue);
  const tokenHash = purchaseOrderLinkTokenHash(token);
  await tx
    .insert(purchaseOrderShareLinks)
    .values({
      tenantId,
      outletId: order.outletId,
      purchaseOrderId: order.id,
      tokenHash,
      expiresAt: new Date(now.getTime() + PURCHASE_ORDER_LINK_TTL_MS),
      createdBy,
    })
    .onConflictDoNothing();
  const [link] = await tx
    .select({
      expiresAt: purchaseOrderShareLinks.expiresAt,
      revokedAt: purchaseOrderShareLinks.revokedAt,
      purchaseOrderId: purchaseOrderShareLinks.purchaseOrderId,
    })
    .from(purchaseOrderShareLinks)
    .where(
      and(
        eq(purchaseOrderShareLinks.tenantId, tenantId),
        eq(purchaseOrderShareLinks.tokenHash, tokenHash),
      ),
    );
  // An existing link (same key) that died must not be handed out again.
  if (
    !link ||
    link.purchaseOrderId !== order.id ||
    link.revokedAt !== null ||
    link.expiresAt <= now
  )
    throw new PurchasingError(
      "PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE",
      "The share link could not be issued.",
    );
  return {
    token,
    url: await purchaseOrderLinkUrl(tx, tenantId, token),
    expiresAt: link.expiresAt,
  };
}

// ---- DTO mapping ----------------------------------------------------------

// ---- Idempotency (purchasing_idempotency, tenant-level RLS) ---------------

type Claim = {
  operation: string;
  key: string;
  fingerprint: string;
  outletId: string;
};

const reused = () =>
  new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was used for a different request.",
  );

async function findClaim(tx: Tx, context: ScopedTenantContext, claim: Claim) {
  const [row] = await tx
    .select()
    .from(purchasingIdempotency)
    .where(
      and(
        eq(purchasingIdempotency.tenantId, context.tenant.tenantId),
        eq(purchasingIdempotency.operation, claim.operation),
        eq(purchasingIdempotency.idempotencyKey, claim.key),
      ),
    );
  return row ?? null;
}

function replayOf(
  row: { requestFingerprint: string; response: unknown },
  claim: Claim,
): { replay: unknown } {
  if (row.requestFingerprint !== claim.fingerprint || row.response === null)
    throw reused();
  return { replay: row.response };
}

async function claimIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: Claim,
): Promise<{ replay: unknown } | null> {
  const existing = await findClaim(tx, context, claim);
  if (existing) return replayOf(existing, claim);
  const inserted = await tx
    .insert(purchasingIdempotency)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: claim.outletId,
      operation: claim.operation,
      idempotencyKey: claim.key,
      requestFingerprint: claim.fingerprint,
      response: null,
    })
    .onConflictDoNothing()
    .returning({ key: purchasingIdempotency.idempotencyKey });
  if (inserted.length > 0) return null;
  const winner = await findClaim(tx, context, claim);
  if (!winner) throw reused();
  return replayOf(winner, claim);
}

async function completeIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: Claim,
  response: unknown,
): Promise<void> {
  await tx
    .update(purchasingIdempotency)
    .set({ response })
    .where(
      and(
        eq(purchasingIdempotency.tenantId, context.tenant.tenantId),
        eq(purchasingIdempotency.operation, claim.operation),
        eq(purchasingIdempotency.idempotencyKey, claim.key),
      ),
    );
}

// ---- Send -----------------------------------------------------------------

/** What a replay stores: never the token (the URL is recomputed). */
type StoredSend = {
  purchaseOrder: PurchaseOrder;
  channel: "email" | "share_link";
  sentTo: string | null;
  expiresAt: string | null;
};

function toResult(stored: StoredSend, shareUrl: string | null) {
  return purchaseOrderSendResultSchema.parse({ ...stored, shareUrl });
}

export async function sendPurchaseOrder(
  context: ScopedTenantContext,
  actorUserId: string,
  purchaseOrderId: string,
  input: SendPurchaseOrderInput,
): Promise<PurchaseOrderSendResult> {
  assertTrustedScopedContext(context);
  const now = new Date();
  const tenantId = context.tenant.tenantId;
  try {
    return await sendInTransaction();
  } catch (error) {
    throw translatePurchasingError(error);
  }

  function sendInTransaction() {
    return withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.id, purchaseOrderId),
          ),
        )
        .for("update");
      // Another tenant's order, or an outlet outside the caller's reach (RLS),
      // is simply not found.
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        PURCHASE_ORDER_SEND_PERMISSION,
        row.outletId,
      );
      const claim: Claim = {
        operation: OPERATION,
        key: input.idempotencyKey,
        outletId: row.outletId,
        fingerprint: requestFingerprint(OPERATION, actorUserId, {
          purchaseOrderId,
          channel: input.channel,
          email: input.email?.toLowerCase() ?? null,
          note: input.note ?? null,
        }),
      };
      const replay = await claimIdempotency(tx, context, claim);
      if (replay) {
        const stored = replay.replay as StoredSend;
        let shareUrl: string | null = null;
        if (stored.channel === "share_link") {
          // The URL is recomputed, never stored. A replay must not hand out a
          // dead link: the stored hash has to exist, be live and be this order's.
          const token = purchaseOrderLinkToken(
            tenantId,
            purchaseOrderId,
            input.idempotencyKey,
          );
          const [link] = await tx
            .select({
              expiresAt: purchaseOrderShareLinks.expiresAt,
              revokedAt: purchaseOrderShareLinks.revokedAt,
              purchaseOrderId: purchaseOrderShareLinks.purchaseOrderId,
            })
            .from(purchaseOrderShareLinks)
            .where(
              and(
                eq(purchaseOrderShareLinks.tenantId, tenantId),
                eq(
                  purchaseOrderShareLinks.tokenHash,
                  purchaseOrderLinkTokenHash(token),
                ),
              ),
            );
          if (
            !link ||
            link.purchaseOrderId !== purchaseOrderId ||
            link.revokedAt !== null ||
            link.expiresAt <= now
          )
            throw new PurchasingError(
              "PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE",
              "The share link is no longer valid. Send again with a new idempotency key.",
            );
          shareUrl = await purchaseOrderLinkUrl(tx, tenantId, token);
        }
        return toResult(
          {
            ...stored,
            purchaseOrder: purchaseOrderSchema.parse(stored.purchaseOrder),
          },
          shareUrl,
        );
      }

      const resend =
        row.status === "sent" || row.status === "partially_received";
      if (!resend && row.status !== "approved")
        throw new PurchasingError(
          "PURCHASE_ORDER_NOT_SENDABLE",
          `Cannot send a purchase order in ${row.status}`,
        );
      let order = row;
      if (!resend) {
        let next: PurchaseOrderRow["status"];
        try {
          next = transitionPurchaseOrder(row.status, "send");
        } catch (error) {
          if (error instanceof PurchasingError)
            throw new HttpError(409, error.code, error.message);
          throw error;
        }
        const [updated] = await tx
          .update(purchaseOrders)
          .set({
            status: next,
            sentAt: now,
            sentTo: input.channel === "email" ? input.email! : null,
            updatedAt: sql`GREATEST(clock_timestamp(), ${purchaseOrders.updatedAt} + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(purchaseOrders.tenantId, tenantId),
              eq(purchaseOrders.id, row.id),
            ),
          )
          .returning();
        order = updated!;
      }

      let shareUrl: string | null = null;
      let expiresAt: Date | null = null;
      if (input.channel === "share_link") {
        const link = await ensurePurchaseOrderShareLink(
          tx,
          context,
          order,
          input.idempotencyKey,
          actorUserId,
          now,
        );
        shareUrl = link.url;
        expiresAt = link.expiresAt;
      } else {
        await tx.insert(purchaseOrderEmailDeliveries).values({
          tenantId,
          outletId: order.outletId,
          purchaseOrderId: order.id,
          recipientEmail: input.email!,
          createdBy: actorUserId,
        });
      }

      const purchaseOrder = await loadPurchaseOrder(tx, order);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: order.outletId,
        action: "purchasing.order_sent",
        objectType: "purchase_order",
        objectId: order.id,
        before: { status: row.status },
        after: { channel: input.channel, status: order.status, resend },
        safeFields: AUDIT_FIELDS,
        reason: input.note ?? null,
      });
      const stored: StoredSend = {
        purchaseOrder,
        channel: input.channel,
        sentTo: input.channel === "email" ? input.email! : null,
        expiresAt: expiresAt === null ? null : toIsoDateTime(expiresAt),
      };
      await completeIdempotency(tx, context, claim, stored);
      return toResult(stored, shareUrl);
    });
  }
}

// ---- Public PDF -----------------------------------------------------------

const documentNotFound = () =>
  new HttpError(404, "NOT_FOUND", "Dokumen tidak ditemukan.");

export type PurchaseOrderPdfFile = { pdf: Buffer; filename: string };

/**
 * The PDF behind a share link. Unknown, malformed, expired, revoked and
 * cancelled-order links all answer the same 404. `context` must be the
 * tenant-scope context of the request host.
 */
export async function getPublicPurchaseOrderPdf(
  context: ScopedTenantContext,
  token: string,
  now = new Date(),
): Promise<PurchaseOrderPdfFile> {
  if (!TOKEN_PATTERN.test(token)) throw documentNotFound();
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [link] = await tx
      .select()
      .from(purchaseOrderShareLinks)
      .where(
        and(
          eq(purchaseOrderShareLinks.tenantId, tenantId),
          eq(
            purchaseOrderShareLinks.tokenHash,
            purchaseOrderLinkTokenHash(token),
          ),
        ),
      );
    if (!link || link.revokedAt !== null || link.expiresAt <= now)
      throw documentNotFound();
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, link.purchaseOrderId),
        ),
      );
    if (!row || row.status === "cancelled") throw documentNotFound();
    const order = await loadPurchaseOrder(tx, row);
    const [supplier] = await tx
      .select({
        name: suppliers.name,
        address: suppliers.address,
        phone: suppliers.phone,
      })
      .from(suppliers)
      .where(
        and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, row.supplierId)),
      );
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const [outlet] = await tx
      .select({ name: outlets.name })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, row.outletId)));
    if (!supplier || !tenant || !outlet) throw documentNotFound();
    const lineRows = await tx
      .select({
        line: purchaseOrderLines,
        itemName: inventoryItems.name,
        uomCode: uoms.code,
      })
      .from(purchaseOrderLines)
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.tenantId, purchaseOrderLines.tenantId),
          eq(inventoryItems.id, purchaseOrderLines.inventoryItemId),
        ),
      )
      .innerJoin(
        uoms,
        and(
          eq(uoms.tenantId, purchaseOrderLines.tenantId),
          eq(uoms.id, purchaseOrderLines.uomId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          eq(purchaseOrderLines.purchaseOrderId, row.id),
        ),
      )
      .orderBy(asc(purchaseOrderLines.lineNo), sql`${purchaseOrderLines.id}`);
    const lines: (PurchaseOrderLine & { itemName: string; uomCode: string })[] =
      lineRows.map(({ line, itemName, uomCode }) => ({
        ...purchaseOrderLineSchema.parse({
          id: line.id,
          tenantId: line.tenantId,
          purchaseOrderId: line.purchaseOrderId,
          inventoryItemId: line.inventoryItemId,
          quantity: line.quantity,
          uomId: line.uomId,
          unitPriceIdr: line.unitPriceIdr,
          lineTotalIdr: line.lineTotalIdr,
        }),
        itemName,
        uomCode,
      }));
    const pdf = renderPurchaseOrderPdf({
      tenantName: tenant.name,
      outletName: outlet.name,
      supplier,
      order,
      lines,
      // Stable per order: a re-send renders the same bytes.
      issuedAt: row.sentAt ?? row.createdAt,
    });
    return {
      pdf,
      filename: `${order.number.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf`,
    };
  });
}
