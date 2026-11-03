// One statement table for the balance sheet and P&L: section headers, indented
// account rows, subtotals, and the profit/total lines. All amounts are placed
// from the payload; the component only indents and aligns them.
import { ListTree } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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
  REPORT_GROUP_KEYS,
  type StatementRowView,
} from "../lib";

type AccountRow = Extract<StatementRowView, { kind: "account" }>;

export function StatementRowsTable({
  rows,
  onDrillDown,
}: {
  rows: readonly StatementRowView[];
  onDrillDown?: (row: AccountRow) => void;
}) {
  const t = useT();
  return (
    <Table className="min-w-0">
      <TableHeader>
        <TableRow>
          <TableHead>{t("accounting.report.statement.accountColumn")}</TableHead>
          <TableHead numeric>
            {t("accounting.report.statement.amountColumn")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          switch (row.kind) {
            case "section":
              return (
                <TableRow
                  key={`section-${row.group}`}
                  className="bg-surface-2 hover:bg-surface-2"
                >
                  <TableCell
                    colSpan={2}
                    className="type-eyebrow text-muted-foreground"
                  >
                    {t(REPORT_GROUP_KEYS[row.group])}
                  </TableCell>
                </TableRow>
              );
            case "account":
              return (
                <TableRow key={`account-${row.accountId}`}>
                  <TableCell>
                    <span
                      className="flex min-w-0 items-baseline gap-2"
                      style={{ paddingInlineStart: `${row.depth * 12}px` }}
                    >
                      <span className="tabular text-xs text-muted-foreground">
                        {row.code}
                      </span>
                      <span className="min-w-0">{row.name}</span>
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <div className="flex items-center justify-end gap-1">
                      <Money amount={row.amountIdr} />
                      {onDrillDown && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("accounting.report.statement.drillDown", {
                            code: row.code,
                            name: row.name,
                          })}
                          onClick={() => onDrillDown(row)}
                        >
                          <ListTree aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            case "subtotal":
              return (
                <TableRow
                  key={`subtotal-${row.group}`}
                  className="border-t border-border hover:bg-transparent"
                >
                  <TableCell className="text-sm font-medium text-muted-foreground">
                    {t("accounting.report.statement.subtotal", {
                      group: t(REPORT_GROUP_KEYS[row.group]),
                    })}
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.totalIdr} className="text-sm font-semibold" />
                  </TableCell>
                </TableRow>
              );
            case "note":
              return (
                <TableRow key={`note-${row.labelKey}`}>
                  <TableCell>
                    <span className="block pl-3">{t(row.labelKey)}</span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.amountIdr} />
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
