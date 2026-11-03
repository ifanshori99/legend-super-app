// Balance sheet at an as-of date. Asset, liability and equity sections keep
// their section totals; the current-period earnings row and the three totals
// come from the payload. The balance check compares the three server totals.
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  balanceSheetRows,
  drillDownQueryFor,
  hasAccountRows,
  isBalanceSheetBalanced,
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
  basis,
}: StatementViewProps) {
  const t = useT();
  const query = statementQueryFor("balanceSheet", legalEntityId, params);
  const statement = useBalanceSheetStatement(query);
  const rows = statement.data ? balanceSheetRows(statement.data) : [];
  const empty = statement.data !== undefined && !hasAccountRows(rows);
  const balanced = statement.data
    ? isBalanceSheetBalanced(statement.data)
    : null;

  return (
    <StatementFrame
      type="balanceSheet"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
      basis={basis}
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
        {balanced !== null && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 border-t border-border px-card py-3 text-sm leading-5"
          >
            <Badge tone={balanced ? "success" : "danger"}>
              {balanced ? (
                <CircleCheck aria-hidden="true" />
              ) : (
                <TriangleAlert aria-hidden="true" />
              )}
              {t(
                balanced
                  ? "accounting.report.bs.balanced"
                  : "accounting.report.bs.unbalanced",
              )}
            </Badge>
            <span className="text-muted-foreground">
              {t(
                balanced
                  ? "accounting.report.bs.balancedHint"
                  : "accounting.report.bs.unbalancedHint",
              )}
            </span>
          </div>
        )}
        <p className="border-t border-border px-card py-3 text-sm leading-5 text-muted-foreground">
          {t("accounting.report.bs.equationNote")}
        </p>
      </div>
    </StatementFrame>
  );
}
