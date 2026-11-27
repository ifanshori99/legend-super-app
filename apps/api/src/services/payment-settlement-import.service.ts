// WS-05 settlement import (PRD §3 F13, EDC-06). Stores a bank/gateway
// settlement report and compares it with POS transactions. It only READS POS
// data and RECORDS differences as reconciliation cases: it never creates
// payouts, refunds, journals or unallocated funds.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { GATEWAY_SETTLEMENT_PROVIDERS } from "@starter/shared/payment";
import {
  importSettlement as importEndpoint,
  listSettlements as listEndpoint,
  settlementImportViewSchema,
  settlementListItemSchema,
} from "@starter/shared/payment/admin";
import { guardDataImport } from "../config/data-import.ts";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import {
  paymentEdcTerminals,
  paymentReconciliationCases as cases,
  paymentReconciliationCorrections as corrections,
} from "../db/schema/payment-admin.ts";
import {
  paymentSettlementLines as lines,
  paymentSettlements as settlements,
} from "../db/schema/payment-settlement.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  RECONCILIATION_OBJECT_TYPE,
  RECONCILIATION_SOURCE_MODULE,
} from "./payment-admin-reconciliation.service.ts";
import {
  assertPaymentPermission,
  EVENT_DESTINATION,
} from "./payment-support.ts";
import { openLateFundsCorrection } from "./payment-reconciliation-correction.service.ts";
import { cancelApprovalRequest } from "./platform-approval.service.ts";
import type { Tx } from "./permission-resolver.ts";

type Input = ReturnType<typeof importEndpoint.body.parse>;
type SettlementRow = typeof settlements.$inferSelect;
type MatchStatus = "matched" | "mismatch" | "unmatched";

/** Gateway intents that were really paid (a refund later does not unpay them). */
const SETTLED_INTENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const;

/**
 * The sale now sits on a settlement line (matched or mismatch): its earlier
 * "missing" case (no line, booked but not reported) is wrong, the money did
 * arrive. Close it as `matched` with no resolution event and no write-off, and
 * withdraw a close request still waiting for approval so it can never be
 * approved afterwards. Case row first, then chain (same lock order as
 * settleReconciliationCaseForApproval). Only cases of this exact sale
 * (source_transaction_id) are touched. A resolved case (written off) stays
 * resolved and is never reversed: it only gets one finance correction row
 * (legend-oan3p), no journal and no money event.
 */
async function closeMissingCasesOfSale(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    readonly tenantId: TenantId;
    readonly outletId: OutletId;
    readonly source: Input["source"];
    readonly saleId: string;
    readonly reference: string;
    readonly lineNo: number;
    /** The settlement line just inserted for this sale. */
    readonly line: {
      readonly id: string;
      readonly settlementId: string;
      readonly reference: string;
      readonly receivedIdr: number;
    };
    readonly now: Date;
  },
): Promise<void> {
  const note = `Closed automatically: sale matched a settlement line (report ${input.reference}, line ${input.lineNo})`;
  const found = await tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, input.tenantId),
        eq(cases.outletId, input.outletId),
        eq(cases.source, input.source),
        eq(cases.sourceTransactionId, input.saleId),
        isNull(cases.settlementLineId),
        inArray(cases.status, ["open", "pending_approval", "resolved"]),
      ),
    )
    .for("update");
  for (const row of found) {
    if (row.status === "resolved") {
      await openLateFundsCorrection(tx, context, {
        caseRow: row,
        line: input.line,
        now: input.now,
      });
      continue;
    }
    const [closed] = await tx
      .update(cases)
      .set({ status: "matched", note })
      .where(
        and(
          eq(cases.tenantId, input.tenantId),
          eq(cases.id, row.id),
          eq(cases.status, row.status),
        ),
      )
      .returning({ id: cases.id });
    if (!closed) continue;
    let chainOutcome: string | null = null;
    if (row.status === "pending_approval" && row.approvalChainId)
      chainOutcome = await cancelApprovalRequest(tx, context, {
        chainId: row.approvalChainId,
        sourceModule: RECONCILIATION_SOURCE_MODULE,
        actorUserId: null,
        now: input.now,
      });
    // approved/expired/cancelled: a chain that ended before this import (an
    // approval waiting for the worker, or an expiry) is recorded, not hidden.
    const caseNote =
      chainOutcome === "approved" ||
      chainOutcome === "expired" ||
      chainOutcome === "cancelled"
        ? `${note}; approval chain was ${chainOutcome}`
        : note;
    if (caseNote !== note)
      await tx
        .update(cases)
        .set({ note: caseNote })
        .where(and(eq(cases.tenantId, input.tenantId), eq(cases.id, row.id)));
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(input.now.getTime()),
        tenantId: input.tenantId,
        outletId: input.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.reconciliation_case_matched_closed",
        objectType: RECONCILIATION_OBJECT_TYPE,
        objectId: row.id,
        reason: caseNote,
        maskedChanges: {
          before: { status: row.status },
          after: { status: "matched", chainOutcome },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: input.now.toISOString(),
      },
      ["status"],
    );
  }
}

/** Unique violation (SQLSTATE 23505), also when the driver error is wrapped. */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

const settlementConflict = () =>
  new HttpError(
    409,
    "SETTLEMENT_CONFLICT",
    "A settlement report with this reference was already imported with different content.",
  );

/** Same report content gives the same hash; line order never matters. */
function contentHash(input: Input): string {
  const canonical = {
    outletId: input.outletId,
    source: input.source,
    provider: input.provider,
    reference: input.reference,
    terminalId: input.terminalId ?? null,
    batchNo: input.batchNo ?? null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    grossIdr: input.grossIdr,
    feeIdr: input.feeIdr,
    netIdr: input.netIdr,
    lines: [...input.lines]
      .sort((a, b) => (a.reference < b.reference ? -1 : 1))
      .map((l) => ({
        reference: l.reference,
        amountIdr: l.amountIdr,
        feeIdr: l.feeIdr,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Second view of the EDC table: the void row that cancels a sale. */
const voids = alias(edcTransactions, "edc_voids");

/** POS transaction a settlement line may settle. */
type PosCandidate = { id: string; amountIdr: number };

async function matchedElsewhere(
  tx: Tx,
  tenantId: TenantId,
  source: "gateway" | "edc",
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const column =
    source === "edc"
      ? lines.matchedEdcTransactionId
      : lines.matchedPaymentIntentId;
  const rows = await tx
    .select({ id: column })
    .from(lines)
    .where(and(eq(lines.tenantId, tenantId), inArray(column, ids)));
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

async function findEdcCandidates(
  tx: Tx,
  tenantId: TenantId,
  input: Input,
  reference: string,
): Promise<PosCandidate[]> {
  const bank = input.provider.replace(/^edc_/, "");
  const find = (field: AnyPgColumn) =>
    tx
      .select({
        id: edcTransactions.id,
        amountIdr: edcTransactions.amountIdr,
      })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.outletId, input.outletId),
          eq(edcTransactions.terminalId, input.terminalId as string),
          eq(edcTransactions.bank, bank),
          eq(edcTransactions.type, "sale"),
          eq(edcTransactions.status, "approved"),
          eq(field, reference),
        ),
      )
      .orderBy(asc(edcTransactions.createdAt), asc(edcTransactions.id))
      .limit(10);
  // The RRN is the bank's own id; the approval code is the weaker fallback.
  const byRrn = await find(edcTransactions.rrn);
  if (byRrn.length > 0) return byRrn;
  return find(edcTransactions.approvalCode);
}

async function findGatewayCandidates(
  tx: Tx,
  tenantId: TenantId,
  input: Input,
  reference: string,
): Promise<PosCandidate[]> {
  return tx
    .select({ id: paymentIntents.id, amountIdr: paymentIntents.amountIdr })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.outletId, input.outletId),
        eq(paymentIntents.provider, input.provider),
        eq(paymentIntents.providerRef, reference),
        inArray(paymentIntents.status, SETTLED_INTENT_STATUSES),
      ),
    )
    .orderBy(asc(paymentIntents.createdAt), asc(paymentIntents.id))
    .limit(10);
}

async function countsOf(tx: Tx, tenantId: TenantId, settlementId: string) {
  const [row] = await tx
    .select({
      matched: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'matched')::int`,
      mismatch: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'mismatch')::int`,
      unmatched: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'unmatched')::int`,
    })
    .from(lines)
    .where(
      and(eq(lines.tenantId, tenantId), eq(lines.settlementId, settlementId)),
    );
  const [caseRow] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(cases)
    .where(
      and(eq(cases.tenantId, tenantId), eq(cases.settlementId, settlementId)),
    );
  return {
    matchedLines: row?.matched ?? 0,
    mismatchLines: row?.mismatch ?? 0,
    unmatchedLines: row?.unmatched ?? 0,
    casesCreated: caseRow?.total ?? 0,
  };
}

function view(
  row: SettlementRow,
  counts: Awaited<ReturnType<typeof countsOf>>,
  replayed: boolean,
) {
  return settlementImportViewSchema.parse({
    id: row.id,
    outletId: row.outletId,
    source: row.source,
    provider: row.provider,
    reference: row.reference,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    grossIdr: row.grossIdr,
    feeIdr: row.feeIdr,
    netIdr: row.netIdr,
    lineCount: row.lineCount,
    ...counts,
    replayed,
    createdAt: row.createdAt.toISOString(),
  });
}

export async function importSettlement(
  context: ScopedTenantContext,
  actorId: string,
  body: unknown,
  key: string,
) {
  assertTrustedScopedContext(context);
  // Data import guard: classify the upload before any write.
  guardDataImport("payment-settlement.import");
  const input = importEndpoint.body.parse(body);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    await assertPaymentPermission(
      tx,
      context,
      actorId,
      "payment.reconcile",
      { type: "outlet", id: input.outletId },
      now,
    );
    // The provider and terminal must be real before anything is recorded.
    if (input.source === "gateway") {
      if (
        !(GATEWAY_SETTLEMENT_PROVIDERS as readonly string[]).includes(
          input.provider,
        )
      )
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Unknown payment gateway provider.",
        );
    } else {
      const [terminal] = await tx
        .select({ bankCode: paymentEdcTerminals.bankCode })
        .from(paymentEdcTerminals)
        .where(
          and(
            eq(paymentEdcTerminals.tenantId, tenantId),
            eq(paymentEdcTerminals.outletId, input.outletId),
            eq(paymentEdcTerminals.id, input.terminalId as string),
          ),
        );
      if (
        !terminal ||
        terminal.bankCode !== input.provider.replace(/^edc_/, "")
      )
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "The terminal does not belong to this outlet or does not match the settlement bank.",
        );
    }
    async function run() {
      // Imports of one provider and outlet run one at a time, so the
      // "already settled" reads below cannot race a second report.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`settlement:${tenantId}:${input.source}:${input.provider}:${input.outletId}`}, 0))`,
      );
      const hash = contentHash(input);
      const [created] = await tx
        .insert(settlements)
        .values({
          tenantId,
          outletId: input.outletId,
          source: input.source,
          provider: input.provider,
          terminalId: input.terminalId ?? null,
          batchNo: input.batchNo ?? null,
          reference: input.reference,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          grossIdr: idr(input.grossIdr),
          feeIdr: idr(input.feeIdr),
          netIdr: idr(input.netIdr),
          lineCount: input.lines.length,
          contentHash: hash,
          importedBy: actorId,
        })
        // No target: the report key and the EDC (terminal, batch) key both
        // mean "already imported"; the lookup below tells them apart.
        .onConflictDoNothing()
        .returning();
      if (!created) {
        // The same report was imported before: never write twice.
        const [existing] = await tx
          .select()
          .from(settlements)
          .where(
            and(
              eq(settlements.tenantId, tenantId),
              eq(settlements.source, input.source),
              eq(settlements.provider, input.provider),
              eq(settlements.outletId, input.outletId),
              eq(settlements.reference, input.reference),
            ),
          );
        // No row under this reference: another report owns the (terminal, batch).
        if (!existing || existing.contentHash !== hash)
          throw settlementConflict();
        return view(existing, await countsOf(tx, tenantId, existing.id), true);
      }

      const caseBase = {
        tenantId,
        outletId: input.outletId,
        settlementId: created.id,
        source: input.source,
        provider: input.provider,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      };
      const claimed = new Set<string>();
      const tally = { matched: 0, mismatch: 0, unmatched: 0, cases: 0 };
      const sorted = [...input.lines].sort((a, b) =>
        a.reference < b.reference ? -1 : 1,
      );

      for (const [index, line] of sorted.entries()) {
        const candidates =
          input.source === "edc"
            ? await findEdcCandidates(tx, tenantId, input, line.reference)
            : await findGatewayCandidates(tx, tenantId, input, line.reference);
        const taken = await matchedElsewhere(
          tx,
          tenantId,
          input.source,
          candidates.map((c) => c.id),
        );
        const free = candidates.filter(
          (c) => !taken.has(c.id) && !claimed.has(c.id),
        );
        // Prefer the candidate whose amount agrees (approval codes repeat).
        const pos = free.find((c) => c.amountIdr === line.amountIdr) ?? free[0];
        let status: MatchStatus = "unmatched";
        let reason = "";
        if (pos) {
          claimed.add(pos.id);
          status = pos.amountIdr === line.amountIdr ? "matched" : "mismatch";
          reason = "Settlement amount differs from POS transaction";
        } else {
          reason =
            candidates.length > 0
              ? "POS transaction already settled by another settlement report"
              : "No POS transaction found for this settlement line";
        }
        const [lineRow] = await tx
          .insert(lines)
          .values({
            tenantId,
            outletId: input.outletId,
            settlementId: created.id,
            lineNo: index + 1,
            reference: line.reference,
            amountIdr: idr(line.amountIdr),
            feeIdr: idr(line.feeIdr),
            expectedIdr: pos ? idr(pos.amountIdr) : null,
            matchedEdcTransactionId:
              pos && input.source === "edc" ? pos.id : null,
            matchedPaymentIntentId:
              pos && input.source === "gateway" ? pos.id : null,
            matchStatus: status,
          })
          .returning({ id: lines.id });
        if (!lineRow) throw new Error("Settlement line insert returned no row");
        if (pos)
          await closeMissingCasesOfSale(tx, context, {
            tenantId,
            outletId: input.outletId,
            source: input.source,
            saleId: pos.id,
            reference: input.reference,
            lineNo: index + 1,
            line: {
              id: lineRow.id,
              settlementId: created.id,
              reference: line.reference,
              receivedIdr: line.amountIdr,
            },
            now,
          });
        tally[status] += 1;
        if (status === "matched") continue;
        const expected = pos ? pos.amountIdr : 0;
        const [mismatchCase] = await tx
          .insert(cases)
          .values({
            ...caseBase,
            settlementLineId: lineRow.id,
            reference: line.reference,
            expectedIdr: idr(expected),
            receivedIdr: idr(line.amountIdr),
            varianceIdr: idr(line.amountIdr - expected),
            reason,
            status: "open",
          })
          .returning({ id: cases.id });
        // Late funds of a written-off sale with a different amount: the
        // correction (opened above for this same line) points to this case so
        // finance decides both together (legend-oan3p).
        if (pos && mismatchCase)
          await tx
            .update(corrections)
            .set({ mismatchCaseId: mismatchCase.id })
            .where(
              and(
                eq(corrections.tenantId, tenantId),
                eq(corrections.settlementLineId, lineRow.id),
                isNull(corrections.mismatchCaseId),
              ),
            );
        tally.cases += 1;
      }

      // POS sales the report does not list: money booked but not settled.
      const missing =
        input.source === "edc"
          ? await tx
              .select({
                id: edcTransactions.id,
                amountIdr: edcTransactions.amountIdr,
                rrn: edcTransactions.rrn,
                approvalCode: edcTransactions.approvalCode,
                reference: edcTransactions.reference,
              })
              .from(edcTransactions)
              .where(
                and(
                  eq(edcTransactions.tenantId, tenantId),
                  eq(edcTransactions.outletId, input.outletId),
                  eq(edcTransactions.terminalId, input.terminalId as string),
                  eq(edcTransactions.bank, input.provider.replace(/^edc_/, "")),
                  eq(edcTransactions.batchNo, input.batchNo as string),
                  eq(edcTransactions.type, "sale"),
                  eq(edcTransactions.status, "approved"),
                  // Already settled by a line of any report.
                  sql`NOT EXISTS (SELECT 1 FROM ${lines} WHERE ${lines.tenantId} = ${tenantId} AND ${lines.matchedEdcTransactionId} = ${edcTransactions.id})`,
                  // Voided on the same terminal: the sale is not owed.
                  sql`NOT EXISTS (SELECT 1 FROM ${edcTransactions} AS ${voids} WHERE ${voids.tenantId} = ${tenantId} AND ${voids.terminalId} = ${edcTransactions.terminalId} AND ${voids.type} = 'void' AND ${voids.status} = 'approved' AND (${voids.reference} = ${edcTransactions.reference} OR (${edcTransactions.rrn} IS NOT NULL AND ${voids.rrn} = ${edcTransactions.rrn})))`,
                  // One sale, at most one "missing" case for life (open, awaiting approval or resolved).
                  sql`NOT EXISTS (SELECT 1 FROM ${cases} WHERE ${cases.tenantId} = ${tenantId} AND ${cases.outletId} = ${input.outletId} AND ${cases.source} = 'edc' AND ${cases.provider} = ${input.provider} AND ${cases.settlementLineId} IS NULL AND (${cases.sourceTransactionId} = ${edcTransactions.id} OR (${cases.sourceTransactionId} IS NULL AND ${cases.reference} = COALESCE(${edcTransactions.rrn}, ${edcTransactions.approvalCode}, ${edcTransactions.reference}))))`,
                ),
              )
              .orderBy(asc(edcTransactions.createdAt), asc(edcTransactions.id))
              .then((rows) =>
                rows
                  .filter((r) => !claimed.has(r.id))
                  .map((r) => ({
                    id: r.id,
                    amountIdr: r.amountIdr,
                    reference: r.rrn ?? r.approvalCode ?? r.reference,
                  })),
              )
          : await tx
              .select({
                id: paymentIntents.id,
                amountIdr: paymentIntents.amountIdr,
                providerRef: paymentIntents.providerRef,
              })
              .from(paymentIntents)
              .where(
                and(
                  eq(paymentIntents.tenantId, tenantId),
                  eq(paymentIntents.outletId, input.outletId),
                  eq(paymentIntents.provider, input.provider),
                  inArray(paymentIntents.status, SETTLED_INTENT_STATUSES),
                  sql`(${paymentIntents.paidAt} AT TIME ZONE 'Asia/Jakarta')::date BETWEEN ${input.periodStart}::date AND ${input.periodEnd}::date`,
                  // Already settled by a line of any report.
                  sql`NOT EXISTS (SELECT 1 FROM ${lines} WHERE ${lines.tenantId} = ${tenantId} AND ${lines.matchedPaymentIntentId} = ${paymentIntents.id})`,
                  // One sale, at most one "missing" case for life (open, awaiting approval or resolved).
                  sql`NOT EXISTS (SELECT 1 FROM ${cases} WHERE ${cases.tenantId} = ${tenantId} AND ${cases.outletId} = ${input.outletId} AND ${cases.source} = 'gateway' AND ${cases.provider} = ${input.provider} AND ${cases.settlementLineId} IS NULL AND (${cases.sourceTransactionId} = ${paymentIntents.id} OR (${cases.sourceTransactionId} IS NULL AND ${cases.reference} = COALESCE(${paymentIntents.providerRef}, ${paymentIntents.id}::text))))`,
                ),
              )
              .orderBy(asc(paymentIntents.paidAt), asc(paymentIntents.id))
              .then((rows) =>
                rows
                  .filter((r) => !claimed.has(r.id))
                  .map((r) => ({
                    id: r.id,
                    amountIdr: r.amountIdr,
                    reference: r.providerRef ?? r.id,
                  })),
              );
      for (const row of missing) {
        // The partial unique index is the last guard against a duplicate
        // "missing" case; only a row that really went in is counted.
        const inserted = await tx
          .insert(cases)
          .values({
            ...caseBase,
            settlementLineId: null,
            sourceTransactionId: row.id,
            reference: row.reference,
            expectedIdr: row.amountIdr,
            receivedIdr: idr(0),
            varianceIdr: idr(-row.amountIdr),
            reason: "POS transaction is missing from the settlement report",
            status: "open",
          })
          .onConflictDoNothing({
            target: [
              cases.tenantId,
              cases.outletId,
              cases.source,
              cases.sourceTransactionId,
            ],
            where: sql`${cases.settlementLineId} IS NULL AND ${cases.sourceTransactionId} IS NOT NULL`,
          })
          .returning({ id: cases.id });
        tally.cases += inserted.length;
      }

      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: created.outletId,
          actorType: "user",
          actorId,
          deviceId: null,
          action: "payment.settlement_imported",
          objectType: "payment_settlement",
          objectId: created.id,
          reason: null,
          maskedChanges: {
            before: {},
            after: {
              source: created.source,
              provider: created.provider,
              lineCount: created.lineCount,
              casesCreated: tally.cases,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        ["source", "provider", "lineCount", "casesCreated"],
      );
      const event = eventEnvelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: created.outletId,
        name: "settlement.imported",
        version: 1,
        aggregateType: "settlement",
        aggregateId: created.id,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: { type: "user", id: actorId },
        deviceId: null,
        idempotencyKey: `settlement.imported:${created.id}`,
        payloadSchemaRef: "settlement.imported.v1",
        payload: { settlementId: created.id, casesCreated: tally.cases },
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: EVENT_DESTINATION,
        direction: null,
        peerId: null,
      });
      return view(
        created,
        {
          matchedLines: tally.matched,
          mismatchLines: tally.mismatch,
          unmatchedLines: tally.unmatched,
          casesCreated: tally.cases,
        },
        false,
      );
    }

    return idempotentPaymentAdminWrite(
      tx,
      context,
      actorId,
      key,
      "reconciliation.import_settlement",
      input,
      async () => {
        try {
          return await run();
        } catch (error) {
          if (isUniqueViolation(error)) throw settlementConflict();
          throw error;
        }
      },
    );
  });
}

/**
 * C4b: one outlet's imported reports, newest first. Same access as the import
 * (payment.reconcile at the outlet); tenant and outlet are filtered in SQL.
 * Amounts are the stored report totals, the counts come from lines and cases.
 */
export async function listSettlements(
  context: ScopedTenantContext,
  actorId: string,
  input: unknown,
) {
  assertTrustedScopedContext(context);
  const query = listEndpoint.query.parse(input);
  if (
    query.periodFrom !== undefined &&
    query.periodTo !== undefined &&
    query.periodTo < query.periodFrom
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "periodTo must not be before periodFrom.",
    );
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actorId,
      "payment.reconcile",
      { type: "outlet", id: query.outletId },
      new Date(),
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      let keys: unknown[];
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        keys = [];
      }
      const [createdAt, id] = keys;
      if (
        typeof createdAt !== "string" ||
        !uuidSchema.safeParse(id).success ||
        !Number.isFinite(Date.parse(createdAt))
      )
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      cursor = sql`(${settlements.createdAt}, ${settlements.id}) < (${createdAt}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.tenantId, tenantId),
          eq(settlements.outletId, query.outletId),
          query.source ? eq(settlements.source, query.source) : sql`TRUE`,
          query.provider ? eq(settlements.provider, query.provider) : sql`TRUE`,
          // Reports whose period overlaps the window.
          query.periodFrom
            ? sql`${settlements.periodEnd} >= ${query.periodFrom}::date`
            : sql`TRUE`,
          query.periodTo
            ? sql`${settlements.periodStart} <= ${query.periodTo}::date`
            : sql`TRUE`,
          cursor,
        ),
      )
      .orderBy(desc(settlements.createdAt), desc(settlements.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const data = [];
    for (const row of page)
      data.push(
        settlementListItemSchema.parse({
          id: row.id,
          outletId: row.outletId,
          source: row.source,
          provider: row.provider,
          reference: row.reference,
          terminalId: row.terminalId,
          batchNo: row.batchNo,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          grossIdr: row.grossIdr,
          feeIdr: row.feeIdr,
          netIdr: row.netIdr,
          lineCount: row.lineCount,
          ...(await countsOf(tx, tenantId, row.id)),
          createdAt: row.createdAt.toISOString(),
        }),
      );
    const last = page.at(-1);
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
