// /kelola/akuntansi/tutup-periode — fiscal periods, close checklist, snapshot
// and reopen approvals (PRD v1.7 §3.19 "Tutup Periode"; ACC-02 "Transaksi di
// periode yang sudah ditutup ditolak kecuali periode dibuka ulang dengan
// approval").
import * as React from "react";
import { Link } from "@tanstack/react-router";
import type {
  FiscalPeriod,
  PeriodReopenRequest,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/features/ws07-accounting/components/confirm-dialog";
import { ApiError } from "@/lib/api/errors";
import {
  MIN_REOPEN_REASON_LENGTH,
  businessDateToday,
  closedPeriodCount,
  formatDateTime,
  formatPeriod,
  isReopenable,
  latestClosedPeriod,
  nextPeriodToClose,
  openPeriodCount,
  shortUserId,
} from "../lib";
import {
  useApprovePeriodReopen,
  useFiscalPeriods,
  useRejectPeriodReopen,
  useReopenRequests,
  useRequestPeriodReopen,
} from "../hooks";
import { PeriodCloseDialog } from "./period-close-dialog";
import { PeriodSnapshotSheet } from "./period-snapshot-sheet";
import { ReasonDialog } from "./reason-dialog";
import { PeriodStatusBadge, ReopenStatusBadge } from "./status-badges";

/**
 * Server refusals of a reopen decision, in catalog words. The different-
 * approver rule (AUTH-06) is enforced by the API (403 APPROVER_IS_REQUESTER);
 * the screen only states the rule and surfaces the refusal.
 */
function reopenDecisionError(
  error: unknown,
  t: ReturnType<typeof useT>,
): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case "APPROVER_IS_REQUESTER":
      return t("accounting.report.periods.reopen.approverIsRequester");
    case "APPROVER_IS_CLOSER":
      return t("accounting.report.periods.reopen.approverIsCloser");
    case "PERIOD_REOPEN_OUT_OF_ORDER":
      return t("accounting.report.periods.reopen.outOfOrder");
    case "PERIOD_HAS_APPROVED_DISTRIBUTION":
      return t("accounting.report.periods.reopen.hasApprovedDistribution");
    case "PERIOD_ALREADY_OPEN":
      return t("accounting.report.periods.reopen.alreadyOpen");
    case "INVALID_TRANSITION":
      return t("accounting.report.periods.reopen.alreadyDecided");
    default:
      return error.message;
  }
}

export function PeriodsPage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const toast = useToast();
  const today = businessDateToday();
  const periodsQuery = useFiscalPeriods(legalEntityId);
  const requestsQuery = useReopenRequests(legalEntityId);
  const requestReopen = useRequestPeriodReopen(legalEntityId);
  const approveReopen = useApprovePeriodReopen(legalEntityId);
  const rejectReopen = useRejectPeriodReopen(legalEntityId);

  const [closing, setClosing] = React.useState<FiscalPeriod | null>(null);
  const [snapshotPeriod, setSnapshotPeriod] =
    React.useState<FiscalPeriod | null>(null);
  const [requesting, setRequesting] = React.useState<FiscalPeriod | null>(null);
  const [approving, setApproving] = React.useState<PeriodReopenRequest | null>(
    null,
  );
  const [rejecting, setRejecting] = React.useState<PeriodReopenRequest | null>(
    null,
  );
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [rejectError, setRejectError] = React.useState<string | null>(null);
  // A reopen the API refused because an approved distribution stands on the
  // closed period: the notice links to where the run is withdrawn.
  const [distributionBlock, setDistributionBlock] = React.useState(false);

  const periods = React.useMemo(
    () =>
      [...(periodsQuery.data ?? [])].sort((left, right) =>
        left.period.localeCompare(right.period),
      ),
    [periodsQuery.data],
  );
  const requests = requestsQuery.data ?? [];
  const next = nextPeriodToClose(periods, today);
  const latestClosed = latestClosedPeriod(periods);

  const pending = periodsQuery.isPending;
  const failed = periodsQuery.isError;
  const periodState: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : periods.length === 0
        ? "empty"
        : "ready";
  const requestState: DataState = requestsQuery.isPending
    ? "loading"
    : requestsQuery.isError
      ? "error"
      : requests.length === 0
        ? "empty"
        : "ready";

  const stat = (ready: React.ReactNode) =>
    pending ? (
      <Skeleton className="h-8 w-24" />
    ) : failed ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      ready
    );

  const closedDetail = (period: FiscalPeriod) =>
    period.closedAt && period.closedBy
      ? `${formatDateTime(period.closedAt)} · ${t(
          "accounting.report.periods.closedBy",
          { user: shortUserId(period.closedBy) },
        )}`
      : t("accounting.report.periods.openHint");

  const periodActions = (period: FiscalPeriod) => (
    <div className="flex flex-wrap justify-end gap-2">
      {period.status === "open" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setClosing(period)}
        >
          {t("accounting.report.periods.close")}
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSnapshotPeriod(period)}
          >
            {t("accounting.report.periods.snapshot")}
          </Button>
          {isReopenable(period, periods) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRequestError(null);
                setRequesting(period);
              }}
            >
              {t("accounting.report.periods.requestReopen")}
            </Button>
          )}
        </>
      )}
    </div>
  );

  const submitRequest = async (reason: string) => {
    if (!requesting) return;
    setRequestError(null);
    try {
      await requestReopen.mutateAsync({
        fiscalPeriodId: requesting.id,
        reason,
      });
      toast({
        title: t("accounting.report.periods.reopen.requested"),
        tone: "success",
      });
      setRequesting(null);
    } catch (error) {
      setRequestError(
        error instanceof ApiError
          ? error.message
          : t("accounting.report.periods.reopen.requestFailed"),
      );
    }
  };

  const confirmApprove = async () => {
    if (!approving) return;
    setDistributionBlock(false);
    try {
      const result = await approveReopen.mutateAsync({
        requestId: approving.id,
        note: null,
      });
      toast({
        title: t("accounting.report.periods.reopen.approved", {
          period: formatPeriod(result.period.period),
        }),
        tone: "success",
      });
      setApproving(null);
    } catch (error) {
      setDistributionBlock(
        error instanceof ApiError &&
          error.code === "PERIOD_HAS_APPROVED_DISTRIBUTION",
      );
      toast({
        title: t("accounting.report.periods.reopen.failed"),
        description: reopenDecisionError(error, t),
        tone: "danger",
      });
      setApproving(null);
    }
  };

  const submitReject = async (reason: string) => {
    if (!rejecting) return;
    setRejectError(null);
    try {
      await rejectReopen.mutateAsync({ requestId: rejecting.id, reason });
      toast({
        title: t("accounting.report.periods.reopen.rejected"),
        tone: "success",
      });
      setRejecting(null);
    } catch (error) {
      setRejectError(
        reopenDecisionError(error, t) ??
          t("accounting.report.periods.reopen.failed"),
      );
    }
  };

  return (
    <div className="grid min-w-0 gap-5">
      {distributionBlock && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground"
        >
          <p className="min-w-0 max-w-3xl leading-5">
            {t("accounting.report.periods.reopen.hasApprovedDistribution")}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/kelola/akuntansi/bagi-hasil/distribusi">
              {t("accounting.report.periods.reopen.goToDistributions")}
            </Link>
          </Button>
        </div>
      )}
      <StatStrip
        label={t("accounting.report.periods.summaryLabel")}
        columns={3}
      >
        <StatTile
          label={t("accounting.report.periods.statOpen")}
          value={stat(openPeriodCount(periods))}
          context={
            pending || failed
              ? undefined
              : t("accounting.report.periods.statOpenContext")
          }
        />
        <StatTile
          label={t("accounting.report.periods.statClosed")}
          value={stat(closedPeriodCount(periods))}
          context={
            pending || failed
              ? undefined
              : t("accounting.report.periods.statClosedContext")
          }
        />
        <StatTile
          label={t("accounting.report.periods.statNext")}
          value={stat(
            next
              ? formatPeriod(next.period)
              : t("accounting.report.periods.statNextNone"),
          )}
          context={
            pending || failed
              ? undefined
              : next
                ? t("accounting.report.periods.statNextContext")
                : t("accounting.report.periods.statNextNoneHint")
          }
        />
      </StatStrip>

      <DataTableShell
        title={t("accounting.report.periods.tableTitle")}
        description={t("accounting.report.periods.tableSubtitle")}
        state={periodState}
        onRetry={() => void periodsQuery.refetch()}
        loadingRows={4}
        rowCount={periods.length}
        empty={{
          title: t("accounting.report.periods.emptyTitle"),
          description: t("accounting.report.periods.emptyHint"),
        }}
      >
        {/* Phones: one card per period. */}
        <ul className="divide-y divide-border md:hidden">
          {periods.map((period) => (
            <li key={period.id} className="grid gap-2 p-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {formatPeriod(period.period)}
                </span>
                <PeriodStatusBadge status={period.status} />
              </div>
              <div className="grid gap-0.5 text-sm text-muted-foreground">
                <span className="tabular">{closedDetail(period)}</span>
                {period.reopenedAt && (
                  <span className="tabular">
                    {t("accounting.report.periods.reopenedHint", {
                      time: formatDateTime(period.reopenedAt),
                    })}
                  </span>
                )}
                <span className="tabular">
                  {t("accounting.report.periods.columns.version")}{" "}
                  {period.version}
                </span>
              </div>
              {periodActions(period)}
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("accounting.report.periods.columns.period")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.columns.status")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.columns.closed")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.report.periods.columns.version")}
                </TableHead>
                <TableHead className="text-right">
                  {t("accounting.report.periods.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.map((period) => (
                <TableRow key={period.id}>
                  <TableCell className="font-medium">
                    {formatPeriod(period.period)}
                  </TableCell>
                  <TableCell>
                    <PeriodStatusBadge status={period.status} />
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm tabular">
                      {closedDetail(period)}
                    </span>
                    {period.reopenedAt && (
                      <span className="block text-xs text-muted-foreground tabular">
                        {t("accounting.report.periods.reopenedHint", {
                          time: formatDateTime(period.reopenedAt),
                        })}
                      </span>
                    )}
                    {period.reopenedReason && (
                      <span className="block text-xs text-muted-foreground">
                        {t("accounting.report.periods.reopenedReason", {
                          reason: period.reopenedReason,
                        })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell numeric>{period.version}</TableCell>
                  <TableCell className="text-right">
                    {periodActions(period)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>

      <DataTableShell
        title={t("accounting.report.periods.reopen.requestsTitle")}
        description={t("accounting.report.periods.reopen.requestsSubtitle")}
        state={requestState}
        onRetry={() => void requestsQuery.refetch()}
        loadingRows={3}
        rowCount={requests.length}
        empty={{
          title: t("accounting.report.periods.reopen.requestsEmptyTitle"),
          description: t("accounting.report.periods.reopen.requestsEmptyHint"),
          action:
            latestClosed && requestState === "empty" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRequestError(null);
                  setRequesting(latestClosed);
                }}
              >
                {t("accounting.report.periods.requestReopen")}
              </Button>
            ) : undefined,
        }}
      >
        <ul className="divide-y divide-border md:hidden">
          {requests.map((request) => (
            <li key={request.id} className="grid gap-2 p-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {formatPeriod(request.period)}
                </span>
                <ReopenStatusBadge status={request.status} />
              </div>
              <p className="text-sm leading-5">{request.reason}</p>
              <div className="grid gap-0.5 text-sm text-muted-foreground">
                <span className="tabular">
                  {t("accounting.report.periods.reopen.columns.requested")} ·{" "}
                  {formatDateTime(request.requestedAt)} ·{" "}
                  {shortUserId(request.requestedBy)}
                </span>
                {request.decidedAt && (
                  <span className="tabular">
                    {t("accounting.report.periods.reopen.columns.decided")} ·{" "}
                    {formatDateTime(request.decidedAt)} ·{" "}
                    {shortUserId(request.decidedBy)}
                  </span>
                )}
                {request.decisionNote && (
                  <span>
                    {t("accounting.report.periods.reopen.decisionNote", {
                      note: request.decisionNote,
                    })}
                  </span>
                )}
              </div>
              {request.status === "pending" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setApproving(request)}
                  >
                    {t("accounting.report.periods.reopen.approve")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRejectError(null);
                      setRejecting(request);
                    }}
                  >
                    {t("accounting.report.periods.reopen.reject")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("accounting.report.periods.reopen.columns.period")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.reopen.columns.reason")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.reopen.columns.status")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.reopen.columns.requested")}
                </TableHead>
                <TableHead>
                  {t("accounting.report.periods.reopen.columns.decided")}
                </TableHead>
                <TableHead className="text-right">
                  {t("accounting.report.periods.reopen.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {formatPeriod(request.period)}
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-md text-sm leading-5">
                      {request.reason}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ReopenStatusBadge status={request.status} />
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm tabular">
                      {formatDateTime(request.requestedAt)}
                    </span>
                    <span className="block text-xs text-muted-foreground font-mono">
                      {shortUserId(request.requestedBy)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {request.decidedAt ? (
                      <>
                        <span className="block text-sm tabular">
                          {formatDateTime(request.decidedAt)}
                        </span>
                        <span className="block text-xs text-muted-foreground font-mono">
                          {shortUserId(request.decidedBy)}
                        </span>
                        {request.decisionNote && (
                          <span className="block max-w-md text-xs text-muted-foreground">
                            {t(
                              "accounting.report.periods.reopen.decisionNote",
                              { note: request.decisionNote },
                            )}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t("accounting.report.periods.reopen.empty")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {request.status === "pending" ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => setApproving(request)}
                        >
                          {t("accounting.report.periods.reopen.approve")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRejectError(null);
                            setRejecting(request);
                          }}
                        >
                          {t("accounting.report.periods.reopen.reject")}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t("accounting.report.periods.reopen.empty")}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>

      <PeriodCloseDialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
        legalEntityId={legalEntityId}
        period={closing}
        entityPeriods={periods}
      />

      <PeriodSnapshotSheet
        open={snapshotPeriod !== null}
        onOpenChange={(open) => {
          if (!open) setSnapshotPeriod(null);
        }}
        legalEntityId={legalEntityId}
        period={snapshotPeriod}
      />

      <ReasonDialog
        open={requesting !== null}
        onOpenChange={(open) => {
          if (!open) setRequesting(null);
        }}
        title={t("accounting.report.periods.reopen.requestTitle", {
          period: requesting ? formatPeriod(requesting.period) : "",
        })}
        description={t("accounting.report.periods.reopen.requestHint")}
        label={t("accounting.report.periods.reopen.reason")}
        hint={t("accounting.report.periods.reopen.reasonHint", {
          count: MIN_REOPEN_REASON_LENGTH,
        })}
        submitLabel={t("accounting.report.periods.reopen.requestSubmit")}
        requiredMessage={t("accounting.report.periods.reopen.reasonRequired")}
        tooShortMessage={t("accounting.report.periods.reopen.reasonTooShort", {
          count: MIN_REOPEN_REASON_LENGTH,
        })}
        minLength={MIN_REOPEN_REASON_LENGTH}
        pending={requestReopen.isPending}
        error={requestError ?? undefined}
        onSubmit={(reason) => void submitRequest(reason)}
      />

      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(open) => {
          if (!open) setApproving(null);
        }}
        title={t("accounting.report.periods.reopen.approveTitle", {
          period: approving ? formatPeriod(approving.period) : "",
        })}
        description={t("accounting.report.periods.reopen.approveBody")}
        confirmLabel={t("accounting.report.periods.reopen.approveSubmit")}
        destructive={false}
        pending={approveReopen.isPending}
        onConfirm={() => void confirmApprove()}
      />

      <ReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null);
        }}
        title={t("accounting.report.periods.reopen.rejectTitle", {
          period: rejecting ? formatPeriod(rejecting.period) : "",
        })}
        description={t("accounting.report.periods.reopen.rejectReasonHint")}
        label={t("accounting.report.periods.reopen.rejectReason")}
        hint={t("accounting.report.periods.reopen.rejectReasonHint")}
        submitLabel={t("accounting.report.periods.reopen.rejectSubmit")}
        requiredMessage={t("accounting.report.periods.reopen.reasonRequired")}
        tooShortMessage={t("accounting.report.periods.reopen.reasonTooShort", {
          count: 1,
        })}
        minLength={1}
        pending={rejectReopen.isPending}
        error={rejectError ?? undefined}
        onSubmit={(reason) => void submitReject(reason)}
      />
    </div>
  );
}
