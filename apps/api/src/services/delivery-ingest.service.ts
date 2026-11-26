// Delivery platform webhook ingest (bead legend-5bn3 D3; PRD v1.7 §3.23, Alur
// G). The route verifies the signature over the raw bytes; this service does
// the rest:
//
// - resolves tenant + outlet from the platform's store id (`delivery_store_index`,
//   readable before a tenant context exists), then runs in that tenant's
//   outlet-scoped transaction (RLS applies, the owner role is never used);
// - idempotent import per (tenant, platform, external order id): any payload
//   hash already applied to the order answers with the stored order, a payload
//   signed before the newest applied one is ignored, a new hash updates that
//   order (never a second order) unless the order is final on the platform;
// - maps every line to our menu (`sync_menu` sends our menu item id as the
//   platform item id): unknown or inactive id -> `unmatched`, and an order with
//   an unmatched line is stored with `order_id` null and NOT injected, NOT
//   accepted (`needs_review`, contract `assertDeliveryOrderInjectable`);
// - a closed or paused channel rejects the order through the delivery machine;
// - an open channel injects the order to the POS/KDS (delivery-inject.ts) and
//   then auto-accepts it on the platform through the adapter;
// - an outlet its edge serves (E3b, CTO 26 Nov) cooks on the edge, which never
//   sees a cloud order: the order is stored, NOT injected and NOT accepted (the
//   platform cancels it on its own), logged and the outlet's supervisors alerted.
// Nothing here logs the payload (customer note, prices): ids only.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  idr,
  toIsoDateTime,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import type { DeliveryWebhookPayload } from "@starter/shared/adapters";
import {
  assertDeliveryOrderTransition,
  deliveryActionForTransition,
  DeliveryError,
  deliveryOrderLineSchema,
  deliveryOrderIsInjectable,
  type DeliveryOrderLine,
  type DeliveryOrderStatus,
  type DeliveryPlatform,
} from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import {
  deliveryChannelOrders,
  deliveryChannels,
} from "../db/schema/delivery.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { posWritesOnEdge } from "./pos-edge-outlet.ts";
import { deliveryChannelAdapterFor } from "./delivery-ports.ts";
import { recordAudit } from "./core-audit.ts";
import {
  advisoryLock,
  appendDeliveryEvent,
  injectDeliveryOrder,
  latestSignedAt,
  voidQueuedKdsLines,
  withSeenHash,
} from "./delivery-inject.ts";
import { outletContext } from "./device-pin-support.ts";
import {
  findByExternalId,
  lockDeliveryOrder,
  type DeliveryChannelOrderRow,
} from "./delivery-store.ts";
import type { Tx } from "./menu-internals.ts";
import { loadPosCatalogue } from "./pos-order-pricing.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";
import {
  evaluatePacingIfStale,
  isLinePaused,
  readPausedMenuLines,
} from "./kds-pacing.service.ts";
import type { CatalogueItem } from "./qr-order-pricing.ts";

export const DELIVERY_INGEST_RESULTS = [
  "injected",
  "duplicate",
  "updated",
  "cancelled",
  "needs_review",
  "rejected",
] as const;
export type DeliveryIngestResultKind = (typeof DELIVERY_INGEST_RESULTS)[number];

export type DeliveryIngestResult = {
  result: DeliveryIngestResultKind;
  deliveryOrderId: string;
  orderId: string | null;
  pickupNumber: string | null;
  status: DeliveryOrderStatus;
};

/** SHA-256 hex of the exact bytes received (dedupe key and audit). */
export function hashDeliveryPayload(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type ResolvedDeliveryStore = {
  tenantId: string;
  outletId: string;
};

/**
 * Tenant and outlet of a platform store id, or null. Runs outside any tenant
 * context through the SECURITY DEFINER `app.resolve_delivery_store` (one row
 * for an exact platform + store id; the app role has no SELECT on
 * `delivery_store_index`); everything after runs under RLS.
 */
export async function resolveDeliveryStore(
  platform: DeliveryPlatform,
  storeId: string,
): Promise<ResolvedDeliveryStore | null> {
  const result = await db.execute<{ tenant_id: string; outlet_id: string }>(
    sql`SELECT tenant_id, outlet_id FROM app.resolve_delivery_store(${platform}, ${storeId})`,
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, outletId: row.outlet_id } : null;
}

// ---- Line mapping -----------------------------------------------------------

/**
 * Maps the platform's lines onto our menu. The platform item id IS our menu
 * item id (`sync_menu`); a missing, inactive, unpriced or non-variant-matching
 * item is `unmatched` and keeps the platform's name for the review screen.
 */
export function mapDeliveryLines(
  items: DeliveryWebhookPayload["items"],
  catalogue: ReadonlyMap<string, CatalogueItem>,
): DeliveryOrderLine[] {
  return items.map((item, index) => {
    const itemId = uuidSchema.safeParse(item.itemId);
    const variantId =
      item.variantId == null ? null : uuidSchema.safeParse(item.variantId);
    const entry = itemId.success ? catalogue.get(itemId.data) : undefined;
    let channelPrice: number | null = null;
    if (entry && (variantId === null || variantId.success)) {
      channelPrice =
        variantId === null
          ? entry.variants.size > 0
            ? null
            : entry.plainPriceIdr
          : (entry.variants.get(variantId.data)?.priceIdr ?? null);
    }
    const modifiersTotal = item.modifiers.reduce(
      (sum, modifier) => sum + modifier.priceIdr,
      0,
    );
    const base = {
      lineNo: index + 1,
      externalItemId: item.itemId.slice(0, 100),
      externalItemName: item.name,
      quantity: item.quantity,
      unitPriceIdr: idr(item.unitPriceIdr),
      lineTotalIdr: idr((item.unitPriceIdr + modifiersTotal) * item.quantity),
      modifiers: item.modifiers.map((modifier) => ({
        name: modifier.name,
        priceIdr: idr(modifier.priceIdr),
      })),
      note: item.note ?? null,
    };
    if (!entry || channelPrice === null)
      return deliveryOrderLineSchema.parse({
        ...base,
        menuItemId: null,
        variantId: null,
        mapping: "unmatched",
        channelPriceIdr: null,
      });
    return deliveryOrderLineSchema.parse({
      ...base,
      menuItemId: entry.id,
      variantId: variantId?.success ? variantId.data : null,
      mapping: !entry.sellable
        ? "sold_out"
        : channelPrice === item.unitPriceIdr
          ? "matched"
          : "price_mismatch",
      channelPriceIdr: idr(channelPrice),
    });
  });
}

// ---- Ingest -----------------------------------------------------------------

/**
 * Final on the platform side: a later payload never changes their money or
 * reopens them (it is recorded as seen and answered without a change).
 */
const FINAL_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "cancelled",
  "rejected",
  "picked_up",
  "delivered",
]);

/** A payload hash this order already applied or recorded. */
function alreadySeen(row: DeliveryChannelOrderRow, payloadHash: string) {
  return (
    row.payloadHash === payloadHash ||
    row.seenPayloadHashes.includes(payloadHash)
  );
}

/**
 * Records a payload that changes nothing (a late update of a final order, a
 * repeated platform cancel), so its retries are plain duplicates.
 */
async function recordSeen(
  tx: Tx,
  row: DeliveryChannelOrderRow,
  input: { payloadHash: string; signedAt: Date | null },
): Promise<DeliveryChannelOrderRow> {
  const [updated] = await tx
    .update(deliveryChannelOrders)
    .set({
      seenPayloadHashes: withSeenHash(row.seenPayloadHashes, input.payloadHash),
      lastSignedAt: latestSignedAt(row.lastSignedAt, input.signedAt),
    })
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, row.tenantId),
        eq(deliveryChannelOrders.id, row.id),
      ),
    )
    .returning();
  return updated ?? row;
}

type ChannelRow = typeof deliveryChannels.$inferSelect;

async function loadChannel(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  platform: DeliveryPlatform,
): Promise<ChannelRow | null> {
  const [row] = await tx
    .select()
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.tenantId, tenantId),
        eq(deliveryChannels.outletId, outletId),
        eq(deliveryChannels.platform, platform),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The platform's commission when it reports none: the channel's rate. */
function commissionFor(
  payload: DeliveryWebhookPayload,
  channel: ChannelRow,
): number {
  const reported =
    payload.commissionIdr ??
    Math.round((payload.grossIdr * channel.commissionRateBps) / 10_000);
  return Math.min(reported, payload.grossIdr);
}

const outcome = (
  result: DeliveryIngestResultKind,
  row: Pick<
    DeliveryChannelOrderRow,
    "id" | "orderId" | "pickupNumber" | "status"
  >,
): DeliveryIngestResult => ({
  result,
  deliveryOrderId: row.id,
  orderId: row.orderId,
  pickupNumber: row.pickupNumber,
  status: row.status,
});

/**
 * Stores an order that is not injected (needs_review, or rejected because the
 * channel is closed): `order_id` null, no KDS, no pickup number.
 */
async function storeWithoutInjection(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    platform: DeliveryPlatform;
    payload: DeliveryWebhookPayload;
    payloadHash: string;
    signedAt: Date | null;
    commissionIdr: number;
    lines: DeliveryOrderLine[];
    status: "received" | "rejected";
    closeReason: string | null;
    existing: DeliveryChannelOrderRow | null;
    now: Date;
  },
): Promise<DeliveryChannelOrderRow> {
  const tenantId = context.tenant.tenantId;
  const { now, payload } = input;
  const values = {
    status: input.status,
    grossIdr: idr(payload.grossIdr),
    commissionIdr: idr(input.commissionIdr),
    payloadHash: input.payloadHash,
    seenPayloadHashes: withSeenHash(
      input.existing?.seenPayloadHashes ?? [],
      input.payloadHash,
    ),
    lastSignedAt: latestSignedAt(
      input.existing?.lastSignedAt ?? null,
      input.signedAt,
    ),
    customerNote: payload.customerNote ?? null,
    lines: input.lines,
    closedAt: input.status === "rejected" ? now : null,
    closeReason: input.closeReason,
    updatedAt: now,
  };
  const [row] = input.existing
    ? await tx
        .update(deliveryChannelOrders)
        .set({ ...values, version: sql`${deliveryChannelOrders.version} + 1` })
        .where(
          and(
            eq(deliveryChannelOrders.tenantId, tenantId),
            eq(deliveryChannelOrders.id, input.existing.id),
          ),
        )
        .returning()
    : await tx
        .insert(deliveryChannelOrders)
        .values({
          tenantId,
          outletId: input.outletId,
          platform: input.platform,
          externalOrderId: payload.orderId,
          orderId: null,
          pickupNumber: null,
          source: "platform",
          receivedAt: now,
          createdAt: now,
          ...values,
        })
        .returning();
  if (!row) throw new Error("Delivery channel order write returned no row");
  if (!input.existing)
    await appendDeliveryEvent(tx, context, "delivery_order.received", {
      deliveryOrderId: row.id,
      outletId: input.outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform: input.platform,
        externalOrderId: payload.orderId,
        orderId: null,
        source: "platform",
        grossIdr: payload.grossIdr,
        commissionIdr: input.commissionIdr,
        payloadHash: input.payloadHash,
      },
      actorUserId: null,
      now,
    });
  if (input.status === "rejected") {
    assertDeliveryOrderTransition("received", "rejected");
    await appendDeliveryEvent(tx, context, "delivery_order.status_changed", {
      deliveryOrderId: row.id,
      outletId: input.outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform: input.platform,
        externalOrderId: payload.orderId,
        orderId: null,
        from: "received",
        to: "rejected",
        action: deliveryActionForTransition("received", "rejected"),
      },
      actorUserId: null,
      now,
    });
  }
  return row;
}

/**
 * A platform cancel of a known order: through the machine, never a new order.
 * `needsReview` when the POS order already has captured money (left unvoided
 * for staff, see voidQueuedKdsLines).
 */
async function cancelFromPlatform(
  tx: Tx,
  context: ScopedTenantContext,
  existing: DeliveryChannelOrderRow,
  input: {
    payloadHash: string;
    signedAt: Date | null;
    reason: string;
    now: Date;
  },
): Promise<{ row: DeliveryChannelOrderRow; needsReview: boolean }> {
  assertDeliveryOrderTransition(existing.status, "cancelled");
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .update(deliveryChannelOrders)
    .set({
      status: "cancelled",
      closedAt: input.now,
      closeReason: input.reason,
      payloadHash: input.payloadHash,
      seenPayloadHashes: withSeenHash(
        existing.seenPayloadHashes,
        input.payloadHash,
      ),
      lastSignedAt: latestSignedAt(existing.lastSignedAt, input.signedAt),
      updatedAt: input.now,
      version: sql`${deliveryChannelOrders.version} + 1`,
    })
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.id, existing.id),
      ),
    )
    .returning();
  if (!row) throw new Error("Delivery channel order cancel returned no row");
  await appendDeliveryEvent(tx, context, "delivery_order.status_changed", {
    deliveryOrderId: row.id,
    outletId: row.outletId,
    payload: {
      deliveryChannelOrderId: row.id,
      platform: row.platform,
      externalOrderId: row.externalOrderId,
      orderId: row.orderId,
      from: existing.status,
      to: "cancelled",
      // The platform cancelled it: nothing is pushed back.
      action: null,
    },
    actorUserId: null,
    now: input.now,
  });
  // The kitchen stops: lines not started are voided (KDS too), their daily
  // limit released, and the POS order voided once no live line is left.
  const { needsReview } = await voidQueuedKdsLines(tx, context, row, {
    reason: input.reason,
    actorUserId: null,
    now: input.now,
  });
  return { row, needsReview };
}

/**
 * Accepts the order on the platform (adapter `accept_order`) and records
 * `accepted` through the delivery machine. A refused or failed adapter call
 * leaves the order `received` for staff to accept by hand; it never throws.
 */
export async function autoAccept(
  context: ScopedTenantContext,
  row: DeliveryChannelOrderRow,
  now: Date,
): Promise<DeliveryChannelOrderRow> {
  const action = deliveryActionForTransition("received", "accepted");
  if (action === null) return row;
  let accepted = false;
  try {
    const result = await deliveryChannelAdapterFor(row.platform).execute(
      context,
      {
        tenantId: row.tenantId,
        outletId: row.outletId,
        reference: `${row.id}:accepted`,
        channel: row.platform,
        action,
        payload: {
          externalOrderId: row.externalOrderId,
          status: "accepted",
          reason: null,
        },
      },
    );
    accepted = result.accepted;
  } catch {
    accepted = false;
  }
  if (!accepted) return row;
  return withTenant(db, context, async (tx) => {
    const locked = await lockDeliveryOrder(tx, context.tenant.tenantId, row.id);
    if (!locked || locked.status !== "received") return locked ?? row;
    assertDeliveryOrderTransition("received", "accepted");
    const [updated] = await tx
      .update(deliveryChannelOrders)
      .set({
        status: "accepted",
        acceptedAt: now,
        updatedAt: now,
        version: sql`${deliveryChannelOrders.version} + 1`,
      })
      .where(
        and(
          eq(deliveryChannelOrders.tenantId, context.tenant.tenantId),
          eq(deliveryChannelOrders.id, row.id),
        ),
      )
      .returning();
    if (!updated) return locked;
    await appendDeliveryEvent(tx, context, "delivery_order.status_changed", {
      deliveryOrderId: row.id,
      outletId: row.outletId,
      payload: {
        deliveryChannelOrderId: row.id,
        platform: row.platform,
        externalOrderId: row.externalOrderId,
        orderId: row.orderId,
        from: "received",
        to: "accepted",
        action,
      },
      actorUserId: null,
      now,
    });
    return updated;
  });
}

/** Longest wait for a row or advisory lock inside one webhook import. */
export const DELIVERY_INGEST_LOCK_TIMEOUT_MS = 5_000;

/**
 * What the kitchen cooks from a line, in platform terms: item, variant,
 * quantity, unit price, modifiers and note. Names and mapping are not part
 * of it (a renamed item is the same line).
 */
function lineSignature(
  lines: readonly {
    itemId: string | null;
    variantId: string | null;
    quantity: number;
    unitPriceIdr: number;
    modifiers: readonly { name: string; priceIdr: number }[];
    note: string | null;
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        lines.map((line) => [
          line.itemId,
          line.variantId,
          line.quantity,
          line.unitPriceIdr,
          line.modifiers.map((modifier) => [modifier.name, modifier.priceIdr]),
          line.note,
        ]),
      ),
    )
    .digest("hex");
}

/** True when the payload's lines differ from the lines the kitchen has. */
export function deliveryLinesChanged(
  stored: readonly DeliveryOrderLine[],
  items: DeliveryWebhookPayload["items"],
): boolean {
  return (
    lineSignature(
      stored.map((line) => ({
        itemId: line.externalItemId,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceIdr: line.unitPriceIdr,
        modifiers: line.modifiers,
        note: line.note,
      })),
    ) !==
    lineSignature(
      items.map((item) => ({
        itemId: item.itemId.slice(0, 100),
        // As mapDeliveryLines stores it (uuidSchema lower-cases).
        variantId:
          item.variantId == null
            ? null
            : (uuidSchema.safeParse(item.variantId).data ?? item.variantId),
        quantity: item.quantity,
        unitPriceIdr: item.unitPriceIdr,
        modifiers: item.modifiers,
        note: item.note ?? null,
      })),
    )
  );
}

/**
 * A changed payload for an injected order: money and note updated, lines kept
 * as cooked. Appends `delivery_order.updated` and an audit entry with the
 * money before and after and whether the lines changed.
 */
async function applyPayloadUpdate(
  tx: Tx,
  context: ScopedTenantContext,
  existing: DeliveryChannelOrderRow,
  input: {
    payload: DeliveryWebhookPayload;
    payloadHash: string;
    signedAt: Date | null;
    commissionIdr: number;
    now: Date;
  },
): Promise<{ row: DeliveryChannelOrderRow; linesChanged: boolean }> {
  const { payload, now } = input;
  const tenantId = context.tenant.tenantId;
  const linesChanged = deliveryLinesChanged(existing.lines, payload.items);
  const [row] = await tx
    .update(deliveryChannelOrders)
    .set({
      grossIdr: idr(payload.grossIdr),
      commissionIdr: idr(input.commissionIdr),
      customerNote: payload.customerNote ?? null,
      payloadHash: input.payloadHash,
      seenPayloadHashes: withSeenHash(
        existing.seenPayloadHashes,
        input.payloadHash,
      ),
      lastSignedAt: latestSignedAt(existing.lastSignedAt, input.signedAt),
      updatedAt: now,
      version: sql`${deliveryChannelOrders.version} + 1`,
    })
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.id, existing.id),
      ),
    )
    .returning();
  if (!row) throw new Error("Delivery channel order update returned none");
  await appendDeliveryEvent(tx, context, "delivery_order.updated", {
    deliveryOrderId: row.id,
    outletId: row.outletId,
    payload: {
      deliveryChannelOrderId: row.id,
      platform: row.platform,
      externalOrderId: row.externalOrderId,
      orderId: row.orderId,
      grossBeforeIdr: existing.grossIdr,
      grossIdr: payload.grossIdr,
      commissionBeforeIdr: existing.commissionIdr,
      commissionIdr: input.commissionIdr,
      payloadHash: input.payloadHash,
      linesChanged,
    },
    actorUserId: null,
    now,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: row.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "delivery_order.updated",
      objectType: "delivery_channel_order",
      objectId: row.id,
      reason: linesChanged
        ? "Platform mengubah item pesanan setelah dikirim ke dapur; perlu ditinjau."
        : null,
      maskedChanges: {
        before: {
          platform: existing.platform,
          grossIdr: existing.grossIdr,
          commissionIdr: existing.commissionIdr,
        },
        after: {
          platform: row.platform,
          grossIdr: payload.grossIdr,
          commissionIdr: input.commissionIdr,
          linesChanged,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    ["platform", "grossIdr", "commissionIdr", "linesChanged"],
  );
  return { row, linesChanged };
}

type Stored = {
  result: DeliveryIngestResult;
  /**
   * Injected order (new, or a replay still `received`) to auto-accept on the
   * platform after the commit.
   */
  accept: DeliveryChannelOrderRow | null;
  /** Rejected order to tell the platform about after the commit. */
  rejected: DeliveryChannelOrderRow | null;
};

/**
 * Imports one verified webhook delivery. `raw` is the exact signed body, the
 * payload its parsed form, `signedAt` the signature's instant (null: no
 * ordering check). Throws DELIVERY_CHANNEL_UNKNOWN (unknown store id),
 * DELIVERY_ORDER_NOT_FOUND (cancel of an order we never received) and
 * DELIVERY_TRANSITION_INVALID (cancel of an order past the machine's reach).
 */
export async function ingestDeliveryWebhook(
  platform: DeliveryPlatform,
  payload: DeliveryWebhookPayload,
  raw: Uint8Array,
  options: { signedAt?: Date | null; now?: Date } = {},
): Promise<DeliveryIngestResult> {
  const now = options.now ?? new Date();
  const signedAt = options.signedAt ?? null;
  const store = await resolveDeliveryStore(platform, payload.storeId);
  if (!store) throw new DeliveryError("DELIVERY_CHANNEL_UNKNOWN");
  const tenantId = tenantIdSchema.parse(store.tenantId);
  const outletId = outletIdSchema.parse(store.outletId);
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
    outletId,
  );
  const payloadHash = hashDeliveryPayload(raw);

  // KDS-05: refresh the pause rows before the transaction, never inside it.
  await evaluatePacingIfStale(context, outletId, now);
  const stored = await withTenant(db, context, async (tx): Promise<Stored> => {
    // A stuck writer of the same order must not hold the platform's request:
    // past this the webhook fails and the platform retries.
    await tx.execute(
      sql.raw(
        `SET LOCAL lock_timeout = '${DELIVERY_INGEST_LOCK_TIMEOUT_MS}ms'`,
      ),
    );
    await advisoryLock(
      tx,
      `delivery-order:${tenantId}:${platform}:${payload.orderId}`,
    );
    const existing = await findByExternalId(
      tx,
      tenantId,
      platform,
      payload.orderId,
      { lock: true },
    );

    if (existing && alreadySeen(existing, payloadHash)) {
      // An injected order whose auto-accept failed is retried on a replay.
      const retryAccept =
        existing.status === "received" &&
        existing.orderId !== null &&
        (await loadChannel(tx, tenantId, outletId, platform))?.isOpen ===
          true &&
        !(await posWritesOnEdge(tx, tenantId, outletId));
      return {
        result: outcome("duplicate", existing),
        accept: retryAccept ? existing : null,
        rejected: null,
      };
    }

    if (payload.event === "order.cancelled") {
      if (!existing) throw new DeliveryError("DELIVERY_ORDER_NOT_FOUND");
      // Already closed: a repeated cancel (new hash) is recorded, not a 409
      // the platform would retry forever.
      if (existing.status === "cancelled" || existing.status === "rejected") {
        const row = await recordSeen(tx, existing, { payloadHash, signedAt });
        return {
          result: outcome("cancelled", row),
          accept: null,
          rejected: null,
        };
      }
      const { row, needsReview } = await cancelFromPlatform(
        tx,
        context,
        existing,
        {
          payloadHash,
          signedAt,
          reason: payload.reason?.trim() || "Dibatalkan oleh platform",
          now,
        },
      );
      return {
        result: outcome(needsReview ? "needs_review" : "cancelled", row),
        accept: null,
        rejected: null,
      };
    }
    if (payload.items.length === 0)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Pesanan platform harus memuat minimal satu item.",
      );

    if (existing) {
      // Signed before the newest payload already applied: out of order, ignored.
      if (
        signedAt !== null &&
        existing.lastSignedAt !== null &&
        signedAt < existing.lastSignedAt
      )
        return {
          result: outcome("duplicate", existing),
          accept: null,
          rejected: null,
        };
      // Final on the platform: the money and the status stay as they are.
      if (FINAL_STATUSES.has(existing.status)) {
        const row = await recordSeen(tx, existing, { payloadHash, signedAt });
        return {
          result: outcome("duplicate", row),
          accept: null,
          rejected: null,
        };
      }
    }

    // A changed payload for an order the kitchen already has: only the money
    // and note the platform reports are updated; the fired lines stay as
    // cooked. Changed lines are not applied: the answer is needs_review and
    // the change is on the event and the audit for staff to act on.
    if (existing && existing.orderId !== null) {
      const channel = await loadChannel(tx, tenantId, outletId, platform);
      const updated = await applyPayloadUpdate(tx, context, existing, {
        payload,
        payloadHash,
        signedAt,
        commissionIdr: channel ? commissionFor(payload, channel) : 0,
        now,
      });
      return {
        result: outcome(
          updated.linesChanged ? "needs_review" : "updated",
          updated.row,
        ),
        accept: null,
        rejected: null,
      };
    }
    // Closed on the platform side already (rejected/cancelled): a changed
    // payload cannot reopen it.
    if (existing && existing.status !== "received")
      throw new DeliveryError("DELIVERY_TRANSITION_INVALID");

    const channel = await loadChannel(tx, tenantId, outletId, platform);
    if (!channel) throw new DeliveryError("DELIVERY_CHANNEL_UNKNOWN");
    const commissionIdr = commissionFor(payload, channel);

    const outlet = await loadOutlet(tx, context, outletId);
    const catalogue = await loadPosCatalogue(tx, context, {
      brandId: outlet.brandId,
      outletId,
      timeZone: outlet.timezone,
      businessDate: businessDateFor(outlet, now),
      channel: platform,
      itemIds: payload.items
        .map((item) => uuidSchema.safeParse(item.itemId))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : [])),
      now,
    });
    const paused = await readPausedMenuLines(
      tx,
      context,
      outletId,
      platform,
      now,
    );
    const lines = mapDeliveryLines(payload.items, catalogue);

    // Closed or paused: the order is refused through the machine and recorded.
    if (!channel.isOpen) {
      const row = await storeWithoutInjection(tx, context, {
        outletId,
        platform,
        payload,
        payloadHash,
        signedAt,
        commissionIdr,
        lines,
        status: "rejected",
        closeReason: "Toko sedang ditutup pada platform ini",
        existing,
        now,
      });
      return { result: outcome("rejected", row), accept: null, rejected: row };
    }

    // E3b: the edge's kitchen never sees a cloud order, so none is injected or
    // accepted for an outlet its edge serves (until delivery reaches the edge).
    if (await posWritesOnEdge(tx, tenantId, outletId)) {
      const row = await storeWithoutInjection(tx, context, {
        outletId,
        platform,
        payload,
        payloadHash,
        signedAt,
        commissionIdr,
        lines,
        status: "received",
        closeReason: null,
        existing,
        now,
      });
      if (!existing) await alertDeliveryOnEdge(tx, context, row, now);
      return {
        result: outcome("needs_review", row),
        accept: null,
        rejected: null,
      };
    }

    // needs_review: an unmatched line keeps the order out of the KDS and out
    // of auto-accept until staff resolve the mapping.
    if (!deliveryOrderIsInjectable({ lines })) {
      const row = await storeWithoutInjection(tx, context, {
        outletId,
        platform,
        payload,
        payloadHash,
        signedAt,
        commissionIdr,
        lines,
        status: "received",
        closeReason: null,
        existing,
        now,
      });
      return {
        result: outcome("needs_review", row),
        accept: null,
        rejected: null,
      };
    }

    const injected = await injectDeliveryOrder(tx, context, {
      outletId,
      platform,
      externalOrderId: payload.orderId,
      source: "platform",
      grossIdr: payload.grossIdr,
      commissionIdr,
      payloadHash,
      signedAt,
      customerNote: payload.customerNote ?? null,
      lines,
      initialStatus: "received",
      existing: existing ?? undefined,
      actorUserId: null,
      now,
    });
    // Linked to a POS twin the cashier voided: kept for review, not accepted.
    if (injected.needsReview)
      return {
        result: outcome("needs_review", injected.row),
        accept: null,
        rejected: null,
      };
    // KDS-05: a paused line never refuses a paid order; the pause is only
    // recorded, the order is injected and accepted like any other.
    const pausedLines = lines.flatMap((line) =>
      line.menuItemId !== null &&
      isLinePaused(paused, line.menuItemId, line.variantId)
        ? [{ menuItemId: line.menuItemId, variantId: line.variantId }]
        : [],
    );
    if (pausedLines.length > 0)
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: injected.row.outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "delivery_order.paused_line_accepted",
          objectType: "delivery_channel_order",
          objectId: injected.row.id,
          reason:
            "Item dijeda dapur, pesanan platform yang sudah dibayar tetap diterima.",
          maskedChanges: {
            before: null,
            after: { platform: injected.row.platform, pausedLines },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(now),
        },
        ["platform", "pausedLines", "menuItemId", "variantId"],
      );
    return {
      result: outcome("injected", injected.row),
      accept: injected.row,
      rejected: null,
    };
  });

  // The platform learns about a rejected order after the commit; best effort.
  if (stored.rejected) await pushRejection(context, stored.rejected);

  if (stored.accept) {
    const accepted = await autoAccept(context, stored.accept, now);
    return outcome(stored.result.result, accepted);
  }
  return stored.result;
}

/**
 * A platform order the cloud left alone because the outlet's edge serves it:
 * logged (ids only) and one alert to the outlet's supervisors (or owners),
 * keyed on the delivery order so a replay never alerts twice.
 */
async function alertDeliveryOnEdge(
  tx: Tx,
  context: ScopedTenantContext,
  row: DeliveryChannelOrderRow,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  logger.warn(
    {
      tenantId,
      outletId: row.outletId,
      deliveryOrderId: row.id,
      platform: row.platform,
    },
    "Delivery order not injected: the outlet is served by its edge",
  );
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId,
      outletId: outletIdSchema.parse(row.outletId),
      alsoOwners: true,
      id: uuidToUlid(row.id),
      eventName: "delivery_order.edge_not_injected",
      aggregateType: "delivery_order",
      aggregateId: row.id,
      payload: { deliveryOrderId: row.id, platform: row.platform },
      title: "Pesanan delivery tidak diterima",
      body: `Pesanan ${row.platform} ${row.externalOrderId} tidak masuk dapur karena outlet ini memakai server lokal. Platform akan membatalkannya.`,
      recordEmpty: true,
    },
    now,
  );
}

async function pushRejection(
  context: ScopedTenantContext,
  row: DeliveryChannelOrderRow,
): Promise<void> {
  const action = deliveryActionForTransition("received", "rejected");
  if (action === null) return;
  try {
    await deliveryChannelAdapterFor(row.platform).execute(context, {
      tenantId: row.tenantId,
      outletId: row.outletId,
      reference: `${row.id}:rejected`,
      channel: row.platform,
      action,
      payload: {
        externalOrderId: row.externalOrderId,
        status: "rejected",
        reason: row.closeReason,
      },
    });
  } catch {
    // The order is already recorded as rejected; the platform call is a courtesy.
  }
}
