// /kelola/akuntansi/pajak — tax recap and Coretax export (bead legend-5fdy;
// PRD v1.7 §3 F19 "Pajak [P0]"). One screen: entity scope (EntityScope from the
// accounting shell), a business-month picker, the four report types, the period
// totals in one StatStrip, then the selected type's recap. PPN masukan shows a
// reason card instead of a table when the legal entity is not PKP.
//
// State machine and applicability come from the contract; this screen only
// renders what the endpoints returned and never computes a tax amount.
import * as React from "react";
import type { TaxReport, TaxReportType } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { EntityRef } from "@/features/ws07-accounting/components/entity-picker";
import { useLegalEntities } from "@/features/ws07-accounting/hooks";
import {
  useCanManageTaxReports,
  useExportTaxReport,
  useTaxReports,
} from "../hooks";
import {
  defaultTaxPeriod,
  formatTaxPeriod,
  TAX_TYPES,
  reportOfType,
  taxErrorMessageKey,
  taxPeriodSummary,
  taxTypeApplicable,
  taxTypeLabelKey,
} from "../lib";
import {
  ExportArtifactDialog,
  type TaxExportArtifact,
} from "./export-artifact-dialog";
import { FinalizeReportDialog } from "./finalize-report-dialog";
import { GenerateReportDialog } from "./generate-report-dialog";
import { PeriodPicker } from "./period-picker";
import { PpnGate } from "./ppn-gate";
import { ReportCard } from "./report-card";

function TaxPageSkeleton() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-5" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-control-sm w-44" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-control w-80 max-w-full" />
      </div>
      <div className="rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline">
        <div className="grid gap-(--border-w) overflow-hidden rounded-container border-(length:--border-w) bg-border sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="grid gap-2 bg-card p-card">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
      <CardShell>
        <CardShellBody>
          <div className="grid gap-3 p-card">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-9 w-40" />
            <div className="grid gap-2 sm:grid-cols-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        </CardShellBody>
      </CardShell>
    </div>
  );
}

export function TaxPage({ legalEntity }: { legalEntity: EntityRef }) {
  const t = useT();
  const toast = useToast();
  // The picker's EntityRef carries id+name; PKP status lives on the legal entity
  // read the accounting shell already cached. Unknown status fails closed.
  const entitiesQuery = useLegalEntities();
  const isPkp =
    entitiesQuery.data?.find((row) => row.id === legalEntity.id)?.isPkp ??
    false;

  const canManage = useCanManageTaxReports();
  const reportsQuery = useTaxReports(legalEntity.id);
  const exportMutation = useExportTaxReport(legalEntity.id);

  const [selectedPeriod, setSelectedPeriod] = React.useState<string | null>(
    null,
  );
  const [type, setType] = React.useState<TaxReportType>("pbjt");
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [finalizeOpen, setFinalizeOpen] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [exported, setExported] = React.useState<{
    report: TaxReport;
    artifact: TaxExportArtifact;
  } | null>(null);

  const reports = React.useMemo(
    () => reportsQuery.data ?? [],
    [reportsQuery.data],
  );
  // Opens on the latest period that has a recap (fixtures: 2026-11); the
  // current business month when the entity has none yet.
  const period = selectedPeriod ?? defaultTaxPeriod(reports);
  const summary = React.useMemo(
    () => taxPeriodSummary(reports, period),
    [reports, period],
  );
  const report = reportOfType(reports, type, period);
  const ppnBlocked = !taxTypeApplicable(type, isPkp);

  const changePeriod = (next: string) => {
    setSelectedPeriod(next);
    setActionError(null);
  };
  const changeType = (next: TaxReportType) => {
    setType(next);
    setActionError(null);
  };

  const runExport = () => {
    if (!report) return;
    setActionError(null);
    exportMutation.mutate(report.id, {
      onSuccess: (artifact) => {
        setExported({ report, artifact });
        toast({
          title: t("accounting.tax.toasts.exported"),
          tone: "success",
        });
      },
      onError: (cause) =>
        setActionError(
          t(
            taxErrorMessageKey(
              cause instanceof ApiError ? cause.code : undefined,
            ),
          ),
        ),
    });
  };

  const intro = (
    <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
      {t("accounting.tax.subtitle")}
    </p>
  );

  if (reportsQuery.isPending)
    return (
      <div className="grid min-w-0 gap-5">
        {intro}
        <TaxPageSkeleton />
      </div>
    );

  if (reportsQuery.isError)
    return (
      <div className="grid min-w-0 gap-5">
        {intro}
        <CardShell>
          <CardShellBody>
            <ErrorState
              onRetry={() => {
                void reportsQuery.refetch();
              }}
            />
          </CardShellBody>
        </CardShell>
      </div>
    );

  return (
    <div className="grid min-w-0 gap-5">
      {intro}
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <PeriodPicker value={period} onChange={changePeriod} />
        <div className="grid gap-1.5">
          <span className="type-eyebrow text-muted-foreground">
            {t("accounting.tax.types.label")}
          </span>
          <SegmentedControl
            value={type}
            onValueChange={changeType}
            label={t("accounting.tax.types.label")}
            options={TAX_TYPES.map((value) => ({
              value,
              label: t(taxTypeLabelKey(value)),
            }))}
          />
        </div>
      </div>

      <StatStrip label={t("accounting.tax.summary.label")} columns={3}>
        <StatTile
          label={t("accounting.tax.summary.totalTax")}
          value={<Money amount={summary.totalTaxIdr} />}
          context={formatTaxPeriod(period)}
        />
        <StatTile
          label={t("accounting.tax.summary.finalCount")}
          value={<NumberDisplay value={summary.finalCount} />}
          context={t("accounting.tax.summary.typeCount", {
            count: TAX_TYPES.length,
          })}
        />
        <StatTile
          label={t("accounting.tax.summary.openCount")}
          value={<NumberDisplay value={summary.draftCount} />}
          context={t("accounting.tax.summary.typeCount", {
            count: TAX_TYPES.length,
          })}
        />
      </StatStrip>

      {type === "ppn" && ppnBlocked ? (
        <PpnGate isPkp={isPkp} />
      ) : (
        <ReportCard
          type={type}
          period={period}
          report={report}
          canManage={canManage}
          actionError={actionError}
          exporting={exportMutation.isPending}
          onGenerate={() => {
            setActionError(null);
            setGenerateOpen(true);
          }}
          onFinalize={() => {
            setActionError(null);
            setFinalizeOpen(true);
          }}
          onExport={runExport}
        />
      )}

      <GenerateReportDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        legalEntity={legalEntity}
        type={type}
        period={period}
      />
      {report && (
        <FinalizeReportDialog
          open={finalizeOpen}
          onOpenChange={setFinalizeOpen}
          legalEntityId={legalEntity.id}
          report={report}
          onError={setActionError}
        />
      )}
      <ExportArtifactDialog
        open={exported !== null}
        onOpenChange={(open) => {
          if (!open) setExported(null);
        }}
        report={exported?.report ?? null}
        artifact={exported?.artifact ?? null}
      />
    </div>
  );
}
