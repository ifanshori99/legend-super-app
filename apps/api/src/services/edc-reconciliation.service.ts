// EDC reconciliation (legend-x9zmq, EDC-01 follow-up). An ECR sale flagged
// `needs_reconciliation` locks its bill (assertNoOpenEdcRequest) and nothing
// else clears the flag. A person with `payment.reconcile` (Owner, Finance)
// resolves it here after checking the terminal (inquiry, receipt or bank
// statement). Founder rule "jangan sampai rugi": the customer is never charged
// twice and the outlet is never short, so every unclear case is rejected.
//
// - declined: the terminal did not charge. The bill stays unpaid and unlocks.
// - approved: the terminal charged. The row becomes `approved` only when it
//   can be booked exactly once: no other approved sale for the reference, the
//   bill is still open and its remaining balance equals the row amount
//   (assertEdcSaleBillPayable), and the amount printed on the terminal evidence
//   equals the row amount. The tender itself is booked by the normal ECR tender
//   path (edcTenderSettlement), and the bill stays locked to everything else
//   until then. An approved ECR row with no tender yet is only cleared while the
//   bill can still take exactly that tender.
// - Needs a second factor on the session (MFA_REQUIRED), as manual refund settle.
// - A final decline/cancel/fail never flips to approved (late approval): the
//   charge must be voided at the terminal and then resolved as declined.
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AccessError, outletReachOf } from "@starter/shared/access";
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  userIdSchema,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EdcError,
  edcTransactionSchema,
  resolveEdcReconciliationBodySchema,
  resolveEdcReconciliationParamsSchema,
  type EdcReconciliationEvidence,
  type EdcReconciliationOutcome,
  type EdcTransaction,
} from "@starter/shared/edc";
import type { EdcTransactionEventName } from "@starter/shared/edc/events";
import {
  edcReconciliationQueueItemSchema,
  listEdcReconciliationQueue,
  type EdcReconciliationQueueItem,
} from "@starter/shared/payment/admin";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { paymentEdcTerminals } from "../db/schema/payment-admin.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { posOrderTenders, posOrders } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { emitEdcTransactionEvent } from "../edge/edc/events.ts";
import {
  EDC_LATE_RESPONSE_WINDOW_MS,
  lateResponsePossible,
} from "../edge/edc/late-response.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import {
  loadTenantAccessInTransaction,
  type Tx,
} from "./permission-resolver.ts";
import {
  assertEdcSaleBillPayable,
  remainingIdr,
  type TenderRow,
} from "./pos-order-support.ts";

export type ResolveEdcReconciliationInput = {
  edcTransactionId: string;
  outcome: EdcReconciliationOutcome;
  evidence: EdcReconciliationEvidence;
  actorUserId: string;
};

/** Who is asking: set by the route from the session, never by the body. */
export type ResolveEdcReconciliationOptions = { readonly mfaVerified: boolean };

type EdcRow = typeof edcTransactions.$inferSelect;

function toDto(row: EdcRow): EdcTransaction {
  // Same projection as the agent's DTO; the strict schema re-applies the
  // card-data filters on read.
  return edcTransactionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    terminalId: row.terminalId,
    bank: row.bank,
    reference: row.reference,
    idempotencyKey: row.idempotencyKey,
    amountIdr: row.amountIdr,
    method: row.method,
    status: row.status,
    trace: row.trace,
    approvalCode: row.approvalCode,
    rrn: row.rrn,
    cardType: row.cardType,
    maskedPan: row.maskedPan,
    responseCode: row.responseCode,
    message: row.message,
    invoiceNo: row.invoiceNo,
    batchNo: row.batchNo,
    needsReconciliation: row.needsReconciliation,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    inquiryCount: row.inquiryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

const notFound = () =>
  new CoreError("NOT_FOUND", "Transaksi EDC tidak ditemukan.");

/** Outbox event named after the status a resolve leaves the row in. */
function resolvedEventName(status: string): EdcTransactionEventName {
  switch (status) {
    case "approved":
      return "edc_transaction.approved";
    case "declined":
      return "edc_transaction.declined";
    case "cancelled":
      return "edc_transaction.cancelled";
    case "failed":
      return "edc_transaction.failed";
    default:
      throw new Error(`EDC reconciliation left a non-final status: ${status}`);
  }
}

/** A tender that still counts: the row is booked on a bill (not voided/failed). */
async function hasLiveTender(
  tx: Tx,
  context: ScopedTenantContext,
  edcTransactionId: string,
): Promise<boolean> {
  const [live] = await tx
    .select({ id: posOrderTenders.id })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, context.tenant.tenantId),
        eq(posOrderTenders.edcTransactionId, edcTransactionId),
        notInArray(posOrderTenders.status, ["voided", "failed"]),
      ),
    )
    .limit(1);
  return live !== undefined;
}

/** The amount on the terminal/bank evidence must be exactly what the request
 * was for; otherwise the real charge is not what the books would record. */
function assertChargedAmount(
  row: EdcRow,
  evidence: EdcReconciliationEvidence,
): void {
  if (evidence.chargedAmountIdr !== row.amountIdr)
    throw new EdcError("EDC_AMOUNT_MISMATCH");
}

/**
 * Resolves one flagged ECR sale. Runs in the caller's tenant transaction and
 * does NOT check permission (see `resolveEdcReconciliationForActor`). Returns
 * the updated row as the POS/admin sees it.
 */
export async function resolveEdcReconciliation(
  tx: Tx,
  context: ScopedTenantContext,
  input: ResolveEdcReconciliationInput,
  now = new Date(),
): Promise<EdcTransaction> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const byId = and(
    eq(edcTransactions.tenantId, tenantId),
    eq(edcTransactions.id, input.edcTransactionId),
  );

  const [peek] = await tx
    .select({
      outletId: edcTransactions.outletId,
      reference: edcTransactions.reference,
    })
    .from(edcTransactions)
    .where(byId)
    .limit(1);
  if (!peek) throw notFound();
  try {
    assertOutletInScope(context.outletScope, peek.outletId);
  } catch {
    throw notFound();
  }

  // Same advisory lock as the EDC-01 guard and the agent's write-ahead, taken
  // BEFORE the row lock so the three never interleave or deadlock. The bill's
  // own row is deliberately not locked: a tender holding it waits on this
  // advisory lock and then fails the EDC-01 guard against the new state.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${peek.outletId}:${peek.reference}`}))`,
  );
  const [row] = await tx
    .select()
    .from(edcTransactions)
    .where(byId)
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  // Flagged sale, or an unflagged `unknown` sale (a terminal without
  // inquiry/cancel never raises the flag; legend-ftsq0).
  if (
    row.type !== "sale" ||
    !(row.needsReconciliation || row.status === "unknown")
  )
    throw new CoreError(
      "CONFLICT",
      "Transaksi ini tidak menunggu rekonsiliasi (sudah diselesaikan atau bukan penjualan).",
    );
  // The agent stopped waiting but its adapter call is still running: the
  // terminal is still processing this sale, whatever status the row shows.
  if (row.saleWireOpenAt !== null)
    throw new CoreError(
      "CONFLICT",
      "Terminal masih memproses transaksi ini; tunggu sampai selesai, lalu ulangi.",
    );
  // An unknown sale may still get a late answer from the terminal: fail closed
  // until the window passes, for either outcome.
  if (row.status === "unknown" && lateResponsePossible(row, now))
    throw new CoreError(
      "CONFLICT",
      `Terminal masih mungkin mengirim jawaban untuk transaksi ini; tunggu sampai ${EDC_LATE_RESPONSE_WINDOW_MS / 60_000} menit setelah dikirim, lalu ulangi.`,
    );

  const evidence = input.evidence;
  let nextStatus = row.status;
  let completedAt = row.completedAt;
  let approvalCode = row.approvalCode;
  let rrn = row.rrn;

  if (input.outcome === "declined") {
    if (!["unknown", "declined", "cancelled", "failed"].includes(row.status))
      throw new CoreError(
        "CONFLICT",
        "Transaksi yang sudah disetujui terminal tidak dapat dinyatakan ditolak; void dulu di terminal dan catat lewat jalur void.",
      );
    if (await hasLiveTender(tx, context, row.id))
      throw new CoreError(
        "CONFLICT",
        "Transaksi ini sudah menjadi pembayaran di tagihan; batalkan pembayarannya lebih dulu.",
      );
    if (row.status === "unknown") {
      nextStatus = "declined";
      completedAt = now;
    }
  } else if (row.status === "approved") {
    assertChargedAmount(row, evidence);
    // Already booked as a tender (any mode): only the flag is cleared.
    if (!(await hasLiveTender(tx, context, row.id))) {
      // No tender yet: an ECR sale may be cleared only while the bill can still
      // take exactly this tender (the ECR path then books it once). A
      // hand-keyed entry can never be booked later, so it stays refused.
      if (row.mode !== "ecr")
        throw new CoreError(
          "CONFLICT",
          "Transaksi disetujui ini belum menjadi pembayaran di tagihan; tidak dapat dinyatakan selesai.",
        );
      await assertEdcSaleBillPayable(tx, context, {
        outletId: row.outletId,
        reference: row.reference,
        amountIdr: row.amountIdr,
      });
    }
  } else if (row.status === "unknown") {
    assertChargedAmount(row, evidence);
    const [other] = await tx
      .select({ id: edcTransactions.id })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.outletId, row.outletId),
          eq(edcTransactions.reference, row.reference),
          eq(edcTransactions.type, "sale"),
          eq(edcTransactions.status, "approved"),
          ne(edcTransactions.id, row.id),
        ),
      )
      .limit(1);
    if (other)
      throw new CoreError(
        "CONFLICT",
        "Tagihan ini sudah punya transaksi EDC yang disetujui; void salah satu muatan di terminal lalu nyatakan transaksi ini ditolak.",
      );
    await assertEdcSaleBillPayable(tx, context, {
      outletId: row.outletId,
      reference: row.reference,
      amountIdr: row.amountIdr,
    });
    nextStatus = "approved";
    completedAt = now;
    approvalCode = evidence.approvalCode ?? approvalCode;
    rrn = evidence.rrn ?? rrn;
  } else {
    // Late approval after a final decline/cancel/fail: the final status never
    // flips. The charge is voided at the terminal, then resolved as declined.
    throw new CoreError(
      "CONFLICT",
      "Transaksi ini sudah berstatus akhir tanpa persetujuan. Void muatan di terminal, lalu nyatakan ditolak.",
    );
  }

  const [updated] = await tx
    .update(edcTransactions)
    .set({
      status: nextStatus,
      completedAt,
      approvalCode,
      rrn,
      needsReconciliation: false,
      updatedAt: now,
    })
    .where(
      and(
        byId,
        eq(edcTransactions.status, row.status),
        eq(edcTransactions.needsReconciliation, row.needsReconciliation),
      ),
    )
    .returning();
  if (!updated) throw new Error("EDC reconciliation update returned no row");

  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: "edc_transaction.reconciliation_resolved",
      objectType: "edc_transaction",
      objectId: updated.id,
      reason: evidence.note,
      maskedChanges: {
        before: {
          status: row.status,
          needsReconciliation: row.needsReconciliation,
        },
        after: {
          status: updated.status,
          needsReconciliation: false,
          outcome: input.outcome,
          evidenceSource: evidence.source,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["status", "needsReconciliation", "outcome", "evidenceSource"],
  );
  // Always emitted, in the same transaction as the ledger update: a status
  // change and a flag that clears with the status unchanged both need it.
  await emitEdcTransactionEvent(tx, context, {
    name: resolvedEventName(updated.status),
    row: updated,
    now,
  });
  return toDto(updated);
}

/**
 * HTTP entry: checks `payment.reconcile` at the row's outlet (Owner, Finance)
 * and the session's second factor, then resolves. The tenant and actor come from the verified session.
 */
export async function resolveEdcReconciliationForActor(
  context: ScopedTenantContext,
  actorUserId: string,
  params: unknown,
  body: unknown,
  options: ResolveEdcReconciliationOptions,
  now = new Date(),
): Promise<EdcTransaction> {
  assertTrustedScopedContext(context);
  const { id } = resolveEdcReconciliationParamsSchema.parse(params);
  const input = resolveEdcReconciliationBodySchema.parse(body);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: edcTransactions.outletId })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, context.tenant.tenantId),
          eq(edcTransactions.id, id),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "payment.reconcile",
      { type: "outlet", id: row.outletId },
      now,
    );
    // Money decision (books a charge or releases a locked bill): a second
    // factor always, whatever the role (precedent: manual refund settle).
    if (!options.mfaVerified) throw new AccessError("MFA_REQUIRED");
    return resolveEdcReconciliation(
      tx,
      context,
      {
        edcTransactionId: id,
        outcome: input.outcome,
        evidence: input.evidence,
        actorUserId,
      },
      now,
    );
  });
}

export type EdcReconciliationQueueQuery = ReturnType<
  typeof listEdcReconciliationQueue.query.parse
>;

const BANK_LABEL: Record<string, string> = {
  bca: "BCA",
  mandiri: "Mandiri",
  bni: "BNI",
  bjb: "BJB",
};

const outletIn = (column: SQL, ids: readonly string[]) =>
  ids.length === 0
    ? sql`FALSE`
    : sql`${column} IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

/**
 * Queue for the reconciliation screen (legend-p98qi): ECR sales a person must
 * look at. A row is listed when it is flagged `needs_reconciliation` or is
 * `unknown`; an unknown row younger than the late-response window is listed
 * too (the client shows it locked, resolve refuses it with CONFLICT). The
 * fields that decide the allowed action (status, flag, saleWireOpenAt,
 * dispatchedAt) are returned as stored: this read grants nothing, the POST
 * resolve rules stay the only authority.
 *
 * Tenant and outlet scope are filtered in SQL (`context.outletScope`); an
 * outlet outside the scope is rejected by `outletIdsForQuery`, never answered
 * with another outlet's rows.
 */
export async function listEdcReconciliationQueueForActor(
  context: ScopedTenantContext,
  actorUserId: string,
  input: unknown,
  now = new Date(),
): Promise<CursorPage<EdcReconciliationQueueItem>> {
  assertTrustedScopedContext(context);
  const query = listEdcReconciliationQueue.query.parse(input);
  const scoped = outletIdsForQuery(
    context.outletScope,
    query.outletId ? [query.outletId] : undefined,
  );
  let cursorKeys: [string, string] | null = null;
  if (query.cursor) {
    // A malformed cursor is a contract error (422), never a 500.
    try {
      const [created, id] = decodeCursor(query.cursor);
      if (
        typeof created !== "string" ||
        typeof id !== "string" ||
        !uuidSchema.safeParse(id).success ||
        !Number.isFinite(Date.parse(created))
      )
        throw new RangeError("Invalid cursor");
      cursorKeys = [created, id];
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof SyntaxError))
        throw error;
      throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
    }
  }
  return withTenant(db, context, async (tx) => {
    let outletIds: readonly string[] | null; // null = every outlet of the tenant
    if (query.outletId) {
      await assertPaymentPermission(
        tx,
        context,
        actorUserId,
        "payment.reconcile",
        { type: "outlet", id: query.outletId },
        now,
      );
      outletIds = scoped.kind === "all" ? null : scoped.outletIds;
    } else {
      // No outlet asked: a brand- or outlet-scoped Finance still lists the
      // outlets its own payment.reconcile grant reaches (a tenant-wide check
      // would 403 it). Only that permission's reach is used, never the wider
      // outletScope of the context: the two are intersected.
      const data = await loadTenantAccessInTransaction(
        tx,
        context,
        actorUserId,
      );
      const reach = outletReachOf({
        principal: {
          tenantId: context.tenant.tenantId,
          userId: userIdSchema.parse(actorUserId),
          assignments: data.assignments,
        },
        roles: data.roles,
        org: data.org,
        now: data.clock ?? now,
        permission: "payment.reconcile",
      });
      if (reach === null)
        throw new AccessError(
          "PERMISSION_DENIED",
          "Your account cannot perform this action.",
        );
      if (reach.kind === "tenant") {
        outletIds = scoped.kind === "all" ? null : scoped.outletIds;
      } else {
        const allowed = new Set(reach.outletIds.map((id) => id.toLowerCase()));
        outletIds = (
          scoped.kind === "all"
            ? reach.outletIds
            : scoped.outletIds.filter((id) => allowed.has(id.toLowerCase()))
        ).map((id) => id.toLowerCase());
      }
    }
    // Milliseconds on both sides: the cursor carries a JS Date, so a row with
    // microseconds must not compare greater than its own cursor.
    const createdMs = sql`date_trunc('milliseconds', ${edcTransactions.createdAt})`;
    const cursor: SQL = cursorKeys
      ? sql`(${createdMs}, ${edcTransactions.id}) < (${cursorKeys[0]}::timestamptz, ${cursorKeys[1]}::uuid)`
      : sql`TRUE`;
    const pattern = query.q
      ? `%${query.q.replaceAll(/[%_\\]/g, "\\$&")}%`
      : null;
    const rows = await tx
      .select({
        row: edcTransactions,
        outletName: outlets.name,
        terminalCode: paymentEdcTerminals.terminalId,
        order: orders,
        cashierName: user.name,
      })
      .from(edcTransactions)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, edcTransactions.tenantId),
          eq(outlets.id, edcTransactions.outletId),
        ),
      )
      .leftJoin(
        paymentEdcTerminals,
        and(
          eq(paymentEdcTerminals.tenantId, edcTransactions.tenantId),
          eq(paymentEdcTerminals.id, edcTransactions.terminalId),
        ),
      )
      // (tenant, outlet, number) is unique: at most one bill per sale.
      .leftJoin(
        orders,
        and(
          eq(orders.tenantId, edcTransactions.tenantId),
          eq(orders.outletId, edcTransactions.outletId),
          eq(orders.number, edcTransactions.reference),
        ),
      )
      .leftJoin(
        posOrders,
        and(
          eq(posOrders.tenantId, orders.tenantId),
          eq(posOrders.orderId, orders.id),
        ),
      )
      .leftJoin(user, eq(user.id, posOrders.cashierId))
      .where(
        and(
          eq(edcTransactions.tenantId, context.tenant.tenantId),
          eq(edcTransactions.type, "sale"),
          or(
            eq(edcTransactions.needsReconciliation, true),
            eq(edcTransactions.status, "unknown"),
          ),
          outletIds === null
            ? sql`TRUE`
            : outletIn(sql`${edcTransactions.outletId}`, outletIds),
          query.status ? eq(edcTransactions.status, query.status) : sql`TRUE`,
          pattern
            ? or(
                ilike(edcTransactions.reference, pattern),
                ilike(edcTransactions.invoiceNo, pattern),
                ilike(orders.number, pattern),
                ilike(paymentEdcTerminals.terminalId, pattern),
              )
            : sql`TRUE`,
          cursor,
        ),
      )
      .orderBy(sql`${createdMs} DESC`, sql`${edcTransactions.id} DESC`)
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    // One query for every bill's tenders (no per-row N+1), grouped in memory.
    const orderIds = [
      ...new Set(page.flatMap(({ order }) => (order ? [order.id] : []))),
    ];
    const tendersByOrder = new Map<string, TenderRow[]>();
    if (orderIds.length > 0) {
      const tenderRows = await tx
        .select()
        .from(posOrderTenders)
        .where(
          and(
            eq(posOrderTenders.tenantId, context.tenant.tenantId),
            inArray(posOrderTenders.orderId, orderIds),
          ),
        )
        .orderBy(asc(posOrderTenders.requestedAt), asc(posOrderTenders.id));
      for (const tender of tenderRows) {
        const list = tendersByOrder.get(tender.orderId);
        if (list) list.push(tender);
        else tendersByOrder.set(tender.orderId, [tender]);
      }
    }
    const data: EdcReconciliationQueueItem[] = [];
    for (const { row, outletName, terminalCode, order, cashierName } of page) {
      const tenders = order ? (tendersByOrder.get(order.id) ?? []) : [];
      data.push(
        edcReconciliationQueueItemSchema.parse({
          transaction: toDto(row),
          outletName,
          cashierName: cashierName?.trim().slice(0, 100) || null,
          terminalLabel: `${terminalCode ?? row.terminalId} · ${
            BANK_LABEL[row.bank] ?? row.bank.toUpperCase()
          }`,
          billNumber: order?.number ?? null,
          remainingIdr: order ? remainingIdr(order, tenders) : null,
          saleWireOpenAt: row.saleWireOpenAt?.toISOString() ?? null,
        }),
      );
    }
    const last = page.at(-1)?.row;
    return {
      data,
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
