// The distribution runs of one profit entity: period/basis, status, total,
// who created and approved it, and how far the payments got. Opening a row
// resumes the wizard from the run's own status.
import { PlayCircle } from "lucide-react";
import type { DistributionRunSummary } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
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
  canCancelApprovedSummary,
  formatShareDateTime,
  formatSharePeriod,
  runSummaryProgress,
  shortActorRef,
} from "../lib";
import { Badge } from "@/components/ui/badge";
import { RunStatusBadge } from "./share-status";

export function DistributionRunsTable({
  runs,
  state,
  canWrite,
  canApprove,
  onRetry,
  onCreate,
  onOpen,
  onCancelApproved,
}: {
  runs: readonly DistributionRunSummary[];
  state: DataState;
  canWrite: boolean;
  /** May approve distributions, and so withdraw an approval. */
  canApprove: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (run: DistributionRunSummary) => void;
  onCancelApproved: (run: DistributionRunSummary) => void;
}) {
  const t = useT();
  return (
    <DataTableShell
      title={t("accounting.share.runs.title")}
      description={t("accounting.share.runs.subtitle")}
      state={state}
      onRetry={onRetry}
      rowCount={runs.length}
      actions={
        canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <PlayCircle aria-hidden="true" />
            {t("accounting.share.runs.new")}
          </Button>
        ) : undefined
      }
      empty={{
        title: t("accounting.share.runs.emptyTitle"),
        description: t("accounting.share.runs.emptyHint"),
        action: canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <PlayCircle aria-hidden="true" />
            {t("accounting.share.runs.new")}
          </Button>
        ) : undefined,
      }}
    >
      <Table className="min-w-[56rem]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("accounting.share.runs.columns.period")}</TableHead>
            <TableHead>{t("accounting.share.runs.columns.type")}</TableHead>
            <TableHead>{t("accounting.share.runs.columns.status")}</TableHead>
            <TableHead numeric>
              {t("accounting.share.runs.columns.total")}
            </TableHead>
            <TableHead>{t("accounting.share.runs.columns.created")}</TableHead>
            <TableHead>{t("accounting.share.runs.columns.approved")}</TableHead>
            <TableHead>{t("accounting.share.runs.columns.payment")}</TableHead>
            <TableHead className="text-right">
              {t("accounting.share.runs.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const percent = runSummaryProgress(run);
            return (
              <TableRow key={run.id}>
                <TableCell className="font-semibold">
                  {formatSharePeriod(run.period)}
                </TableCell>
                <TableCell>
                  {run.type === "adjustment"
                    ? t("accounting.share.runType.adjustment")
                    : t("accounting.share.runType.regular")}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <RunStatusBadge status={run.status} />
                    {run.needsCorrection ? (
                      <button
                        type="button"
                        className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
                        aria-label={t(
                          "accounting.share.runs.needsCorrectionAria",
                          { period: formatSharePeriod(run.period) },
                        )}
                        onClick={() =>
                          canApprove && canCancelApprovedSummary(run)
                            ? onCancelApproved(run)
                            : onOpen(run)
                        }
                      >
                        <Badge tone="warning">
                          {t("accounting.share.runs.needsCorrection")}
                        </Badge>
                      </button>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell numeric>
                  <Money amount={run.distributableIdr} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <span className="tabular">
                    {shortActorRef(run.requestedBy)}
                  </span>
                  <br />
                  <span>{formatShareDateTime(run.requestedAt)}</span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {run.approvedAt
                    ? formatShareDateTime(run.approvedAt)
                    : t("accounting.share.emptyValue")}
                </TableCell>
                <TableCell>
                  <div className="grid gap-1">
                    <span className="text-sm text-muted-foreground tabular">
                      {t("accounting.share.runs.progress", {
                        paid: run.paidLineCount,
                        total: run.lineCount,
                      })}
                    </span>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${percent}%` }}
                      />
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {canApprove && canCancelApprovedSummary(run) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(
                        "accounting.share.runs.cancelApprovedAria",
                        {
                          period: formatSharePeriod(run.period),
                        },
                      )}
                      onClick={() => onCancelApproved(run)}
                    >
                      {t("accounting.share.wizard.cancelApproved.action")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("accounting.share.runs.openAria", {
                      period: formatSharePeriod(run.period),
                    })}
                    onClick={() => onOpen(run)}
                  >
                    {t("accounting.share.runs.open")}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
