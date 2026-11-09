// Read-only financial statement lines for AI tool TL-06 (bead legend-mfyo),
// derived from posted journal lines only (same source as the accounting
// statements, ACC-03). Amounts use the account's natural sign (revenue,
// liability, equity: credit - debit; asset, expense: debit - credit), whole
// rupiah. Cash flow is the direct movement of cash-and-equivalent accounts.
// With `closedOnly` (shareholder: closed-period aggregates) only entries that
// belong to a closed fiscal period are counted.
import { sql, type SQL } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";

export type AccountBalance = {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  reportGroup: string;
  debit: number;
  credit: number;
};

export type StatementData = {
  accounts: AccountBalance[];
  /** Every month of the period has fiscal periods and all are closed. */
  periodClosed: boolean;
};

const num = (value: unknown): number => Number(value ?? 0);

export const naturalAmount = (account: AccountBalance): number =>
  account.type === "asset" || account.type === "expense"
    ? account.debit - account.credit
    : account.credit - account.debit;

/** True when each listed month has fiscal periods and none is open. */
export async function accountingMonthsClosed(
  context: ScopedTenantContext,
  months: readonly string[],
  legalEntityId?: string,
): Promise<boolean> {
  return withTenant(db, context, async (tx) =>
    monthsClosedIn(tx, context.tenant.tenantId, months, legalEntityId),
  );
}

async function monthsClosedIn(
  tx: Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], "execute">,
  tenantId: string,
  months: readonly string[],
  legalEntityId?: string,
): Promise<boolean> {
  const entity: SQL = legalEntityId
    ? sql`AND legal_entity_id = ${legalEntityId}::uuid`
    : sql``;
  const result = await tx.execute(sql`
    SELECT period, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE status = 'closed')::int AS closed
    FROM fiscal_periods
    WHERE tenant_id = ${tenantId}::uuid
      AND period IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)}) ${entity}
    GROUP BY period`);
  const byMonth = new Map(
    result.rows.map((row) => [String(row.period), row] as const),
  );
  return months.every((month) => {
    const row = byMonth.get(month);
    return row !== undefined && num(row.n) > 0 && num(row.n) === num(row.closed);
  });
}

export async function queryStatementData(
  context: ScopedTenantContext,
  input: {
    from: string | null;
    to: string;
    months: readonly string[];
    legalEntityId?: string;
    closedOnly: boolean;
  },
): Promise<StatementData> {
  const tenantId = context.tenant.tenantId;
  const entity: SQL = input.legalEntityId
    ? sql`AND je.legal_entity_id = ${input.legalEntityId}::uuid`
    : sql``;
  const from: SQL = input.from
    ? sql`AND je.entry_date >= ${input.from}::date`
    : sql``;
  const closed: SQL = input.closedOnly
    ? sql`AND EXISTS (SELECT 1 FROM fiscal_periods fp
        WHERE fp.tenant_id = je.tenant_id AND fp.id = je.fiscal_period_id
          AND fp.status = 'closed')`
    : sql``;
  return withTenant(db, context, async (tx) => {
    const result = await tx.execute(sql`
      SELECT coa.code AS code, coa.name AS name, coa.type AS type,
        coa.report_group AS report_group,
        SUM(jl.debit_idr)::bigint AS debit, SUM(jl.credit_idr)::bigint AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.tenant_id = jl.tenant_id AND coa.id = jl.account_id
      WHERE jl.tenant_id = ${tenantId}::uuid
        AND je.entry_date <= ${input.to}::date ${from} ${entity} ${closed}
      GROUP BY coa.code, coa.name, coa.type, coa.report_group
      ORDER BY coa.code`);
    const periodClosed = await monthsClosedIn(
      tx,
      tenantId,
      input.months,
      input.legalEntityId,
    );
    return {
      periodClosed,
      accounts: result.rows.map((row) => ({
        code: String(row.code),
        name: String(row.name),
        type: String(row.type) as AccountBalance["type"],
        reportGroup: String(row.report_group),
        debit: num(row.debit),
        credit: num(row.credit),
      })),
    };
  });
}
