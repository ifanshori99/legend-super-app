// Equity changes: one row per equity component with the roll-forward columns
// the API returns. A component row drills into its cumulative postings; the
// current-earnings row (no account) does not.
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
  EQUITY_COLUMNS,
  EQUITY_COLUMN_KEYS,
  drillDownQueryFor,
  isEmptyEquityChanges,
  statementQueryFor,
  type StatementViewProps,
} from "../lib";
import { useEquityChangesStatement } from "../hooks";
import { StatementFrame } from "./statement-frame";

export function EquityChangesView({
  legalEntityId,
  params,
  onDrillDown,
  onResetRange,
  basis,
}: StatementViewProps) {
  const t = useT();
  const query = statementQueryFor("equityChanges", legalEntityId, params);
  const statement = useEquityChangesStatement(query);
  const rows = statement.data?.rows ?? [];
  const empty =
    statement.data !== undefined && isEmptyEquityChanges(statement.data);

  const drill = (row: (typeof rows)[number]) => {
    if (row.accountId === null) return;
    onDrillDown({
      ...drillDownQueryFor(
        "equityChanges",
        legalEntityId,
        params,
        row.accountId,
      ),
      code: "",
      name: row.label,
      amountIdr: row.closingIdr,
    });
  };

  return (
    <StatementFrame
      type="equityChanges"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
      basis={basis}
    >
      <>
        {/* Phones: one card per equity component with the five amounts. */}
        <ul className="divide-y divide-border md:hidden">
          {rows.map((row) => (
            <li key={row.accountId ?? "earnings"} className="grid gap-2 p-card">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{row.label}</span>
                {row.accountId !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("accounting.report.statement.drillDownName", {
                      name: row.label,
                    })}
                    onClick={() => drill(row)}
                  >
                    <ListTree aria-hidden="true" />
                  </Button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {EQUITY_COLUMNS.map((column) => (
                  <div key={column} className="grid gap-0.5">
                    <dt className="type-eyebrow text-muted-foreground">
                      {t(EQUITY_COLUMN_KEYS[column])}
                    </dt>
                    <dd>
                      <Money amount={row[column]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[48rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card">
                  {t("accounting.report.statement.componentColumn")}
                </TableHead>
                {EQUITY_COLUMNS.map((column) => (
                  <TableHead key={column} numeric>
                    {t(EQUITY_COLUMN_KEYS[column])}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.accountId ?? "earnings"}>
                  <TableCell className="sticky left-0 z-10 bg-card font-medium">
                    <span className="flex items-center gap-1">
                      {row.label}
                      {row.accountId !== null && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t(
                            "accounting.report.statement.drillDownName",
                            { name: row.label },
                          )}
                          onClick={() => drill(row)}
                        >
                          <ListTree aria-hidden="true" />
                        </Button>
                      )}
                    </span>
                  </TableCell>
                  {EQUITY_COLUMNS.map((column) => (
                    <TableCell key={column} numeric>
                      <Money amount={row[column]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </>
    </StatementFrame>
  );
}
