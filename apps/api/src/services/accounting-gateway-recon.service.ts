// Gateway settlement recon rows (bead legend-ds1o, WS-07; PRD v1.7 §3.19 Kas &
// Bank). Contract: `@starter/shared/accounting` endpoint
// `getGatewaySettlementRecon`.
//
// Read-only: one `gateway_settlement` journal of the legal entity becomes one
// row of bruto / biaya / diterima di bank, plus the bank statement line matched
// to it and the variance between the two. Never posts, pays or refunds.
//
// - The bank line of a journal is the one on the bank account's GL account
//   (net = debit - credit); every other credit line is gross; every other debit
//   line is a fee (MDR, VA service fee, ...). Same formula the card used
//   client side (`settlementRows`).
// - Journals are entity-level, so the scope is tenant (assertTenantScope).
//   A bank account of another entity or tenant is "not found".
// - At most `MAX_JOURNALS` journals; `truncated` says there were more.

import { and, desc, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accountIdSchema,
  bankStatementLineIdSchema,
  getGatewaySettlementRecon,
  journalEntryIdSchema,
  type BankStatementLine,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  idr,
  uuidSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import { db } from "../db";
import {
  bankStatementLineMatches,
  bankStatementLines,
} from "../db/schema/accounting-cash-bank.ts";
import { journalEntries, journalLines } from "../db/schema/accounting.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertTenantScope } from "./accounting-ap-fa-shared.ts";
import { loadBankAccount, notFound } from "./accounting-cash-bank-shared.ts";

const MAX_JOURNALS = 500;
const SOURCE_TYPE = "gateway_settlement";

type Query = z.infer<typeof getGatewaySettlementRecon.query>;
export type GatewaySettlementRecon = z.infer<
  typeof getGatewaySettlementRecon.response
>["data"];
type Row = GatewaySettlementRecon["rows"][number];

export async function getGatewaySettlementReconRows(
  context: ScopedTenantContext,
  query: Query,
): Promise<GatewaySettlementRecon> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  if (query.from > query.to)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Tanggal awal harus sebelum tanggal akhir.",
    );
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const account = await loadBankAccount(tx, tenantId, query.bankAccountId);
    if (account.legalEntityId !== query.legalEntityId)
      throw notFound("Rekening bank");

    const journals = await tx
      .select({
        id: journalEntries.id,
        sourceId: journalEntries.sourceId,
        entryDate: journalEntries.entryDate,
        description: journalEntries.description,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.legalEntityId, query.legalEntityId),
          eq(journalEntries.sourceType, SOURCE_TYPE),
          gte(journalEntries.entryDate, query.from),
          lte(journalEntries.entryDate, query.to),
        ),
      )
      .orderBy(
        desc(journalEntries.entryDate),
        asc(journalEntries.description),
        asc(journalEntries.id),
      )
      .limit(MAX_JOURNALS + 1);
    const truncated = journals.length > MAX_JOURNALS;
    const page = journals.slice(0, MAX_JOURNALS);
    if (page.length === 0) return { rows: [], truncated };

    const lines = await tx
      .select({
        entryId: journalLines.entryId,
        accountId: journalLines.accountId,
        debitIdr: journalLines.debitIdr,
        creditIdr: journalLines.creditIdr,
      })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.tenantId, tenantId),
          inArray(
            journalLines.entryId,
            page.map((journal) => journal.id),
          ),
        ),
      )
      .orderBy(asc(journalLines.entryId), asc(journalLines.lineNo));
    const linesByEntry = new Map<string, typeof lines>();
    for (const line of lines) {
      const list = linesByEntry.get(line.entryId) ?? [];
      list.push(line);
      linesByEntry.set(line.entryId, list);
    }

    // Statement line of this bank account matched to each settlement id.
    const sourceIds = page.flatMap((journal) =>
      journal.sourceId && uuidSchema.safeParse(journal.sourceId).success
        ? [journal.sourceId]
        : [],
    );
    const statementBySource = new Map<
      string,
      { id: string; amountIdr: BankStatementLine["amountIdr"] }
    >();
    if (sourceIds.length > 0) {
      const matched = await tx
        .select({
          refId: bankStatementLineMatches.refId,
          lineId: bankStatementLines.id,
          // This settlement's share: one line may pay several outlets.
          amountIdr: bankStatementLineMatches.amountIdr,
        })
        .from(bankStatementLineMatches)
        .innerJoin(
          bankStatementLines,
          and(
            eq(bankStatementLines.tenantId, bankStatementLineMatches.tenantId),
            eq(bankStatementLines.id, bankStatementLineMatches.lineId),
          ),
        )
        .where(
          and(
            eq(bankStatementLineMatches.tenantId, tenantId),
            eq(bankStatementLineMatches.bankAccountId, query.bankAccountId),
            eq(bankStatementLineMatches.refType, SOURCE_TYPE),
            inArray(bankStatementLineMatches.refId, sourceIds),
            gte(bankStatementLines.postedOn, query.from),
            lte(bankStatementLines.postedOn, query.to),
          ),
        )
        .orderBy(
          asc(bankStatementLineMatches.matchedAt),
          asc(bankStatementLineMatches.id),
        );
      for (const row of matched)
        if (!statementBySource.has(row.refId))
          statementBySource.set(row.refId, {
            id: row.lineId,
            amountIdr: row.amountIdr,
          });
    }

    const rows: Row[] = page.map((journal) => {
      let net = 0;
      let gross = 0;
      const fees: Row["fees"] = [];
      for (const line of linesByEntry.get(journal.id) ?? []) {
        if (line.accountId === account.glAccountId) {
          net += line.debitIdr - line.creditIdr;
        } else if (line.creditIdr > 0) {
          gross += line.creditIdr;
        } else if (line.debitIdr > 0) {
          fees.push({
            accountId: accountIdSchema.parse(line.accountId),
            amountIdr: line.debitIdr,
          });
        }
      }
      const statement = journal.sourceId
        ? (statementBySource.get(journal.sourceId) ?? null)
        : null;
      const matched = statement?.amountIdr ?? 0;
      return {
        journalId: journalEntryIdSchema.parse(journal.id),
        settlementId: journal.sourceId ?? journal.id,
        entryDate: journal.entryDate,
        description: journal.description,
        grossIdr: idr(gross),
        fees,
        feeIdr: idr(fees.reduce((sum, fee) => sum + fee.amountIdr, 0)),
        netIdr: idr(net),
        statementLineId: statement
          ? bankStatementLineIdSchema.parse(statement.id)
          : null,
        matchedAmountIdr: idr(matched),
        varianceIdr: idr(net - matched),
      };
    });
    rows.sort(
      (a, b) =>
        b.entryDate.localeCompare(a.entryDate) ||
        a.description.localeCompare(b.description),
    );
    return { rows, truncated };
  });
}
