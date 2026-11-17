// Failed item after payment: report, guest choice, staff resolution (bead
// legend-4qu; PRD v1.7 §3 F10 "Item Gagal", ORD-08, ORD-09; contract
// @starter/shared/qr-order `reportOrderIssue`, `listSessionOrderIssues`,
// `getOrderIssueOptions`, `chooseOrderIssueResolution`, `resolveOrderIssue`).
//
// - Permission `order.recovery.handle` (report, resolve), checked on the outlet
//   of the concrete order line or issue. The guest never holds a permission:
//   the opaque session credential must belong to the session that owns the
//   issue's order, otherwise the issue is NOT_FOUND (no cross-session oracle).
// - Only a paid line (order `sent` or `completed`, line not voided) can fail.
//   One issue per line and type: the idempotency key is derived
//   (`recovery:<orderItemId>:<type>`), so a resend returns the stored row
//   without a second row or event.
// - ORD-08: an `unfulfillable` report appends `item.failed` to the outbox and
//   wakes the guest phone (pg_notify, delivered at commit) in the same
//   transaction. The guest is offered exactly swap or voucher credit; a refund
//   is never offered to the guest and `manual_refund` is refused (422).
// - A swap is priced through the QR catalogue at settle time. A cheaper
//   replacement credits the difference as an apology voucher (one voucher per
//   issue, kept in `voucher_id`). The guest can only pick a replacement that
//   costs the same or less (dearer: 422). Staff can swap to a dearer item only
//   with an approved `price_correction` approval for this issue whose amount is
//   the difference, approved by someone other than the actor and not used by
//   another issue; the approval is recorded on the issue.
// - ORD-09: a manual refund needs a fully approved WS-01 approval chain for
//   this very issue and the line total, a written reason of 10+ characters, and
//   an approver who is not the actor. This service only records the approval
//   and appends `order_issue.manual_refund_approved` for the payment module; it
//   never moves money.
// - Races: the issue row is locked before it is read and the settle UPDATE is
//   guarded by `status = 'open'`, so two concurrent choices end in one winner
//   (the other replays the same choice or ends in 409).

import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  createUlid,
  idr,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  createOrderIssueInputSchema,
  customerOrderIssueChoiceInputSchema,
  guestOrderIssueSchema,
  orderIssueOptionsSchema,
  orderIssueSchema,
  qrOrderEvents,
  staffOrderIssueResolutionInputSchema,
  type GuestOrderIssue,
  type OrderIssue,
  type OrderIssueOptions,
  type QrOrderEventName,
} from "@starter/shared/qr-order";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { apologyVouchers } from "../db/schema/apology-vouchers.ts";
import { vouchers } from "../db/schema/crm-promo.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { menuItems } from "../db/schema/menu.ts";
import { posOrderItems } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { domainEventOutbox, outlets } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret } from "../lib/secrets.ts";
import {
  approvalRequiredMessage,
  mintApologyVoucher,
  requireSwapCreditApproval,
  sealAad,
} from "./apology-voucher.service.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { Tx } from "./menu-internals.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { assertLineNotManuallyRefunded } from "./order-issue-manual-refund.ts";
import { estimateDeductionCostIdr } from "./recipe-deduction.service.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";
import {
  lockGuestSessionForPayment,
  priceMenuItemForOutlet,
  type OutletMenuPrice,
} from "./qr-order.service.ts";

type CreateOrderIssueInput = z.output<typeof createOrderIssueInputSchema>;
type CustomerChoiceInput = z.output<typeof customerOrderIssueChoiceInputSchema>;
type StaffResolutionInput = z.output<
  typeof staffOrderIssueResolutionInputSchema
>;

const HANDLE = "order.recovery.handle";
const EVENT_DESTINATION = "cloud-sync";
const IDEMPOTENCY_KEY = "order_issues_tenant_idempotency_key";
const RECOVERY_KEY_PREFIX = "recovery:";
const RESOLVED_ITEM_ONCE_INDEX = "order_issues_resolved_item_once_idx";
const VOUCHER_ONCE_INDEX = "order_issues_voucher_once_idx";
const MANUAL_REFUND_ONCE_INDEX = "order_issues_manual_refund_once_idx";
const SWAP_CANDIDATE_LIMIT = 200;
const SUGGESTED_SWAP_LIMIT = 10;
const CREDIT_VOUCHER_DAYS = 30;
const AUDIT_SAFE_FIELDS = [
  "id",
  "type",
  "reason",
  "resolution",
  "costIdr",
  "priceDifferenceIdr",
  "approvalRequestId",
  "voucherId",
  "replacementItemId",
];

const deniedOutlet = () =>
  new AccessError(
    "PERMISSION_DENIED",
    "Anda tidak dapat menangani item gagal di outlet ini.",
  );
const itemNotFound = () =>
  new CoreError("NOT_FOUND", "Item pesanan tidak ditemukan.");
const issueNotFound = () =>
  new CoreError("NOT_FOUND", "Laporan item gagal tidak ditemukan.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

type IssueRow = typeof orderIssues.$inferSelect;

/** The issue with the order and line it is about. */
type IssueContext = {
  issue: IssueRow;
  order: {
    id: string;
    tableSessionId: string | null;
    customerProfileId: string | null;
    status: string;
    paymentMode: string;
    paymentIntentId: string | null;
    /** Status of `paymentIntentId` read in the same transaction; null when none. */
    paymentIntentStatus: string | null;
  };
  line: {
    id: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPriceIdr: number;
    lineTotalIdr: number;
    voided: boolean;
  };
};

/**
 * Intent statuses that mean the money arrived. A refunded intent still paid
 * the bill first, so it stays settled (same set as the QR payment consumer).
 */
const SETTLED_INTENT_STATUSES: readonly string[] = [
  "paid",
  "partially_refunded",
  "refunded",
];

/**
 * ORD-08: only a paid order can fail an item. `pay_first` is paid once sent;
 * an `open_bill` order only when it is completed (settled) or its intent is
 * settled. An intent that is still pending, failed or expired is not money
 * received (legend-mz15j). An unsettled open bill, a draft or a voided order
 * is refused.
 */
function isPaidOrder(order: {
  status: string;
  paymentMode: string;
  paymentIntentId: string | null;
  paymentIntentStatus: string | null;
}): boolean {
  if (order.status === "completed") return true;
  if (order.status !== "sent") return false;
  if (order.paymentMode === "pay_first") return true;
  return (
    order.paymentIntentId !== null &&
    order.paymentIntentStatus !== null &&
    SETTLED_INTENT_STATUSES.includes(order.paymentIntentStatus)
  );
}

/** A recovery needs a paid order and a line that is not voided (QR or POS). */
function assertRecoverable(found: IssueContext): void {
  if (!isPaidOrder(found.order))
    throw unprocessable(
      "Item gagal hanya bisa ditangani untuk pesanan yang sudah dibayar.",
    );
  if (found.line.voided)
    throw unprocessable("Item ini sudah dibatalkan (void).");
}

function toIssue(row: IssueRow): OrderIssue {
  return orderIssueSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    type: row.type,
    reason: row.reason,
    reasonNote: row.reasonNote,
    stationId: row.stationId,
    employeeId: row.employeeId,
    reportedBy: row.reportedBy,
    resolution: row.resolution,
    replacementItemId: row.replacementItemId,
    voucherId: row.voucherId,
    priceDifferenceIdr: row.priceDifferenceIdr,
    approvedBy: row.approvedBy,
    costIdr: row.costIdr,
    status: row.status,
    createdAt: toIsoDateTime(row.createdAt),
    resolvedAt: row.resolvedAt ? toIsoDateTime(row.resolvedAt) : null,
  });
}

/** Name of the violated unique constraint, directly or in drizzle's cause chain. */
function uniqueViolationOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolationOf(candidate.cause, depth + 1);
}

// ---- Events, realtime, audit -----------------------------------------------

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
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
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** One catalogued QR event in the caller's transaction (transactional outbox). */
async function appendRecoveryEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: QrOrderEventName,
  input: {
    aggregateId: string;
    outletId: string;
    payload: Record<string, unknown>;
    actor: { type: "user"; id: string } | { type: "system" };
    now: Date;
  },
): Promise<void> {
  const definition = qrOrderEvents[name];
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
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
    actor: input.actor,
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

async function auditIssue(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    issue: IssueRow;
    actorUserId: string | null;
    reason: string | null;
    after: Record<string, unknown>;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.issue.outletId,
      actorType: input.actorUserId === null ? "system" : "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: "order",
      objectId: input.issue.orderId,
      reason: input.reason,
      maskedChanges: { before: null, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Reads -------------------------------------------------------------------

async function loadIssue(
  tx: Tx,
  context: ScopedTenantContext,
  issueId: string,
  lock: boolean,
): Promise<IssueContext | undefined> {
  const query = tx
    .select({
      issue: orderIssues,
      orderId: orders.id,
      tableSessionId: orders.tableSessionId,
      customerProfileId: orders.customerProfileId,
      orderStatus: orders.status,
      paymentMode: orders.paymentMode,
      paymentIntentId: orders.paymentIntentId,
      paymentIntentStatus: paymentIntents.status,
      lineStatus: orderItems.status,
      posVoidedAt: posOrderItems.voidedAt,
      lineId: orderItems.id,
      menuItemId: orderItems.menuItemId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceIdr: orderItems.unitPriceIdr,
      lineTotalIdr: orderItems.lineTotalIdr,
    })
    .from(orderIssues)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, orderIssues.tenantId),
        eq(orders.id, orderIssues.orderId),
      ),
    )
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.tenantId, orderIssues.tenantId),
        eq(orderItems.id, orderIssues.orderItemId),
      ),
    )
    .leftJoin(
      posOrderItems,
      and(
        eq(posOrderItems.tenantId, orderItems.tenantId),
        eq(posOrderItems.itemId, orderItems.id),
      ),
    )
    .leftJoin(
      paymentIntents,
      and(
        eq(paymentIntents.tenantId, orders.tenantId),
        eq(paymentIntents.id, orders.paymentIntentId),
      ),
    )
    .where(
      and(
        eq(orderIssues.tenantId, context.tenant.tenantId),
        eq(orderIssues.id, issueId),
      ),
    );
  const [row] = lock
    ? await query.for("update", { of: orderIssues })
    : await query;
  if (!row) return undefined;
  return {
    issue: row.issue,
    order: {
      id: row.orderId,
      tableSessionId: row.tableSessionId,
      customerProfileId: row.customerProfileId,
      status: row.orderStatus,
      paymentMode: row.paymentMode,
      paymentIntentId: row.paymentIntentId,
      paymentIntentStatus: row.paymentIntentStatus,
    },
    line: {
      id: row.lineId,
      menuItemId: row.menuItemId,
      name: row.name,
      quantity: row.quantity,
      unitPriceIdr: row.unitPriceIdr,
      lineTotalIdr: row.lineTotalIdr,
      voided: row.lineStatus === "voided" || row.posVoidedAt !== null,
    },
  };
}

/** Only a recovery report is the guest's: never a KDS remake or comp row. */
function isGuestRecovery(issue: IssueRow): boolean {
  return (
    issue.type === "unfulfillable" &&
    issue.idempotencyKey.startsWith(RECOVERY_KEY_PREFIX)
  );
}

/** The 409 of a unique index that guards one resolution, else the error. */
function recoveryConflictOf(error: unknown): unknown {
  const violated = uniqueViolationOf(error);
  if (violated === RESOLVED_ITEM_ONCE_INDEX)
    return new CoreError("CONFLICT", "Item ini sudah diselesaikan.");
  if (violated === VOUCHER_ONCE_INDEX)
    return new CoreError(
      "CONFLICT",
      "Voucher maaf ini sudah dipakai laporan lain.",
    );
  if (violated === MANUAL_REFUND_ONCE_INDEX)
    return new CoreError("CONFLICT", "Item ini sudah pernah direfund manual.");
  return error;
}

/**
 * The issue for a guest: the credential must belong to the session that owns
 * the issue's order. A foreign or unknown issue is the same NOT_FOUND.
 */
async function loadGuestIssue(
  tx: Tx,
  context: ScopedTenantContext,
  credential: string,
  issueId: string,
  now: Date,
  lock: boolean,
): Promise<IssueContext> {
  const found = await loadIssue(tx, context, issueId, false);
  if (
    !found ||
    found.order.tableSessionId === null ||
    !isGuestRecovery(found.issue)
  )
    throw issueNotFound();
  try {
    await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      found.order.tableSessionId,
      now,
      "none",
    );
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND")
      throw issueNotFound();
    throw error;
  }
  if (!lock) return found;
  const locked = await loadIssue(tx, context, issueId, true);
  if (!locked) throw issueNotFound();
  return locked;
}

/** Menu items of the outlet a guest can be moved to, cheapest check first. */
async function swapCandidates(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<OutletMenuPrice[]> {
  const tenantId = context.tenant.tenantId;
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return [];
  const rows = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, outlet.brandId),
        eq(menuItems.isActive, true),
        sql`${menuItems.deletedAt} IS NULL`,
      ),
    )
    .orderBy(asc(menuItems.name), asc(menuItems.id))
    .limit(SWAP_CANDIDATE_LIMIT);
  const priced = await priceMenuItemForOutlet(
    tx,
    context,
    outletId,
    rows.map((row) => row.id),
    now,
  );
  return rows.flatMap((row) => priced.get(row.id) ?? []);
}

/** The apology voucher with its readable code, null when it cannot be shown. */
async function voucherView(
  tx: Tx,
  context: ScopedTenantContext,
  apologyVoucherId: string | null,
): Promise<GuestOrderIssue["voucher"]> {
  if (apologyVoucherId === null) return null;
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({
      id: apologyVouchers.id,
      voucherId: apologyVouchers.voucherId,
      codeSealed: apologyVouchers.codeSealed,
      valueIdr: vouchers.valueIdr,
      validUntil: vouchers.validUntil,
    })
    .from(apologyVouchers)
    .innerJoin(
      vouchers,
      and(
        eq(vouchers.tenantId, apologyVouchers.tenantId),
        eq(vouchers.id, apologyVouchers.voucherId),
      ),
    )
    .where(
      and(
        eq(apologyVouchers.tenantId, tenantId),
        eq(apologyVouchers.id, apologyVoucherId),
      ),
    );
  if (!row || row.valueIdr === null || row.validUntil === null) return null;
  return {
    id: row.id,
    code: openSecret(row.codeSealed, sealAad(tenantId, row.voucherId)),
    valueIdr: row.valueIdr,
    expiresAt: toIsoDateTime(row.validUntil),
  } as GuestOrderIssue["voucher"];
}

// ---- Report (staff) ---------------------------------------------------------

export async function reportFailedItem(
  context: ScopedTenantContext,
  actorUserId: string,
  orderItemId: string,
  input: CreateOrderIssueInput,
  now: Date,
): Promise<OrderIssue> {
  const store = () =>
    storeFailedItem(context, actorUserId, orderItemId, input, now);
  try {
    return await store();
  } catch (error) {
    // The losing writer of a race: the failed transaction left nothing behind.
    if (uniqueViolationOf(error) === IDEMPOTENCY_KEY) return store();
    throw error;
  }
}

async function storeFailedItem(
  context: ScopedTenantContext,
  actorUserId: string,
  orderItemId: string,
  input: CreateOrderIssueInput,
  now: Date,
): Promise<OrderIssue> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    const [line] = await tx
      .select({
        id: orderItems.id,
        outletId: orderItems.outletId,
        orderId: orderItems.orderId,
        menuItemId: orderItems.menuItemId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        modifiers: orderItems.modifiers,
        status: orderItems.status,
        orderStatus: orders.status,
        paymentMode: orders.paymentMode,
        paymentIntentId: orders.paymentIntentId,
        paymentIntentStatus: paymentIntents.status,
        posVoidedAt: posOrderItems.voidedAt,
        tableSessionId: orders.tableSessionId,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderItems.tenantId),
          eq(orders.id, orderItems.orderId),
        ),
      )
      .leftJoin(
        posOrderItems,
        and(
          eq(posOrderItems.tenantId, orderItems.tenantId),
          eq(posOrderItems.itemId, orderItems.id),
        ),
      )
      .leftJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, orders.tenantId),
          eq(paymentIntents.id, orders.paymentIntentId),
        ),
      )
      .where(
        and(eq(orderItems.tenantId, tenantId), eq(orderItems.id, orderItemId)),
      );
    if (!line) throw itemNotFound();
    if (!snapshot.allows(HANDLE, { type: "outlet", id: line.outletId }))
      throw deniedOutlet();

    const baseKey = `recovery:${orderItemId}:${input.type}`;
    // The newest report of this line and type is the replay. One whose manual
    // refund was rejected is final and gave nothing back: a new report then
    // opens a fresh issue under the next key `<base>:<n>` (legend-wumm8).
    const previous = await tx
      .select()
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          or(
            eq(orderIssues.idempotencyKey, baseKey),
            like(orderIssues.idempotencyKey, `${baseKey}:%`),
          ),
        ),
      )
      .orderBy(desc(orderIssues.createdAt), desc(orderIssues.id));
    const [latest] = previous;
    if (latest && latest.refundRejectedAt === null) return toIssue(latest);
    const idempotencyKey =
      latest === undefined ? baseKey : `${baseKey}:${previous.length + 1}`;

    if (
      !isPaidOrder({
        status: line.orderStatus,
        paymentMode: line.paymentMode,
        paymentIntentId: line.paymentIntentId,
        paymentIntentStatus: line.paymentIntentStatus,
      })
    )
      throw unprocessable(
        "Item gagal hanya bisa dilaporkan untuk pesanan yang sudah dibayar.",
      );
    if (line.status === "voided" || line.posVoidedAt !== null)
      throw unprocessable("Item ini sudah dibatalkan (void).");

    await assertLineNotManuallyRefunded(
      tx,
      tenantId,
      line.orderId,
      orderItemId,
    );

    const costIdr = await estimateDeductionCostIdr(tx, context, line.outletId, [
      {
        menuItemId: line.menuItemId,
        variantId: line.variantId ?? null,
        modifierIds: (line.modifiers ?? []).map(
          (modifier) => modifier.modifierId,
        ),
        quantity: line.quantity,
      },
    ]);

    const [row] = await tx
      .insert(orderIssues)
      .values({
        tenantId,
        outletId: line.outletId,
        orderId: line.orderId,
        orderItemId,
        type: input.type,
        reason: input.reason,
        reasonNote: input.reasonNote,
        stationId: null,
        employeeId: null,
        reportedBy: actorUserId,
        resolution: null,
        idempotencyKey,
        costIdr: idr(costIdr),
        status: "open",
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("order issue not stored");

    // ORD-08: only an item the kitchen could not make is offered a recovery.
    if (input.type === "unfulfillable") {
      await appendRecoveryEvent(tx, context, "item.failed", {
        aggregateId: row.id,
        outletId: row.outletId,
        payload: {
          orderId: row.orderId,
          orderItemId,
          orderIssueId: row.id,
          type: row.type,
          reason: row.reasonNote,
          offeredResolutions: ["swap", "voucher"],
        },
        actor: { type: "user", id: actorUserId },
        now,
      });
      if (line.tableSessionId !== null)
        await notifyQrOrderChange(tx, context, {
          sessionId: line.tableSessionId,
          orderId: row.orderId,
          status: "item_failed",
        });
    }

    await auditIssue(
      tx,
      context,
      {
        action: `order_issue.${input.type}`,
        issue: row,
        actorUserId,
        reason: input.reasonNote,
        after: {
          id: row.id,
          type: row.type,
          reason: row.reason,
          costIdr,
        },
      },
      now,
    );
    return toIssue(row);
  });
}

// ---- Guest reads -------------------------------------------------------------

export async function listSessionOrderIssues(
  guest: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now: Date,
): Promise<GuestOrderIssue[]> {
  return withTenant(db, guest, async (tx) => {
    const tenantId = guest.tenant.tenantId;
    const session = await lockGuestSessionForPayment(
      tx,
      guest,
      credential,
      sessionId,
      now,
      "none",
    );
    const rows = await tx
      .select({
        issue: orderIssues,
        itemName: orderItems.name,
        quantity: orderItems.quantity,
        unitPriceIdr: orderItems.unitPriceIdr,
        lineTotalIdr: orderItems.lineTotalIdr,
        menuItemId: orderItems.menuItemId,
      })
      .from(orderIssues)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderIssues.tenantId),
          eq(orders.id, orderIssues.orderId),
        ),
      )
      .innerJoin(
        orderItems,
        and(
          eq(orderItems.tenantId, orderIssues.tenantId),
          eq(orderItems.id, orderIssues.orderItemId),
        ),
      )
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orders.tableSessionId, sessionId),
          eq(orderIssues.type, "unfulfillable"),
          like(orderIssues.idempotencyKey, `${RECOVERY_KEY_PREFIX}%`),
        ),
      )
      .orderBy(asc(orderIssues.createdAt), asc(orderIssues.id));
    if (rows.length === 0) return [];

    const anyOpen = rows.some((row) => row.issue.status === "open");
    const candidates = anyOpen
      ? await swapCandidates(tx, guest, session.outletId, now)
      : [];
    const replacementIds = rows.flatMap((row) =>
      row.issue.replacementItemId === null ? [] : [row.issue.replacementItemId],
    );
    const replacementNames = new Map<string, string>();
    if (replacementIds.length > 0)
      for (const item of await tx
        .select({ id: menuItems.id, name: menuItems.name })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, tenantId),
            inArray(menuItems.id, replacementIds),
          ),
        ))
        replacementNames.set(item.id, item.name);

    const views: GuestOrderIssue[] = [];
    for (const row of rows) {
      const open = row.issue.status === "open";
      views.push(
        guestOrderIssueSchema.parse({
          id: row.issue.id,
          orderId: row.issue.orderId,
          orderItemId: row.issue.orderItemId,
          itemName: row.itemName,
          quantity: row.quantity,
          lineTotalIdr: row.lineTotalIdr,
          type: row.issue.type,
          status: row.issue.status,
          options: {
            swap: {
              allowed: open,
              items: open
                ? candidates
                    .filter(
                      (item) =>
                        item.menuItemId !== row.menuItemId &&
                        item.unitPriceIdr * row.quantity <= row.lineTotalIdr,
                    )
                    .map((item) => ({
                      menuItemId: item.menuItemId,
                      name: item.name,
                      priceIdr: item.unitPriceIdr,
                      differenceIdr:
                        item.unitPriceIdr * row.quantity - row.lineTotalIdr,
                    }))
                : [],
            },
            voucher: { allowed: open, valueIdr: open ? row.lineTotalIdr : 0 },
          },
          resolution: row.issue.resolution,
          replacementItemName:
            row.issue.replacementItemId === null
              ? null
              : (replacementNames.get(row.issue.replacementItemId) ?? null),
          priceDifferenceIdr: row.issue.priceDifferenceIdr,
          voucher: await voucherView(tx, guest, row.issue.voucherId),
          createdAt: toIsoDateTime(row.issue.createdAt),
          resolvedAt: row.issue.resolvedAt
            ? toIsoDateTime(row.issue.resolvedAt)
            : null,
        }),
      );
    }
    return views;
  });
}

export async function getOrderIssueOptions(
  guest: ScopedTenantContext,
  credential: string,
  issueId: string,
  now: Date = new Date(),
): Promise<OrderIssueOptions> {
  return withTenant(db, guest, async (tx) => {
    const found = await loadGuestIssue(
      tx,
      guest,
      credential,
      issueId,
      now,
      false,
    );
    const open = found.issue.status === "open";
    const candidates = open
      ? await swapCandidates(tx, guest, found.issue.outletId, now)
      : [];
    return orderIssueOptionsSchema.parse({
      issueId: found.issue.id,
      swap: {
        allowed: open,
        suggestedMenuItemIds: candidates
          .filter(
            (item) =>
              item.menuItemId !== found.line.menuItemId &&
              item.unitPriceIdr * found.line.quantity <=
                found.line.lineTotalIdr,
          )
          .slice(0, SUGGESTED_SWAP_LIMIT)
          .map((item) => item.menuItemId),
      },
      voucher: { allowed: open, valueIdr: open ? found.line.lineTotalIdr : 0 },
      manualRefundOfferedToCustomer: false,
    });
  });
}

// ---- Settling ----------------------------------------------------------------

type Settlement = {
  resolution: "swap" | "voucher" | "manual_refund";
  replacementItemId: string | null;
  /** Catalogue unit price at resolve time (swap only), the `difference` source. */
  replacementUnitPriceIdr: number | null;
  voucherId: string | null;
  priceDifferenceIdr: number | null;
  approvedBy: string | null;
  approvalRequestId: string | null;
  reasonNote: string | null;
};

/**
 * Writes the settlement on the still open issue and appends
 * `order_issue.resolved`. The `status = 'open'` guard makes a lost race a 409
 * even if the caller skipped the row lock.
 */
async function settleIssue(
  tx: Tx,
  context: ScopedTenantContext,
  found: IssueContext,
  settlement: Settlement,
  actor: { type: "user"; id: string } | { type: "system" },
  now: Date,
): Promise<OrderIssue> {
  if (settlement.resolution !== "manual_refund")
    await assertLineNotManuallyRefunded(
      tx,
      context.tenant.tenantId,
      found.issue.orderId,
      found.issue.orderItemId,
    );
  const [row] = await tx
    .update(orderIssues)
    .set({
      resolution: settlement.resolution,
      replacementItemId: settlement.replacementItemId,
      replacementUnitPriceIdr:
        settlement.replacementUnitPriceIdr === null
          ? null
          : idr(settlement.replacementUnitPriceIdr),
      voucherId: settlement.voucherId,
      priceDifferenceIdr:
        settlement.priceDifferenceIdr === null
          ? null
          : idr(settlement.priceDifferenceIdr),
      approvedBy: settlement.approvedBy,
      approvalRequestId: settlement.approvalRequestId,
      ...(settlement.reasonNote === null
        ? {}
        : { reasonNote: settlement.reasonNote }),
      status: "resolved",
      resolvedAt: now,
    })
    .where(
      and(
        eq(orderIssues.tenantId, context.tenant.tenantId),
        eq(orderIssues.id, found.issue.id),
        eq(orderIssues.status, "open"),
      ),
    )
    .returning();
  if (!row) throw new CoreError("CONFLICT", "Laporan ini sudah diselesaikan.");

  await appendRecoveryEvent(tx, context, "order_issue.resolved", {
    aggregateId: row.id,
    outletId: row.outletId,
    payload: {
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      orderIssueId: row.id,
      resolution: settlement.resolution,
      resolvedBy: actor.type === "user" ? "staff" : "guest",
      replacementItemId: settlement.replacementItemId,
      voucherId: settlement.voucherId,
      priceDifferenceIdr: settlement.priceDifferenceIdr,
      ...(settlement.approvalRequestId === null
        ? {}
        : { approvalRequestId: settlement.approvalRequestId }),
    },
    actor,
    now,
  });
  await auditIssue(
    tx,
    context,
    {
      action: `order_issue.resolved.${settlement.resolution}`,
      issue: row,
      actorUserId: actor.type === "user" ? actor.id : null,
      reason: settlement.reasonNote,
      after: {
        id: row.id,
        resolution: settlement.resolution,
        priceDifferenceIdr: settlement.priceDifferenceIdr,
        approvalRequestId: settlement.approvalRequestId,
        voucherId: settlement.voucherId,
        replacementItemId: settlement.replacementItemId,
      },
    },
    now,
  );
  return toIssue(row);
}

/** Who settles a swap: the guest never pays more, staff need an approval. */
type SwapActor =
  | { type: "guest" }
  | { type: "staff"; userId: string; approvalRequestId: string | undefined };

/**
 * ORD-09 style check for a dearer swap: a fully approved `price_correction`
 * for this issue and exactly the price difference, from another approver and
 * not yet spent on another issue.
 */
async function priceCorrectionApproval(
  tx: Tx,
  context: ScopedTenantContext,
  found: IssueContext,
  actorUserId: string,
  approvalRequestId: string,
  differenceIdr: number,
): Promise<{ approvedBy: string }> {
  const invalid = (message: string) => unprocessable(message);
  const tenantId = context.tenant.tenantId;
  const [request] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.id, approvalRequestId),
      ),
    );
  if (!request) throw invalid("Permintaan approval tidak ditemukan.");
  const chain = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, request.chainId),
      ),
    )
    .orderBy(asc(approvalRequests.level));
  const last = chain.at(-1);
  if (
    !last ||
    last.status !== "approved" ||
    last.level < last.requiredLevels ||
    last.decidedBy === null
  )
    throw invalid("Approval koreksi harga belum disetujui penuh.");
  if (
    request.actionType !== "price_correction" ||
    request.objectType !== "order_issue" ||
    request.objectId !== found.issue.id
  )
    throw invalid("Approval ini bukan koreksi harga untuk item gagal ini.");
  if (request.amountIdr !== differenceIdr)
    throw invalid("Nominal approval tidak sama dengan selisih harga.");
  if (request.outletId !== null && request.outletId !== found.issue.outletId)
    throw invalid("Approval ini milik outlet lain.");
  if (chain.some((level) => level.decidedBy === actorUserId))
    throw invalid("Penyetuju tidak boleh sama dengan pelaksana penukaran.");
  const [used] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        inArray(
          orderIssues.approvalRequestId,
          chain.map((level) => level.id),
        ),
      ),
    )
    .limit(1);
  if (used)
    throw new CoreError("CONFLICT", "Approval ini sudah dipakai laporan lain.");
  return { approvedBy: last.decidedBy };
}

/** A staff swap credit waiting for its `apology_voucher` approval. */
type SwapPendingApproval = { pendingApprovalRequestId: string };

/**
 * Swap: replacement priced by the QR catalogue, a cheaper one credited. A staff
 * credit follows the `apology_voucher` matrix: when it needs an approval that is
 * not given yet the opened request is returned, not thrown, so the caller can
 * commit it before answering 409.
 */
async function swapSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  found: IssueContext,
  replacementItemId: string,
  actor: SwapActor,
  now: Date,
): Promise<Settlement | SwapPendingApproval> {
  assertRecoverable(found);
  if (replacementItemId === found.line.menuItemId)
    throw unprocessable("Menu pengganti harus berbeda dari item yang gagal.");
  const priced = await priceMenuItemForOutlet(
    tx,
    context,
    found.issue.outletId,
    [replacementItemId],
    now,
  );
  const replacement = priced.get(replacementItemId);
  if (!replacement)
    throw unprocessable("Menu pengganti tidak tersedia di outlet ini.");
  // Against the whole old line (modifiers included): negative is credited.
  const difference =
    replacement.unitPriceIdr * found.line.quantity - found.line.lineTotalIdr;
  let approval: {
    approvedBy: string | null;
    approvalRequestId: string;
  } | null = null;
  if (difference > 0) {
    if (actor.type === "guest")
      throw unprocessable(
        "Menu pengganti lebih mahal dari item yang gagal; pilih menu seharga sama atau lebih murah, atau minta bantuan staf.",
      );
    if (actor.approvalRequestId === undefined)
      throw unprocessable(
        "Menu pengganti lebih mahal dari item yang gagal; butuh approval koreksi harga yang sudah disetujui (approvalRequestId).",
      );
    const approved = await priceCorrectionApproval(
      tx,
      context,
      found,
      actor.userId,
      actor.approvalRequestId,
      difference,
    );
    approval = {
      approvedBy: approved.approvedBy,
      approvalRequestId: actor.approvalRequestId,
    };
  }
  let voucherId: string | null = null;
  if (difference < 0) {
    const creditReason =
      `Kredit selisih harga penukaran ${found.line.name}`.slice(0, 500);
    let creditApprovalId: string | null = null;
    if (actor.type === "staff") {
      const matrix = await requireSwapCreditApproval(tx, context, {
        orderIssueId: found.issue.id,
        outletId: found.issue.outletId,
        valueIdr: -difference,
        reason: creditReason,
        requestedBy: actor.userId,
        approvalRequestId: actor.approvalRequestId,
        now,
      });
      if (matrix.kind === "pending")
        return { pendingApprovalRequestId: matrix.requestId };
      creditApprovalId = matrix.approvalRequestId;
      if (creditApprovalId !== null)
        approval = {
          approvedBy: matrix.approvedBy,
          approvalRequestId: creditApprovalId,
        };
    }
    // One issue, one voucher: the credit rides on the issue's own voucher.
    const credit = await mintApologyVoucher(tx, context, {
      outletId: found.issue.outletId,
      issuedBy: found.issue.reportedBy,
      valueIdr: -difference,
      reason: creditReason,
      orderIssueId: found.issue.id,
      customerProfileId: found.order.customerProfileId,
      approvalRequestId: creditApprovalId,
      expiresInDays: CREDIT_VOUCHER_DAYS,
      now,
    });
    voucherId = credit.apologyVoucherId;
  }
  return {
    resolution: "swap",
    replacementItemId,
    replacementUnitPriceIdr: replacement.unitPriceIdr,
    voucherId,
    priceDifferenceIdr: difference,
    approvedBy: approval?.approvedBy ?? null,
    approvalRequestId: approval?.approvalRequestId ?? null,
    reasonNote: null,
  };
}

/** System-issued voucher worth the line total, no approval matrix. */
async function systemVoucherSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  found: IssueContext,
  now: Date,
): Promise<Settlement> {
  assertRecoverable(found);
  const minted = await mintApologyVoucher(tx, context, {
    outletId: found.issue.outletId,
    issuedBy: found.issue.reportedBy,
    valueIdr: found.line.lineTotalIdr,
    reason: `Voucher pengganti item gagal ${found.line.name}`.slice(0, 500),
    orderIssueId: found.issue.id,
    customerProfileId: found.order.customerProfileId,
    approvalRequestId: null,
    expiresInDays: CREDIT_VOUCHER_DAYS,
    now,
  });
  return {
    resolution: "voucher",
    replacementItemId: null,
    replacementUnitPriceIdr: null,
    voucherId: minted.apologyVoucherId,
    priceDifferenceIdr: null,
    approvedBy: null,
    approvalRequestId: null,
    reasonNote: null,
  };
}

// ---- Guest choice ------------------------------------------------------------

/** A tenant transaction whose one-resolution unique violations become 409. */
async function inRecoveryTransaction<T>(
  context: ScopedTenantContext,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withTenant(db, context, run);
  } catch (error) {
    throw recoveryConflictOf(error);
  }
}

export async function chooseOrderIssueResolution(
  guest: ScopedTenantContext,
  credential: string,
  issueId: string,
  input: CustomerChoiceInput,
  now: Date,
): Promise<OrderIssue> {
  return inRecoveryTransaction(guest, async (tx) => {
    // The row lock serialises two phones choosing at once.
    const found = await loadGuestIssue(
      tx,
      guest,
      credential,
      issueId,
      now,
      true,
    );
    const { issue } = found;
    if (issue.status !== "open") {
      if (
        issue.status === "resolved" &&
        issue.resolution === input.choice &&
        (input.choice !== "swap" ||
          issue.replacementItemId === input.replacementItemId)
      )
        return toIssue(issue);
      throw new CoreError(
        "CONFLICT",
        "Laporan ini sudah diselesaikan dengan pilihan lain.",
      );
    }
    const settlement =
      input.choice === "swap"
        ? await swapSettlement(
            tx,
            guest,
            found,
            input.replacementItemId ?? "",
            { type: "guest" },
            now,
          )
        : await systemVoucherSettlement(tx, guest, found, now);
    // The guest swap never opens an approval request.
    if ("pendingApprovalRequestId" in settlement)
      throw new Error("Guest swap returned a pending approval");
    return settleIssue(tx, guest, found, settlement, { type: "system" }, now);
  });
}

// ---- Staff resolution -----------------------------------------------------------

/** ORD-09: the approval chain that allows a manual refund of this issue. */
async function refundApproval(
  tx: Tx,
  context: ScopedTenantContext,
  found: IssueContext,
  actorUserId: string,
  approvalRequestId: string,
): Promise<{ approvedBy: string }> {
  const invalid = (message: string) => unprocessable(`ORD-09: ${message}`);
  assertRecoverable(found);
  const [request] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.id, approvalRequestId),
      ),
    );
  if (!request) throw invalid("permintaan approval tidak ditemukan.");
  const chain = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.chainId, request.chainId),
      ),
    )
    .orderBy(asc(approvalRequests.level));
  const last = chain.at(-1);
  if (
    !last ||
    last.status !== "approved" ||
    last.level < last.requiredLevels ||
    last.decidedBy === null
  )
    throw invalid("approval belum disetujui penuh.");
  if (
    request.actionType !== "refund" ||
    request.objectType !== "order_issue" ||
    request.objectId !== found.issue.id
  )
    throw invalid("approval ini bukan untuk refund item ini.");
  if (request.amountIdr !== found.line.lineTotalIdr)
    throw invalid("nominal approval tidak sama dengan total item.");
  if (request.outletId !== null && request.outletId !== found.issue.outletId)
    throw invalid("approval ini milik outlet lain.");
  if (chain.some((level) => level.decidedBy === actorUserId))
    throw invalid("penyetuju tidak boleh sama dengan pelaksana refund.");
  return { approvedBy: last.decidedBy };
}

export async function resolveOrderIssue(
  context: ScopedTenantContext,
  actorUserId: string,
  issueId: string,
  input: StaffResolutionInput,
  now: Date,
): Promise<OrderIssue> {
  const outcome = await inRecoveryTransaction<OrderIssue | SwapPendingApproval>(
    context,
    async (tx) => {
      const tenantId = context.tenant.tenantId;
      const snapshot = await accessSnapshotInTransaction(
        tx,
        context,
        actorUserId,
        now,
      );
      const found = await loadIssue(tx, context, issueId, true);
      if (!found) throw issueNotFound();
      if (
        !snapshot.allows(HANDLE, { type: "outlet", id: found.issue.outletId })
      )
        throw deniedOutlet();
      const { issue } = found;

      if (issue.status !== "open") {
        const same =
          issue.status === "resolved" &&
          issue.resolution === input.resolution &&
          (input.resolution !== "swap" ||
            issue.replacementItemId === input.replacementItemId) &&
          (input.resolution !== "voucher" ||
            issue.voucherId === input.voucherId) &&
          (input.resolution !== "manual_refund" ||
            issue.approvalRequestId === input.approvalRequestId);
        if (same) return toIssue(issue);
        throw new CoreError(
          "CONFLICT",
          "Laporan ini sudah diselesaikan dengan pilihan lain.",
        );
      }

      let settlement: Settlement;
      if (input.resolution === "swap") {
        const swapped = await swapSettlement(
          tx,
          context,
          found,
          input.replacementItemId ?? "",
          {
            type: "staff",
            userId: actorUserId,
            approvalRequestId: input.approvalRequestId,
          },
          now,
        );
        // The request stays stored: commit, then answer 409 below.
        if ("pendingApprovalRequestId" in swapped) return swapped;
        settlement = swapped;
      } else if (input.resolution === "voucher") {
        assertRecoverable(found);
        const [apology] = await tx
          .select({
            id: apologyVouchers.id,
            outletId: apologyVouchers.outletId,
            orderIssueId: apologyVouchers.orderIssueId,
            status: vouchers.status,
            validUntil: vouchers.validUntil,
          })
          .from(apologyVouchers)
          .innerJoin(
            vouchers,
            and(
              eq(vouchers.tenantId, apologyVouchers.tenantId),
              eq(vouchers.id, apologyVouchers.voucherId),
            ),
          )
          .where(
            and(
              eq(apologyVouchers.tenantId, tenantId),
              eq(apologyVouchers.id, input.voucherId ?? ""),
            ),
          );
        if (!apology || apology.outletId !== issue.outletId)
          throw unprocessable("Voucher maaf tidak ditemukan di outlet ini.");
        if (apology.orderIssueId !== null && apology.orderIssueId !== issue.id)
          throw new CoreError(
            "CONFLICT",
            "Voucher maaf ini milik laporan lain.",
          );
        if (
          apology.status !== "issued" ||
          apology.validUntil === null ||
          apology.validUntil.getTime() <= now.getTime()
        )
          throw unprocessable(
            "Voucher maaf ini sudah dipakai, dibatalkan, atau kedaluwarsa.",
          );
        const [taken] = await tx
          .select({ id: orderIssues.id })
          .from(orderIssues)
          .where(
            and(
              eq(orderIssues.tenantId, tenantId),
              eq(orderIssues.voucherId, apology.id),
            ),
          )
          .limit(1);
        if (taken)
          throw new CoreError(
            "CONFLICT",
            "Voucher maaf ini sudah dipakai laporan lain.",
          );
        settlement = {
          resolution: "voucher",
          replacementItemId: null,
          replacementUnitPriceIdr: null,
          voucherId: apology.id,
          priceDifferenceIdr: null,
          approvedBy: null,
          approvalRequestId: null,
          reasonNote: null,
        };
      } else {
        const reason = (input.reason ?? "").trim();
        if (input.approvalRequestId === undefined || reason.length < 10)
          throw unprocessable(
            "ORD-09: refund manual butuh approval dan alasan tertulis minimal 10 karakter.",
          );
        const approval = await refundApproval(
          tx,
          context,
          found,
          actorUserId,
          input.approvalRequestId,
        );
        settlement = {
          resolution: "manual_refund",
          replacementItemId: null,
          replacementUnitPriceIdr: null,
          voucherId: null,
          priceDifferenceIdr: null,
          approvedBy: approval.approvedBy,
          approvalRequestId: input.approvalRequestId,
          reasonNote: reason,
        };
      }

      const actor = { type: "user", id: actorUserId } as const;
      const settled = await settleIssue(
        tx,
        context,
        found,
        settlement,
        actor,
        now,
      );
      if (settlement.resolution === "manual_refund")
        await appendRecoveryEvent(
          tx,
          context,
          "order_issue.manual_refund_approved",
          {
            aggregateId: issue.id,
            outletId: issue.outletId,
            payload: {
              orderId: issue.orderId,
              orderItemId: issue.orderItemId,
              orderIssueId: issue.id,
              amountIdr: found.line.lineTotalIdr,
              approvalRequestId: settlement.approvalRequestId,
              approvedBy: settlement.approvedBy,
              reason: settlement.reasonNote,
            },
            actor,
            now,
          },
        );
      return settled;
    },
  );
  if ("pendingApprovalRequestId" in outcome)
    throw new HttpError(
      409,
      "APPROVAL_REQUIRED",
      approvalRequiredMessage(outcome.pendingApprovalRequestId),
    );
  return outcome;
}
