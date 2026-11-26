// Export of what is on screen (PRD v1.7 §3 F36 "Ekspor"; DASH-04). CSV, XLSX
// and PDF go through POST /api/reports/exports. The server derives whether the
// file holds personal data from the report and the split; this dialog only
// mirrors that rule so the visitor knows an approval comes first. States:
// pending_approval (nothing leaves the server), queued/generating, ready with a
// download link, failed, rejected, expired.
import { useState } from "react";
import {
  CircleAlert,
  Clock,
  Download,
  Hourglass,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { publicApiUrl } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { StatusPill, type StatusKind } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatNumber } from "@starter/shared/i18n";
import type {
  ReportDefinition,
  ReportExport,
  ReportExportFormat,
} from "@starter/shared/dashboard";
import {
  formatBusinessDate,
  formatReviewDate,
} from "@/features/ws11-owner-dashboard/board";
import {
  useCreateReportExport,
  useReportExportJob,
  useReportExports,
} from "../hooks";
import { buildExportInput, type ReportQuerySelection } from "../lib";
import { useFormatLabel } from "./labels";

const STATUS_VIEW: Record<
  ReportExport["status"],
  {
    pill: StatusKind;
    icon: LucideIcon;
    key: Parameters<ReturnType<typeof useT>>[0];
  }
> = {
  pending_approval: {
    pill: "warning",
    icon: Hourglass,
    key: "reportViewer.export.status.pending_approval",
  },
  queued: {
    pill: "info",
    icon: Clock,
    key: "reportViewer.export.status.queued",
  },
  generating: {
    pill: "info",
    icon: Clock,
    key: "reportViewer.export.status.generating",
  },
  ready: {
    pill: "success",
    icon: Download,
    key: "reportViewer.export.status.ready",
  },
  failed: {
    pill: "danger",
    icon: CircleAlert,
    key: "reportViewer.export.status.failed",
  },
  rejected: {
    pill: "danger",
    icon: ShieldAlert,
    key: "reportViewer.export.status.rejected",
  },
  expired: {
    pill: "warning",
    icon: Clock,
    key: "reportViewer.export.status.expired",
  },
  cancelled: {
    pill: "warning",
    icon: CircleAlert,
    key: "reportViewer.export.status.cancelled",
  },
};

function ExportStatusPill({ status }: { status: ReportExport["status"] }) {
  const t = useT();
  const view = STATUS_VIEW[status];
  return (
    <StatusPill status={view.pill} icon={view.icon}>
      {t(view.key)}
    </StatusPill>
  );
}

function ExportJobSummary({ job }: { job: ReportExport }) {
  const t = useT();
  const formatLabel = useFormatLabel();
  return (
    <div
      data-testid="export-job"
      // Announces queued -> generating -> ready while the dialog stays open.
      role="status"
      aria-live="polite"
      className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ExportStatusPill status={job.status} />
        <span className="text-sm font-semibold">{formatLabel(job.format)}</span>
        {job.containsPersonalData && (
          <span className="text-xs text-muted-foreground">
            {t("reportViewer.export.personalTag")}
          </span>
        )}
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {job.status === "pending_approval"
          ? t("reportViewer.export.pendingHint")
          : job.status === "queued" || job.status === "generating"
            ? t("reportViewer.export.workingHint")
            : job.status === "rejected"
              ? t("reportViewer.export.rejectedHint")
              : job.status === "failed"
                ? t("reportViewer.export.failedHint")
                : job.status === "expired"
                  ? t("reportViewer.export.expiredHint")
                  : job.status === "cancelled"
                    ? t("reportViewer.export.cancelledHint")
                    : t("reportViewer.export.readyHint")}
      </p>
      {job.file && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <a
            href={publicApiUrl(job.file.downloadPath)}
            download
            className="inline-flex items-center gap-1.5 font-semibold text-primary underline-offset-4 hover:underline"
          >
            <Download className="size-4" aria-hidden="true" />
            {t("reportViewer.export.download")}
          </a>
          <span className="tabular text-muted-foreground">
            {t("reportViewer.export.fileInfo", {
              rows: formatNumber(job.file.rowCount),
              size: formatNumber(
                Math.max(1, Math.round(job.file.sizeBytes / 1024)),
              ),
            })}
          </span>
          <span className="text-muted-foreground">
            {t("reportViewer.export.expires", {
              date: formatBusinessDate(job.file.expiresAt.slice(0, 10)),
            })}
          </span>
        </div>
      )}
    </div>
  );
}

function RecentExports({ reportCode }: { reportCode: string }) {
  const t = useT();
  const formatLabel = useFormatLabel();
  const exportsQuery = useReportExports(true);
  const jobs = (exportsQuery.data?.data ?? [])
    .filter((job) => job.reportCode === reportCode)
    .slice(0, 5);
  if (jobs.length === 0) return null;
  return (
    <section
      aria-label={t("reportViewer.export.recent")}
      className="grid gap-2"
    >
      <h3 className="type-eyebrow text-muted-foreground">
        {t("reportViewer.export.recent")}
      </h3>
      <ul className="grid divide-y rounded-container border-(length:--border-w)">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <ExportStatusPill status={job.status} />
              <span className="font-medium">{formatLabel(job.format)}</span>
            </span>
            <span className="flex items-center gap-3 text-muted-foreground">
              <span className="tabular">
                {formatReviewDate(job.requestedAt)}
              </span>
              {job.file && (
                <a
                  href={publicApiUrl(job.file.downloadPath)}
                  download
                  className="font-semibold text-primary underline-offset-4 hover:underline"
                >
                  {t("reportViewer.export.download")}
                </a>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  definition,
  selection,
  personal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  definition: ReportDefinition;
  selection: ReportQuerySelection;
  /** DASH-04: this view's output singles out a person. */
  personal: boolean;
}) {
  const t = useT();
  const formatLabel = useFormatLabel();
  const [format, setFormat] = useState<ReportExportFormat>(
    definition.exportFormats[0] ?? "csv",
  );
  const create = useCreateReportExport();
  const jobQuery = useReportExportJob(create.data?.id ?? null);
  const job = jobQuery.data ?? create.data ?? null;

  const error =
    create.error instanceof ApiError
      ? create.error.code === "EXPORT_PII_APPROVAL_REQUIRED"
        ? t("reportViewer.export.errors.approval")
        : create.error.code === "REPORT_NOT_PERMITTED"
          ? t("reportViewer.export.errors.permission")
          : create.error.code === "EXPORT_FORMAT_NOT_SUPPORTED"
            ? t("reportViewer.export.errors.format")
            : create.error.status === 0
              ? t("reportViewer.export.errors.offline")
              : t("reportViewer.export.errors.generic")
      : create.error
        ? t("reportViewer.export.errors.generic")
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("reportViewer.export.title")}</DialogTitle>
          <DialogDescription>
            {t("reportViewer.export.description", { report: definition.name })}
          </DialogDescription>
        </DialogHeader>

        {personal && (
          <div
            role="note"
            data-testid="export-pii-notice"
            className="flex gap-3 rounded-container bg-warning-subtle p-card text-warning"
          >
            <ShieldAlert
              className="mt-0.5 size-5 shrink-0"
              aria-hidden="true"
            />
            <div className="grid gap-1 text-sm leading-5">
              <p className="font-semibold">
                {t("reportViewer.export.piiTitle")}
              </p>
              <p>{t("reportViewer.export.piiBody")}</p>
            </div>
          </div>
        )}

        <div className="grid gap-2">
          <p className="type-eyebrow text-muted-foreground">
            {t("reportViewer.export.format")}
          </p>
          <SegmentedControl
            label={t("reportViewer.export.format")}
            value={format}
            onValueChange={setFormat}
            options={definition.exportFormats.map((item) => ({
              value: item,
              label: formatLabel(item),
            }))}
          />
          <p className="text-sm leading-5 text-muted-foreground">
            {t("reportViewer.export.scope", {
              from: formatBusinessDate(selection.period.startDate),
              to: formatBusinessDate(selection.period.endDate),
            })}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {error}
          </p>
        )}
        {job && <ExportJobSummary job={job} />}
        <RecentExports reportCode={definition.code} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                buildExportInput(
                  definition.code,
                  format,
                  selection,
                  `exp-${globalThis.crypto.randomUUID()}`,
                ),
              )
            }
          >
            {personal
              ? t("reportViewer.export.requestApproval")
              : t("reportViewer.export.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
