// Profit and loss: sections, subtotals and the three profit lines from the
// endpoint payload. Each account row drills down to its journal lines (ACC-03).
import {
  drillDownQueryFor,
  hasAccountRows,
  profitAndLossRows,
  statementQueryFor,
  type StatementViewProps,
} from "../lib";
import { useProfitAndLossStatement } from "../hooks";
import { StatementFrame } from "./statement-frame";
import { StatementRowsTable } from "./statement-table";

export function ProfitAndLossView({
  legalEntityId,
  params,
  onDrillDown,
  onResetRange,
}: StatementViewProps) {
  const query = statementQueryFor("profitAndLoss", legalEntityId, params);
  const statement = useProfitAndLossStatement(query);
  const rows = statement.data ? profitAndLossRows(statement.data) : [];
  const empty = statement.data !== undefined && !hasAccountRows(rows);

  return (
    <StatementFrame
      type="profitAndLoss"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
    >
      <StatementRowsTable
        rows={rows}
        onDrillDown={(row) =>
          onDrillDown({
            ...drillDownQueryFor(
              "profitAndLoss",
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
    </StatementFrame>
  );
}
