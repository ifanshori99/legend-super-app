// Purchase requests (PRD v1.7 §3.18, §4 Alur I step 1-2; §6 E
// `purchase_requests`; bead legend-9yz slice D).
//
// - State changes only through the contract `transitionPurchaseRequest`; a
//   PurchasingError answers HTTP 409 with its code.
// - `submit` opens an approval chain when the matrix asks for one (amount =
//   estimate from active supplier prices of today, null when a line has no
//   price: every tier applies). With a chain open the module approve/reject is
//   refused (409 CONFLICT) and `settlePurchaseRequestForApproval` applies the
//   outcome from the `approval.resolved` consumer. When the matrix asks for
//   none at this amount the module approves manually (`purchasing.order.approve`,
//   never the requester). No policy for the action (or a broken one) refuses
//   submit with 409 APPROVAL_POLICY_MISSING.
// - `cancel`: only the requester (with `purchasing.request.create`) or a holder
//   of `purchasing.order.approve` at the outlet; others get 403.
// - Every create/transition is bound to its idempotency key and request
//   fingerprint (`purchasing_idempotency`).

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  businessDateOf,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertPurchaseRequestApproval,
  purchaseRequestDetailSchema,
  purchaseRequestEstimateIdr,
  purchaseRequestSchema,
  PurchasingError,
  transitionPurchaseRequest,
  type createPurchaseRequestInputSchema,
  type PurchaseRequest,
  type PurchaseRequestDetail,
  type PurchaseRequestAction,
  type purchaseRequestQuerySchema,
  type transitionPurchaseRequestInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { inventoryItems, uoms } from "../db/schema/inventory.ts";
import {
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  supplierPrices,
} from "../db/schema/purchasing.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
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
import {
  assertDocumentOwner,
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  guardMoneyMath,
  openPurchasingApproval,
  requireCreatorOrApprover,
  PURCHASING_SOURCE_MODULE,
  refuseWhenChainOpen,
  requireAnyPurchasingPermission,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  cancelApprovalRequest,
  getApprovalChainOutcome,
} from "./platform-approval.service.ts";

export type CreatePurchaseRequestInput = z.infer<
  typeof createPurchaseRequestInputSchema
>;
export type TransitionPurchaseRequestInput = z.infer<
  typeof transitionPurchaseRequestInputSchema
>;
export type PurchaseRequestQuery = z.infer<typeof purchaseRequestQuerySchema>;

const CREATE_OPERATION = "purchase_request.create";
const TRANSITION_OPERATION = "purchase_request.transition";
const AUDIT_FIELDS = [
  "status",
  "neededBy",
  "decidedBy",
  "decidedAt",
  "decisionNote",
] as const;

type RequestRow = typeof purchaseRequests.$inferSelect;
type LineRow = typeof purchaseRequestLines.$inferSelect;

export function toPurchaseRequest(row: RequestRow): PurchaseRequest {
  return purchaseRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    requestedBy: row.requestedBy,
    status: row.status,
    neededBy: row.neededBy,
    note: row.note,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toLine(row: LineRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    purchaseRequestId: row.purchaseRequestId,
    inventoryItemId: row.inventoryItemId,
    quantity: row.quantity,
    uomId: row.uomId,
  };
}

async function loadLines(tx: Tx, requestId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(purchaseRequestLines)
    .where(eq(purchaseRequestLines.purchaseRequestId, requestId))
    .orderBy(purchaseRequestLines.id);
}

/** Items and UOMs must exist in the tenant (RLS scopes the lookup). */
export async function assertItemsAndUoms(
  tx: Tx,
  lines: readonly { inventoryItemId: string; uomId: string }[],
): Promise<void> {
  const itemIds = [...new Set(lines.map((line) => line.inventoryItemId))];
  const uomIds = [...new Set(lines.map((line) => line.uomId))];
  const items = await tx
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, itemIds));
  if (items.length !== itemIds.length)
    throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
  const units = await tx
    .select({ id: uoms.id })
    .from(uoms)
    .where(inArray(uoms.id, uomIds));
  if (units.length !== uomIds.length)
    throw new HttpError(404, "NOT_FOUND", "Unit of measure not found.");
}

/**
 * Estimated PR value in whole rupiah from the active supplier prices on
 * `onDate`: per item the highest current price among suppliers quoting the
 * line's own unit (conservative: a higher estimate can only add approval
 * tiers). Null when any line has no such price (fail closed).
 */
export async function estimatePurchaseRequest(
  tx: Tx,
  lines: readonly {
    inventoryItemId: string;
    quantity: string;
    uomId: string;
  }[],
  onDate: string,
): Promise<number | null> {
  const itemIds = [...new Set(lines.map((line) => line.inventoryItemId))];
  const prices = await tx
    .select()
    .from(supplierPrices)
    .where(
      and(
        inArray(supplierPrices.inventoryItemId, itemIds),
        eq(supplierPrices.isActive, true),
        lte(supplierPrices.effectiveFrom, onDate),
      ),
    )
    .orderBy(
      desc(supplierPrices.effectiveFrom),
      desc(supplierPrices.createdAt),
    );
  // Latest row per (supplier, item, unit), then the highest across suppliers.
  const current = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const price of prices) {
    const key = `${price.supplierId}|${price.inventoryItemId}|${price.purchaseUomId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const itemKey = `${price.inventoryItemId}|${price.purchaseUomId}`;
    const value = parseDecimal4(price.priceIdr);
    const best = current.get(itemKey);
    if (best === undefined || value > best) current.set(itemKey, value);
  }
  const priced: { quantity: never; unitPriceIdr: never }[] = [];
  for (const line of lines) {
    const best = current.get(`${line.inventoryItemId}|${line.uomId}`);
    if (best === undefined) return null;
    priced.push({
      quantity: line.quantity as never,
      unitPriceIdr: formatDecimal4(best) as never,
    });
  }
  return guardMoneyMath(() =>
    purchaseRequestEstimateIdr(priced, ROUNDING_MODE),
  );
}

async function todayOf(tx: Tx, outletId: string, now: Date): Promise<string> {
  return businessDateOf(now, await loadOutletClock(tx, outletId));
}

/** POST purchase request (draft). Needs `purchasing.request.create`. */
export async function createPurchaseRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePurchaseRequestInput,
): Promise<PurchaseRequestDetail> {
  assertOutlet(context, input.outletId);
  const claim = {
    operation: CREATE_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(CREATE_OPERATION, actorUserId, {
      outletId: input.outletId,
      neededBy: input.neededBy,
      note: input.note ?? null,
      lines: input.lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: formatDecimal4(parseDecimal4(line.quantity)),
        uomId: line.uomId,
      })),
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        "purchasing.request.create",
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchaseRequestDetailSchema.parse(replay.replay);
      await assertItemsAndUoms(tx, input.lines);
      const id = randomUUID();
      const [row] = await tx
        .insert(purchaseRequests)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          requestedBy: actorUserId,
          status: "draft",
          neededBy: input.neededBy,
          note: input.note ?? null,
        })
        .returning();
      const lineRows = await tx
        .insert(purchaseRequestLines)
        .values(
          input.lines.map((line) => ({
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            purchaseRequestId: id,
            inventoryItemId: line.inventoryItemId,
            quantity: line.quantity,
            uomId: line.uomId,
          })),
        )
        .returning();
      const detail = purchaseRequestDetailSchema.parse({
        request: toPurchaseRequest(row!),
        lines: lineRows.map(toLine),
      });
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: input.outletId,
        action: "purchasing.request_created",
        objectType: "purchase_request",
        objectId: id,
        before: null,
        after: detail.request,
        safeFields: AUDIT_FIELDS,
      });
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translatePurchasingError(error);
  }
}

/** GET purchase requests of one outlet, newest first. */
export async function listPurchaseRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PurchaseRequestQuery,
): Promise<CursorPage<PurchaseRequest>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    requireAnyPurchasingPermission(snapshot, query.outletId);
    const filters: SQL[] = [eq(purchaseRequests.outletId, query.outletId)];
    if (query.status) filters.push(eq(purchaseRequests.status, query.status));
    const [createdAt, id] = cursorKeys(query.cursor, 2);
    if (createdAt !== undefined && id !== undefined) {
      const at = cursorInstant(createdAt);
      filters.push(
        or(
          lt(purchaseRequests.createdAt, at),
          and(
            eq(purchaseRequests.createdAt, at),
            sql`${purchaseRequests.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(purchaseRequests)
      .where(and(...filters))
      .orderBy(desc(purchaseRequests.createdAt), desc(purchaseRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPurchaseRequest),
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

/** GET one purchase request with lines; another outlet or tenant is a 404. */
export async function getPurchaseRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  requestId: string,
): Promise<PurchaseRequestDetail> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchaseRequests)
      .where(
        and(
          eq(purchaseRequests.tenantId, context.tenant.tenantId),
          eq(purchaseRequests.id, requestId),
        ),
      );
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Purchase request not found.");
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    requireAnyPurchasingPermission(snapshot, row.outletId);
    return purchaseRequestDetailSchema.parse({
      request: toPurchaseRequest(row),
      lines: (await loadLines(tx, row.id)).map(toLine),
    });
  });
}

const ACTION_PERMISSION = {
  submit: "purchasing.request.create",
  cancel: "purchasing.request.create",
  approve: "purchasing.order.approve",
  reject: "purchasing.order.approve",
  convert: "purchasing.order.create",
} as const satisfies Record<PurchaseRequestAction, string>;

/** Permission the route gate needs for one action (the service re-checks). */
export function purchaseRequestActionPermission(action: PurchaseRequestAction) {
  return ACTION_PERMISSION[action];
}

/**
 * POST transition. Needs the action's permission at the request's outlet
 * (submit `purchasing.request.create`, cancel: requester or approver, approve/reject
 * `purchasing.order.approve`, convert `purchasing.order.create`).
 */
export async function transitionPurchaseRequestStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  requestId: string,
  input: TransitionPurchaseRequestInput,
): Promise<PurchaseRequest> {
  const note = input.note?.trim() ? input.note.trim() : null;
  const claimBase = {
    operation: TRANSITION_OPERATION,
    key: input.idempotencyKey,
    fingerprint: requestFingerprint(TRANSITION_OPERATION, actorUserId, {
      requestId: requestId.toLowerCase(),
      action: input.action,
      note,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(purchaseRequests)
        .where(
          and(
            eq(purchaseRequests.tenantId, context.tenant.tenantId),
            eq(purchaseRequests.id, requestId),
          ),
        )
        .for("update");
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "Purchase request not found.");
      assertOutlet(context, row.outletId);
      if (input.action === "cancel")
        await requireCreatorOrApprover(
          tx,
          context,
          actorUserId,
          row.requestedBy,
          ACTION_PERMISSION[input.action],
          row.outletId,
        );
      else
        await requireOpsPermission(
          tx,
          context,
          actorUserId,
          ACTION_PERMISSION[input.action],
          row.outletId,
        );
      // Claimed only after the lock and the access checks: a replay by a caller
      // without access is refused, never answered from the stored response.
      const claim = { ...claimBase, outletId: row.outletId };
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchaseRequestSchema.parse(replay.replay);
      const now = new Date();
      const patch: Partial<typeof purchaseRequests.$inferInsert> = {
        updatedAt: now,
      };
      switch (input.action) {
        case "submit": {
          assertDocumentOwner(row.requestedBy, actorUserId);
          patch.status = transitionPurchaseRequest(row.status, "submit");
          const lines = await loadLines(tx, row.id);
          const estimate = await estimatePurchaseRequest(
            tx,
            lines,
            await todayOf(tx, row.outletId, now),
          );
          patch.approvalChainId = await openPurchasingApproval(tx, context, {
            objectType: "purchase_request",
            objectId: row.id,
            amountIdr: estimate,
            outletId: row.outletId,
            requestedBy: actorUserId,
            requestReason: "Purchase request approval",
            payload: { lines: lines.length },
          });
          break;
        }
        case "approve":
        case "reject": {
          refuseWhenChainOpen(row.approvalChainId);
          assertPurchaseRequestApproval(
            {
              status: row.status,
              requestedBy: userIdSchema.parse(row.requestedBy),
            },
            actorUserId,
          );
          if (input.action === "reject" && note === null)
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              "A rejected purchase request needs a reason.",
            );
          patch.status = transitionPurchaseRequest(row.status, input.action);
          patch.decidedBy = actorUserId;
          patch.decidedAt = now;
          patch.decisionNote = note;
          break;
        }
        case "cancel": {
          patch.status = transitionPurchaseRequest(row.status, "cancel");
          if (row.approvalChainId !== null)
            await cancelApprovalRequest(tx, context, {
              chainId: row.approvalChainId,
              sourceModule: PURCHASING_SOURCE_MODULE,
              actorUserId,
              now,
            });
          break;
        }
        case "convert": {
          patch.status = transitionPurchaseRequest(row.status, "convert");
          const [linked] = await tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(eq(purchaseOrders.purchaseRequestId, row.id))
            .limit(1);
          if (!linked)
            throw new PurchasingError(
              "PURCHASE_REQUEST_INVALID_TRANSITION",
              "Convert needs a purchase order linked to this request",
            );
          break;
        }
      }
      const [updated] = await tx
        .update(purchaseRequests)
        .set(patch)
        .where(
          and(
            eq(purchaseRequests.id, row.id),
            eq(purchaseRequests.status, row.status),
          ),
        )
        .returning();
      if (!updated)
        throw new HttpError(409, "CONFLICT", "The request changed; retry.");
      const result = toPurchaseRequest(updated);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: row.outletId,
        action: `purchasing.request_${input.action}`,
        objectType: "purchase_request",
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
 * Marks an approved PR converted inside the PO creation transaction. The
 * caller holds the row lock it got from `lockApprovedRequest`.
 */
export async function lockApprovedRequest(
  tx: Tx,
  context: ScopedTenantContext,
  requestId: string,
): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(purchaseRequests)
    .where(
      and(
        eq(purchaseRequests.tenantId, context.tenant.tenantId),
        eq(purchaseRequests.id, requestId),
      ),
    )
    .for("update");
  if (!row)
    throw new HttpError(404, "NOT_FOUND", "Purchase request not found.");
  return row;
}

export async function markRequestConverted(
  tx: Tx,
  row: RequestRow,
  now: Date,
): Promise<void> {
  const status = transitionPurchaseRequest(row.status, "convert");
  await tx
    .update(purchaseRequests)
    .set({ status, updatedAt: now })
    .where(eq(purchaseRequests.id, row.id));
}

/**
 * Consumer entry point for `approval.resolved` (sourceModule `purchasing`,
 * objectType `purchase_request`): applies the chain outcome to the PR that
 * owns it. The database, not the event, is the authority: the outcome is
 * re-read under the row lock, and an approver without
 * `purchasing.order.approve` at the outlet cannot approve (fail closed).
 * Idempotent: a PR no longer pending is returned unchanged. An expired or
 * cancelled chain, or an approver equal to the requester, leaves the PR
 * pending (the requester cancels it); nothing is approved.
 */
export async function settlePurchaseRequestForApproval(
  context: ScopedTenantContext,
  chainId: string,
  now = new Date(),
): Promise<PurchaseRequest | null> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchaseRequests)
      .where(
        and(
          eq(purchaseRequests.tenantId, context.tenant.tenantId),
          eq(purchaseRequests.approvalChainId, chainId),
        ),
      )
      .for("update");
    if (!row) return null;
    if (row.status !== "pending_approval") return toPurchaseRequest(row);
    const outcome = await getApprovalChainOutcome(tx, {
      chainId,
      sourceModule: PURCHASING_SOURCE_MODULE,
    });
    if (outcome !== "approved" && outcome !== "rejected")
      return toPurchaseRequest(row);
    // Every level's decider is checked: a requester who decided any level
    // taints the chain and nothing is applied (the PR stays pending).
    const levels = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        reason: approvalRequests.reason,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.chainId, chainId),
        ),
      )
      .orderBy(asc(approvalRequests.level));
    const last = levels.at(-1);
    const approver = last?.decidedBy ?? null;
    if (
      approver === null ||
      levels.some(
        (level) =>
          level.decidedBy !== null &&
          level.decidedBy.toLowerCase() === row.requestedBy.toLowerCase(),
      )
    )
      return toPurchaseRequest(row);
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      approver,
      now,
    );
    const permitted = snapshot.allows(
      "purchasing.order.approve",
      outletTarget(row.outletId),
    );
    const approved = outcome === "approved" && permitted;
    const decisionNote = approved
      ? null
      : !permitted
        ? "Approver lacks purchasing approval permission."
        : (last?.reason ?? "Rejected in the approvals inbox.");
    const [updated] = await tx
      .update(purchaseRequests)
      .set({
        status: transitionPurchaseRequest(
          row.status,
          approved ? "approve" : "reject",
        ),
        decidedBy: approver,
        decidedAt: now,
        decisionNote,
        updatedAt: now,
      })
      .where(
        and(
          eq(purchaseRequests.id, row.id),
          eq(purchaseRequests.status, "pending_approval"),
        ),
      )
      .returning();
    if (!updated) throw new Error("purchase request changed under its lock");
    const result = toPurchaseRequest(updated);
    await recordOpsAudit(tx, context, {
      actorUserId: approver,
      outletId: row.outletId,
      action: approved
        ? "purchasing.request_approve"
        : "purchasing.request_reject",
      objectType: "purchase_request",
      objectId: row.id,
      before: { status: row.status },
      after: result,
      safeFields: AUDIT_FIELDS,
      reason: decisionNote,
    });
    return result;
  });
}
