// The recap lines of one report. Amounts and the total come from the stored
// report (`taxIdr`, `amountIdr`); the effective rate is display-only and the
// basis is never multiplied client-side. Wide tables scroll inside their own
// container; phones get one readable block per line.
import type { TaxReport } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTaxLineRate, taxSubjectLabelKey, taxTypeLabelKey } from "../lib";

// Auditor notes of one line (screen only, never in the Coretax export).
function LineWarnings({ warnings }: { warnings: readonly string[] }) {
  const t = useT();
  if (warnings.length === 0) return null;
  return (
    <ul className="grid gap-0.5 text-sm text-warning">
      {warnings.map((warning, index) => (
        <li key={`${index}-${warning}`} className="break-words">
          <span className="font-medium">
            {t("accounting.tax.report.warningsLabel")}:
          </span>{" "}
          {warning}
        </li>
      ))}
    </ul>
  );
}

export function ReportLinesTable({ report }: { report: TaxReport }) {
  const t = useT();
  const rows = report.lines;
  const subjectTypeLabel = (type: (typeof rows)[number]["subjectType"]) =>
    t(taxSubjectLabelKey(type));
  return (
    <DataTableShell
      title={t("accounting.tax.report.linesTitle", {
        type: t(taxTypeLabelKey(report.type)),
      })}
      description={t("accounting.tax.report.linesDescription")}
      state={rows.length === 0 ? "empty" : "ready"}
      rowCount={rows.length}
      empty={{
        title: t("accounting.tax.report.noLinesTitle"),
        description: t("accounting.tax.report.noLinesHint"),
      }}
    >
      <ul className="divide-y divide-border md:hidden">
        {rows.map((line, index) => (
          <li
            key={`${line.subjectType}-${line.subjectId}-${index}`}
            className="grid gap-2 p-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium break-words">
                  {line.subjectName}
                </span>
                <span className="text-sm text-muted-foreground">
                  {subjectTypeLabel(line.subjectType)} ·{" "}
                  {line.taxIdMasked ?? t("accounting.tax.report.taxIdMissing")}
                </span>
              </div>
              <Money amount={line.taxIdr} className="font-medium" />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                {t("accounting.tax.report.columns.base")}
              </dt>
              <dd className="text-right">
                <Money amount={line.baseIdr} />
              </dd>
              <dt className="text-muted-foreground">
                {t("accounting.tax.report.columns.rate")}
              </dt>
              <dd className="text-right tabular">{formatTaxLineRate(line)}</dd>
              {line.references.length > 0 && (
                <>
                  <dt className="text-muted-foreground">
                    {t("accounting.tax.report.columns.references")}
                  </dt>
                  <dd className="text-right tabular">
                    {t("accounting.tax.report.referenceCount", {
                      count: line.references.length,
                    })}
                  </dd>
                </>
              )}
            </dl>
            <LineWarnings warnings={line.warnings} />
          </li>
        ))}
        <li className="flex items-center justify-between gap-2 p-card font-medium">
          <span>{t("accounting.tax.report.totalTax")}</span>
          <Money amount={report.amountIdr} />
        </li>
      </ul>
      <div className="hidden md:block">
        <Table className="min-w-[44rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("accounting.tax.report.columns.subject")}
              </TableHead>
              <TableHead>{t("accounting.tax.report.columns.taxId")}</TableHead>
              <TableHead numeric>
                {t("accounting.tax.report.columns.base")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.tax.report.columns.rate")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.tax.report.columns.amount")}
              </TableHead>
              <TableHead>
                {t("accounting.tax.report.columns.references")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((line, index) => (
              <TableRow key={`${line.subjectType}-${line.subjectId}-${index}`}>
                <TableCell>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium break-words">
                      {line.subjectName}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {subjectTypeLabel(line.subjectType)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {line.taxIdMasked ?? t("accounting.tax.report.taxIdMissing")}
                </TableCell>
                <TableCell numeric>
                  <Money amount={line.baseIdr} />
                </TableCell>
                <TableCell numeric>{formatTaxLineRate(line)}</TableCell>
                <TableCell numeric>
                  <Money amount={line.taxIdr} className="font-medium" />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {line.references.length === 0
                    ? "—"
                    : line.references.join(", ")}
                  <LineWarnings warnings={line.warnings} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={4}>
                {t("accounting.tax.report.totalTax")}
              </TableCell>
              <TableCell numeric>
                <Money amount={report.amountIdr} />
              </TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </DataTableShell>
  );
}
