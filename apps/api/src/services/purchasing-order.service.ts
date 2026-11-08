// Purchase orders (PRD v1.7 §3.18, §4 Alur I step 2; §6 E `purchase_orders`;
// bead legend-9yz slice D).
//
// - Numbering `PO/<YYYYMM>/<0001>` from `purchasing_document_sequences`
//   (UPSERT ... RETURNING, period of the outlet business date).
// - The server computes line totals and header totals (`taxIdr` = 0 until the
//   tax contract is wired) and overwrites `source` from the actor (session
//   user: `user`).
// - Creating from a purchase request needs that PR `approved` at the same
//   outlet and marks it `converted` in the same transaction.
// - State changes only through the contract `transitionPurchaseOrder`.
//   `submit` opens an approval chain when the matrix asks for one (amount =
//   total); with a chain open the module approve/reject is refused (409
//   CONFLICT) and `settlePurchaseOrderForApproval` applies the outcome from
//   the `approval.resolved` consumer. Without a chain the module approves
//   manually (`purchasing.order.approve`, never the creator). `reject` returns
//   the PO to `draft`.
// - Events `purchase_order.created` / `purchase_order.approved` go through the
//   transactional outbox.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import {
  businessDateOf,
  CoreError,
  encodeCursor,
  formatDecimal4,
  idr,
  parseDecimal4,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertPurchaseOrderApproval,
  purchaseOrderDetailSchema,
  purchaseOrderLineTotalIdr,
  purchaseOrderSchema,
  purchaseOrderTotals,
  transitionPurchaseOrder,
  transitionPurchaseRequest,
  type createPurchaseOrderInputSchema,
  type purchaseOrderQuerySchema,
  type PurchaseOrder,
  type PurchaseOrderAction,
  type PurchaseOrderDetail,
  type transitionPurchaseOrderInputSchema,
  type updatePurchaseOrderInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import {
  purchaseOrderLines,
  purchaseOrders,
  purchasingDocumentSequences,
  suppliers,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  loadOutletClock,
  outletTarget,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  ROUNDING_MODE,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  cancelApprovalRequest,
  getApprovalChainOutcome,
} from "./platform-approval.service.ts";
import {
  appendPurchaseOrderEvent,
  assertDocumentOwner,
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  openPurchasingApproval,
  PURCHASING_SOURCE_MODULE,
  recordSystemPurchasingAudit,
  refuseWhenChainOpen,
  requireAnyPurchasingPermission,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";
import {
  assertItemsAndUoms,
  lockApprovedRequest,
  markRequestConverted,
} from "./purchasing-request.service.ts";

export type CreatePurchaseOrderInput = z.infer<
  typeof createPurchaseOrderInputSchema
>;
export type UpdatePurchaseOrderInput = z.infer<
  typeof updatePurchaseOrderInputSchema
>;
export type TransitionPurchaseOrderInput = z.infer<
  typeof transitionPurchaseOrderInputSchema
>;
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;

const CREATE_OPERATION = "purchase_order.create";
const TRANSITION_OPERATION = "purchase_order.transition";
const AUDIT_FIELDS = [
  "number",
  "status",
  "supplierId",
  "expectedDate",
  "subtotalIdr",
  "taxIdr",
  "totalIdr",
  "source",
  "approvedBy",
  "approvedAt",
] as const;
/** Tax contract not wired yet: purchasing never invents a rate. */
const TAX_IDR = idr(0);

type OrderRow = typeof purchaseOrders.$inferSelect;
type LineRow = typeof purchaseOrderLines.$inferSelect;

export function toPurchaseOrder(row: OrderRow): PurchaseOrder {
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
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentTo: row.sentTo,
    closedAt: row.closedAt?.toISOString() ?? null,
    note: row.note,
  });
}

function toLine(row: LineRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    purchaseOrderId: row.purchaseOrderId,
    inventoryItemId: row.inventoryItemId,
    quantity: row.quantity,
    uomId: row.uomId,
    unitPriceIdr: row.unitPriceIdr,
    lineTotalIdr: row.lineTotalIdr,
  };
}

async function loadLines(tx: Tx, orderId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, orderId))
    .orderBy(asc(purchaseOrderLines.lineNo));
}

async function detailOf(tx: Tx, row: OrderRow): Promise<PurchaseOrderDetail> {
  return purchaseOrderDetailSchema.parse({
    purchaseOrder: toPurchaseOrder(row),
    lines: (await loadLines(tx, row.id)).map(toLine),
  });
}

async function requireActiveSupplier(tx: Tx, supplierId: string) {
  const [supplier] = await tx
    .select({ id: suppliers.id, isActive: suppliers.isActive })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId));
  if (!supplier) throw new HttpError(404, "NOT_FOUND", "Supplier not found.");
  if (!supplier.isActive)
    throw new HttpError(422, "VALIDATION_ERROR", "Supplier is not active.");
}

type LineInput = CreatePurchaseOrderInput["lines"][number];

function priceLines(lines: readonly LineInput[]) {
  return lines.map((line, index) => ({
    inventoryItemId: line.inventoryItemId,
    quantity: line.quantity,
    uomId: line.uomId,
    unitPriceIdr: line.unitPriceIdr,
    lineTotalIdr: purchaseOrderLineTotalIdr(
      line.quantity,
      line.unitPriceIdr,
      ROUNDING_MODE,
    ),
    lineNo: index + 1,
  }));
}

function canonicalLines(lines: readonly LineInput[]) {
  return lines.map((line) => ({
    inventoryItemId: line.inventoryItemId,
    quantity: formatDecimal4(parseDecimal4(line.quantity)),
    uomId: line.uomId,
    unitPriceIdr: formatDecimal4(parseDecimal4(line.unitPriceIdr)),
  }));
}

/** `PO/<YYYYMM>/<0001>`: next value of the tenant's monthly counter. */
async function nextPoNumber(
  tx: Tx,
  context: ScopedTenantContext,
  businessDate: string,
): Promise<string> {
  const period = `${businessDate.slice(0, 4)}${businessDate.slice(5, 7)}`;
  const [row] = await tx
    .insert(purchasingDocumentSequences)
    .values({
      tenantId: context.tenant.tenantId,
      kind: "PO",
      period,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [
        purchasingDocumentSequences.tenantId,
        purchasingDocumentSequences.kind,
        purchasingDocumentSequences.period,
      ],
      set: {
        lastValue: sql`${purchasingDocumentSequences.lastValue} + 1`,
      },
    })
    .returning({ value: purchasingDocumentSequences.lastValue });
  return `PO/${period}/${String(row!.value).padStart(4, "0")}`;
}

/**
 * POST purchase order (draft). Needs `purchasing.order.create` at the outlet.
 * With `purchaseRequestId`, that PR must be `approved` at the same outlet and
 * becomes `converted` in this transaction.
 */
export async function createPurchaseOrder(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderDetail> {
  assertOutlet(context, input.outletId);
  const claim = {
    operation: CREATE_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(CREATE_OPERATION, actorUserId, {
      outletId: input.outletId,
      supplierId: input.supplierId,
      purchaseRequestId: input.purchaseRequestId ?? null,
      expectedDate: input.expectedDate,
      note: input.note ?? null,
      lines: canonicalLines(input.lines),
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        "purchasing.order.create",
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchaseOrderDetailSchema.parse(replay.replay);
      await requireActiveSupplier(tx, input.supplierId);
      await assertItemsAndUoms(tx, input.lines);
      const now = new Date();
      if (input.purchaseRequestId) {
        const request = await lockApprovedRequest(
          tx,
          context,
          input.purchaseRequestId,
        );
        if (request.outletId.toLowerCase() !== input.outletId.toLowerCase())
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "The purchase request belongs to another outlet.",
          );
        // Throws PURCHASE_REQUEST_INVALID_TRANSITION unless `approved`.
        transitionPurchaseRequest(request.status, "convert");
        await markRequestConverted(tx, request, now);
      }
      const lines = priceLines(input.lines);
      const totals = purchaseOrderTotals(lines, TAX_IDR, ROUNDING_MODE);
      const businessDate = businessDateOf(
        now,
        await loadOutletClock(tx, input.outletId),
      );
      const number = await nextPoNumber(tx, context, businessDate);
      const id = randomUUID();
      const [row] = await tx
        .insert(purchaseOrders)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          supplierId: input.supplierId,
          number,
          purchaseRequestId: input.purchaseRequestId ?? null,
          status: "draft",
          expectedDate: input.expectedDate,
          subtotalIdr: totals.subtotalIdr,
          taxIdr: totals.taxIdr,
          totalIdr: totals.totalIdr,
          // The actor is a session user; AI / MCP callers set their own.
          source: "user",
          createdBy: actorUserId,
          note: input.note ?? null,
        })
        .returning();
      await tx.insert(purchaseOrderLines).values(
        lines.map((line) => ({
          ...line,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          purchaseOrderId: id,
        })),
      );
      const detail = await detailOf(tx, row!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: input.outletId,
        action: "purchasing.order_created",
        objectType: "purchase_order",
        objectId: id,
        before: null,
        after: detail.purchaseOrder,
        safeFields: AUDIT_FIELDS,
      });
      await appendPurchaseOrderEvent(tx, context, {
        name: "purchase_order.created",
        purchaseOrderId: id,
        outletId: input.outletId,
        actorUserId,
        occurredAt: now,
        payload: {
          purchaseOrderId: id,
          supplierId: row!.supplierId,
          outletId: input.outletId,
          number,
          source: "user",
          totalIdr: totals.totalIdr,
          createdBy: actorUserId,
          createdAt: row!.createdAt.toISOString(),
        },
      });
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translatePurchasingError(error);
  }
}

/** PATCH a draft PO (supplier, date, lines, note). Needs `order.create`. */
export async function updatePurchaseOrder(
  context: ScopedTenantContext,
  actorUserId: string,
  orderId: string,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrderDetail> {
  try {
    return await withTenant(db, context, async (tx) => {
      const row = await lockOrder(tx, context, orderId);
      assertOutlet(context, row.outletId);
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        "purchasing.order.create",
        row.outletId,
      );
      assertDocumentOwner(row.createdBy, actorUserId);
      if (row.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt))
        throw new CoreError(
          "PRECONDITION_FAILED",
          "The purchase order changed; reload it.",
        );
      if (row.status !== "draft")
        throw new HttpError(
          409,
          "PURCHASE_ORDER_INVALID_TRANSITION",
          `Only a draft purchase order can change, not ${row.status}`,
        );
      const now = new Date();
      const patch: Partial<typeof purchaseOrders.$inferInsert> = {
        updatedAt: now,
      };
      if (input.supplierId !== undefined) {
        await requireActiveSupplier(tx, input.supplierId);
        patch.supplierId = input.supplierId;
      }
      if (input.expectedDate !== undefined)
        patch.expectedDate = input.expectedDate;
      if (input.note !== undefined) patch.note = input.note ?? null;
      if (input.lines !== undefined) {
        await assertItemsAndUoms(tx, input.lines);
        const lines = priceLines(input.lines);
        const totals = purchaseOrderTotals(lines, TAX_IDR, ROUNDING_MODE);
        await tx
          .delete(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, row.id));
        await tx.insert(purchaseOrderLines).values(
          lines.map((line) => ({
            ...line,
            tenantId: context.tenant.tenantId,
            outletId: row.outletId,
            purchaseOrderId: row.id,
          })),
        );
        patch.subtotalIdr = totals.subtotalIdr;
        patch.taxIdr = totals.taxIdr;
        patch.totalIdr = totals.totalIdr;
      }
      const [updated] = await tx
        .update(purchaseOrders)
        .set(patch)
        .where(eq(purchaseOrders.id, row.id))
        .returning();
      const detail = await detailOf(tx, updated!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: row.outletId,
        action: "purchasing.order_updated",
        objectType: "purchase_order",
        objectId: row.id,
        before: toPurchaseOrder(row),
        after: detail.purchaseOrder,
        safeFields: AUDIT_FIELDS,
      });
      return detail;
    });
  } catch (error) {
    throw translatePurchasingError(error);
  }
}

async function lockOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<OrderRow> {
  const [row] = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.tenantId, context.tenant.tenantId),
        eq(purchaseOrders.id, orderId),
      ),
    )
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
  return row;
}

/** GET purchase orders of one outlet, newest first. */
export async function listPurchaseOrders(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PurchaseOrderQuery,
): Promise<CursorPage<PurchaseOrder>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    requireAnyPurchasingPermission(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      query.outletId,
    );
    const filters: SQL[] = [eq(purchaseOrders.outletId, query.outletId)];
    if (query.status) filters.push(eq(purchaseOrders.status, query.status));
    if (query.supplierId)
      filters.push(eq(purchaseOrders.supplierId, query.supplierId));
    const [createdAt, id] = cursorKeys(query.cursor, 2);
    if (createdAt !== undefined && id !== undefined) {
      const at = cursorInstant(createdAt);
      filters.push(
        or(
          lt(purchaseOrders.createdAt, at),
          and(
            eq(purchaseOrders.createdAt, at),
            sql`${purchaseOrders.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(purchaseOrders)
      .where(and(...filters))
      .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPurchaseOrder),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET one purchase order with lines; another outlet or tenant is a 404. */
export async function getPurchaseOrder(
  context: ScopedTenantContext,
  actorUserId: string,
  orderId: string,
): Promise<PurchaseOrderDetail> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, context.tenant.tenantId),
          eq(purchaseOrders.id, orderId),
        ),
      );
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
    requireAnyPurchasingPermission(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      row.outletId,
    );
    return detailOf(tx, row);
  });
}

const ACTION_PERMISSION = {
  submit: "purchasing.order.create",
  close: "purchasing.order.create",
  cancel: "purchasing.order.create",
  approve: "purchasing.order.approve",
  reject: "purchasing.order.approve",
} as const;

/** Permission the route gate needs for one client action. */
export function purchaseOrderActionPermission(
  action: TransitionPurchaseOrderInput["action"],
) {
  return ACTION_PERMISSION[action];
}

async function appendApproved(
  tx: Tx,
  context: ScopedTenantContext,
  row: OrderRow,
  approverId: string,
  now: Date,
): Promise<void> {
  await appendPurchaseOrderEvent(tx, context, {
    name: "purchase_order.approved",
    purchaseOrderId: row.id,
    outletId: row.outletId,
    actorUserId: approverId,
    occurredAt: now,
    payload: {
      purchaseOrderId: row.id,
      supplierId: row.supplierId,
      number: row.number,
      totalIdr: row.totalIdr,
      approvedBy: approverId,
      approvedAt: now.toISOString(),
    },
  });
}

/**
 * POST transition (submit, approve, reject, close, cancel). `receive_*` and
 * `send` are applied by the goods-receipt and send services.
 */
export async function transitionPurchaseOrderStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  orderId: string,
  input: TransitionPurchaseOrderInput,
): Promise<PurchaseOrder> {
  const note = input.note?.trim() ? input.note.trim() : null;
  const claim = {
    operation: TRANSITION_OPERATION,
    key: input.idempotencyKey,
    outletId: null,
    fingerprint: requestFingerprint(TRANSITION_OPERATION, actorUserId, {
      orderId: orderId.toLowerCase(),
      action: input.action,
      note,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchaseOrderSchema.parse(replay.replay);
      const row = await lockOrder(tx, context, orderId);
      assertOutlet(context, row.outletId);
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        ACTION_PERMISSION[input.action],
        row.outletId,
      );
      const now = new Date();
      const action: PurchaseOrderAction = input.action;
      const patch: Partial<typeof purchaseOrders.$inferInsert> = {
        updatedAt: now,
      };
      let approvedNow = false;
      switch (input.action) {
        case "submit": {
          assertDocumentOwner(row.createdBy, actorUserId);
          patch.status = transitionPurchaseOrder(row.status, "submit");
          patch.approvalChainId = await openPurchasingApproval(tx, context, {
            objectType: "purchase_order",
            objectId: row.id,
            amountIdr: row.totalIdr,
            outletId: row.outletId,
            requestedBy: actorUserId,
            requestReason: `Purchase order ${row.number}`,
            payload: { number: row.number, supplierId: row.supplierId },
          });
          break;
        }
        case "approve": {
          refuseWhenChainOpen(row.approvalChainId);
          assertPurchaseOrderApproval(
            {
              status: row.status,
              createdBy: userIdSchema.parse(row.createdBy),
            },
            actorUserId,
          );
          patch.status = transitionPurchaseOrder(row.status, "approve");
          patch.approvedBy = actorUserId;
          patch.approvedAt = now;
          approvedNow = true;
          break;
        }
        case "reject": {
          refuseWhenChainOpen(row.approvalChainId);
          assertPurchaseOrderApproval(
            {
              status: row.status,
              createdBy: userIdSchema.parse(row.createdBy),
            },
            actorUserId,
          );
          patch.status = transitionPurchaseOrder(row.status, "reject");
          patch.approvalChainId = null;
          break;
        }
        case "close": {
          patch.status = transitionPurchaseOrder(row.status, "close");
          patch.closedAt = now;
          break;
        }
        case "cancel": {
          patch.status = transitionPurchaseOrder(row.status, "cancel");
          if (row.approvalChainId !== null && row.status === "pending_approval")
            await cancelApprovalRequest(tx, context, {
              chainId: row.approvalChainId,
              sourceModule: PURCHASING_SOURCE_MODULE,
              actorUserId,
              now,
            });
          break;
        }
      }
      const [updated] = await tx
        .update(purchaseOrders)
        .set(patch)
        .where(
          and(
            eq(purchaseOrders.id, row.id),
            eq(purchaseOrders.status, row.status),
          ),
        )
        .returning();
      if (!updated)
        throw new HttpError(409, "CONFLICT", "The order changed; retry.");
      const result = toPurchaseOrder(updated);
      if (approvedNow)
        await appendApproved(tx, context, updated, actorUserId, now);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: row.outletId,
        action: `purchasing.order_${action}`,
        objectType: "purchase_order",
        objectId: row.id,
        before: { status: row.status },
        after: result,
        safeFields: AUDIT_FIELDS,
        reason: note,
      });
      await completePurchasingIdempotency(tx, context, claim, result);
      return result;
    });
  } catch (error) {
    throw translatePurchasingError(error);
  }
}

/**
 * Consumer entry point for `approval.resolved` (sourceModule `purchasing`,
 * objectType `purchase_order`): applies the chain outcome to the PO that owns
 * it. The database is the authority (outcome and final approver re-read under
 * the row lock). Approved needs an approver who is not the creator and holds
 * `purchasing.order.approve` at the outlet, else the PO returns to `draft`
 * (fail closed). Rejected, expired or cancelled also return it to `draft`.
 * Idempotent: a PO no longer pending is returned unchanged.
 */
export async function settlePurchaseOrderForApproval(
  context: ScopedTenantContext,
  chainId: string,
  now = new Date(),
): Promise<PurchaseOrder | null> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, context.tenant.tenantId),
          eq(purchaseOrders.approvalChainId, chainId),
        ),
      )
      .for("update");
    if (!row) return null;
    if (row.status !== "pending_approval") return toPurchaseOrder(row);
    const outcome = await getApprovalChainOutcome(tx, {
      chainId,
      sourceModule: PURCHASING_SOURCE_MODULE,
    });
    if (outcome === "pending") return toPurchaseOrder(row);
    // Every level's decider is checked: a creator who decided any level
    // taints the chain (fail closed, the PO returns to draft).
    const levels = await tx
      .select({ decidedBy: approvalRequests.decidedBy })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.chainId, chainId),
        ),
      )
      .orderBy(asc(approvalRequests.level));
    const approver = levels.at(-1)?.decidedBy ?? null;
    const creatorDecided = levels.some(
      (level) =>
        level.decidedBy !== null &&
        level.decidedBy.toLowerCase() === row.createdBy.toLowerCase(),
    );
    let approved = false;
    if (outcome === "approved" && approver !== null && !creatorDecided) {
      const snapshot = await accessSnapshotInTransaction(
        tx,
        context,
        approver,
        now,
      );
      approved = snapshot.allows(
        "purchasing.order.approve",
        outletTarget(row.outletId),
      );
    }
    const [updated] = await tx
      .update(purchaseOrders)
      .set(
        approved
          ? {
              status: transitionPurchaseOrder(row.status, "approve"),
              approvedBy: approver,
              approvedAt: now,
              updatedAt: now,
            }
          : {
              status: transitionPurchaseOrder(row.status, "reject"),
              approvalChainId: null,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(purchaseOrders.id, row.id),
          eq(purchaseOrders.status, "pending_approval"),
        ),
      )
      .returning();
    if (!updated) throw new Error("purchase order changed under its lock");
    if (approved && approver !== null)
      await appendApproved(tx, context, updated, approver, now);
    const result = toPurchaseOrder(updated);
    const audit = {
      outletId: row.outletId,
      action: approved ? "purchasing.order_approve" : "purchasing.order_reject",
      objectType: "purchase_order",
      objectId: row.id,
      before: { status: row.status },
      after: result,
      safeFields: AUDIT_FIELDS,
      reason: approved ? null : `approval_${outcome}`,
    };
    // A human decided approved/rejected; expired and cancelled chains are the
    // system's own effect.
    if (approver !== null && (outcome === "approved" || outcome === "rejected"))
      await recordOpsAudit(tx, context, { ...audit, actorUserId: approver });
    else await recordSystemPurchasingAudit(tx, context, audit);
    return result;
  });
}
