// EDC settlement CSV per bank (X2 legend-wasr7.11, cloud-only release §3).
// Finance uploads the bank's settlement export of one outlet; every line is
// matched to an EDC sale by terminal + RRN + amount.
//
// Founder rule "jangan sampai rugi": the import never books, voids or changes
// an amount or a payment status. A line with the sale's own terminal, RRN and
// amount only clears the "perlu dicek" flag of an approved sale, through
// resolveEdcReconciliation (same locks, checks, audit and outbox event as the
// person's resolve; a manual slip still needs its live tender). Everything
// else leaves the sale as it is:
//
// - same RRN, other amount: mismatch, X1 alert `amount`;
// - same RRN on another terminal of the outlet: mismatch, alert `terminal`;
// - a void line for the RRN in the same file: the sale is not cleared;
// - a sale still `unknown` (or declined): unmatched, a person decides;
// - no sale: unmatched (the bank holds money the POS did not book; the outlet
//   is not short). A booked sale no line confirms stays flagged and the H+1
//   overdue alert (edc-reconciliation-alert.ts) reaches its shift.
//
// Idempotent per file (sha256 of the text, per outlet: a replay returns the
// first result) and per line (a line key of bank, kind, terminal, RRN and
// amount, per outlet: a re-export records only its new lines). Imports of one
// outlet run one at a time. An outlet outside the tenant or the caller's
// scope is 404; payment.reconcile at the outlet and a second factor are
// required, as for the person's resolve.
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EdcBank } from "@starter/shared/edc";
import {
  edcSettlementCsvImportViewSchema,
  importEdcSettlementCsvInputSchema,
  type EdcSettlementCsvImportView,
} from "@starter/shared/payment/admin";
import { guardDataImport } from "../config/data-import.ts";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import {
  edcSettlementFiles,
  edcSettlementRows,
  type EdcSettlementRowStatus,
} from "../db/schema/edc-settlement-csv.ts";
import { paymentEdcTerminals } from "../db/schema/payment-admin.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  alertEdcReconciliationMismatch,
  type EdcReconciliationMismatch,
} from "./edc-reconciliation-alert.ts";
import { resolveEdcReconciliation } from "./edc-reconciliation.service.ts";
import {
  EdcSettlementCsvError,
  parseEdcSettlementCsv,
  type EdcSettlementCsvLine,
} from "./edc-settlement-csv-parse.ts";
import { assertPaymentPermission } from "./payment-support.ts";

/** Who is asking: set by the route from the session, never by the body. */
export type ImportEdcSettlementCsvOptions = { readonly mfaVerified: boolean };

type FileRow = typeof edcSettlementFiles.$inferSelect;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const notFound = () => new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");

/** The RRN of a stored sale as the CSV reader normalises it. */
const rrnSql = sql<string>`upper(replace(replace(${edcTransactions.rrn}, '-', ''), ' ', ''))`;

function view(row: FileRow, replayed: boolean): EdcSettlementCsvImportView {
  return edcSettlementCsvImportViewSchema.parse({
    id: row.id,
    outletId: row.outletId,
    bank: row.bank,
    fileName: row.fileName,
    fileHash: row.fileHash,
    rowCount: row.rowCount,
    matched: row.matchedCount,
    cleared: row.clearedCount,
    mismatch: row.mismatchCount,
    unmatched: row.unmatchedCount,
    duplicate: row.duplicateCount,
    replayed,
    createdAt: row.createdAt.toISOString(),
  });
}

const lineKey = (bank: EdcBank, line: EdcSettlementCsvLine) =>
  sha256(
    [bank, line.kind, line.terminalCode, line.rrn, String(line.amountIdr)].join(
      "|",
    ),
  );

type Decision = {
  line: EdcSettlementCsvLine;
  key: string;
  terminalId: string | null;
  status: EdcSettlementRowStatus;
  edcTransactionId: string | null;
  cleared: boolean;
  reason: string | null;
};

export async function importEdcSettlementCsv(
  context: ScopedTenantContext,
  actorUserId: string,
  body: unknown,
  options: ImportEdcSettlementCsvOptions,
  now = new Date(),
): Promise<EdcSettlementCsvImportView> {
  assertTrustedScopedContext(context);
  // Data import guard: classify the upload before any write.
  guardDataImport("edc-settlement.csv-import");
  const input = importEdcSettlementCsvInputSchema.parse(body);
  let lines: EdcSettlementCsvLine[];
  try {
    lines = parseEdcSettlementCsv(input.bank, input.csv);
  } catch (error) {
    if (error instanceof EdcSettlementCsvError)
      throw new HttpError(422, "VALIDATION_ERROR", error.message);
    throw error;
  }
  const tenantId = context.tenant.tenantId;
  const outletId = input.outletId;
  const fileHash = sha256(input.csv);
  const alerts: EdcReconciliationMismatch[] = [];

  const result = await withTenant(db, context, async (tx) => {
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
      )
      .limit(1);
    if (!outlet) throw notFound();
    try {
      assertOutletInScope(context.outletScope, outletId);
    } catch {
      throw notFound();
    }
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "payment.reconcile",
      { type: "outlet", id: outletId },
      now,
    );
    // It clears flags like the person's resolve: a second factor always.
    if (!options.mfaVerified) throw new AccessError("MFA_REQUIRED");

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edc-settlement-csv:${tenantId}:${outletId}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(edcSettlementFiles)
      .where(
        and(
          eq(edcSettlementFiles.tenantId, tenantId),
          eq(edcSettlementFiles.outletId, outletId),
          eq(edcSettlementFiles.fileHash, fileHash),
        ),
      )
      .limit(1);
    if (existing) return view(existing, true);

    const terminals = new Map(
      (
        await tx
          .select({
            id: paymentEdcTerminals.id,
            code: paymentEdcTerminals.terminalId,
          })
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, tenantId),
              eq(paymentEdcTerminals.outletId, outletId),
              eq(paymentEdcTerminals.bankCode, input.bank),
            ),
          )
      ).map((t) => [t.code.trim().toUpperCase(), t.id]),
    );

    const keys = lines.map((line) => lineKey(input.bank, line));
    const known = new Set(
      (
        await tx
          .select({ key: edcSettlementRows.rowKey })
          .from(edcSettlementRows)
          .where(
            and(
              eq(edcSettlementRows.tenantId, tenantId),
              eq(edcSettlementRows.outletId, outletId),
              inArray(edcSettlementRows.rowKey, [...new Set(keys)]),
            ),
          )
      ).map((row) => row.key),
    );

    const rrns = [...new Set(lines.map((line) => line.rrn))];
    const sales = await tx
      .select({
        id: edcTransactions.id,
        terminalId: edcTransactions.terminalId,
        status: edcTransactions.status,
        amountIdr: edcTransactions.amountIdr,
        needsReconciliation: edcTransactions.needsReconciliation,
        outletId: edcTransactions.outletId,
        rrn: rrnSql,
      })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.outletId, outletId),
          eq(edcTransactions.bank, input.bank),
          eq(edcTransactions.type, "sale"),
          inArray(rrnSql, rrns),
        ),
      )
      .orderBy(edcTransactions.createdAt, edcTransactions.id);
    const salesByRrn = new Map<string, typeof sales>();
    for (const sale of sales) {
      const list = salesByRrn.get(sale.rrn);
      if (list) list.push(sale);
      else salesByRrn.set(sale.rrn, [sale]);
    }
    const claimed = new Set(
      sales.length === 0
        ? []
        : (
            await tx
              .select({ id: edcSettlementRows.matchedEdcTransactionId })
              .from(edcSettlementRows)
              .where(
                and(
                  eq(edcSettlementRows.tenantId, tenantId),
                  eq(edcSettlementRows.matchStatus, "matched"),
                  inArray(
                    edcSettlementRows.matchedEdcTransactionId,
                    sales.map((sale) => sale.id),
                  ),
                ),
              )
          ).flatMap((row) => (row.id ? [row.id] : [])),
    );
    const voided = new Set(
      lines
        .filter((line) => line.kind === "void")
        .map((line) => `${line.terminalCode}:${line.rrn}`),
    );

    const seen = new Set<string>();
    const decisions: Decision[] = [];
    let duplicate = 0;
    for (const [index, line] of lines.entries()) {
      const key = keys[index]!;
      if (known.has(key) || seen.has(key)) {
        duplicate += 1;
        continue;
      }
      seen.add(key);
      const terminalId = terminals.get(line.terminalCode) ?? null;
      const decision: Decision = {
        line,
        key,
        terminalId,
        status: "unmatched",
        edcTransactionId: null,
        cleared: false,
        reason: null,
      };
      decisions.push(decision);
      if (line.kind === "void") {
        decision.reason =
          "Baris void atau pembatalan di laporan bank; tidak dicocokkan.";
        continue;
      }
      if (voided.has(`${line.terminalCode}:${line.rrn}`)) {
        decision.reason =
          "Laporan bank juga memuat void untuk RRN ini; transaksi tetap perlu dicek.";
        continue;
      }
      const all = salesByRrn.get(line.rrn) ?? [];
      const sameTerminal = (sale: (typeof all)[number]) =>
        terminalId !== null &&
        sale.terminalId.toLowerCase() === terminalId.toLowerCase();
      const here = all.filter(sameTerminal);
      const onTerminal = here.filter((sale) => sale.status === "approved");
      if (onTerminal.length === 0) {
        // Only when this terminal has no sale for the RRN at all: a sale here
        // still waiting for a decision is not another terminal's.
        const elsewhere =
          here.length === 0
            ? all.find((sale) => sale.status === "approved")
            : undefined;
        if (elsewhere) {
          decision.status = "mismatch";
          decision.edcTransactionId = elsewhere.id;
          decision.reason =
            "RRN ini tercatat di terminal EDC lain di outlet ini.";
          alerts.push({
            kind: "terminal",
            edcTransactionId: elsewhere.id,
            outletId: elsewhere.outletId,
            amountIdr: Number(elsewhere.amountIdr),
            chargedAmountIdr: line.amountIdr,
          });
        } else
          decision.reason =
            all.length > 0
              ? "Transaksi EDC dengan RRN ini belum disetujui; putuskan di layar rekonsiliasi."
              : terminalId === null
                ? "Terminal tidak terdaftar di outlet ini untuk bank ini."
                : "Tidak ada transaksi EDC dengan RRN ini di outlet ini.";
        continue;
      }
      const exact = onTerminal.find(
        (sale) => Number(sale.amountIdr) === line.amountIdr,
      );
      if (!exact) {
        const sale = onTerminal[0]!;
        decision.status = "mismatch";
        decision.edcTransactionId = sale.id;
        decision.reason = "Nominal di laporan bank berbeda dengan transaksi.";
        alerts.push({
          kind: "amount",
          edcTransactionId: sale.id,
          outletId: sale.outletId,
          amountIdr: Number(sale.amountIdr),
          chargedAmountIdr: line.amountIdr,
        });
        continue;
      }
      if (claimed.has(exact.id)) {
        decision.reason =
          "Transaksi ini sudah dicocokkan dengan baris laporan lain.";
        continue;
      }
      claimed.add(exact.id);
      decision.status = "matched";
      decision.edcTransactionId = exact.id;
      if (!exact.needsReconciliation) continue;
      // Clears the flag only: the row is approved, so the resolve never
      // changes its status or amount. A refusal (no live tender, terminal
      // still processing) rolls back to the savepoint and keeps the flag.
      try {
        await tx.transaction((savepoint) =>
          resolveEdcReconciliation(
            savepoint,
            context,
            {
              edcTransactionId: exact.id,
              outcome: "approved",
              evidence: {
                source: "bank_statement",
                note: `Impor CSV settlement ${input.bank.toUpperCase()}, baris ${line.lineNo}`,
                rrn: line.rrn,
                chargedAmountIdr: idr(line.amountIdr),
                ...(line.approvalCode
                  ? { approvalCode: line.approvalCode }
                  : {}),
              },
              actorUserId,
            },
            now,
          ),
        );
        decision.cleared = true;
      } catch (error) {
        if (!(error instanceof CoreError || error instanceof HttpError))
          throw error;
        decision.reason =
          `Cocok, tetapi tanda perlu dicek tidak dapat dihapus: ${error.message}`.slice(
            0,
            300,
          );
      }
    }

    const tally = (status: EdcSettlementRowStatus) =>
      decisions.filter((d) => d.status === status).length;
    const [file] = await tx
      .insert(edcSettlementFiles)
      .values({
        tenantId,
        outletId: outletId,
        bank: input.bank,
        fileName: input.fileName,
        fileHash,
        rowCount: lines.length,
        matchedCount: tally("matched"),
        clearedCount: decisions.filter((d) => d.cleared).length,
        mismatchCount: tally("mismatch"),
        unmatchedCount: tally("unmatched"),
        duplicateCount: duplicate,
        importedBy: actorUserId,
        createdAt: now,
      })
      .returning();
    if (!file) throw new Error("EDC settlement file insert returned no row");
    if (decisions.length > 0)
      await tx.insert(edcSettlementRows).values(
        decisions.map((d) => ({
          tenantId,
          outletId: outletId,
          fileId: file.id,
          lineNo: d.line.lineNo,
          rowKey: d.key,
          bank: input.bank,
          terminalCode: d.line.terminalCode,
          terminalId: d.terminalId,
          rrn: d.line.rrn,
          approvalCode: d.line.approvalCode,
          batchNo: d.line.batchNo,
          amountIdr: idr(d.line.amountIdr),
          matchStatus: d.status,
          matchedEdcTransactionId: d.edcTransactionId,
          clearedFlag: d.cleared,
          reason: d.reason,
          createdAt: now,
        })),
      );
    return view(file, false);
  });
  // After the import committed, in their own transactions; never throws.
  if (!result.replayed)
    for (const alert of alerts)
      await alertEdcReconciliationMismatch(context, alert, now);
  return result;
}
