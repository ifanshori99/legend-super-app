// `approval.resolved` consumer for purchase requests and purchase orders sent
// through the approval matrix (bead legend-9yz slice D; PRD v1.7 §3 F7 "Kotak
// Approval", §3.7 Matriks Approval). Wired in worker-main.ts before the
// deployment's own `deliverEvent` (the engineer registers it, next to
// `handleApprovalResolved` of the POS overrides).
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains this module opened
// (sourceModule `purchasing`, objectType `purchase_request`, `purchase_order`
// or `supplier_payment`) and delegates to the settle functions, which re-read
// the chain outcome and the final approver from the database under the
// document's row lock. The event is a trigger, never the authority: a forged or stale
// "approved" event cannot approve a chain the database still has pending.
//
// - Other event names and other source modules: ignored (not ours).
// - A purchasing event of the wrong shape, another tenant, no outlet, or whose
//   chain belongs to a different document: throws, so the outbox retries and
//   finally dead-letters it. Nothing is written (fail closed).
// - Replay: settling a document that is no longer pending returns it
//   unchanged, so a redelivered event records nothing twice.

import { approvalResolvedEvent } from "@starter/shared/identity";
import {
  CoreError,
  ulidSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { purchaseOrders, purchaseRequests } from "../db/schema/purchasing.ts";
import { supplierPayments } from "../db/schema/supplier-payments.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { PURCHASING_SOURCE_MODULE } from "./purchasing-flow.shared.ts";
import { settlePurchaseOrderForApproval } from "./purchasing-order.service.ts";
import { settlePurchaseRequestForApproval } from "./purchasing-request.service.ts";
import { settleSupplierPaymentForApproval } from "./purchasing-supplier-payment.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function sourceModuleOf(event: DomainEvent): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>).sourceModule
    : undefined;
}

/** ULID or UUID spelling of one id, compared in its stored (uuid) form. */
function storedId(id: string): string {
  return ulidSchema.safeParse(id).success
    ? ulidToUuid(id).toLowerCase()
    : id.toLowerCase();
}

function refuse(message: string): never {
  // No payload, ids only in the message the outbox stores as lastError.
  throw new CoreError("VALIDATION_ERROR", message);
}

/**
 * Settles the purchase request or purchase order that owns the resolved
 * chain. Idempotent and replay safe; ignores other events and source modules;
 * throws (no write) on a malformed or foreign `purchasing` event.
 */
export async function handlePurchasingApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (sourceModuleOf(event) !== PURCHASING_SOURCE_MODULE) return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    refuse("approval.resolved for purchasing has an unknown shape");
  const resolved = parsed.data;
  if (resolved.tenantId.toLowerCase() !== context.tenant.tenantId.toLowerCase())
    refuse("approval.resolved tenant does not match the worker context");
  const { objectType, chainId } = resolved.payload;
  if (
    objectType !== "purchase_request" &&
    objectType !== "purchase_order" &&
    objectType !== "supplier_payment"
  )
    refuse("approval.resolved for purchasing names another object type");
  // Both documents belong to one outlet; settle on exactly that RLS scope so
  // a document of another outlet stays invisible (TEN-03).
  if (resolved.outletId === null)
    refuse("approval.resolved for purchasing has no outlet");
  const scoped = outletContext(context.tenant, resolved.outletId);

  // The chain must belong to the document the event names. A mismatch is
  // corrupt or forged input: refuse. No document: nothing of ours to settle.
  const owner = await withTenant(db, scoped, async (tx) => {
    const table =
      objectType === "supplier_payment"
        ? supplierPayments
        : objectType === "purchase_order"
          ? purchaseOrders
          : purchaseRequests;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tenantId, context.tenant.tenantId),
          eq(table.approvalChainId, chainId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (owner === null) return;
  if (storedId(owner.id) !== storedId(resolved.payload.objectId))
    refuse("approval.resolved chain belongs to another document");

  if (objectType === "supplier_payment")
    await settleSupplierPaymentForApproval(scoped, chainId, now);
  else if (objectType === "purchase_order")
    await settlePurchaseOrderForApproval(scoped, chainId, now);
  else await settlePurchaseRequestForApproval(scoped, chainId, now);
}
