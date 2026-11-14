// Monthly PBJT recap per outlet for the regional report (PRD §3.14 "Laporan
// Pajak"). The table is the source figure; the CSV export carries the same
// rows plus a totals line so finance can attach it to the regional filing.
import * as React from "react";
import { Download } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Input } from "@/components/ui/input";
import { Money, NumberDisplay } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantContext } from "@/lib/tenant-context";
import { usePbjtRecap } from "../hooks";
import {
  downloadTextFile,
  formatBasisPoints,
  formatTaxPeriod,
  formatDateTime,
  pbjtCsvFileName,
  pbjtRowTotals,
  toPbjtCsv,
  type PbjtCsvHeaders,
} from "../lib";

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh report.
 */
export function PbjtReportPage(props: {
  period: string;
  onPeriodChange: (period: string) => void;
}) {
  const { outlet } = useTenantContext();
  return <PbjtReportContent key={outlet?.id ?? "none"} {...props} />;
}

function PbjtReportContent({
  period,
  onPeriodChange,
}: {
  period: string;
  onPeriodChange: (period: string) => void;
}) {
  const t = useT();
  // The outlet the shell selected; none means nothing to report on.
  const { outlet } = useTenantContext();
  const recapQuery = usePbjtRecap(outlet?.id, period);
  const recap = recapQuery.data?.data;
  const sums = recap ? pbjtRowTotals(recap) : undefined;

  const csvHeaders: PbjtCsvHeaders = {
    code: t("tax.report.csv.code"),
    rate: t("tax.report.csv.rate"),
    priceMode: t("tax.report.csv.priceMode"),
    priceModeIncluded: t("tax.report.priceModeIncluded"),
    priceModeExcluded: t("tax.report.priceModeExcluded"),
    transactions: t("tax.report.csv.transactions"),
    gross: t("tax.report.csv.gross"),
    base: t("tax.report.csv.base"),
    service: t("tax.report.csv.service"),
    tax: t("tax.report.csv.tax"),
    total: t("tax.report.csv.total"),
  };

  function exportCsv() {
    if (!recap) return;
    downloadTextFile(
      pbjtCsvFileName(recap.period, recap.outletId),
      toPbjtCsv(recap, csvHeaders),
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      {recap && sums && (
        // Owner Q30 (DESIGN.md v2): one strip, hairline dividers.
        <StatStrip label={t("tax.report.summaryLabel")} columns={3}>
          <StatTile
            label={t("tax.report.totalTax")}
            value={<Money amount={recap.totalTaxIdr} />}
            context={formatTaxPeriod(recap.period)}
            source={<a href="#pbjt-rincian">{t("tax.report.viewRows")}</a>}
          />
          <StatTile
            label={t("tax.report.totalBase")}
            value={<Money amount={recap.totalTaxBaseIdr} />}
            context={formatTaxPeriod(recap.period)}
          />
          <StatTile
            label={t("tax.report.transactions")}
            value={<NumberDisplay value={sums.transactionCount} />}
            context={formatTaxPeriod(recap.period)}
          />
        </StatStrip>
      )}

      <div id="pbjt-rincian" className="grid min-w-0 gap-4">
        <DataTableShell
          title={t("tax.report.tableTitle")}
          description={
            recap
              ? t("tax.report.generated", {
                  time: formatDateTime(recap.generatedAt),
                  region: recap.regionCode ?? t("tax.report.regionEmpty"),
                })
              : t("tax.report.tableDescription")
          }
          state={
            !outlet
              ? "empty"
              : recapQuery.isPending
                ? "loading"
                : recapQuery.isError
                  ? "error"
                  : recap === undefined || recap.rows.length === 0
                    ? "empty"
                    : "ready"
          }
          actions={
            <>
              <Input
                type="month"
                value={period}
                aria-label={t("tax.report.period")}
                onChange={(event) => {
                  if (event.target.value !== "")
                    onPeriodChange(event.target.value);
                }}
                className="h-control-sm w-full sm:w-48"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={exportCsv}
                disabled={recap === undefined || recap.rows.length === 0}
              >
                <Download aria-hidden="true" />
                {t("tax.report.export")}
              </Button>
            </>
          }
          error={recapQuery.error}
          onRetry={() => void recapQuery.refetch()}
          empty={
            outlet
              ? {
                  title: t("tax.report.emptyTitle"),
                  description: t("tax.report.emptyHint"),
                }
              : {
                  title: t("area.noOutletTitle"),
                  description: t("area.noOutletHint"),
                }
          }
          rowCount={recap?.rows.length ?? 0}
        >
          {recap && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tax.report.columns.rule")}</TableHead>
                  <TableHead numeric>{t("tax.report.columns.rate")}</TableHead>
                  <TableHead>{t("tax.report.columns.priceMode")}</TableHead>
                  <TableHead numeric>
                    {t("tax.report.columns.transactions")}
                  </TableHead>
                  <TableHead numeric>{t("tax.report.columns.gross")}</TableHead>
                  <TableHead numeric>{t("tax.report.columns.base")}</TableHead>
                  <TableHead numeric>
                    {t("tax.report.columns.service")}
                  </TableHead>
                  <TableHead numeric>{t("tax.report.columns.tax")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recap.rows.map((row) => (
                  <TableRow
                    key={`${row.taxRuleCode}:${row.rateBp}:${row.priceIncludesTax}`}
                  >
                    <TableCell className="font-medium">
                      {row.taxRuleCode}
                    </TableCell>
                    <TableCell numeric>
                      {formatBasisPoints(row.rateBp)}
                    </TableCell>
                    <TableCell>
                      {row.priceIncludesTax
                        ? t("tax.report.priceModeIncluded")
                        : t("tax.report.priceModeExcluded")}
                    </TableCell>
                    <TableCell numeric>
                      <NumberDisplay value={row.transactionCount} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={row.grossSalesIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={row.taxBaseIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={row.serviceChargeIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={row.taxIdr} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("tax.report.totalRow")}</TableCell>
                  <TableCell numeric />
                  <TableCell />
                  <TableCell numeric>
                    <NumberDisplay value={sums?.transactionCount ?? 0} />
                  </TableCell>
                  <TableCell numeric>
                    {sums?.grossSalesIdr == null && sums ? (
                      "-"
                    ) : (
                      <Money amount={sums?.grossSalesIdr ?? 0} />
                    )}
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={recap.totalTaxBaseIdr} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={sums?.serviceChargeIdr ?? 0} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={recap.totalTaxIdr} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </DataTableShell>
      </div>
    </div>
  );
}
