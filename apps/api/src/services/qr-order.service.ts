import { maskAuditChanges } from "@starter/shared/audit";
// QR order: shared cart, server quote, checkout and the session bill (bead
// legend-e2x; PRD v1.7 §3 F10 "Menu & Keranjang", "Mode Bayar", "Estimasi
// Waktu Saji"; §4 Alur A (bayar di muka) and B (open bill); ORD-01, ORD-02,
// ORD-03, ORD-05, ORD-11).
//
// Guests are not users (ORD-01: no login, no install). Every call carries the
// opaque table-session credential from the scan (`Authorization: Bearer`); the
// service resolves the session by the credential's hash inside the tenant
// transaction and refuses a closed, voided, expired or rotated credential
// (ORD-04). The tenant comes from the request host (TEN-02), never the body.
//
// Concurrency and idempotency:
// - Cart writes lock the session row FOR SHARE, then the cart row FOR UPDATE;
//   the client's `expectedCartVersion` is compared under that lock (412 on a
//   stale view), so two guests editing one cart never lose a write.
// - Checkout takes the table's live-state lock (table-session.service.ts), the
//   session row FOR UPDATE and then the cart row, so a checkout serializes with
//   open-bill confirm/close and with a second payer checking out the same cart.
// - Every guest mutation key is bound to a request fingerprint
//   (`qr_order_idempotency`): a replay returns the stored answer, a different
//   request with the same key is refused with IDEMPOTENCY_KEY_REUSED.
//
// ORD-05: an item that is sold out cannot be added; at checkout each line
// reserves its daily stock (`reserveMenuItemDailyLimit`) inside the order
// transaction on the outlet business date (owner Q39), and a line that cannot
// be reserved leaves the cart and is reported in `quote.removedLines`. A void
// releases exactly once per line, in the transaction that voids it.
//
// ORD-02: a pay-first order is stored `awaiting_payment` with every item
// `held`; only a verified payment (qr-order-payment.ts, `payment.paid`) fires
// it. An open-bill order fires immediately, once a waiter confirmed the
// session (contract planQrOrderPlacement).

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  businessDateOf,
  CoreError,
  createUlid,
  idr,
  outletIdSchema,
  toIsoDateTime,
  ulidToUuid,
  uuidSchema,
  z,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { defineDomainEvent } from "@starter/shared/events";
import { PosError } from "@starter/shared/pos";
import {
  addCartLineInputSchema,
  cartLineSchema,
  cartMutationResultSchema,
  cartSchema,
  placeOrderInputSchema,
  placeOrderResultSchema,
  planQrOrderPlacement,
  QR_ORDER_PRICING_MODE_MIXED,
  qrOrderErrorHttpStatus,
  qrOrderErrorMessages,
  qrOrderEvents,
  qrOrderSchema,
  quoteInputSchema,
  sessionBillSchema,
  tableSessionIdSchema,
  tableSessionSchema,
  tableSessionTokenExpiresAt,
  tableSessionViewSchema,
  transitionTableSession,
  updateCartLineInputSchema,
  EDGE_LINK_DOWN,
  QR_OUTLET_CLOSED_MESSAGE,
  type Cart,
  type CartLine,
  type CartMutationResult,
  type OrderQuote,
  type PlaceOrderResult,
  type QrOrderPlacement,
  type QrOrder,
  type SessionBill,
  type TableSession,
  type TableSessionStatus,
  type TableSessionView,
} from "@starter/shared/qr-order";
import {
  calculateTax,
  orderNetSubtotalIdr,
  TaxError,
  type TaxCalculationInput,
} from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { assertCatalogSalesAllowed } from "../edge/sales-gate.ts";
import {
  domainEventOutbox,
  floorZones,
  outlets,
  paymentLinks,
  sessionParticipants,
  tableSessions,
  tables,
} from "../db/schema/index.ts";
import {
  cartLines,
  orderItems,
  orders,
  qrOrderIdempotency,
  tableSessionCarts,
  type CartLineModifierSnapshot,
} from "../db/schema/qr-order.ts";
import { customerProfiles } from "../db/schema/crm-member.ts"; // legend-111j
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts"; // orderIssues: legend-pc51h
import { posOrderTenders } from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  forwardQrOrderToEdge,
  getOutletEdgeLinkState,
} from "../edge/qr-order-forwarding.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertOpenBillWithinLimit,
  OpenBillLimitExceeded,
  refuseOpenBillBreach,
} from "./open-bill-control.service.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { zoneOrderingOpen } from "./guest-menu.service.ts";
import {
  evaluatePacingIfStale,
  readPausedMenuLines,
} from "./kds-pacing.service.ts";
import { routeFiredItemsToKitchen } from "./kds.service.ts";
import {
  releaseMenuItemDailyLimit,
  reserveMenuItemDailyLimit,
} from "./menu-availability.ts";
import type { Tx } from "./menu-internals.ts";
import type { OrderPromoInput, OrderPromoQuote } from "./order-promo-port.ts";
import { computeLineCostSnapshots } from "./order-cost-snapshot.service.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { isBusinessDayClosed } from "./pos-cash-guard.ts";
import {
  depositCreditFor,
  lockSessionDeposit,
  qrOrderOpenServiceRequests,
  qrOrderPromoPort,
  qrOrderServingEstimatePort,
} from "./qr-order-ports.ts";
import { listSessionSplitDtosTx } from "./bill-split.service.ts";
import { assertNoOpenEdcRequest } from "./pos-order-support.ts";
import { assertNoActiveQrisHold } from "./pos-qris-hold.ts";
import { requestRefundsForVoidedQrOrder } from "./qr-order-late-payment.ts";
import { appendQrOrderPaid } from "./qr-order-paid.ts";
import { netAllocatedIdrSql } from "./payment-net-allocated-sql.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { listSessionDepositSources } from "./reservation-deposit-credit.ts";
import {
  buildQuote,
  loadCatalogue,
  loadTaxConfig,
  QR_PRICE_CHANNEL,
  resolveLine,
  selectServiceChargeRules,
  type CatalogueItem,
  type PriceChangeDraft,
  type PricedQuoteLine,
  type QrTaxConfig,
  type QuoteBuild,
  type RemovedLineDraft,
} from "./qr-order-pricing.ts";
import { recordTaxSnapshots } from "./tax.service.ts";
import { lockTableLiveState } from "./table-session.service.ts";

type AddCartLineInput = z.output<typeof addCartLineInputSchema>;
type UpdateCartLineInput = z.output<typeof updateCartLineInputSchema>;
type QuoteInput = z.output<typeof quoteInputSchema>;
type PlaceOrderInput = z.output<typeof placeOrderInputSchema>;

type SessionRow = typeof tableSessions.$inferSelect;
type CartRow = typeof tableSessionCarts.$inferSelect;
type CartLineRow = typeof cartLines.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;
type OutletRow = typeof outlets.$inferSelect;
type ZoneRow = typeof floorZones.$inferSelect;

const EVENT_DESTINATION = "cloud-sync";
/** PostgreSQL NOTIFY channel for shared-cart pushes; only identifiers cross it. */
export const QR_CART_WAKE_CHANNEL = "legend_qr_cart_wakeup";
/** PRD silent on a cart size; 50 lines bounds one quote (decision, e2x). */
export const MAX_CART_LINES = 50;
const AUDIT_SAFE_FIELDS = [
  "id",
  "number",
  "status",
  "paymentMode",
  "totalIdr",
  "depositAppliedIdr",
  "itemCount",
  "removedCount",
  "reason",
  "kitchenFire",
  "tableSessionId",
] as const;

/**
 * `cart.updated` is catalogued on the WS-03 line without a payload schema;
 * this definition binds it (lead: move into @starter/shared/qr-order events).
 */
export const cartUpdatedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  cartId: uuidSchema,
  version: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  change: z.enum(["line_added", "line_updated", "line_removed", "checked_out"]),
});
export const cartUpdatedEvent = defineDomainEvent({
  name: "cart.updated",
  payload: cartUpdatedPayloadSchema,
});
type CartChange = z.infer<typeof cartUpdatedPayloadSchema>["change"];

// ---- Small helpers --------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unauthorized(
  message = "Sesi meja tidak dikenali; pindai QR meja lagi.",
) {
  return new CoreError("UNAUTHORIZED", message);
}

function isActive(status: TableSessionStatus): boolean {
  return status !== "closed" && status !== "voided";
}

function tokenExpired(row: SessionRow, now: Date): boolean {
  const expiresAt = new Date(
    tableSessionTokenExpiresAt({
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    }),
  ).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= now.getTime();
}

function lineTotal(line: {
  unitPriceIdr: number;
  modifiersTotalIdr: number;
  quantity: number;
}): number {
  return (line.unitPriceIdr + line.modifiersTotalIdr) * line.quantity;
}

/**
 * Resolves the guest credential to its session inside the caller's
 * transaction (ORD-04). The credential names exactly one session; a path id
 * that is not that session answers 404 so the route is no oracle. `update`
 * serializes with the staff lifecycle through the table's live-state lock.
 */
async function guestSession(
  tx: Tx,
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now: Date,
  lock: "none" | "share" | "update",
): Promise<SessionRow> {
  if (credential.length < 20 || credential.length > 256) throw unauthorized();
  const tenantId = context.tenant.tenantId;
  const hash = sha256(credential);
  const [found] = await tx
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.sessionTokenHash, hash),
      ),
    );
  if (!found) throw unauthorized();
  if (found.id !== sessionId)
    throw new CoreError("NOT_FOUND", "Sesi meja tidak ditemukan.");
  let row = found;
  if (lock !== "none") {
    if (lock === "update")
      await lockTableLiveState(tx, tenantId, found.tableId);
    const query = tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, found.id),
          eq(tableSessions.sessionTokenHash, hash),
        ),
      );
    const [locked] =
      lock === "update" ? await query.for("update") : await query.for("share");
    // Rotated between the lookup and the lock: the session just closed.
    if (!locked)
      throw unauthorized(
        "ORD-04: sesi meja sudah ditutup; pindai QR meja lagi.",
      );
    row = locked;
  }
  if (!isActive(row.status) || tokenExpired(row, now))
    throw unauthorized("ORD-04: sesi meja sudah ditutup; pindai QR meja lagi.");
  assertOutletInScope(context.outletScope, row.outletId);
  return row;
}

/**
 * Refresh stale auto-pause state BEFORE the order transaction opens, so the
 * in-tx `readPausedMenuLines` stays a plain read. The session's outlet is only
 * known from the session row, so a short read-only tx resolves it first. Never
 * throws: a bad credential or session surfaces from the real transaction.
 */
async function refreshPacingForSession(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  if (credential.length < 20 || credential.length > 256) return;
  let outletId: string | undefined;
  try {
    const [found] = await withTenant(db, context, (tx) =>
      tx
        .select({ id: tableSessions.id, outletId: tableSessions.outletId })
        .from(tableSessions)
        .where(
          and(
            eq(tableSessions.tenantId, context.tenant.tenantId),
            eq(tableSessions.sessionTokenHash, sha256(credential)),
          ),
        ),
    );
    if (found?.id === sessionId) outletId = found.outletId;
  } catch {
    return;
  }
  if (outletId === undefined) return;
  await evaluatePacingIfStale(context, outletId as OutletId, now);
}

async function loadOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletRow> {
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  return row;
}

async function loadZoneOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  session: SessionRow,
): Promise<{ zone: ZoneRow; tableCode: string }> {
  const tenantId = context.tenant.tenantId;
  const [table] = await tx
    .select({ zoneId: tables.zoneId, code: tables.code })
    .from(tables)
    .where(and(eq(tables.tenantId, tenantId), eq(tables.id, session.tableId)));
  if (!table) throw new CoreError("NOT_FOUND", "Meja sesi tidak ditemukan.");
  const [zone] = await tx
    .select()
    .from(floorZones)
    .where(
      and(eq(floorZones.tenantId, tenantId), eq(floorZones.id, table.zoneId)),
    );
  if (!zone) throw new CoreError("NOT_FOUND", "Zona meja tidak ditemukan.");
  return { zone, tableCode: table.code };
}

function businessDateFor(outlet: OutletRow, now: Date): string {
  return businessDateOf(now, outletBusinessDayClock(outlet));
}

// ---- Events, realtime push, audit ----------------------------------------------

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateUuid: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateUuid),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

type EventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

/** One catalogued event in the caller's transaction (transactional outbox). */
async function appendEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  input: {
    aggregateId: string;
    outletId: string;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const aggregateUuid = uuidSchema.safeParse(input.aggregateId).success
    ? input.aggregateId
    : ulidToUuid(input.aggregateId);
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    aggregateUuid,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Shared-cart push: the `cart.updated` outbox event (cloud-sync, edge and any
 * consumer) plus a NOTIFY wake-up that the realtime layer relays to the other
 * guests of the session after commit (notification-realtime.ts pattern: only
 * identifiers cross NOTIFY; the client re-reads under its own credential).
 */
async function publishCartChange(
  tx: Tx,
  context: ScopedTenantContext,
  cart: CartRow,
  lineCount: number,
  change: CartChange,
  now: Date,
): Promise<void> {
  await appendEvent(tx, context, cartUpdatedEvent, {
    aggregateId: cart.id,
    outletId: cart.outletId,
    payload: {
      sessionId: cart.tableSessionId,
      cartId: cart.id,
      version: cart.version,
      lineCount,
      change,
    },
    now,
  });
  await tx.execute(
    sql`SELECT pg_notify(${QR_CART_WAKE_CHANNEL}, ${JSON.stringify({
      tenantId: context.tenant.tenantId,
      sessionId: cart.tableSessionId,
      version: cart.version,
    })})`,
  );
}

async function auditOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    order: Pick<OrderRow, "id" | "outletId">;
    actorUserId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.order.outletId,
      actorType: input.actorUserId === null ? "system" : "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: "order",
      objectId: input.order.id,
      reason: input.reason ?? null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, AUDIT_SAFE_FIELDS),
        after:
          input.after === null
            ? null
            : maskAuditChanges(input.after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Idempotency ------------------------------------------------------------------

/**
 * Runs `run` once per (session, key). The key is bound to the fingerprint of
 * the operation and its request: the same request replays the stored answer,
 * another request with the key is refused (contract IDEMPOTENCY_KEY_REUSED).
 * Concurrent requests with one key serialize on an advisory lock first.
 */
async function idempotent<T>(
  tx: Tx,
  context: ScopedTenantContext,
  scope: { sessionId: string; outletId: SessionRow["outletId"] },
  key: string | null,
  operation: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (key === null) return run();
  const tenantId = context.tenant.tenantId;
  const fingerprint = idempotencyFingerprint(scope, operation, request);
  const stored = await readIdempotent<T>(tx, context, scope, key, fingerprint);
  if (stored !== undefined) return stored;
  const response = await run();
  await tx.insert(qrOrderIdempotency).values({
    tenantId,
    outletId: scope.outletId,
    tableSessionId: scope.sessionId,
    key,
    operation,
    fingerprint,
    response,
  });
  return response;
}

function idempotencyFingerprint(
  scope: { sessionId: string },
  operation: string,
  request: unknown,
): string {
  return sha256(
    JSON.stringify({ operation, sessionId: scope.sessionId, request }),
  );
}

/** Lock the key, then return its stored answer (undefined on a miss). */
async function readIdempotent<T>(
  tx: Tx,
  context: ScopedTenantContext,
  scope: { sessionId: string },
  key: string,
  fingerprint: string,
): Promise<T | undefined> {
  const tenantId = context.tenant.tenantId;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qr-order-idem:${tenantId}:${scope.sessionId}:${key}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(qrOrderIdempotency)
    .where(
      and(
        eq(qrOrderIdempotency.tenantId, tenantId),
        eq(qrOrderIdempotency.tableSessionId, scope.sessionId),
        eq(qrOrderIdempotency.key, key),
      ),
    );
  if (!existing) return undefined;
  if (existing.fingerprint !== fingerprint)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempoten ini sudah dipakai untuk permintaan lain.",
    );
  return existing.response as T;
}

/**
 * Read-only peek (legend-nqfov): the stored answer of (session, key) when the
 * same request was already served, undefined on a miss, IDEMPOTENCY_KEY_REUSED
 * when the key belongs to another request. Writes nothing.
 */
async function peekIdempotent<T>(
  tx: Tx,
  context: ScopedTenantContext,
  scope: { sessionId: string },
  key: string | null,
  operation: string,
  request: unknown,
): Promise<T | undefined> {
  if (key === null) return undefined;
  return readIdempotent<T>(
    tx,
    context,
    scope,
    key,
    idempotencyFingerprint(scope, operation, request),
  );
}

// ---- DTO mapping --------------------------------------------------------------------

async function sessionDto(tx: Tx, row: SessionRow): Promise<TableSession> {
  const participants = await tx
    .select()
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.tenantId, row.tenantId),
        eq(sessionParticipants.tableSessionId, row.id),
      ),
    )
    .orderBy(asc(sessionParticipants.joinedAt), asc(sessionParticipants.id));
  return tableSessionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableId: row.tableId,
    pax: row.pax,
    paymentMode: row.paymentMode,
    status: row.status,
    confirmedBy: row.confirmedBy,
    reservationId: row.reservationId,
    participants: participants.map((participant) => ({
      id: participant.id,
      tenantId: participant.tenantId,
      tableSessionId: participant.tableSessionId,
      deviceHash: participant.deviceHash,
      userId: participant.userId,
      joinedAt: participant.joinedAt.toISOString(),
      lastSeenAt: participant.lastSeenAt.toISOString(),
    })),
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    billRequestedAt: row.billRequestedAt?.toISOString() ?? null,
    closedReason: row.closedReason,
  });
}

function lineDto(row: CartLineRow): CartLine {
  return cartLineSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableSessionId: row.tableSessionId,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    name: row.name,
    quantity: row.quantity,
    modifiers: row.modifiers,
    note: row.note,
    unitPriceIdr: row.unitPriceIdr,
    modifiersTotalIdr: row.modifiersTotalIdr,
    lineTotalIdr: lineTotal(row),
    addedByParticipantId: row.addedByParticipantId,
    addedAt: row.addedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function cartDto(
  session: SessionRow,
  cart: CartRow | undefined,
  lines: readonly CartLineRow[],
): Cart {
  return cartSchema.parse({
    sessionId: session.id,
    version: cart?.version ?? 0,
    lines: lines.map(lineDto),
    updatedAt: (cart?.updatedAt ?? session.openedAt).toISOString(),
  });
}

async function readCart(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<{ cart: CartRow | undefined; lines: CartLineRow[] }> {
  const tenantId = context.tenant.tenantId;
  const query = tx
    .select()
    .from(tableSessionCarts)
    .where(
      and(
        eq(tableSessionCarts.tenantId, tenantId),
        eq(tableSessionCarts.tableSessionId, sessionId),
      ),
    );
  const [cart] = options.forUpdate ? await query.for("update") : await query;
  if (!cart) return { cart: undefined, lines: [] };
  const lines = await tx
    .select()
    .from(cartLines)
    .where(and(eq(cartLines.tenantId, tenantId), eq(cartLines.cartId, cart.id)))
    .orderBy(asc(cartLines.addedAt), asc(cartLines.id));
  return { cart, lines };
}

/** The session's cart row, created on first write, locked FOR UPDATE. */
async function lockCart(
  tx: Tx,
  context: ScopedTenantContext,
  session: SessionRow,
  now: Date,
): Promise<{ cart: CartRow; lines: CartLineRow[] }> {
  await tx
    .insert(tableSessionCarts)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: session.outletId,
      tableSessionId: session.id,
      version: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const { cart, lines } = await readCart(tx, context, session.id, {
    forUpdate: true,
  });
  if (!cart) throw new Error("Cart row missing after upsert");
  return { cart, lines };
}

function assertCartVersion(cart: CartRow, expected: number): void {
  if (cart.version !== expected)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Keranjang baru saja diubah tamu lain; muat ulang keranjang.",
    );
}

async function bumpCart(
  tx: Tx,
  context: ScopedTenantContext,
  cart: CartRow,
  now: Date,
): Promise<CartRow> {
  const [updated] = await tx
    .update(tableSessionCarts)
    .set({ version: cart.version + 1, updatedAt: now })
    .where(
      and(
        eq(tableSessionCarts.tenantId, context.tenant.tenantId),
        eq(tableSessionCarts.id, cart.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("Cart update returned no row");
  return updated;
}

async function orderItemsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderIds: readonly string[],
): Promise<Map<string, OrderItemRow[]>> {
  const byOrder = new Map<string, OrderItemRow[]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, context.tenant.tenantId),
        inArray(orderItems.orderId, [...orderIds]),
      ),
    )
    .orderBy(asc(orderItems.id));
  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

/**
 * legend-pc51h: the lines a kitchen swap added (`order_issues.
 * replacement_order_item_id`) per order. Their price difference is settled
 * outside the order (apology voucher or `order_issue_charges`), so the order
 * money stays frozen and `orderDto` reports those lines as a recovery
 * adjustment instead of part of the subtotal.
 */
async function swapReplacementIdsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const byOrder = new Map<string, Set<string>>();
  if (orderIds.length === 0) return byOrder;
  const rows = await tx
    .select({
      orderId: orderIssues.orderId,
      replacementId: orderIssues.replacementOrderItemId,
    })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, context.tenant.tenantId),
        inArray(orderIssues.orderId, [...orderIds]),
        isNotNull(orderIssues.replacementOrderItemId),
      ),
    );
  for (const row of rows) {
    if (row.replacementId === null) continue;
    const set = byOrder.get(row.orderId) ?? new Set<string>();
    set.add(row.replacementId);
    byOrder.set(row.orderId, set);
  }
  return byOrder;
}

export function orderDto(
  row: OrderRow,
  items: readonly OrderItemRow[],
  swapReplacementIds: ReadonlySet<string> = new Set(),
): QrOrder {
  // Sale value of the swap lines: the original line keeps the sale value in
  // the subtotal (the replacement is only a kitchen line, its difference is
  // billed or credited elsewhere), so the replacements are taken back out.
  const swapReplacementIdr = items
    .filter((item) => swapReplacementIds.has(item.id))
    .reduce((sum, item) => sum + item.lineTotalIdr, 0);
  return qrOrderSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    number: row.number,
    channel: "qr",
    serviceType: "dine_in",
    tableSessionId: row.tableSessionId,
    customerProfileId: row.customerProfileId,
    subtotalIdr: row.subtotalIdr,
    discountIdr: row.discountIdr,
    serviceChargeIdr: row.serviceChargeIdr,
    taxIdr: row.taxIdr,
    roundingIdr: row.roundingIdr,
    totalIdr: row.totalIdr,
    pricesIncludeTaxAndService: row.pricesIncludeTax,
    swapReplacementIdr,
    status: row.status,
    items: items.map((item) => ({
      id: item.id,
      tenantId: item.tenantId,
      orderId: item.orderId,
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      name: item.name,
      quantity: item.quantity,
      unitPriceIdr: item.unitPriceIdr,
      modifiersTotalIdr: item.modifiersTotalIdr,
      lineTotalIdr: item.lineTotalIdr,
      modifiers: item.modifiers.map((modifier) => ({
        modifierId: modifier.modifierId,
        name: modifier.name,
        priceIdr: modifier.priceIdr,
      })),
      note: item.note,
      course: item.course,
      fireStatus: item.fireStatus,
      status: item.status,
    })),
    createdAt: row.createdAt.toISOString(),
    placedAt: row.placedAt.toISOString(),
  });
}

async function sessionOrders(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
): Promise<OrderRow[]> {
  return tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.tableSessionId, sessionId),
        ne(orders.status, "draft"),
      ),
    )
    .orderBy(asc(orders.placedAt), asc(orders.id));
}

async function orderDtos(
  tx: Tx,
  context: ScopedTenantContext,
  rows: readonly OrderRow[],
): Promise<QrOrder[]> {
  const ids = rows.map((row) => row.id);
  const items = await orderItemsOf(tx, context, ids);
  const swaps = await swapReplacementIdsOf(tx, context, ids);
  return rows.map((row) =>
    orderDto(row, items.get(row.id) ?? [], swaps.get(row.id)),
  );
}

// ---- Pricing the cart ---------------------------------------------------------------

type PricedCart = {
  /** Lines that can be sold now, at today's server price. */
  sellable: Array<{
    row: CartLineRow;
    priced: PricedQuoteLine;
    modifiers: CartLineModifierSnapshot[];
    item: CatalogueItem;
  }>;
  removed: RemovedLineDraft[];
  priceChanges: PriceChangeDraft[];
};

async function priceCartLines(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletRow,
  lines: readonly CartLineRow[],
  now: Date,
): Promise<PricedCart> {
  const catalogue = await loadCatalogue(tx, context, {
    brandId: outlet.brandId,
    outletId: outlet.id as OutletId,
    timeZone: outlet.timezone,
    businessDate: businessDateFor(outlet, now),
    itemIds: lines.map((line) => line.menuItemId),
    now,
  });
  const paused = await readPausedMenuLines(
    tx,
    context,
    outlet.id as OutletId,
    QR_PRICE_CHANNEL,
    now,
  );
  const result: PricedCart = { sellable: [], removed: [], priceChanges: [] };
  for (const row of lines) {
    const item = catalogue.get(row.menuItemId);
    const resolution = resolveLine(item, {
      paused,
      menuItemId: row.menuItemId,
      variantId: row.variantId,
      quantity: row.quantity,
      modifierIds: row.modifiers.map((modifier) => modifier.modifierId),
    });
    // A line the menu no longer allows is as unorderable as a sold-out one
    // (ORD-05); the contract's only removal reason is `sold_out`.
    if (!resolution.ok || !item) {
      result.removed.push({
        cartLineId: row.id,
        menuItemId: row.menuItemId,
        name: row.name,
        reason: "sold_out",
      });
      continue;
    }
    const previous = row.unitPriceIdr + row.modifiersTotalIdr;
    const current =
      resolution.line.unitPriceIdr + resolution.line.modifiersTotalIdr;
    // Decision (PRD silent): a change is reported per unit including
    // modifiers, so a modifier repricing is visible too.
    if (previous !== current)
      result.priceChanges.push({
        cartLineId: row.id,
        name: resolution.line.name,
        previousUnitPriceIdr: idr(previous),
        unitPriceIdr: idr(current),
      });
    result.sellable.push({
      row,
      item,
      modifiers: resolution.line.modifiers,
      priced: {
        cartLineId: row.id,
        menuItemId: row.menuItemId,
        categoryId: item.categoryId,
        name: resolution.line.name,
        quantity: row.quantity,
        unitPriceIdr: resolution.line.unitPriceIdr,
        modifiersTotalIdr: resolution.line.modifiersTotalIdr,
      },
    });
  }
  return result;
}

function promoInput(
  outlet: OutletRow,
  lines: readonly PricedQuoteLine[],
  code: string | null,
  now: Date,
  minSpendSubtotalIdr?: Idr,
): OrderPromoInput {
  return {
    outletId: outlet.id as OrderPromoInput["outletId"],
    channel: "dine_in",
    lines: lines.map((line) => ({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      unitPriceIdr: idr(line.unitPriceIdr + line.modifiersTotalIdr),
      lineTotalIdr: idr(lineTotal(line)),
    })),
    customer: null,
    voucherCode: code,
    at: now,
    ...(minSpendSubtotalIdr === undefined ? {} : { minSpendSubtotalIdr }),
  };
}

/**
 * Promo `min_spend` basis at an inclusive outlet (legend-u5tkd, Q53): the
 * pre-promo bill before service charge and tax, which the gross line sum
 * already contains. The same engine call as `buildQuote` with no discount, so
 * quote and redeem send one value. Undefined for an exclusive cart (and a
 * mixed one, which `buildQuote` refuses): the engine then keeps the subtotal.
 */
function promoMinSpendBasis(input: {
  context: ScopedTenantContext;
  outlet: OutletRow;
  zone: ZoneRow;
  lines: readonly PricedQuoteLine[];
  taxConfig: QrTaxConfig;
  now: Date;
}): Idr | undefined {
  const subtotals = input.lines.map(lineTotal);
  const subtotal = subtotals.reduce((sum, value) => sum + value, 0);
  const tax = calculateTax(
    {
      outletId: input.outlet.id as OutletId,
      businessDate: businessDateFor(input.outlet, input.now),
      channel: QR_PRICE_CHANNEL,
      zoneId: input.zone.id,
      regionCode: null,
      lines: input.lines.map((line, index) => ({
        lineId: line.cartLineId,
        itemId: line.menuItemId,
        categoryId: line.categoryId,
        itemClass: "food_beverage" as const,
        grossIdr: idr(subtotals[index]),
        discountIdr: idr(0),
        components: [],
      })),
      orderDiscountIdr: idr(0),
    } as TaxCalculationInput,
    {
      taxRules: input.taxConfig.taxRules,
      serviceChargeRules: selectServiceChargeRules(
        input.zone,
        input.context,
        input.taxConfig.serviceChargeRules,
      ),
      settings: input.taxConfig.settings,
    },
  );
  const inclusiveRules = tax.taxes.filter(
    (summary) => summary.priceIncludesTax,
  );
  if (inclusiveRules.length === 0 || inclusiveRules.length < tax.taxes.length)
    return undefined;
  return idr(
    orderNetSubtotalIdr({
      subtotalIdr: subtotal,
      serviceChargeIdr: tax.serviceChargeIdr,
      taxIdr: tax.taxIdr,
      pricesIncludeTax: true,
    }),
  );
}

async function quoteFor(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    session: SessionRow;
    outlet: OutletRow;
    zone: ZoneRow;
    cartVersion: number;
    priced: PricedCart;
    extraRemoved?: readonly RemovedLineDraft[];
    promoCode: string | null;
    now: Date;
  },
): Promise<
  QuoteBuild & {
    promo: OrderPromoQuote | null;
    /** The inclusive pre-tax promo min spend basis (redeem sends it again). */
    minSpendSubtotalIdr: Idr | undefined;
  }
> {
  const lines = input.priced.sellable.map((entry) => entry.priced);
  // Tax config first: the promo engine measures `min_spend` before tax and
  // service charge, which an inclusive outlet only knows from the tax rules.
  const taxConfig =
    lines.length === 0
      ? null
      : await loadTaxConfig(tx, context, input.outlet.id);
  const minSpendSubtotalIdr =
    taxConfig === null
      ? undefined
      : promoMinSpendBasis({
          context,
          outlet: input.outlet,
          zone: input.zone,
          lines,
          taxConfig,
          now: input.now,
        });
  const promo =
    lines.length === 0
      ? null
      : await qrOrderPromoPort().quote(
          tx,
          context,
          promoInput(
            input.outlet,
            lines,
            input.promoCode,
            input.now,
            minSpendSubtotalIdr,
          ),
        );
  const estimate =
    lines.length === 0
      ? null
      : await qrOrderServingEstimatePort()(tx, context, {
          outletId: input.outlet.id,
          lines: input.priced.sellable.map((entry) => ({
            menuItemId: entry.row.menuItemId,
            quantity: entry.row.quantity,
            stationTargetSeconds: entry.item.stationTargetSeconds,
          })),
          at: input.now,
        });
  const build = buildQuote({
    context,
    sessionId: input.session.id,
    cartVersion: input.cartVersion,
    outletId: input.outlet.id as OutletId,
    businessDate: businessDateFor(input.outlet, input.now),
    zone: input.zone,
    lines,
    removedLines: [...input.priced.removed, ...(input.extraRemoved ?? [])],
    priceChanges: input.priced.priceChanges,
    promo,
    promoCode: input.promoCode,
    taxConfig,
    servingEstimate: estimate,
    now: input.now,
  });
  return { ...build, promo, minSpendSubtotalIdr };
}

// ---- Session view ---------------------------------------------------------------------

/** GET /api/table-sessions/:sessionId — session, shared cart, quote, orders. */
export async function getTableSessionView(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<TableSessionView> {
  await refreshPacingForSession(context, credential, sessionId, now);
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const { cart, lines } = await readCart(tx, context, session.id);
    let quote: OrderQuote | null = null;
    if (lines.length > 0) {
      const outlet = await loadOutlet(tx, context, session.outletId);
      const { zone } = await loadZoneOfSession(tx, context, session);
      const priced = await priceCartLines(tx, context, outlet, lines, now);
      // The promo code the guests last quoted first (checkout prices it),
      // then without it if that promotion no longer applies.
      const codes = [...new Set([cart?.promoCode ?? null, null])];
      for (const promoCode of codes) {
        try {
          quote = (
            await quoteFor(tx, context, {
              session,
              outlet,
              zone,
              cartVersion: cart?.version ?? 0,
              priced,
              promoCode,
              now,
            })
          ).quote;
          break;
        } catch (error) {
          // An unconfigured tax setup or a promo code that stopped applying
          // must not hide the cart; the quote/checkout routes report those
          // errors themselves. Both are expected client-visible failures.
          if (
            !(error instanceof TaxError) &&
            !(error instanceof CoreError) &&
            !(error instanceof HttpError)
          )
            throw error;
          quote = null;
        }
      }
    }
    const orderRows = await sessionOrders(tx, context, session.id);
    // WS-02: an outlet with an edge node whose link is down cannot take QR
    // orders; the guest page shows the waiter notice instead.
    const edge = await getOutletEdgeLinkState(
      tx,
      context,
      session.outletId,
      now,
    );
    return tableSessionViewSchema.parse({
      session: await sessionDto(tx, session),
      cart: cartDto(session, cart, lines),
      quote,
      orders: await orderDtos(tx, context, orderRows),
      openServiceRequests: await qrOrderOpenServiceRequests()(
        tx,
        context,
        session.id,
      ),
      orderingAvailable: !(edge.hasEdge && !edge.linkUp),
    });
  });
}

// ---- Cart writes ------------------------------------------------------------------------

function cartResult(
  session: SessionRow,
  cart: CartRow,
  lines: readonly CartLineRow[],
  line: CartLineRow | null,
): CartMutationResult {
  return cartMutationResultSchema.parse({
    cart: cartDto(session, cart, lines),
    line: line === null ? null : lineDto(line),
  });
}

/** POST /cart/lines. ORD-05: a sold-out item is refused; ORD-03 server price. */
export async function addCartLine(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: AddCartLineInput,
  now = new Date(),
): Promise<CartMutationResult> {
  const parsed = addCartLineInputSchema.parse(input);
  await refreshPacingForSession(context, credential, sessionId, now);
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const { idempotencyKey, ...request } = parsed;
    return idempotent(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      idempotencyKey,
      "cart.add_line",
      request,
      async () => {
        const { cart, lines } = await lockCart(tx, context, session, now);
        assertCartVersion(cart, parsed.expectedCartVersion);
        if (lines.length >= MAX_CART_LINES)
          throw new CoreError(
            "CONFLICT",
            `Keranjang maksimal ${MAX_CART_LINES} baris.`,
          );
        const outlet = await loadOutlet(tx, context, session.outletId);
        const catalogue = await loadCatalogue(tx, context, {
          brandId: outlet.brandId,
          outletId: outlet.id as OutletId,
          timeZone: outlet.timezone,
          businessDate: businessDateFor(outlet, now),
          itemIds: [parsed.menuItemId],
          now,
        });
        const paused = await readPausedMenuLines(
          tx,
          context,
          outlet.id as OutletId,
          QR_PRICE_CHANNEL,
          now,
        );
        const resolution = resolveLine(catalogue.get(parsed.menuItemId), {
          paused,
          menuItemId: parsed.menuItemId,
          variantId: parsed.variantId ?? null,
          quantity: parsed.quantity,
          modifierIds: parsed.modifierIds,
        });
        if (!resolution.ok)
          throw resolution.reason === "sold_out"
            ? new CoreError(
                "CONFLICT",
                "ORD-05: menu ini sedang habis dan tidak dapat ditambahkan.",
              )
            : new CoreError("VALIDATION_ERROR", resolution.message);
        const [line] = await tx
          .insert(cartLines)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: session.outletId,
            cartId: cart.id,
            tableSessionId: session.id,
            menuItemId: parsed.menuItemId,
            variantId: parsed.variantId ?? null,
            name: resolution.line.name,
            quantity: parsed.quantity,
            modifiers: resolution.line.modifiers,
            note: parsed.note ?? null,
            unitPriceIdr: resolution.line.unitPriceIdr,
            modifiersTotalIdr: resolution.line.modifiersTotalIdr,
            addedByParticipantId: null,
            addedAt: now,
            updatedAt: now,
          })
          .returning();
        if (!line) throw new Error("Cart line insert returned no row");
        const bumped = await bumpCart(tx, context, cart, now);
        const all = [...lines, line];
        await publishCartChange(
          tx,
          context,
          bumped,
          all.length,
          "line_added",
          now,
        );
        return cartResult(session, bumped, all, line);
      },
    );
  });
}

/** PATCH /cart/lines/:lineId — quantity, modifiers and/or note. */
export async function updateCartLine(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  lineId: string,
  input: UpdateCartLineInput,
  now = new Date(),
): Promise<CartMutationResult> {
  const parsed = updateCartLineInputSchema.parse(input);
  await refreshPacingForSession(context, credential, sessionId, now);
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const { idempotencyKey, ...request } = parsed;
    return idempotent(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      idempotencyKey,
      "cart.update_line",
      { lineId, ...request },
      async () => {
        const { cart, lines } = await lockCart(tx, context, session, now);
        assertCartVersion(cart, parsed.expectedCartVersion);
        const current = lines.find((line) => line.id === lineId);
        if (!current)
          throw new CoreError("NOT_FOUND", "Baris keranjang tidak ditemukan.");
        const quantity = parsed.quantity ?? current.quantity;
        let priced: {
          name: string;
          unitPriceIdr: Idr;
          modifiers: CartLineModifierSnapshot[];
          modifiersTotalIdr: Idr;
        } = {
          name: current.name,
          unitPriceIdr: current.unitPriceIdr,
          modifiers: current.modifiers,
          modifiersTotalIdr: current.modifiersTotalIdr,
        };
        // A note-only edit keeps the line's snapshot; a quantity or modifier
        // change re-prices it on the server (ORD-03) and re-checks ORD-05.
        if (parsed.quantity !== undefined || parsed.modifierIds !== undefined) {
          const outlet = await loadOutlet(tx, context, session.outletId);
          const catalogue = await loadCatalogue(tx, context, {
            brandId: outlet.brandId,
            outletId: outlet.id as OutletId,
            timeZone: outlet.timezone,
            businessDate: businessDateFor(outlet, now),
            itemIds: [current.menuItemId],
            now,
          });
          const paused = await readPausedMenuLines(
            tx,
            context,
            outlet.id as OutletId,
            QR_PRICE_CHANNEL,
            now,
          );
          const resolution = resolveLine(catalogue.get(current.menuItemId), {
            paused,
            menuItemId: current.menuItemId,
            variantId: current.variantId,
            quantity,
            modifierIds:
              parsed.modifierIds ??
              current.modifiers.map((modifier) => modifier.modifierId),
          });
          if (!resolution.ok)
            throw resolution.reason === "sold_out"
              ? new CoreError(
                  "CONFLICT",
                  "ORD-05: menu ini sedang habis; hapus dari keranjang.",
                )
              : new CoreError("VALIDATION_ERROR", resolution.message);
          priced = resolution.line;
        }
        const [updated] = await tx
          .update(cartLines)
          .set({
            quantity,
            name: priced.name,
            modifiers: priced.modifiers,
            unitPriceIdr: priced.unitPriceIdr,
            modifiersTotalIdr: priced.modifiersTotalIdr,
            note: parsed.note === undefined ? current.note : parsed.note,
            updatedAt: now,
          })
          .where(
            and(
              eq(cartLines.tenantId, context.tenant.tenantId),
              eq(cartLines.id, current.id),
            ),
          )
          .returning();
        if (!updated) throw new Error("Cart line update returned no row");
        const bumped = await bumpCart(tx, context, cart, now);
        const all = lines.map((line) =>
          line.id === updated.id ? updated : line,
        );
        await publishCartChange(
          tx,
          context,
          bumped,
          all.length,
          "line_updated",
          now,
        );
        return cartResult(session, bumped, all, updated);
      },
    );
  });
}

/**
 * DELETE /cart/lines/:lineId?expectedCartVersion=n. The contract carries no
 * body key; an optional `Idempotency-Key` header binds a retry, and the
 * version check alone already refuses a stale second delete (412).
 */
export async function removeCartLine(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  lineId: string,
  input: { expectedCartVersion: number; idempotencyKey: string | null },
  now = new Date(),
): Promise<CartMutationResult> {
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    return idempotent(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      input.idempotencyKey,
      "cart.remove_line",
      { lineId, expectedCartVersion: input.expectedCartVersion },
      async () => {
        const { cart, lines } = await lockCart(tx, context, session, now);
        assertCartVersion(cart, input.expectedCartVersion);
        const current = lines.find((line) => line.id === lineId);
        if (!current)
          throw new CoreError("NOT_FOUND", "Baris keranjang tidak ditemukan.");
        await tx
          .delete(cartLines)
          .where(
            and(
              eq(cartLines.tenantId, context.tenant.tenantId),
              eq(cartLines.id, current.id),
            ),
          );
        const bumped = await bumpCart(tx, context, cart, now);
        const all = lines.filter((line) => line.id !== current.id);
        await publishCartChange(
          tx,
          context,
          bumped,
          all.length,
          "line_removed",
          now,
        );
        return cartResult(session, bumped, all, null);
      },
    );
  });
}

// ---- Quote --------------------------------------------------------------------------------

/**
 * POST /quote (ORD-03): the body carries only codes. A valid promo code is
 * remembered on the cart so checkout (whose contract has no code field)
 * prices the same promotion; a quote without a code clears it. The apology
 * voucher code (legend-4qu) is not redeemable at checkout yet and is refused.
 */
export async function quoteTableSession(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: QuoteInput,
  now = new Date(),
): Promise<OrderQuote> {
  const parsed = quoteInputSchema.parse(input);
  await refreshPacingForSession(context, credential, sessionId, now);
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    if (parsed.voucherCode !== undefined)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Voucher permintaan maaf belum dapat dipakai di QR order.",
      );
    const { cart, lines } = await lockCart(tx, context, session, now);
    const outlet = await loadOutlet(tx, context, session.outletId);
    const { zone } = await loadZoneOfSession(tx, context, session);
    const priced = await priceCartLines(tx, context, outlet, lines, now);
    const promoCode = parsed.promoCode ?? null;
    const { quote } = await quoteFor(tx, context, {
      session,
      outlet,
      zone,
      cartVersion: cart.version,
      priced,
      promoCode,
      now,
    });
    if (cart.promoCode !== promoCode)
      await tx
        .update(tableSessionCarts)
        .set({ promoCode })
        .where(
          and(
            eq(tableSessionCarts.tenantId, context.tenant.tenantId),
            eq(tableSessionCarts.id, cart.id),
          ),
        );
    return quote;
  });
}

// ---- Checkout -------------------------------------------------------------------------------

/** Order number: Q + outlet business date (YYMMDD) + 8 ULID characters. */
function orderNumber(businessDate: string, orderId: string): string {
  return `Q${businessDate.replaceAll("-", "").slice(2)}-${orderId.slice(-8)}`;
}

/**
 * Fires an order to the kitchen inside the caller's transaction: the order
 * becomes `sent`, every live item `fired`, the PBJT snapshots are recorded
 * (a sale only once it is fired), and `order.placed` with status `sent` tells
 * KDS (WS-04) to build tickets. Callers check the gate first (ORD-02).
 */
export async function fireQrOrder(
  tx: Tx,
  context: ScopedTenantContext,
  order: OrderRow,
  input: {
    now: Date;
    reason: "open_bill" | "verified_payment" | "deposit";
    /**
     * legend-9pz9: the intent whose payment fired the order. Pinned on the
     * row, since a superseded payment code may have paid instead of the
     * current one. Null (or absent) when nothing was left to pay.
     */
    paidIntentId?: string | null;
  },
): Promise<OrderRow> {
  const paidIntentId = input.paidIntentId ?? null;
  const [fired] = await tx
    .update(orders)
    .set({
      status: "sent",
      firedAt: input.now,
      updatedAt: input.now,
      ...(paidIntentId === null ? {} : { paymentIntentId: paidIntentId }),
    })
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.id, order.id),
        eq(orders.status, "awaiting_payment"),
      ),
    )
    .returning();
  if (!fired) {
    throw new Error("Order is not awaiting payment; not fired again");
  }
  const items = await tx
    .update(orderItems)
    .set({ fireStatus: "fired", updatedAt: input.now })
    .where(
      and(
        eq(orderItems.tenantId, context.tenant.tenantId),
        eq(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
      ),
    )
    .returning({ id: orderItems.id });
  await routeFiredItemsToKitchen(tx, context, {
    outletId: order.outletId,
    orderId: order.id,
    itemIds: items.map((item) => item.id),
    actor: null,
    now: input.now,
    // Never fail a paid or placed guest order on a missing station.
    onUnresolved: "skip",
  });
  if (order.taxResult)
    await recordTaxSnapshots(tx, context, {
      sourceType: "order",
      sourceId: ulidToUuid(order.id),
      outletId: order.outletId,
      businessDate: order.businessDate,
      result: order.taxResult,
    });
  if (order.tableSessionId === null)
    throw new Error("A QR order always belongs to a table session");
  // A pay-first sale is made here, with its money verified: WS-07 books it
  // from order.paid at `fired_at` (legend-9pz9). An open bill is paid later.
  if (input.reason === "verified_payment" || input.reason === "deposit")
    await appendQrOrderPaid(tx, context, fired, {
      now: input.now,
      paidIntentId,
    });
  await appendEvent(tx, context, qrOrderEvents["order.placed"], {
    aggregateId: order.id,
    outletId: order.outletId,
    payload: {
      orderId: order.id,
      sessionId: order.tableSessionId,
      channel: "qr",
      itemCount: Math.max(1, items.length),
      totalIdr: order.totalIdr,
      paymentMode: order.paymentMode,
      status: "sent",
    },
    now: input.now,
  });
  await auditOrder(
    tx,
    context,
    {
      action: "order.fired",
      order,
      actorUserId: null,
      before: { id: order.id, status: order.status },
      after: { id: order.id, status: "sent", reason: input.reason },
    },
    input.now,
  );
  return fired;
}

type CheckoutOutcome =
  | { kind: "placed"; result: PlaceOrderResult }
  | { kind: "all_sold_out"; names: string[] };

/**
 * POST /orders. Places the whole shared cart as one order (PRD §4 Alur A/B):
 * server prices (ORD-03), daily stock reserved per line in this transaction,
 * sold-out lines dropped with notice (ORD-05), serving estimate in the quote
 * (ORD-11), the reservation deposit credit applied for pay-first (floored at
 * 0), and the pay-first gate (ORD-02).
 */
export async function placeQrOrder(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: PlaceOrderInput,
  now = new Date(),
  // legend-111j: Better Auth user id of the signed-in guest, when the request
  // carries a member session. Guests are not users, so null by default.
  memberUserId: string | null = null,
): Promise<PlaceOrderResult> {
  // legend-10nex: before any validation or write, so a held sale leaves no row.
  assertCatalogSalesAllowed();
  const parsed = placeOrderInputSchema.parse(input);
  await refreshPacingForSession(context, credential, sessionId, now);
  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<CheckoutOutcome> => {
      const session = await guestSession(
        tx,
        context,
        credential,
        sessionId,
        now,
        "update",
      );
      const { idempotencyKey, ...request } = parsed;
      // An all-sold-out attempt stores nothing under the key (it placed no
      // order), so a retry recomputes; a placed order replays as stored.
      // The thrown marker is plain JS, so the transaction stays usable and
      // commits the cart clean-up.
      try {
        const result = await idempotent(
          tx,
          context,
          { sessionId: session.id, outletId: session.outletId },
          idempotencyKey,
          "order.place",
          request,
          async () => {
            const placed = await checkout(
              tx,
              context,
              session,
              parsed,
              now,
              memberUserId,
            );
            if (placed.kind === "all_sold_out")
              throw new AllSoldOut(placed.names);
            return placed.result;
          },
        );
        return { kind: "placed", result };
      } catch (error) {
        if (error instanceof AllSoldOut)
          return { kind: "all_sold_out", names: error.names };
        throw error;
      }
    },
  ).catch(async (error: unknown) => {
    // The checkout transaction rolled back (stock released); the breach is
    // recorded in a fresh one, then answered 409 (ORD-10 / F43).
    if (error instanceof OpenBillLimitExceeded)
      return refuseOpenBillBreach(context, error);
    throw error;
  });
  if (outcome.kind === "all_sold_out")
    throw new CoreError(
      "CONFLICT",
      `ORD-05: semua menu di keranjang sedang habis (${outcome.names.join(", ").slice(0, 300)}); keranjang sudah diperbarui.`,
    );
  return outcome.result;
}

/** Internal control flow: commits the cart clean-up, places no order. */
class AllSoldOut extends Error {
  constructor(readonly names: string[]) {
    super("all_sold_out");
  }
}

async function checkout(
  tx: Tx,
  context: ScopedTenantContext,
  session: SessionRow,
  input: PlaceOrderInput,
  now: Date,
  memberUserId: string | null = null,
): Promise<
  | { kind: "placed"; result: PlaceOrderResult }
  | { kind: "all_sold_out"; names: string[] }
> {
  const tenantId = context.tenant.tenantId;
  const { cart, lines } = await lockCart(tx, context, session, now);
  assertCartVersion(cart, input.expectedCartVersion);
  let plan: QrOrderPlacement;
  try {
    plan = planQrOrderPlacement({
      paymentMode: session.paymentMode,
      sessionStatus: session.status,
      cartLineCount: lines.length,
    });
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError(
        "CONFLICT",
        lines.length === 0
          ? "Keranjang masih kosong."
          : error.message.startsWith("ORD-04")
            ? error.message
            : "Sesi open bill harus dikonfirmasi waiter sebelum pesanan pertama.",
      );
    throw error;
  }
  const outlet = await loadOutlet(tx, context, session.outletId);
  const { zone } = await loadZoneOfSession(tx, context, session);
  if (zone.status !== "active")
    throw new CoreError("CONFLICT", "Zona meja sedang tidak aktif.");
  if (!zoneOrderingOpen(zone.hours, now, outlet.timezone))
    throw new CoreError(
      "CONFLICT",
      "Zona ini sedang di luar jam pemesanan; menu tetap bisa dilihat.",
    );
  // WS-02: an outlet with an edge node whose link is down refuses the order
  // before anything is reserved or inserted (the guest asks a waiter). The
  // throw rolls the whole transaction back.
  const edge = await getOutletEdgeLinkState(tx, context, session.outletId, now);
  if (edge.hasEdge && !edge.linkUp)
    throw new HttpError(
      qrOrderErrorHttpStatus[EDGE_LINK_DOWN],
      EDGE_LINK_DOWN,
      qrOrderErrorMessages[EDGE_LINK_DOWN],
    );
  const businessDate = businessDateFor(outlet, now);
  // Tutup Hari (bead legend-2o1b): an order on an already-closed business day
  // is refused before anything is priced or reserved. The shared day lock is
  // held to transaction end, so closePosDay (exclusive, same key) cannot slip
  // in between this check and the insert. Lock order: session row ->
  // idempotency advisory lock -> cart row -> day lock (shared); closePosDay
  // takes no row locks, so there is no cycle. This runs inside the idempotent
  // body, so a replay of an already-placed order returns the stored result
  // without reaching the guard.
  if (
    await isBusinessDayClosed(tx, context, {
      outletId: outletIdSchema.parse(outlet.id),
      businessDates: [businessDate],
    })
  )
    throw new PosError("BUSINESS_DAY_ALREADY_CLOSED", QR_OUTLET_CLOSED_MESSAGE);
  const priced = await priceCartLines(tx, context, outlet, lines, now);

  // ORD-05: reserve each line's daily stock inside this transaction. A line
  // that cannot be reserved (86, outside schedule, daily limit) leaves the
  // cart with a notice; everything rolls back if the order is not placed.
  const reservedRemoved: RemovedLineDraft[] = [];
  const reserved: PricedCart["sellable"] = [];
  for (const entry of priced.sellable) {
    const reservation = await reserveMenuItemDailyLimit(tx, context, {
      outletId: outlet.id,
      menuItemId: entry.row.menuItemId,
      businessDate,
      quantity: entry.row.quantity,
      now,
    });
    if (reservation.allowed) reserved.push(entry);
    else
      reservedRemoved.push({
        cartLineId: entry.row.id,
        menuItemId: entry.row.menuItemId,
        name: entry.row.name,
        reason: "sold_out",
      });
  }
  const removed = [...priced.removed, ...reservedRemoved];

  if (reserved.length === 0) {
    // Nothing can be ordered. Drop the unorderable lines so every guest's
    // cart shows the change; the caller commits this and answers 409.
    await tx
      .delete(cartLines)
      .where(
        and(eq(cartLines.tenantId, tenantId), eq(cartLines.cartId, cart.id)),
      );
    const bumped = await bumpCart(tx, context, cart, now);
    await publishCartChange(tx, context, bumped, 0, "line_removed", now);
    return { kind: "all_sold_out", names: removed.map((line) => line.name) };
  }

  const built = await quoteFor(tx, context, {
    session,
    outlet,
    zone,
    cartVersion: cart.version,
    priced: {
      sellable: reserved,
      removed: priced.removed,
      priceChanges: priced.priceChanges.filter((change) =>
        reserved.some((entry) => entry.row.id === change.cartLineId),
      ),
    },
    extraRemoved: reservedRemoved,
    promoCode: cart.promoCode,
    now,
  });
  if (built.tax === null) throw new Error("A non-empty order has a tax result");
  const quote = built.quote;
  // legend-zmc2: one session, one pricing mode. The quote already refuses a
  // cart mixing inclusive and exclusive rules; an order may not mix with the
  // session's earlier non-voided orders either (the bill has one formula).
  const [otherMode] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, session.id),
        ne(orders.status, "voided"),
        ne(orders.pricesIncludeTax, quote.pricesIncludeTaxAndService),
      ),
    )
    .limit(1);
  if (otherMode)
    throw new HttpError(
      qrOrderErrorHttpStatus.QR_ORDER_PRICING_MODE_MIXED,
      QR_ORDER_PRICING_MODE_MIXED,
      qrOrderErrorMessages.QR_ORDER_PRICING_MODE_MIXED,
    );
  // ORD-10 / F43: an open-bill order may not push the session over its limit.
  await assertOpenBillWithinLimit(tx, context, {
    sessionId: session.id,
    outletId: session.outletId,
    tableId: session.tableId,
    zoneId: zone.id,
    paymentMode: session.paymentMode,
    cartVersion: cart.version,
    orderTotalIdr: quote.totalIdr,
    now,
  });

  const orderId = createUlid(now.getTime());
  const payFirst = plan.kitchenFire === "held_for_payment";
  // Reservation DP credit (WS-08), floored at 0 and never above this order.
  // legend-94qt: the order row is inserted with no deposit; the credit is
  // applied below, AFTER the promotion redeem, so this checkout takes the promo
  // locks before the session deposit lock (the POS order: discount -> redeem
  // -> reprice -> deposit).
  let depositApplied = 0;
  // legend-111j: a signed-in member with an active profile in this tenant is
  // attached to their own order (`pwa_session`, attached_by NULL).
  let memberProfileId: string | null = null;
  if (memberUserId !== null) {
    const [profile] = await tx
      .select({ id: customerProfiles.id })
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.userId, memberUserId),
          eq(customerProfiles.membershipStatus, "active"),
        ),
      )
      .limit(1);
    memberProfileId = profile?.id ?? null;
  }
  let [order] = await tx
    .insert(orders)
    .values({
      id: orderId,
      tenantId,
      outletId: session.outletId,
      number: orderNumber(businessDate, orderId),
      channel: "qr",
      serviceType: "dine_in",
      tableSessionId: session.id,
      customerProfileId: memberProfileId,
      customerAttachedBy: null,
      customerAttachedVia: memberProfileId === null ? null : "pwa_session",
      customerAttachedAt: memberProfileId === null ? null : now,
      paymentMode: session.paymentMode,
      subtotalIdr: quote.subtotalIdr,
      discountIdr: quote.discountIdr,
      serviceChargeIdr: quote.serviceCharge.amountIdr,
      taxIdr: quote.taxIdr,
      roundingIdr: quote.rounding.adjustmentIdr,
      totalIdr: quote.totalIdr,
      // legend-zmc2: subtotal stays the gross line sum; service and tax are
      // the parts backed out of it (orders_total_check branches on this).
      pricesIncludeTax: quote.pricesIncludeTaxAndService,
      depositAppliedIdr: idr(0),
      status: payFirst ? "awaiting_payment" : "sent",
      businessDate,
      taxResult: built.tax,
      note: input.note ?? null,
      createdBy: null,
      placedAt: now,
      firedAt: payFirst ? null : now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!order) throw new Error("Order insert returned no row");
  const quoteLines = new Map<string, OrderQuote["lines"][number]>(
    quote.lines.map((line) => [line.cartLineId, line]),
  );
  // legend-u4js6: freeze each line's cost (HPP) at the moment of sale.
  const costSnapshots = await computeLineCostSnapshots(
    tx,
    context,
    session.outletId,
    reserved.map((entry) => ({
      menuItemId: entry.row.menuItemId,
      variantId: entry.row.variantId,
      modifierIds: entry.modifiers.map((modifier) => modifier.modifierId),
      quantity: entry.row.quantity,
    })),
  );
  const itemRows = reserved.map((entry, index) => {
    const line = quoteLines.get(entry.row.id);
    const costSnapshot = costSnapshots[index] ?? null;
    if (!line) throw new Error("Quoted line missing for a reserved cart line");
    return {
      id: createUlid(now.getTime() + index),
      tenantId,
      outletId: session.outletId,
      orderId,
      menuItemId: entry.row.menuItemId,
      variantId: entry.row.variantId,
      name: line.name,
      quantity: entry.row.quantity,
      unitPriceIdr: line.unitPriceIdr,
      modifiersTotalIdr: line.modifiersTotalIdr,
      lineTotalIdr: line.lineSubtotalIdr,
      costSnapshotIdr: costSnapshot === null ? null : idr(costSnapshot),
      modifiers: entry.modifiers,
      note: entry.row.note,
      course: entry.item.course,
      fireStatus: payFirst ? ("held" as const) : ("fired" as const),
      status: "queued" as const,
      reservedBusinessDate: businessDate,
      createdAt: now,
      updatedAt: now,
    };
  });
  await tx.insert(orderItems).values(itemRows);

  // Promotion usage is redeemed with the order row in place (port contract);
  // a promotion that changed since the quote refuses the order.
  if (built.promo !== null && built.promo.totalDiscountIdr > 0) {
    const redeemed = await qrOrderPromoPort().redeem(tx, context, {
      ...promoInput(
        outlet,
        reserved.map((entry) => entry.priced),
        cart.promoCode,
        now,
        built.minSpendSubtotalIdr,
      ),
      orderId,
      actorUserId: null,
      expected: built.promo.result,
    });
    if (redeemed.totalDiscountIdr !== built.promo.totalDiscountIdr)
      throw new CoreError(
        "CONFLICT",
        "Promo berubah saat checkout; minta penawaran harga ulang.",
      );
  }

  let depositFactAt = now;
  if (payFirst) {
    // Lock original receipts before depositCreditFor takes its shared
    // refund-vs-credit advisory lock. Taking receipt rows after that lock
    // would invert the refund writer's lock order.
    const sources = await listSessionDepositSources(tx, tenantId, session.id);
    depositFactAt = await lockIntentsForFact(
      tx,
      tenantId,
      sources.map(({ paymentIntentId }) => paymentIntentId),
      now,
    );
    const credit = await depositCreditFor(tx, tenantId, session.id);
    if (credit > 0) {
      // legend-94qt: global lock order promo -> deposit (see
      // `lockSessionDeposit`). Same session deposit lock as the POS reprice,
      // taken after the promo redeem above and right before the used sum.
      await lockSessionDeposit(tx, tenantId, session.id);
      const [used] = await tx
        .select({
          used: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.tableSessionId, session.id),
            ne(orders.status, "draft"),
            ne(orders.status, "voided"),
            ne(orders.id, orderId),
          ),
        );
      const remaining = Math.max(0, credit - Number(used?.used ?? 0));
      depositApplied = Math.min(remaining, quote.totalIdr);
      if (depositApplied > 0) {
        const [withDeposit] = await tx
          .update(orders)
          .set({ depositAppliedIdr: idr(depositApplied) })
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
          .returning();
        if (!withDeposit)
          throw new Error("Order deposit update returned no row");
        order = withDeposit;
      }
    }
  }

  // The whole cart is consumed: ordered lines became the order, sold-out
  // lines leave with the notice in quote.removedLines.
  await tx
    .delete(cartLines)
    .where(
      and(eq(cartLines.tenantId, tenantId), eq(cartLines.cartId, cart.id)),
    );
  await tx
    .update(tableSessionCarts)
    .set({ promoCode: null })
    .where(
      and(
        eq(tableSessionCarts.tenantId, tenantId),
        eq(tableSessionCarts.id, cart.id),
      ),
    );
  const bumped = await bumpCart(tx, context, cart, now);
  await publishCartChange(tx, context, bumped, 0, "checked_out", now);

  // Session lifecycle: an open-bill order on a bill_requested session reopens
  // it (contract planQrOrderPlacement), and every order is activity.
  const statusAfter: TableSessionStatus =
    plan.sessionStatusAfter !== session.status
      ? transitionTableSession(session.status, "reopen")
      : session.status;
  const [sessionAfter] = await tx
    .update(tableSessions)
    .set({ status: statusAfter, lastActivityAt: now })
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.id, session.id),
      ),
    )
    .returning();
  if (!sessionAfter) throw new Error("Session update returned no row");

  await appendEvent(tx, context, qrOrderEvents["order.placed"], {
    aggregateId: orderId,
    outletId: outlet.id,
    payload: {
      orderId,
      sessionId: session.id,
      channel: "qr",
      itemCount: itemRows.length,
      totalIdr: quote.totalIdr,
      paymentMode: session.paymentMode,
      status: payFirst ? "awaiting_payment" : "sent",
    },
    now,
  });

  let finalOrder = order;
  let kitchenFire: "fired" | "held_for_payment" = plan.kitchenFire;
  if (!payFirst) {
    // Open bill: items were inserted `fired`; route them to the stations.
    await routeFiredItemsToKitchen(tx, context, {
      outletId: outlet.id,
      orderId,
      itemIds: itemRows.map((row) => row.id),
      actor: null,
      now,
      onUnresolved: "skip",
    });
    // Open bill: fired now; the sale is recorded for PBJT at once.
    await recordTaxSnapshots(tx, context, {
      sourceType: "order",
      sourceId: ulidToUuid(orderId),
      outletId: outlet.id,
      businessDate,
      result: built.tax,
    });
  } else if (quote.totalIdr - depositApplied === 0) {
    // Nothing left to pay (deposit or promotion covered it): the money is
    // already verified, so the pay-first gate is satisfied (ORD-02).
    finalOrder = await fireQrOrder(tx, context, order, {
      now: depositFactAt,
      reason: "deposit",
      paidIntentId: null,
    });
    kitchenFire = "fired";
  }

  await auditOrder(
    tx,
    context,
    {
      action: "order.placed",
      order,
      actorUserId: null,
      before: null,
      after: {
        id: orderId,
        number: order.number,
        status: finalOrder.status,
        paymentMode: session.paymentMode,
        totalIdr: quote.totalIdr,
        depositAppliedIdr: depositApplied,
        itemCount: itemRows.length,
        removedCount: removed.length,
        kitchenFire,
        tableSessionId: session.id,
      },
    },
    now,
  );

  // WS-02: queue the placed order for the outlet's edge node in this same
  // transaction (it is rolled back together with the order). Order and lines
  // are re-read so the edge sees the state after a possible fire.
  if (edge.hasEdge && edge.edgeNodeId !== null) {
    const forwardedItems = await tx
      .select()
      .from(orderItems)
      .where(
        and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)),
      )
      .orderBy(asc(orderItems.id));
    await forwardQrOrderToEdge(tx, context, {
      edgeNodeId: edge.edgeNodeId,
      order: finalOrder,
      items: forwardedItems,
      now,
    });
  }

  const items = await orderItemsOf(tx, context, [orderId]);
  const result = placeOrderResultSchema.parse({
    order: orderDto(finalOrder, items.get(orderId) ?? []),
    quote,
    session: await sessionDto(tx, sessionAfter),
    kitchenFire,
  });
  return { kind: "placed", result };
}

// ---- Bill and settlement ------------------------------------------------------------------

type Settlement = { billTotalIdr: Idr; paidIdr: Idr };

/**
 * Swap differences owed on the session (legend-i83ls). A charge is not an
 * order: no kitchen, no order total. `open` and `paid` ones are on the bill,
 * `paid` is also paid; `waived`, `expired` and `routed_pos` owe nothing here.
 */
async function sessionCharges(tx: Tx, tenantId: TenantId, sessionId: string) {
  return tx
    .select()
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.tableSessionId, sessionId),
      ),
    )
    .orderBy(asc(orderIssueCharges.createdAt), asc(orderIssueCharges.id));
}

type ChargeRow = Awaited<ReturnType<typeof sessionCharges>>[number];

const chargeOwed = (row: ChargeRow) =>
  row.status === "open" || row.status === "paid" ? row.amountIdr : 0;

/**
 * The session's bill: submitted, non-voided orders, the reservation deposit
 * credit (WS-08, floored at 0), verified payments on the orders' WS-05 links,
 * captured POS tenders, and the swap charges (open or paid). Shared by GET
 * /bill and the ORD-10 close port, so closing waits for an open charge.
 */
async function settlementOf(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  liveOrders: readonly OrderRow[],
): Promise<Settlement> {
  const billTotal = liveOrders.reduce((sum, row) => sum + row.totalIdr, 0);
  const linkIds = liveOrders
    .map((row) => row.paymentLinkId)
    .filter((id): id is string => id !== null);
  const links = linkIds.length
    ? await tx
        .select({
          id: paymentLinks.id,
          grossIdr: paymentLinks.paidIdr,
          // 1273 P2: `paid_idr` is gross and never drops when the provider
          // refunds on its own, so count what the link's settled intents
          // still net (`netAllocatedIdrSql`), capped at `paid_idr` (same rule
          // as legend-9yw78.12 in open-bill-control). The outer columns are
          // written out: inside the subquery they would bind to the intent.
          paidIdr: sql<string>`least(${paymentLinks.paidIdr}, coalesce((
            SELECT sum(${netAllocatedIdrSql(sql`i.tenant_id`, sql`i.id`)})
              FROM payment_intents i
             WHERE i.tenant_id = payment_links.tenant_id
               AND i.payment_link_id = payment_links.id
               AND i.status IN ('paid', 'partially_refunded', 'refunded')), 0))::text`,
        })
        .from(paymentLinks)
        .where(
          and(
            eq(paymentLinks.tenantId, tenantId),
            inArray(paymentLinks.id, linkIds),
          ),
        )
    : [];
  const linkPaid = links.reduce((sum, row) => sum + Number(row.paidIdr), 0);
  const orderIds = liveOrders.map((row) => row.id);
  const capturedTenders = orderIds.length
    ? await tx
        .select({
          amountIdr: posOrderTenders.amountIdr,
          paymentLinkId: posOrderTenders.paymentLinkId,
        })
        .from(posOrderTenders)
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            inArray(posOrderTenders.orderId, orderIds),
            eq(posOrderTenders.status, "captured"),
          ),
        )
    : [];
  const countedLinks = new Set(
    links.filter((row) => row.grossIdr > 0).map((row) => row.id),
  );
  // A POS QRIS tender owns its own WS-05 link. If a link is also present on
  // an order and contributed paid money above, never count it twice.
  const posPaid = capturedTenders.reduce(
    (sum, row) =>
      sum +
      (row.paymentLinkId !== null && countedLinks.has(row.paymentLinkId)
        ? 0
        : row.amountIdr),
    0,
  );
  const deposit = await depositCreditFor(tx, tenantId, sessionId);
  const charges = await sessionCharges(tx, tenantId, sessionId);
  const chargesOwed = charges.reduce((sum, row) => sum + chargeOwed(row), 0);
  const chargesPaid = charges.reduce(
    (sum, row) => sum + (row.status === "paid" ? row.amountIdr : 0),
    0,
  );
  return {
    billTotalIdr: idr(billTotal + chargesOwed),
    paidIdr: idr(deposit + linkPaid + posPaid + chargesPaid),
  };
}

/** GET /bill — orders, totals, paid and outstanding (splits: legend-ms3). */
export async function getSessionBill(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<SessionBill> {
  return withTenant(db, context, async (tx) => {
    const session = await guestSession(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const liveOrders = (await sessionOrders(tx, context, session.id)).filter(
      (row) => row.status !== "voided",
    );
    const settlement = await settlementOf(
      tx,
      context.tenant.tenantId,
      session.id,
      liveOrders,
    );
    const charges = await sessionCharges(
      tx,
      context.tenant.tenantId,
      session.id,
    );
    const sum = (pick: (row: OrderRow) => number) =>
      liveOrders.reduce((total, row) => total + pick(row), 0);
    return sessionBillSchema.parse({
      sessionId: session.id,
      orders: await orderDtos(tx, context, liveOrders),
      charges: charges.map((row) => ({
        id: row.id,
        orderIssueId: row.orderIssueId,
        orderId: row.orderId,
        status: row.status,
        differenceIdr: row.differenceIdr,
        grossSalesIdr: row.grossSalesIdr,
        serviceChargeIdr: row.serviceChargeIdr,
        pbjtIdr: row.pbjtIdr,
        amountIdr: row.amountIdr,
        paidAt: row.paidAt ? toIsoDateTime(row.paidAt) : null,
      })),
      totals: {
        subtotalIdr: sum((row) => row.subtotalIdr),
        discountIdr: sum((row) => row.discountIdr),
        serviceChargeIdr: sum((row) => row.serviceChargeIdr),
        taxIdr: sum((row) => row.taxIdr),
        roundingIdr: sum((row) => row.roundingIdr),
        totalIdr: settlement.billTotalIdr,
        paidIdr: settlement.paidIdr,
        outstandingIdr: Math.max(
          0,
          settlement.billTotalIdr - settlement.paidIdr,
        ),
      },
      splits: await listSessionSplitDtosTx(tx, context, session.id),
      computedAt: toIsoDateTime(now),
    });
  });
}

/**
 * The ORD-10 settlement port for table-session.service.ts
 * (`setTableSessionSettlementLookup(qrOrderSettlementLookup)`), so close and
 * expiry read the real bill instead of failing closed.
 */
export async function qrOrderSettlementLookup(input: {
  tx: Tx;
  tenantId: TenantId;
  sessionId: string;
}): Promise<Settlement> {
  const rows = await input.tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.tableSessionId, input.sessionId),
        ne(orders.status, "draft"),
        ne(orders.status, "voided"),
      ),
    );
  return settlementOf(input.tx, input.tenantId, input.sessionId, rows);
}

// ---- Void (unpaid pay-first order) ------------------------------------------------------------

/**
 * Voids a pay-first order that was never paid (payment expired or failed, or
 * a cashier cancels it). Each live item moves to `voided` exactly once — the
 * UPDATE ... WHERE status <> 'voided' RETURNING is the idempotency key — and
 * releases its daily stock on the business date it reserved, in this same
 * transaction (menu-availability.ts contract). The promotion usage is released
 * through the promo port. A second void releases nothing.
 */
export async function voidUnpaidQrOrder(
  context: ScopedTenantContext,
  orderId: string,
  input: { reason: string; actorUserId: string | null },
  now = new Date(),
): Promise<QrOrder> {
  return withTenant(db, context, (tx) =>
    voidUnpaidQrOrderTx(tx, context, orderId, input, now),
  );
}

/**
 * `voidUnpaidQrOrder` inside the caller's transaction (legend-x4qy: the
 * payment.expired / payment.failed consumer voids in the outbox consumption
 * transaction, so the void commits with the consumed offset).
 */
export async function voidUnpaidQrOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  input: { reason: string; actorUserId: string | null },
  now: Date,
): Promise<QrOrder> {
  const voided = await voidAwaitingPaymentOrderTx(
    tx,
    context,
    orderId,
    input,
    now,
  );
  // legend-gjf1: every void path (sweep and cashier) returns the money of each
  // paid intent of the link; once-only per intent, so a second void adds none.
  await requestRefundsForVoidedQrOrder(tx, context, { order: voided, now });
  const items = await orderItemsOf(tx, context, [voided.id]);
  const swaps = await swapReplacementIdsOf(tx, context, [voided.id]);
  return orderDto(voided, items.get(voided.id) ?? [], swaps.get(voided.id));
}

/**
 * The void itself, without the QR order DTO: items voided, daily limits
 * released, promo released, audited. Safe for orders that have no table
 * session (facility breakfast orders). Returns the voided order row; an
 * already voided order is returned as is.
 */
export async function voidAwaitingPaymentOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  input: { reason: string; actorUserId: string | null },
  now: Date,
): Promise<OrderRow> {
  const reason = input.reason.trim().slice(0, 100);
  if (reason.length === 0)
    throw new CoreError("VALIDATION_ERROR", "Alasan pembatalan wajib diisi.");
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .for("update");
  if (!order) throw new CoreError("NOT_FOUND", "Pesanan tidak ditemukan.");
  assertOutletInScope(context.outletScope, order.outletId);
  if (order.status === "voided") return order;
  if (order.status !== "awaiting_payment")
    throw new CoreError(
      "CONFLICT",
      "Hanya pesanan yang belum dibayar yang dapat dibatalkan di sini.",
    );
  // EDC (legend-kiibf): an ECR sale can exist for this bill (reference = order
  // number). While it is open the terminal may still take, or already took, the
  // money, so the void fails closed (409 EDC_REQUEST_OPEN) before any write.
  await assertNoOpenEdcRequest(tx, context, order);
  // legend-5ailc: a bill with a collectible QRIS never voids (the 0369 trigger
  // would refuse the orders write, but only after items, stock and promo were
  // touched). Answer 409 QRIS_HOLD_ACTIVE before any write.
  await assertNoActiveQrisHold(tx, context, order.id);
  const voidedItems = await tx
    .update(orderItems)
    .set({
      status: "voided",
      voidReason: reason,
      voidedBy: input.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
      ),
    )
    .returning();
  for (const item of voidedItems)
    await releaseMenuItemDailyLimit(tx, context, {
      outletId: order.outletId,
      menuItemId: item.menuItemId,
      businessDate: item.reservedBusinessDate,
      quantity: item.quantity,
      now,
    });
  const [voided] = await tx
    .update(orders)
    .set({
      status: "voided",
      voidedAt: now,
      voidReason: reason,
      updatedAt: now,
    })
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)))
    .returning();
  if (!voided) throw new Error("Order void returned no row");
  await qrOrderPromoPort().release(tx, context, {
    orderId: order.id,
    reason,
    actorUserId: input.actorUserId,
    at: now,
  });
  await auditOrder(
    tx,
    context,
    {
      action: "order.voided",
      order,
      actorUserId: input.actorUserId,
      before: { id: order.id, status: order.status },
      after: {
        id: order.id,
        status: "voided",
        itemCount: voidedItems.length,
      },
      reason,
    },
    now,
  );
  return voided;
}

// ---- Shared with order-recovery.service.ts -------------------------------------------------------

/** A menu item a guest can be moved to: plain price, no variant or required choice. */
export type OutletMenuPrice = {
  menuItemId: string;
  name: string;
  unitPriceIdr: number;
};

/**
 * Current dine-in price of `menuItemIds` at one outlet, through the same
 * catalogue the cart uses (ORD-05). Only items a single tap can order come
 * back: sellable, no variants and no required modifier group. Anything else
 * is missing from the map.
 */
export async function priceMenuItemForOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  menuItemIds: readonly string[],
  now: Date,
): Promise<Map<string, OutletMenuPrice>> {
  // legend-10nex: re-pricing lines onto an order (swap, recovery) reads the
  // catalogue prices, so a held sale cannot use this either.
  assertCatalogSalesAllowed();
  const outlet = await loadOutlet(tx, context, outletId);
  const catalogue = await loadCatalogue(tx, context, {
    brandId: outlet.brandId,
    outletId: outlet.id as OutletId,
    timeZone: outlet.timezone,
    businessDate: businessDateFor(outlet, now),
    itemIds: menuItemIds,
    now,
  });
  const priced = new Map<string, OutletMenuPrice>();
  for (const [menuItemId, item] of catalogue) {
    if (!item.sellable || item.plainPriceIdr === null) continue;
    if (item.variants.size > 0) continue;
    if (item.groups.some((group) => group.minSelect > 0)) continue;
    priced.set(menuItemId, {
      menuItemId,
      name: item.name,
      unitPriceIdr: item.plainPriceIdr,
    });
  }
  return priced;
}

// ---- Shared with qr-order-payment.ts ------------------------------------------------------------

export {
  guestSession as lockGuestSessionForPayment,
  loadOutlet as loadQrOutlet,
  loadZoneOfSession as loadQrZoneOfSession,
  idempotent as qrOrderIdempotent,
  peekIdempotent as qrOrderPeekIdempotent,
};
export type { OrderRow as QrOrderRow, SessionRow as QrSessionRow };
