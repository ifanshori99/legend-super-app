// Multi-entity P&L: one column per legal entity. The first column is sticky so
// the account stays visible while the table scrolls at 390px. Per-entity
// amounts and section totals come from each entity's P&L; the combined column
// only has the net profit the contract provides. The official/estimate label
// covers every entity in the report: one open month anywhere makes it an
// estimate.
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
  combineStatementBases,
  drillDownQueryFor,
  hasMultiEntityAccountRows,
  multiEntityRows,
  statementBasis,
  statementQueryFor,
  type MultiEntityRowView,
  type StatementViewProps,
} from "../lib";
import {
  useEntityFiscalPeriods,
  useLegalEntities,
  useMultiEntityStatement,
} from "../hooks";
import { StatementFrame } from "./statement-frame";

function dash() {
  return (
    <span aria-hidden="true" className="text-muted-foreground">
      —
    </span>
  );
}

export function MultiEntityView({
  legalEntityId,
  params,
  onDrillDown,
  onResetRange,
}: StatementViewProps) {
  const t = useT();
  const query = statementQueryFor("multiEntity", legalEntityId, params);
  const statement = useMultiEntityStatement(query);
  const entitiesQuery = useLegalEntities();
  const report = statement.data;
  const rows = report ? multiEntityRows(report) : [];
  const empty = report !== undefined && !hasMultiEntityAccountRows(rows);
  const entityCount = report?.entities.length ?? 0;
  const periodQueries = useEntityFiscalPeriods(
    report?.entities.map((entity) => entity.legalEntityId) ?? [],
  );
  const basis =
    !report || periodQueries.some((query) => query.isPending)
      ? null
      : combineStatementBases(
          periodQueries.map((query) =>
            // A failed period read cannot prove a close: estimate.
            statementBasis(query.data ?? [], params.from, params.to),
          ),
        ).basis;
  const entityName = (legalEntityId: string) =>
    entitiesQuery.data?.find((entity) => entity.id === legalEntityId)?.name ??
    t("accounting.report.multi.entityFallback");

  const drill = (
    row: Extract<MultiEntityRowView, { kind: "account" }>,
    index: number,
    amountIdr: number,
  ) => {
    if (!report) return;
    const entity = report.entities[index];
    const accountId = row.accountIds[index];
    if (!entity || !accountId) return;
    onDrillDown({
      ...drillDownQueryFor(
        "multiEntity",
        entity.legalEntityId,
        params,
        accountId,
      ),
      code: row.code,
      name: row.name,
      amountIdr,
    });
  };

  return (
    <StatementFrame
      type="multiEntity"
      pending={statement.isPending}
      failed={statement.isError}
      empty={empty}
      onRetry={() => void statement.refetch()}
      onReset={onResetRange}
      basis={basis}
    >
      <div>
        <Table className={entityCount > 1 ? "min-w-[48rem]" : "min-w-0"}>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">
                {t("accounting.report.statement.accountColumn")}
              </TableHead>
              {report?.entities.map((entity) => (
                <TableHead key={entity.legalEntityId} numeric>
                  {entityName(entity.legalEntityId)}
                </TableHead>
              ))}
              <TableHead numeric>
                {t("accounting.report.multi.combinedColumn")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              if (row.kind === "section")
                return (
                  <TableRow
                    key={`section-${row.group}`}
                    className="bg-surface-2 hover:bg-surface-2"
                  >
                    <TableCell
                      colSpan={entityCount + 2}
                      className="type-eyebrow text-muted-foreground"
                    >
                      {t(REPORT_GROUP_KEYS[row.group])}
                    </TableCell>
                  </TableRow>
                );
              if (row.kind === "account")
                return (
                  <TableRow key={`account-${row.group}-${row.code}`}>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <span
                        className="flex min-w-0 items-baseline gap-2"
                        style={{
                          paddingInlineStart: `${row.depth * 12}px`,
                        }}
                      >
                        <span className="tabular text-xs text-muted-foreground">
                          {row.code}
                        </span>
                        <span className="min-w-0">{row.name}</span>
                      </span>
                    </TableCell>
                    {row.amounts.map((amountIdr, entityIndex) =>
                      amountIdr === null ? (
                        <TableCell key={entityIndex} numeric>
                          {dash()}
                        </TableCell>
                      ) : (
                        <TableCell key={entityIndex} numeric>
                          <div className="flex items-center justify-end gap-1">
                            <Money amount={amountIdr} />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t(
                                "accounting.report.statement.drillDown",
                                { code: row.code, name: row.name },
                              )}
                              onClick={() => drill(row, entityIndex, amountIdr)}
                            >
                              <ListTree aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      ),
                    )}
                    <TableCell numeric>{dash()}</TableCell>
                  </TableRow>
                );
              if (row.kind === "subtotal")
                return (
                  <TableRow
                    key={`subtotal-${row.group}`}
                    className="border-t border-border hover:bg-transparent"
                  >
                    <TableCell className="sticky left-0 z-10 bg-card text-sm font-medium text-muted-foreground">
                      {t("accounting.report.statement.subtotal", {
                        group: t(REPORT_GROUP_KEYS[row.group]),
                      })}
                    </TableCell>
                    {row.amounts.map((amountIdr, entityIndex) => (
                      <TableCell key={entityIndex} numeric>
                        <Money
                          amount={amountIdr}
                          className="text-sm font-semibold"
                        />
                      </TableCell>
                    ))}
                    <TableCell numeric>{dash()}</TableCell>
                  </TableRow>
                );
              return (
                <TableRow
                  key={`summary-${row.labelKey}`}
                  className="border-t-2 border-border hover:bg-transparent"
                >
                  <TableCell className="sticky left-0 z-10 bg-card font-semibold">
                    {t(row.labelKey)}
                  </TableCell>
                  {row.amounts.map((amountIdr, entityIndex) => (
                    <TableCell key={entityIndex} numeric>
                      <Money amount={amountIdr} className="font-semibold" />
                    </TableCell>
                  ))}
                  <TableCell numeric>
                    {row.combinedIdr === undefined ? (
                      dash()
                    ) : (
                      <Money
                        amount={row.combinedIdr}
                        className="font-semibold"
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="border-t border-border px-card py-3 text-sm leading-5 text-muted-foreground">
          {t("accounting.report.multi.note")}{" "}
          {t("accounting.report.basis.multiEntityNote")}
        </p>
      </div>
    </StatementFrame>
  );
}
