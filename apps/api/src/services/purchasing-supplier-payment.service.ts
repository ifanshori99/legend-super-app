// Payment of a supplier invoice through the approval matrix (bead legend-xxqz3;
// brief docs/briefs/991-akuntansi-kas-supplier.md part A; PRD v1.7 §3.18
// "pembayaran supplier disetujui dan dijurnal otomatis", §3.7 Matriks Approval).
//
// - `requestSupplierInvoicePayment`: finance (`accounting.supplier_payment.process`
//   at the invoice's outlet) asks to pay part or all of a matched/released
//   invoice. The payable open item (it shares the invoice id) is locked FOR
//   UPDATE first, so two requests for one invoice serialize: a request plus the
//   open requests (`pending_approval`, `approved`) of the invoice may never pass
//   the outstanding balance (409 SUPPLIER_INVOICE_OVERPAYMENT). Idempotent on
//   (tenant, key): the same key and the same request is a replay, any other use
//   of the key is 409 IDEMPOTENCY_KEY_REUSED.
// - The approval matrix tiers on the CUMULATIVE amount of the invoice (already
//   settled + open requests + this one), so splitting one large payment into
//   small ones cannot slip under the limit. No policy for `supplier_payment`
//   refuses the request (409 APPROVAL_POLICY_MISSING): nothing is paid.
// - Every payment waits as `pending_approval` for a second person (founder
//   Q27, SO 1036 finding 2): the request opens with `alwaysRequire`, so an
//   amount below every tier takes the lowest tier's chain and no tier can
//   remove the second person. A result without a chain refuses the request
//   (fail closed); nothing is paid at request time. The payment is made by
//   `paySupplierInvoiceInTransaction` only when the decided chain settles.
// - `settleSupplierPaymentForApproval` applies the decided chain from the
//   `approval.resolved` consumer (purchasing-approval-consumer.ts): row locked
//   FOR UPDATE, the chain outcome re-read from the database, a replay is a
//   no-op, a chain the requester took part in never pays, and the outstanding
//   balance is re-checked at execution. Any refusal records `rejected` with a
//   note and writes no money.

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  idr,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { AccountingError } from "@starter/shared/accounting";
import {
  assertSupplierPaymentWithinInvoice,
  PurchasingError,
  supplierInvoicePaymentListSchema,
  supplierInvoicePaymentRequestResultSchema,
  supplierInvoicePaymentSchema,
  type requestSupplierInvoicePaymentInputSchema,
  type SupplierInvoicePayment,
  type SupplierInvoicePaymentRequestResult,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { accountingOpenItems } from "../db/schema/accounting-ap-fa.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { purchaseInvoices } from "../db/schema/purchasing.ts";
import { supplierPayments } from "../db/schema/supplier-payments.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { paySupplierInvoiceInTransaction } from "./accounting-ap.service.ts";
import { uniqueViolation } from "./accounting-shared.ts";
import {
  outletTarget,
  recordOpsAudit,
  requireOpsPermission,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";
import {
  PURCHASING_SOURCE_MODULE,
  recordSystemPurchasingAudit,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";
import { SUPPLIER_INVOICE_READ_PERMISSIONS } from "./purchasing-invoice.service.ts";

export type RequestSupplierInvoicePaymentInput = z.infer<
  typeof requestSupplierInvoicePaymentInputSchema
>;

const PAY_PERMISSION: PermissionCode = "accounting.supplier_payment.process";
const OPEN_STATUSES = ["pending_approval", "approved"] as const;
const AUDIT_FIELDS = [
  "supplierInvoiceId",
  "amountIdr",
  "paidOn",
  "status",
  "decisionNote",
] as const;

type PaymentRow = typeof supplierPayments.$inferSelect;

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Supplier invoice not found.");
}

function toPayment(row: PaymentRow): SupplierInvoicePayment {
  return supplierInvoicePaymentSchema.parse({
    id: row.id,
    supplierInvoiceId: row.supplierInvoiceId,
    amountIdr: row.amountIdr,
    paidOn: row.paidOn,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    note: row.decisionNote,
    journalEntryId: row.journalEntryId,
    createdAt: row.createdAt.toISOString(),
  });
}

function auditView(row: Pick<PaymentRow, (typeof AUDIT_FIELDS)[number]>) {
  return {
    supplierInvoiceId: row.supplierInvoiceId,
    amountIdr: row.amountIdr,
    paidOn: row.paidOn,
    status: row.status,
    decisionNote: row.decisionNote,
  };
}

// ---------------------------------------------------------------- request

/**
 * POST a payment request for one supplier invoice. Returns the payment id and
 * its status: `paid` (below the approval limit) or `pending_approval`.
 */
export async function requestSupplierInvoicePayment(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
  input: RequestSupplierInvoicePaymentInput,
  now = new Date(),
): Promise<SupplierInvoicePaymentRequestResult> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.id, supplierInvoiceId),
          ),
        );
      if (!invoice) throw notFound();
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        PAY_PERMISSION,
        invoice.outletId,
      );
      // Only an invoice that booked its payable can be paid.
      if (invoice.status !== "matched" && invoice.status !== "released")
        throw new PurchasingError(
          "SUPPLIER_INVOICE_NOT_PAYABLE",
          "The invoice has no payable to pay.",
        );

      // Everything that decides "how much may still be paid" runs under this
      // lock (the same row `settleOpenItemInTransaction` locks).
      const [item] = await tx
        .select()
        .from(accountingOpenItems)
        .where(
          and(
            eq(accountingOpenItems.tenantId, tenantId),
            eq(accountingOpenItems.kind, "payable"),
            eq(accountingOpenItems.id, invoice.id),
          ),
        )
        .for("update");
      if (!item) throw notFound();

      const [replay] = await tx
        .select()
        .from(supplierPayments)
        .where(
          and(
            eq(supplierPayments.tenantId, tenantId),
            eq(supplierPayments.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (replay) {
        if (
          replay.supplierInvoiceId !== invoice.id ||
          replay.amountIdr !== input.amountIdr ||
          replay.paidOn !== input.paidOn ||
          replay.requestedBy.toLowerCase() !== actorUserId.toLowerCase()
        )
          throw reusedKey();
        return supplierInvoicePaymentRequestResultSchema.parse({
          id: replay.id,
          status: replay.status,
        });
      }

      if (input.paidOn < item.documentDate)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "A payment cannot be dated before its invoice.",
        );
      const outstanding = item.originalIdr - item.settledIdr;
      if (outstanding <= 0)
        throw new PurchasingError(
          "SUPPLIER_INVOICE_NOT_PAYABLE",
          "The invoice has no outstanding amount.",
        );
      const open = await tx
        .select({
          amountIdr: supplierPayments.amountIdr,
          status: supplierPayments.status,
        })
        .from(supplierPayments)
        .where(
          and(
            eq(supplierPayments.tenantId, tenantId),
            eq(supplierPayments.supplierInvoiceId, invoice.id),
            inArray(supplierPayments.status, [...OPEN_STATUSES]),
          ),
        );
      assertSupplierPaymentWithinInvoice(
        { outstandingIdr: idr(outstanding) },
        idr(input.amountIdr),
        open,
      );
      const committed = open.reduce((sum, row) => sum + row.amountIdr, 0);
      const cumulativeIdr = item.settledIdr + committed + input.amountIdr;

      const paymentId = randomUUID();
      const opened = await openApprovalRequest(tx, context, {
        sourceModule: PURCHASING_SOURCE_MODULE,
        actionType: "supplier_payment",
        objectType: "supplier_payment",
        objectId: paymentId,
        amountIdr: cumulativeIdr,
        alwaysRequire: true,
        outletId: invoice.outletId,
        requestedBy: actorUserId,
        source: "user",
        requestReason: "Persetujuan pembayaran faktur supplier",
        payload: {
          supplierInvoiceId: invoice.id,
          amountIdr: input.amountIdr,
          paidOn: input.paidOn,
          cumulativeIdr,
        },
        now,
      });

      const base = {
        id: paymentId,
        tenantId,
        outletId: invoice.outletId,
        legalEntityId: invoice.legalEntityId,
        supplierInvoiceId: invoice.id,
        amountIdr: idr(input.amountIdr),
        paidOn: input.paidOn,
        requestedBy: actorUserId,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      // Fail closed: `alwaysRequire` never yields `required: false`, so a
      // result without a chain must not reach a payment row (nothing is paid).
      if (!opened.required) throw new AccessError("APPROVAL_POLICY_MISSING");
      const [row] = await tx
        .insert(supplierPayments)
        .values({
          ...base,
          status: "pending_approval",
          approvalChainId: opened.chainId,
        })
        .returning();
      if (!row) throw new Error("supplier payment was not recorded");
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: row.outletId,
        action: "purchasing.supplier_payment_requested",
        objectType: "supplier_payment",
        objectId: row.id,
        before: null,
        after: auditView(row),
        safeFields: AUDIT_FIELDS,
      });
      return supplierInvoicePaymentRequestResultSchema.parse({
        id: row.id,
        status: row.status,
      });
    });
  } catch (error) {
    // The key is taken by a payment of another invoice (same-invoice requests
    // serialize on the lock above and replay instead).
    if (uniqueViolation(error)) throw reusedKey();
    throw translatePurchasingError(error);
  }
}

function reusedKey(): HttpError {
  return new HttpError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "Idempotency key already used for a different request.",
  );
}

// ------------------------------------------------------------------- list

/** GET the payments of one supplier invoice (oldest first). */
export async function listSupplierInvoicePayments(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
): Promise<z.infer<typeof supplierInvoicePaymentListSchema>> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [invoice] = await tx
      .select({ id: purchaseInvoices.id, outletId: purchaseInvoices.outletId })
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.tenantId, tenantId),
          eq(purchaseInvoices.id, supplierInvoiceId),
        ),
      );
    if (!invoice) throw notFound();
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    const allowed = [PAY_PERMISSION, ...SUPPLIER_INVOICE_READ_PERMISSIONS].some(
      (permission) =>
        snapshot.allows(permission, outletTarget(invoice.outletId)),
    );
    if (!allowed) throw new AccessError("PERMISSION_DENIED");
    const rows = await tx
      .select()
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.tenantId, tenantId),
          eq(supplierPayments.supplierInvoiceId, invoice.id),
        ),
      )
      .orderBy(asc(supplierPayments.createdAt), asc(supplierPayments.id));
    return supplierInvoicePaymentListSchema.parse({
      data: rows.map(toPayment),
    });
  });
}

// ----------------------------------------------------- approval settlement

/**
 * Business refusals of the posting guards (closed period, missing or unusable
 * account, a date the settlement refuses). Infra errors are not refusals.
 */
const POSTING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "PERIOD_CLOSED",
  "PERIOD_MISMATCH",
  "ACCOUNT_MAPPING_MISSING",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_ENTITY_MISMATCH",
]);

function postingRefusalCode(error: unknown): string | null {
  if (error instanceof AccountingError)
    return POSTING_REFUSAL_CODES.has(error.code) ? error.code : null;
  return error instanceof HttpError && error.status === 422 ? error.code : null;
}

type Decision = {
  status: "paid" | "rejected" | "cancelled";
  note: string | null;
};

/**
 * Applies a decided approval chain to its payment. Idempotent: a payment that
 * is no longer `pending_approval` is returned unchanged. The chain outcome and
 * every level's decider are read from the database here, under the payment's
 * row lock; the event that triggered this call is never the authority.
 */
export async function settleSupplierPaymentForApproval(
  context: ScopedTenantContext,
  chainId: string,
  now = new Date(),
): Promise<SupplierInvoicePayment | null> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.tenantId, tenantId),
          eq(supplierPayments.approvalChainId, chainId),
        ),
      )
      .for("update");
    if (!row) return null;
    if (row.status !== "pending_approval") return toPayment(row);
    const outcome = await getApprovalChainOutcome(tx, {
      chainId,
      sourceModule: PURCHASING_SOURCE_MODULE,
    });
    if (outcome === "pending") return toPayment(row);

    const levels = await tx
      .select({ decidedBy: approvalRequests.decidedBy })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.chainId, chainId),
        ),
      )
      .orderBy(asc(approvalRequests.level));
    const approver = levels.at(-1)?.decidedBy ?? null;
    // A requester who decided any level taints the chain (fail closed).
    const requesterDecided = levels.some(
      (level) =>
        level.decidedBy !== null &&
        level.decidedBy.toLowerCase() === row.requestedBy.toLowerCase(),
    );

    let decision: Decision;
    let settlement: {
      settlementId: string;
      journalEntryId: string | null;
    } | null = null;
    if (outcome === "rejected")
      decision = { status: "rejected", note: "approval_rejected" };
    else if (outcome !== "approved")
      decision = { status: "cancelled", note: `approval_${outcome}` };
    else if (approver === null)
      decision = { status: "rejected", note: "approver_unknown" };
    else if (requesterDecided)
      decision = { status: "rejected", note: "self_approval" };
    else {
      // The balance is re-read under the open item lock: a debit note or
      // another payment may have reduced it since the request.
      const [item] = await tx
        .select()
        .from(accountingOpenItems)
        .where(
          and(
            eq(accountingOpenItems.tenantId, tenantId),
            eq(accountingOpenItems.kind, "payable"),
            eq(accountingOpenItems.id, row.supplierInvoiceId),
          ),
        )
        .for("update");
      if (!item || row.amountIdr > item.originalIdr - item.settledIdr)
        decision = { status: "rejected", note: "exceeds_outstanding" };
      else {
        try {
          // Savepoint: a refused posting leaves no settlement, journal or
          // idempotency claim behind, and the payment can still be marked.
          settlement = await tx.transaction((savepoint) =>
            paySupplierInvoiceInTransaction(
              savepoint,
              context,
              {
                supplierInvoiceId: row.supplierInvoiceId,
                supplierPaymentId: row.id,
                amountIdr: row.amountIdr,
                paidOn: row.paidOn,
                idempotencyKey: `sp-pay:${row.id}`,
              },
              userIdSchema.parse(approver),
              now,
            ),
          );
          decision = { status: "paid", note: null };
        } catch (error) {
          // A business refusal (closed period, unusable account) will not
          // clear by retrying: the payment is rejected, its reserved amount is
          // released and nothing is paid. Any other error is rethrown.
          const code = postingRefusalCode(error);
          if (code === null) throw error;
          settlement = null;
          decision = { status: "rejected", note: `posting_refused:${code}` };
        }
      }
    }

    const [updated] = await tx
      .update(supplierPayments)
      .set({
        status: decision.status,
        decisionNote: decision.note,
        decidedAt: now,
        updatedAt: sql`GREATEST(clock_timestamp(), ${supplierPayments.updatedAt})`,
        ...(decision.status === "paid" && settlement !== null
          ? {
              approvedBy: approver,
              settlementId: settlement.settlementId,
              journalEntryId: settlement.journalEntryId,
            }
          : {}),
      })
      .where(
        and(
          eq(supplierPayments.id, row.id),
          eq(supplierPayments.status, "pending_approval"),
        ),
      )
      .returning();
    if (!updated) throw new Error("supplier payment changed under its lock");
    const audit = {
      outletId: row.outletId,
      action:
        decision.status === "paid"
          ? "purchasing.supplier_payment_paid"
          : "purchasing.supplier_payment_declined",
      objectType: "supplier_payment",
      objectId: row.id,
      before: auditView(row),
      after: auditView(updated),
      safeFields: AUDIT_FIELDS,
    };
    // A human decided approved/rejected; expired and cancelled chains and a
    // refusal at execution are the system's own effect.
    if (approver !== null && (outcome === "approved" || outcome === "rejected"))
      await recordOpsAudit(tx, context, {
        ...audit,
        actorUserId: approver,
        reason: decision.note,
      });
    else
      await recordSystemPurchasingAudit(tx, context, {
        ...audit,
        reason: decision.note,
      });
    return toPayment(updated);
  });
}
