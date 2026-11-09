// Shared building blocks of the purchase request / purchase order services
// (bead legend-9yz, slice D; PRD v1.7 §3.18, §4 Alur I): permission sets,
// the purchasing idempotency guard, the approval-matrix hook and the outbox
// events. None of this is HTTP.
//
// Approval: on `submit` the document asks the generic approval service
// (sourceModule `purchasing`). A required chain is stored on the document and
// is decided in the approvals inbox; the module `approve` / `reject` action is
// refused while a chain is open. Without a chain (the matrix asks for none at
// this amount) the module transition approves manually: approver needs
// `purchasing.order.approve` and must not be the requester / creator. A tenant
// with no (or a broken) policy for the action is blocked, never approved by one
// person: submit fails with 409 APPROVAL_POLICY_MISSING. Nothing is ever
// auto-approved.

import { AccessError, type PermissionCode } from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  CoreError,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  purchaseOrderSchema,
  purchasingEvents,
  type PurchaseOrder,
  type PurchaseOrderEmailDeliveryStatus,
  type PurchasingEventName,
} from "@starter/shared/inventory";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import {
  purchaseOrderEmailDeliveries,
  purchaseOrders,
  purchasingIdempotency,
} from "../db/schema/purchasing.ts";
import { HttpError } from "../lib/http-error.ts";
import { translateDomainError } from "./domain-error-http.shared.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  EVENT_DESTINATION,
  outletTarget,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  accessSnapshotInTransaction,
  type AccessSnapshot,
} from "./permission-resolver.ts";
import { openApprovalRequest } from "./platform-approval.service.ts";

export const PURCHASING_SOURCE_MODULE = "purchasing";
export type PurchasingApprovalObject = "purchase_request" | "purchase_order";

/** Any of these lets a caller read PR / PO of an outlet (fail closed). */
export const PURCHASING_READ_PERMISSIONS: readonly PermissionCode[] = [
  "purchasing.supplier.manage",
  "purchasing.request.create",
  "purchasing.order.create",
  "purchasing.order.approve",
  "purchasing.invoice.match",
];

/** Contract status and safe message per code (see domain-error-http.shared.ts). */
export function translatePurchasingError(error: unknown): unknown {
  return translateDomainError(error);
}

/**
 * Money math (`extendCostIdr`, `sumIdr`) throws RangeError past the safe
 * integer range: a caller's absurd quantity x price is a 422, not a 500.
 */
export function guardMoneyMath<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError)
      throw new HttpError(422, "VALIDATION_ERROR", "The amount is too large.");
    throw error;
  }
}

// ---------------------------------------------------------- PO DTO

export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;

/**
 * Latest email delivery status per order (by created time, id as tiebreak) in
 * one query. An order never emailed has no entry.
 */
export async function loadEmailDeliveryStatuses(
  tx: Tx,
  tenantId: PurchaseOrderRow["tenantId"],
  orderIds: readonly string[],
): Promise<Map<string, PurchaseOrderEmailDeliveryStatus>> {
  const statuses = new Map<string, PurchaseOrderEmailDeliveryStatus>();
  if (orderIds.length === 0) return statuses;
  const rows = await tx
    .selectDistinctOn([purchaseOrderEmailDeliveries.purchaseOrderId], {
      purchaseOrderId: purchaseOrderEmailDeliveries.purchaseOrderId,
      status: purchaseOrderEmailDeliveries.status,
    })
    .from(purchaseOrderEmailDeliveries)
    .where(
      and(
        eq(purchaseOrderEmailDeliveries.tenantId, tenantId),
        inArray(purchaseOrderEmailDeliveries.purchaseOrderId, [...orderIds]),
      ),
    )
    .orderBy(
      purchaseOrderEmailDeliveries.purchaseOrderId,
      desc(purchaseOrderEmailDeliveries.createdAt),
      desc(purchaseOrderEmailDeliveries.id),
    );
  for (const row of rows)
    statuses.set(
      row.purchaseOrderId,
      row.status as PurchaseOrderEmailDeliveryStatus,
    );
  return statuses;
}

export function toPurchaseOrder(
  row: PurchaseOrderRow,
  emailDeliveryStatus: PurchaseOrderEmailDeliveryStatus | null,
): PurchaseOrder {
  return purchaseOrderSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    supplierId: row.supplierId,
    number: row.number,
    purchaseRequestId: row.purchaseRequestId,
    status: row.status,
    expectedDate: row.expectedDate,
    subtotalIdr: row.subtotalIdr,
    taxIdr: row.taxIdr,
    totalIdr: row.totalIdr,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentTo: row.sentTo,
    closedAt: row.closedAt?.toISOString() ?? null,
    note: row.note,
    emailDeliveryStatus,
  });
}

/** One order DTO with its latest email delivery status. */
export async function loadPurchaseOrder(
  tx: Tx,
  row: PurchaseOrderRow,
): Promise<PurchaseOrder> {
  const statuses = await loadEmailDeliveryStatuses(tx, row.tenantId, [row.id]);
  return toPurchaseOrder(row, statuses.get(row.id) ?? null);
}

/** Reads: any purchasing permission at the outlet, else PERMISSION_DENIED. */
export function requireAnyPurchasingPermission(
  snapshot: AccessSnapshot,
  outletId: string,
): void {
  const allowed = PURCHASING_READ_PERMISSIONS.some((permission) =>
    snapshot.allows(permission, outletTarget(outletId)),
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
}

/**
 * Separation of duties: only the person who created a document may change or
 * submit it. Otherwise B could edit A's draft and then approve it as the
 * "different" person. Denied with the existing PERMISSION_DENIED (403).
 */
export function assertDocumentOwner(
  ownerUserId: string,
  actorUserId: string,
): void {
  if (ownerUserId.toLowerCase() !== actorUserId.toLowerCase())
    throw new AccessError(
      "PERMISSION_DENIED",
      "Only the creator of this document can change or submit it.",
    );
}

/**
 * Close / cancel (founder Q11): only the document creator (holding the
 * document's create permission) or a holder of `purchasing.order.approve` at
 * the outlet. Anyone else is denied with PERMISSION_DENIED (403).
 */
export async function requireCreatorOrApprover(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  ownerUserId: string,
  createPermission: PermissionCode,
  outletId: string,
): Promise<void> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  const target = outletTarget(outletId);
  const isOwner = ownerUserId.toLowerCase() === actorUserId.toLowerCase();
  if (
    (isOwner && snapshot.allows(createPermission, target)) ||
    snapshot.allows("purchasing.order.approve", target)
  )
    return;
  throw new AccessError(
    "PERMISSION_DENIED",
    "Only the creator of this document or an approver can cancel or close it.",
  );
}

/** Audit row for an effect the system applied (no human actor). */
export async function recordSystemPurchasingAudit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    action: string;
    objectType: string;
    objectId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    safeFields: readonly string[];
    reason: string | null;
  },
): Promise<void> {
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason,
      maskedChanges: {
        before: maskAuditChanges(input.before, input.safeFields),
        after: maskAuditChanges(input.after, input.safeFields),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    input.safeFields,
  );
}

// ---------------------------------------------------------- idempotency

export type PurchasingClaim = {
  operation: string;
  key: string;
  fingerprint: string;
  outletId: string | null;
};

async function findClaim(
  tx: Tx,
  context: ScopedTenantContext,
  claim: PurchasingClaim,
) {
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
  claim: PurchasingClaim,
): { replay: unknown } {
  if (row.requestFingerprint !== claim.fingerprint || row.response === null)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return { replay: row.response };
}

/**
 * Claims the key inside the caller's transaction before any write. Returns the
 * stored response for a replay (same fingerprint), throws
 * IDEMPOTENCY_KEY_REUSED for a different request, or null when this
 * transaction now owns the key.
 */
export async function claimPurchasingIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: PurchasingClaim,
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
  if (!winner)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return replayOf(winner, claim);
}

export async function completePurchasingIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: PurchasingClaim,
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

// -------------------------------------------------------------- approval

/**
 * Opens the approval chain for a submitted document. Returns the chain id when
 * the matrix requires approval, null when the document is approved manually
 * through the module transition (the matrix asks for none at this amount). A
 * missing or broken policy is not a fallback: the AccessError
 * APPROVAL_POLICY_MISSING propagates (HTTP 409, fail closed).
 */
export async function openPurchasingApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    objectType: PurchasingApprovalObject;
    objectId: string;
    amountIdr: number | null;
    outletId: string;
    requestedBy: string;
    requestReason: string;
    payload: Record<string, unknown>;
  },
): Promise<string | null> {
  const opened = await openApprovalRequest(tx, context, {
    sourceModule: PURCHASING_SOURCE_MODULE,
    actionType: input.objectType,
    objectType: input.objectType,
    objectId: input.objectId,
    amountIdr: input.amountIdr,
    outletId: input.outletId,
    requestedBy: input.requestedBy,
    source: "user",
    requestReason: input.requestReason,
    payload: input.payload,
  });
  return opened.required ? opened.chainId : null;
}

/** The module decision is refused while an approval chain decides. */
export function refuseWhenChainOpen(chainId: string | null): void {
  if (chainId !== null)
    throw new HttpError(
      409,
      "CONFLICT",
      "This document is decided in the approvals inbox.",
    );
}

// ---------------------------------------------------------------- events

async function nextSequence(
  tx: Tx,
  tenantId: string,
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
        eq(domainEventOutbox.aggregateType, "purchase_order"),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Appends one catalogued purchase order event in the caller's transaction. */
export async function appendPurchaseOrderEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    name: Extract<
      PurchasingEventName,
      "purchase_order.created" | "purchase_order.approved"
    >;
    purchaseOrderId: string;
    outletId: string;
    actorUserId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    input.purchaseOrderId,
  );
  const event = purchasingEvents[input.name].envelopeSchema.parse({
    id: createUlid(input.occurredAt.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: input.name,
    version: 1,
    aggregateType: "purchase_order",
    aggregateId: input.purchaseOrderId,
    sequence,
    occurredAt: input.occurredAt.toISOString(),
    actor: { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: `${input.name}:${input.purchaseOrderId}:${sequence}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}
