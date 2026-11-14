// Status karyawan tab (legend-wnkep.7): the result of a payout employee by
// employee. Manual transfer files download once, results are recorded by a
// second person with MFA (and password when asked), an `unknown` result has
// no pay-again button. Buttons are switched off for clarity only; the server
// stays the checker and its refusals are always shown.
import * as React from "react";
import { CircleAlert, Download } from "lucide-react";
import type { PayrollDisbursementItemDto } from "@starter/shared/types";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { useToast } from "@/components/ui/toast";
import { cn } from "cn";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { payoutErrorMessage } from "../errors";
import { useBatch, useExportBatch } from "../hooks";
import { batchStatusMeta, type PayoutTabProps } from "../lib";
import {
  ExcludedList,
  isExcludedItem,
  useEmployeeLine,
} from "./approval-items";
import { CashDialog, DetailDialog, ResultDialog } from "./status-dialogs";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { StatusList, type RowAction } from "./status-items";
import { summarizeGroups } from "./status-groups";

export type StatusTabProps = PayoutTabProps & {
  /** Optional: sends the user to the Siap bayar tab from the empty state. */
  onOpenRuns?: () => void;
};

export function StatusTab(props: StatusTabProps) {
  const t = useT();
  if (!props.batchId) {
    return (
      <EmptyState
        data-testid="status-empty"
        title={t("payrollPayoutReview.status.empty.title")}
        description={t("payrollPayoutReview.status.empty.description")}
        action={
          props.onOpenRuns && (
            <Button
              type="button"
              className="min-h-11"
              onClick={props.onOpenRuns}
            >
              {t("payrollPayoutReview.status.empty.action")}
            </Button>
          )
        }
      />
    );
  }
  return <StatusBatch {...props} batchId={props.batchId} />;
}

function StatusSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayoutReview.common.loadingLabel")}
      className="grid gap-4"
    >
      <Skeleton className="h-6 w-56" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

type ActiveDialog = {
  kind: "record" | "cash" | "detail";
  item: PayrollDisbursementItemDto;
} | null;

function StatusBatch({
  batchId,
  access,
  currentUserId,
}: StatusTabProps & { batchId: string }) {
  const t = useT();
  const toast = useToast();
  const query = useBatch(batchId);
  const exportFile = useExportBatch();
  const line = useEmployeeLine();
  const [dialog, setDialog] = React.useState<ActiveDialog>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const exportStepUp = useStepUp();

  if (query.isPending) return <StatusSkeleton />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        error={query.error}
        title={t("payrollPayoutReview.status.error.title")}
        description={t("payrollPayoutReview.status.error.description")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const batch = query.data;
  const excluded = batch.items.filter(isExcludedItem);
  const listed = batch.items.filter((item) => !isExcludedItem(item));
  const groups = summarizeGroups(listed, batch);
  const paidIdr = groups.succeeded.amountIdr + groups.manual.amountIdr;
  const restIdr =
    groups.waiting.amountIdr +
    groups.unknown.amountIdr +
    groups.failed.amountIdr;
  const showUnknown = groups.unknown.count > 0;
  const isCreator = batch.requestedBy === currentUserId;
  const canRecord = (access.canApprove || access.canRequest) && !isCreator;
  const blockKey = isCreator ? "creator" : !canRecord ? "access" : null;
  const canExport =
    batch.channel === "manual_bank" &&
    batch.status === "approved" &&
    (access.canApprove || access.canRequest);

  const onAction = (action: RowAction, item: PayrollDisbursementItemDto) => {
    if (action === "check") {
      void query.refetch();
      return;
    }
    if (action === "record" || action === "cash") {
      setDialog({ kind: action, item });
      return;
    }
    setDialog({ kind: "detail", item });
  };

  const download = () => {
    if (exportFile.isPending) return;
    setExportError(null);
    exportFile.mutate(
      { batchId: batch.id },
      {
        onSuccess: () => {
          exportStepUp.reset();
          toast({
            title: t("payrollPayoutReview.status.export.done"),
            tone: "success",
          });
        },
        onError: (failure) => {
          if (exportStepUp.capture(failure)) return;
          setExportError(payoutErrorMessage(failure, t));
        },
      },
    );
  };

  const tiles: {
    key: "waiting" | "unknown" | "succeeded" | "failed" | "manual";
    show: boolean;
  }[] = [
    { key: "waiting", show: true },
    { key: "unknown", show: showUnknown },
    { key: "succeeded", show: true },
    { key: "failed", show: true },
    { key: "manual", show: true },
  ];
  const visibleTiles = tiles.filter((tile) => tile.show);
  const closeDialog = () => setDialog(null);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid gap-1">
          <p className="type-eyebrow text-muted-foreground">
            {t("payrollPayoutReview.status.eyebrow", {
              channel: t(`payrollPayoutReview.channel.${batch.channel}`),
            })}
          </p>
          <h2 className="type-title">
            {t("payrollPayoutReview.status.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {query.dataUpdatedAt > 0 &&
              t("payrollPayoutReview.status.updated", {
                time: formatDateTime(
                  new Date(query.dataUpdatedAt).toISOString(),
                ),
              })}
          </p>
        </div>
        <p className="rounded-full bg-warning-subtle px-2.5 py-0.5 text-xs font-semibold text-warning">
          {t(batchStatusMeta(batch.status).labelKey)}
        </p>
      </header>

      {showUnknown && (
        <div
          role="alert"
          data-testid="status-unknown-banner"
          className="flex gap-3 rounded-container border-(length:--border-w) bg-warning-subtle p-4 text-warning"
        >
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("payrollPayoutReview.status.unknownBanner.title")}
            </p>
            <p className="text-sm text-foreground">
              {t("payrollPayoutReview.status.unknownBanner.description")}
            </p>
          </div>
        </div>
      )}

      {canExport && (
        <section
          aria-label={t("payrollPayoutReview.status.export.title")}
          data-testid="status-export"
          className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-4"
        >
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("payrollPayoutReview.status.export.title")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutReview.status.export.description")}
            </p>
          </div>
          <Button
            type="button"
            className="min-h-11 w-full min-[700px]:w-fit"
            loading={exportFile.isPending && !exportStepUp.active}
            disabled={exportStepUp.active}
            onClick={download}
          >
            <Download aria-hidden="true" />
            {t("payrollPayoutReview.status.export.button")}
          </Button>
          {exportStepUp.active && (
            <VerifyPanel
              key={exportStepUp.round}
              needs={exportStepUp.needs}
              busy={exportFile.isPending}
              error={exportError}
              onVerified={download}
            />
          )}
          {exportError && !exportStepUp.active && (
            <p role="alert" className="text-sm font-medium text-danger">
              {exportError}
            </p>
          )}
        </section>
      )}

      <div
        className={cn(
          "grid gap-3 sm:grid-cols-2",
          visibleTiles.length > 4 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        )}
      >
        {visibleTiles.map(({ key }) => (
          <StatTile
            key={key}
            label={t(`payrollPayoutReview.status.tile.${key}`)}
            value={groups[key].count}
            context={`${formatRupiah(groups[key].amountIdr)} · ${t(
              "payrollPayoutReview.status.tile.people",
              { count: groups[key].count },
            )}`}
          />
        ))}
      </div>

      <section
        aria-label={t("payrollPayoutReview.status.results.title")}
        className="grid gap-4 rounded-shell border-(length:--border-w) bg-card p-card shadow-hairline"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="type-title">
              {t("payrollPayoutReview.status.results.title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutReview.status.results.summary", {
                paid: formatRupiah(paidIdr),
                rest: formatRupiah(restIdr),
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t("payrollPayoutReview.common.refresh")}
          </Button>
        </div>
        {listed.length === 0 ? (
          <EmptyState
            title={t("payrollPayoutReview.status.empty.title")}
            description={t("payrollPayoutReview.status.empty.description")}
          />
        ) : (
          <StatusList
            batch={batch}
            items={listed}
            canRecord={canRecord}
            recordBlockKey={blockKey}
            onAction={onAction}
          />
        )}
        <ExcludedList
          items={excluded}
          title={t("payrollPayoutReview.status.excluded.title", {
            count: excluded.length,
          })}
          hint={t("payrollPayoutReview.status.excluded.hint")}
        />
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutReview.status.footnote")}
        </p>
      </section>

      {dialog?.kind === "record" && (
        <ResultDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item.employeeId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "cash" && (
        <CashDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item.employeeId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "detail" && (
        <DetailDialog
          item={dialog.item}
          person={line(dialog.item.employeeId)}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
