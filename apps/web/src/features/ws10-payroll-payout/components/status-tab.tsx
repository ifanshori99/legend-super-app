// Status karyawan tab (legend-wnkep.7): the result of a payout employee by
// employee. Manual transfer files download once, results are recorded by a
// second person with MFA (and password when asked), an `unknown` result has
// no pay-again button. A failed or unsent transfer, and funds that came back,
// are recorded with an uploaded proof photo. Buttons are switched off for clarity only; the server
// stays the checker and its refusals are always shown.
import * as React from "react";
import { CircleAlert, Download } from "lucide-react";
import type { PayrollDisbursementItemDto } from "@starter/shared/types";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { payoutErrorMessage } from "../errors";
import { useBatch, useExportBatch, useResolutionProposals } from "../hooks";
import { batchStatusMeta, type PayoutTabProps } from "../lib";
import { ReturnWithdrawSection } from "./return-withdraw";
import {
  ExcludedList,
  isExcludedItem,
  useEmployeeLine,
} from "./approval-items";
import {
  CashDialog,
  DetailDialog,
  ResultDialog,
  ReturnDialog,
  WithdrawProposalDialog,
} from "./status-dialogs";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { FreezeBadge, FreezeBanner } from "./freeze-banner";
import {
  StatusList,
  proposalFor,
  withdrawableProposal,
  type RowAction,
} from "./status-items";
import { summarizeGroups } from "./status-groups";
import { StatusSummary } from "./status-summary";

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
  kind: "record" | "cash" | "detail" | "return" | "withdraw";
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
  const proposals = useResolutionProposals(batchId);
  const line = useEmployeeLine();
  const [dialog, setDialog] = React.useState<ActiveDialog>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const exportStepUp = useStepUp({ acceptsPassword: true });
  // isPending flips a macrotask late: a fast double click would run the export
  // twice, so a ref closes the gap until the request settles.
  const inFlightRef = React.useRef(false);

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
  const showOverpaid = groups.overpaid.count > 0;
  const isCreator = batch.requestedBy === currentUserId;
  const canRecord = (access.canApprove || access.canRequest) && !isCreator;
  const blockKey = isCreator ? "creator" : !canRecord ? "access" : null;
  // Funds that came back are recorded for a manual transfer that was paid.
  const canReturn = batch.channel === "manual_bank" && access.canApprove;
  // The proposer or another approver takes back a proposal; the creator never.
  const withdrawBlockKey = isCreator
    ? "creator"
    : !access.canApprove
      ? "access"
      : null;
  const canExport =
    batch.channel === "manual_bank" &&
    batch.status === "approved" &&
    (access.canApprove || access.canRequest);

  const onAction = (action: RowAction, item: PayrollDisbursementItemDto) => {
    if (action === "check") {
      void query.refetch();
      return;
    }
    if (action === "withdraw") {
      if (withdrawBlockKey === null) setDialog({ kind: "withdraw", item });
      return;
    }
    if (action === "record" || action === "cash") {
      setDialog({ kind: action, item });
      return;
    }
    setDialog({ kind: "detail", item });
  };

  // The password only lives in the panel for the one retry: it is sent as an
  // argument, never kept in state, logged or stored.
  const download = (password?: string) => {
    if (inFlightRef.current || exportFile.isPending) return;
    setExportError(null);
    inFlightRef.current = true;
    exportFile.mutate(
      { batchId: batch.id, ...(password ? { password } : {}) },
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
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  };

  const visibleTiles = (
    [
      ["waiting", true],
      ["unknown", showUnknown],
      ["succeeded", true],
      ["failed", true],
      ["manual", true],
      ["returned", groups.returned.count > 0],
      ["overpaid", showOverpaid],
    ] as const
  )
    .filter(([, show]) => show)
    .map(([key]) => key);
  const closeDialog = () => setDialog(null);
  // The first person's proposal for an item, only of the kind the dialog records.
  const proposalOf = (
    item: PayrollDisbursementItemDto,
    kind: "resolve" | "return",
  ) => {
    const found = proposalFor(proposals, item.id);
    return found?.kind === kind ? found : undefined;
  };
  const withdrawing =
    dialog?.kind === "withdraw"
      ? withdrawableProposal(proposals, dialog.item.id)
      : undefined;
  const isMine = (item: PayrollDisbursementItemDto) =>
    proposalFor(proposals, item.id)?.proposedBy === currentUserId;

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
        <div className="flex flex-wrap items-center gap-2">
          <FreezeBadge batch={batch} />
          <Badge tone={batchStatusMeta(batch.status).kind}>
            {t(batchStatusMeta(batch.status).labelKey)}
          </Badge>
        </div>
      </header>

      <FreezeBanner batch={batch} canUnfreeze={access.canApprove} />

      {showOverpaid && (
        <div
          role="alert"
          data-testid="status-overpaid-banner"
          className="flex gap-3 rounded-container bg-danger p-4 text-danger-foreground"
        >
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("payrollPayoutReview.status.overpaidBanner.title")}
            </p>
            <p className="text-sm">
              {t("payrollPayoutReview.status.overpaidBanner.description", {
                count: groups.overpaid.count,
              })}
            </p>
          </div>
        </div>
      )}

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
            onClick={() => download()}
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
              onCancel={() => {
                exportStepUp.reset();
                setExportError(null);
              }}
            />
          )}
          {exportError && !exportStepUp.active && (
            <p role="alert" className="text-sm font-medium text-danger">
              {exportError}
            </p>
          )}
        </section>
      )}

      <StatusSummary
        label={t("payrollPayoutReview.status.summaryLabel")}
        tiles={visibleTiles.map((key) => ({
          key,
          label: t(`payrollPayoutReview.status.tile.${key}`),
          count: groups[key].count,
          amountIdr: groups[key].amountIdr,
        }))}
        unit={t("payrollPayoutReview.status.tile.unit")}
      />

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
            proposals={proposals}
            withdrawBlockKey={withdrawBlockKey}
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

      {canReturn && (
        <ReturnWithdrawSection
          batchId={batch.id}
          currentUserId={currentUserId}
          isCreator={isCreator}
        />
      )}

      {dialog?.kind === "record" && (
        <ResultDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item)}
          proposal={proposalOf(dialog.item, "resolve")}
          mine={isMine(dialog.item)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "cash" && (
        <CashDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "detail" && (
        <DetailDialog
          item={dialog.item}
          person={line(dialog.item)}
          onClose={closeDialog}
          onReturn={
            canReturn && dialog.item.status === "succeeded"
              ? () => setDialog({ kind: "return", item: dialog.item })
              : undefined
          }
        />
      )}
      {dialog?.kind === "withdraw" && withdrawing && (
        <WithdrawProposalDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item)}
          proposal={withdrawing}
          mine={isMine(dialog.item)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "return" && (
        <ReturnDialog
          batchId={batch.id}
          item={dialog.item}
          person={line(dialog.item)}
          proposal={proposalOf(dialog.item, "return")}
          mine={isMine(dialog.item)}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
