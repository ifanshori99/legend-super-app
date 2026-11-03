// Direct cash flow: one section per activity, server-labelled lines, activity
// subtotals and the opening/net/closing cash roll-forward. The contract has no
// account on a cash-flow row, so these rows do not drill down.
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CASH_FLOW_ACTIVITY_KEYS,
  cashFlowRows,
  isEmptyCashFlow,
  statementQueryFor,
  type CashFlowRowView,
  type StatementViewProps,
} from "../lib";
import { useCashFlowStatement } from "../hooks";
import { StatementFrame } from "./statement-frame";

function CashFlowTable({ rows }: { rows: readonly CashFlowRowView[] }) {
  const t = useT();
  return (
    <Table className="min-w-0">
      <TableHeader>
        <TableRow>
          <TableHead>
            {t("accounting.report.statement.componentColumn")}
          </TableHead>
          <TableHead numeric>
            {t("accounting.report.statement.amountColumn")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          switch (row.kind) {
            case "section":
              return (
                <TableRow
                  key={`section-${row.activity}`}
                  className="bg-surface-2 hover:bg-surface-2"
                >
                  <TableCell
                    colSpan={2}
                    className="type-eyebrow text-muted-foreground"
                  >
                    {t(CASH_FLOW_ACTIVITY_KEYS[row.activity])}
                  </TableCell>
                </TableRow>
              );
            case "line":
              return (
                <TableRow key={`line-${index}`}>
                  <TableCell>
                    <span className="block pl-3">{row.label}</span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.amountIdr} />
                  </TableCell>
                </TableRow>
              );
            case "empty":
              return (
                <TableRow
                  key={`empty-${index}`}
                  className="hover:bg-transparent"
                >
                  <TableCell
                    colSpan={2}
                    className="text-sm text-muted-foreground"
                  >
                    <span className="block pl-3">
                      {t("accounting.report.cf.emptyActivity")}
                    </span>
                  </TableCell>
                </TableRow>
              );
            case "subtotal":
              return (
                <TableRow
                  key={`subtotal-${row.activity}`}
                  className="border-t border-border hover:bg-transparent"
                >
                  <TableCell className="text-sm font-medium text-muted-foreground">
                    {t("accounting.report.statement.subtotal", {
                      group: t(CASH_FLOW_ACTIVITY_KEYS[row.activity]),
                    })}
                  </TableCell>
                  <TableCell numeric>
                    <Money
                      amount={row.totalIdr}
                      className="text-sm font-semibold"
                    />
                  </TableCell>
                </TableRow>
              );
            case "summary":
              return (
                <TableRow
                  key={`summary-${row.labelKey}`}
                  className={
                    row.emphasis === "strong"
                      ? "border-t-2 border-border hover:bg-transparent"
                      : "border-t border-border hover:bg-transparent"
                  }
                >
                  <TableCell
                    className={
                      row.emphasis === "strong"
                        ? "font-semibold"
                        : "font-medium"
                    }
                  >
                    {t(row.labelKey)}
                  </TableCell>
                  <TableCell numeric>
                    <Money
                      amount={row.amountIdr}
                      className={
                        row.emphasis === "strong"
                          ? "font-semibold"
                          : "font-medium"
                      }
                    />
                  </TableCell>
                </TableRow>
              );
          }
        })}
      </TableBody>
    </Table>
  );
}

export function CashFlowView({
  legalEntityId,
  params,
  onResetRange,
  basis,
}: StatementViewProps) {
  const query = statementQueryFor("cashFlow", legalEntityId, params);
  const statement = useCashFlowStatement(query);
  const rows = statement.data ? cashFlowRows(statement.data) : [];
  const empty = statement.data !== undefined && isEmptyCashFlow(statement.data);
  return (
    <StatementFrame
      type="cashFlow"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
      basis={basis}
    >
      <CashFlowTable rows={rows} />
    </StatementFrame>
  );
}
