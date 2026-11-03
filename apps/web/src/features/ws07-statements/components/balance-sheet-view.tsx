// Balance sheet at an as-of date. Asset, liability and equity sections keep
// their section totals; the current-period earnings row and the three totals
// come from the payload.
import { useT } from "@/components/i18n";
import {
  balanceSheetRows,
  drillDownQueryFor,
  hasAccountRows,
  statementQueryFor,
  type StatementViewProps,
} from "../lib";
import { useBalanceSheetStatement } from "../hooks";
import { StatementFrame } from "./statement-frame";
import { StatementRowsTable } from "./statement-table";

export function BalanceSheetView({
  legalEntityId,
  params,
  onDrillDown,
  onResetRange,
}: StatementViewProps) {
  const t = useT();
  const query = statementQueryFor("balanceSheet", legalEntityId, params);
  const statement = useBalanceSheetStatement(query);
  const rows = statement.data ? balanceSheetRows(statement.data) : [];
  const empty = statement.data !== undefined && !hasAccountRows(rows);

  return (
    <StatementFrame
      type="balanceSheet"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
    >
      <div>
        <StatementRowsTable
          rows={rows}
          onDrillDown={(row) =>
            onDrillDown({
              ...drillDownQueryFor(
                "balanceSheet",
                legalEntityId,
                params,
                row.accountId,
              ),
              code: row.code,
              name: row.name,
              amountIdr: row.amountIdr,
            })
          }
        />
        <p className="border-t border-border px-card py-3 text-sm leading-5 text-muted-foreground">
          {t("accounting.report.bs.equationNote")}
        </p>
      </div>
    </StatementFrame>
  );
}
