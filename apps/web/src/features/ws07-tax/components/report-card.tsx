// Header of one tax type in the selected period: status, period, timestamps,
// the type's explanation, the state-machine actions and the status history. The
// lines table is a sibling double shell (a card never nests another card); with
// no report the same body shows the empty state and its one next action.
import {
  CircleAlert,
  CircleDashed,
  CloudUpload,
  Lock,
  Plus,
} from "lucide-react";
import type { TaxReport, TaxReportType } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import {
  formatTaxPeriod,
  formatTaxTimestamp,
  taxTypeHintKey,
  taxTypeLabelKey,
} from "../lib";
import { ReportLinesTable } from "./report-lines-table";
import { ReportStatusHistory } from "./report-status-history";
import { TaxStatusBadge } from "./report-status-badge";

export function ReportCard({
  type,
  period,
  report,
  canManage,
  actionError,
  exporting,
  onGenerate,
  onFinalize,
  onExport,
}: {
  type: TaxReportType;
  period: string;
  report: TaxReport | undefined;
  /** Holds accounting.tax_report.manage; the API enforces it regardless. */
  canManage: boolean;
  actionError: string | null;
  exporting: boolean;
  onGenerate: () => void;
  onFinalize: () => void;
  onExport: () => void;
}) {
  const t = useT();
  const typeLabel = t(taxTypeLabelKey(type));
  const title = t("accounting.tax.report.title", {
    type: typeLabel,
    period: formatTaxPeriod(period),
  });
  return (
    <>
      <CardShell>
        <CardShellBody>
          <header className="grid gap-3 border-b p-card">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="grid min-w-0 gap-1">
                <h2 className="type-title">{title}</h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t(taxTypeHintKey(type))}
                </p>
              </div>
              {report ? (
                <TaxStatusBadge status={report.status} />
              ) : (
                <Badge tone="neutral">
                  <CircleDashed aria-hidden="true" />
                  {t("accounting.tax.status.none")}
                </Badge>
              )}
            </div>

            {report && (
              <p className="text-sm leading-5 text-muted-foreground tabular">
                {t("accounting.tax.report.generated", {
                  time: formatTaxTimestamp(report.generatedAt),
                })}
              </p>
            )}

            {report && canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {report.status === "draft" && (
                  <Button type="button" onClick={onFinalize}>
                    <Lock aria-hidden="true" />
                    {t("accounting.tax.actions.finalize")}
                  </Button>
                )}
                {report.status !== "draft" && (
                  <Button
                    type="button"
                    variant={report.status === "final" ? "default" : "outline"}
                    loading={exporting}
                    onClick={onExport}
                  >
                    <CloudUpload aria-hidden="true" />
                    {t(
                      report.status === "exported"
                        ? "accounting.tax.actions.exportAgain"
                        : "accounting.tax.actions.export",
                    )}
                  </Button>
                )}
              </div>
            )}

            {!canManage && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.tax.actions.manageOnly")}
              </p>
            )}

            {actionError && (
              <p
                role="alert"
                className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {actionError}
              </p>
            )}

            {report && <ReportStatusHistory report={report} />}
          </header>

          {report ? null : (
            <EmptyState
              title={t("accounting.tax.report.emptyTitle", { type: typeLabel })}
              description={t("accounting.tax.report.emptyHint")}
              action={
                canManage ? (
                  <Button type="button" onClick={onGenerate}>
                    <Plus aria-hidden="true" />
                    {t("accounting.tax.actions.generate")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </CardShellBody>
      </CardShell>
      {report && <ReportLinesTable report={report} />}
    </>
  );
}
