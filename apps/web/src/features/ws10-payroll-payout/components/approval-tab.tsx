// Persetujuan tab (legend-wnkep.7): a second person checks one payout batch
// and approves it. The creator cannot approve their own batch; the button is
// switched off with the reason for clarity, but the server stays the checker
// and its refusal is always shown. MFA_REQUIRED opens the step-up panel.
import * as React from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { payoutErrorMessage } from "../errors";
import {
  useApproveBatch,
  useBatch,
  usePayoutConfig,
  usePayoutSourceAccounts,
  usePayoutUserNames,
} from "../hooks";
import { batchFeeTotal, batchFundsNeeded, type PayoutTabProps } from "../lib";
import {
  ExcludedList,
  PayeeTable,
  isExcludedItem,
  isPayableItem,
  lacksAccountSnapshot,
} from "./approval-items";
import { CancelBatchButton, canCancelStatus } from "./approval-cancel";
import { ApprovalSteps } from "./approval-steps";
import { ApprovalSummary } from "./approval-summary";
import { VerifyPanel, useStepUp } from "./approval-verify";

export type ApprovalTabProps = PayoutTabProps & {
  /** Optional: sends the user to the Siap bayar tab from the empty state. */
  onOpenRuns?: () => void;
};

export function ApprovalTab(props: ApprovalTabProps) {
  const t = useT();
  if (!props.batchId) {
    return (
      <EmptyState
        data-testid="approval-empty"
        title={t("payrollPayoutReview.approval.empty.title")}
        description={t("payrollPayoutReview.approval.empty.description")}
        action={
          props.onOpenRuns && (
            <Button
              type="button"
              className="min-h-11"
              onClick={props.onOpenRuns}
            >
              {t("payrollPayoutReview.approval.empty.action")}
            </Button>
          )
        }
      />
    );
  }
  return <ApprovalBatch {...props} batchId={props.batchId} />;
}

function ApprovalSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayoutReview.common.loadingLabel")}
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <div className="grid gap-3 rounded-shell border-(length:--border-w) bg-card p-card">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="grid content-start gap-3 rounded-shell border-(length:--border-w) bg-card p-card">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  );
}

function ApprovalBatch({
  batchId,
  access,
  currentUserId,
}: ApprovalTabProps & { batchId: string }) {
  const t = useT();
  const toast = useToast();
  const query = useBatch(batchId);
  // Settings and source accounts belong to the batch's own PT, which may not
  // be the PT selected on the page.
  const batchEntityId = query.data?.legalEntityId;
  // Never from the cache: the person approves the account shown here, and the
  // server freezes the one in the settings at that moment.
  const configQuery = usePayoutConfig(batchEntityId, { fresh: true });
  const config = configQuery.data;
  const accounts = usePayoutSourceAccounts(batchEntityId).data ?? [];
  const approve = useApproveBatch();
  const userNames = usePayoutUserNames();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [checked, setChecked] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Frozen at approval (from the batch); until then the settings' account,
  // which is the one that will be frozen.
  const manualBank = query.data?.channel === "manual_bank";
  const frozenSourceId = manualBank
    ? (query.data?.sourceBankAccountId ?? null)
    : null;
  const sourceId = manualBank
    ? (frozenSourceId ?? config?.manualSourceBankAccountId ?? null)
    : null;
  // The account the person confirmed when ticking the check. Only this id is
  // ever sent, also on the retry after step-up (MFA).
  const confirmedSourceRef = React.useRef<string | null | undefined>(undefined);
  // isPending flips a macrotask late: a fast double click would run the money
  // action twice, so a ref closes the gap until the request settles.
  const inFlightRef = React.useRef(false);
  const resetStepUp = stepUp.reset;
  React.useEffect(() => {
    const confirmed = confirmedSourceRef.current;
    if (confirmed === undefined || confirmed === sourceId) return;
    // The account on screen moved after it was confirmed: ask for a new check.
    confirmedSourceRef.current = undefined;
    setChecked(false);
    resetStepUp();
    setError(t("payrollPayoutReview.approval.sourceChanged"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  const onCheckedChange = (value: boolean) => {
    confirmedSourceRef.current = value ? sourceId : undefined;
    setChecked(value);
  };

  if (query.isPending) return <ApprovalSkeleton />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        error={query.error}
        title={t("payrollPayoutReview.approval.error.title")}
        description={t("payrollPayoutReview.approval.error.description")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const batch = query.data;
  const payable = batch.items.filter(isPayableItem);
  const excluded = batch.items.filter(isExcludedItem);
  const noSnapshotCount = payable.filter(lacksAccountSnapshot).length;
  const isCreator = batch.requestedBy === currentUserId;
  const pendingApproval = batch.status === "pending_approval";

  const source =
    sourceId === null
      ? undefined
      : accounts.find((account) => account.id === sourceId);
  const sourceInactive =
    pendingApproval && source !== undefined && !source.active;
  // Asking for approval of a source the person cannot see (or that is still
  // being re-read) would approve blind.
  const sourceChecking =
    pendingApproval && manualBank && !frozenSourceId && configQuery.isFetching;
  const sourceUnknown = pendingApproval && manualBank && source === undefined;
  const sourceNote = !manualBank
    ? null
    : frozenSourceId
      ? t("payrollPayoutReview.approval.summary.sourceFrozenNote")
      : pendingApproval && source
        ? t("payrollPayoutReview.approval.summary.sourceWillFreezeNote")
        : null;
  const sourceLabel =
    batch.channel === "manual_bank"
      ? source
        ? `${source.label} ${source.maskedNumber}`
        : t("payrollPayoutReview.approval.summary.sourceMissing")
      : null;

  let blockKey: MessageKey | null = null;
  if (!access.canApprove)
    blockKey = "payrollPayoutReview.approval.blocked.noPermission";
  else if (noSnapshotCount > 0)
    blockKey = "payrollPayoutReview.approval.blocked.noSnapshot";
  else if (isCreator)
    blockKey = "payrollPayoutReview.approval.blocked.selfApproval";
  else if (sourceChecking)
    blockKey = "payrollPayoutReview.approval.blocked.sourceChecking";
  else if (sourceUnknown)
    blockKey = "payrollPayoutReview.approval.blocked.sourceUnknown";
  else if (sourceInactive)
    blockKey = "payrollPayoutReview.approval.blocked.sourceInactive";
  else if (!pendingApproval)
    blockKey = "payrollPayoutReview.approval.blocked.notPending";
  else if (!batch.contentHash)
    blockKey = "payrollPayoutReview.approval.blocked.noHash";
  else if (!checked)
    blockKey = "payrollPayoutReview.approval.blocked.needCheck";

  // The password only lives in the panel for the one retry: it is sent as an
  // argument, never kept in state, logged or stored.
  const submit = (password?: string) => {
    if (
      !batch.contentHash ||
      inFlightRef.current ||
      approve.isPending ||
      noSnapshotCount > 0
    )
      return;
    // A re-read in flight is not a reason to drop a verified retry: the server
    // compares the id and refuses a stale one.
    if (sourceUnknown) {
      setError(t("payrollPayoutReview.approval.blocked.sourceUnknown"));
      return;
    }
    // Only the account the person confirmed, never the one on screen now.
    const confirmedSourceId = confirmedSourceRef.current;
    if (confirmedSourceId === undefined) return;
    setError(null);
    inFlightRef.current = true;
    approve.mutate(
      {
        batchId: batch.id,
        contentHash: batch.contentHash,
        sourceBankAccountId: confirmedSourceId,
        ...(password ? { password } : {}),
      },
      {
        onSuccess: () => {
          stepUp.reset();
          confirmedSourceRef.current = undefined;
          setChecked(false);
          toast({
            title: t("payrollPayoutReview.approval.success"),
            tone: "success",
          });
        },
        onError: (failure) => {
          if (stepUp.capture(failure)) return;
          if (
            failure instanceof ApiError &&
            failure.code === "PAYOUT_SOURCE_MISMATCH"
          ) {
            // The settings moved: read them again and ask for a new check.
            stepUp.reset();
            confirmedSourceRef.current = undefined;
            setChecked(false);
            void configQuery.refetch();
            void query.refetch();
          }
          setError(payoutErrorMessage(failure, t));
        },
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      {sourceInactive && source && (
        <div
          role="alert"
          data-testid="approval-source-inactive"
          className="flex gap-3 rounded-container border-(length:--border-w) bg-danger-subtle p-4 text-danger"
        >
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("payrollPayoutReview.approval.sourceBanner.title")}
            </p>
            <p className="text-sm">
              {t("payrollPayoutReview.approval.sourceBanner.description", {
                account: `${source.label} ${source.maskedNumber}`,
              })}
            </p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          aria-label={t("payrollPayoutReview.approval.title")}
          className="grid gap-4 rounded-shell border-(length:--border-w) bg-card p-card shadow-hairline"
        >
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="grid gap-1">
              <p className="type-eyebrow text-muted-foreground">
                {t("payrollPayoutReview.approval.eyebrow", {
                  channel: t(`payrollPayoutReview.channel.${batch.channel}`),
                })}
              </p>
              <h2 className="type-title">
                {t("payrollPayoutReview.approval.title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("payrollPayoutReview.approval.subtitle", {
                  count: batch.itemCount,
                })}
              </p>
            </div>
            <p className="rounded-full bg-warning-subtle px-2.5 py-0.5 text-xs font-semibold text-warning">
              {t("payrollPayoutReview.approval.step.progress", {
                done: batch.approvedBy ? 2 : 1,
              })}
            </p>
          </header>
          <ApprovalSteps
            batch={batch}
            currentUserId={currentUserId}
            userNames={userNames}
          />
          {payable.length > 0 && <PayeeTable items={payable} />}
          <ExcludedList
            items={excluded}
            title={t("payrollPayoutReview.approval.excluded.title", {
              count: excluded.length,
            })}
            hint={t("payrollPayoutReview.approval.excluded.hint")}
          />
          <PendingNote batch={batch} />
          <div className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm">
            <p className="font-semibold">
              {t("payrollPayoutReview.approval.note.checkName")}
            </p>
            <p className="text-muted-foreground">
              {t("payrollPayoutReview.approval.note.checkNameHint")}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("payrollPayoutReview.approval.note.afterTransfer")}
          </p>
        </section>
        <ApprovalSummary
          count={payable.length}
          netIdr={batch.totalIdr}
          feeIdr={batchFeeTotal(batch)}
          fundsIdr={batchFundsNeeded(batch)}
          methodLabel={t(`payrollPayoutReview.channel.${batch.channel}`)}
          sourceLabel={sourceLabel}
          sourceNote={sourceNote}
          feePerTransferIdr={config?.feePerTransferIdr}
          checked={checked}
          onCheckedChange={onCheckedChange}
          blockKey={blockKey}
          blockParams={{ count: noSnapshotCount }}
          busy={approve.isPending && !stepUp.active}
          stepUpActive={stepUp.active}
          onApprove={() => submit()}
          showApprove={pendingApproval}
        >
          {pendingApproval && stepUp.active && (
            <VerifyPanel
              key={stepUp.round}
              needs={stepUp.needs}
              busy={approve.isPending}
              error={error}
              onVerified={submit}
              onCancel={() => {
                stepUp.reset();
                setError(null);
              }}
            />
          )}
          {noSnapshotCount > 0 &&
            access.canRequest &&
            canCancelStatus(batch.status) && (
              <CancelBatchButton batchId={batch.id} />
            )}
          {error && !stepUp.active && (
            <p
              role="alert"
              data-testid="approval-error"
              className="text-sm font-medium text-danger"
            >
              {error}
            </p>
          )}
        </ApprovalSummary>
      </div>
    </div>
  );
}

/** Non-pending states: why there is nothing to approve any more. */
function PendingNote({ batch }: { batch: PayrollDisbursementBatchDto }) {
  const t = useT();
  if (batch.status === "pending_approval") return null;
  if (batch.approvedBy) {
    return (
      <div
        role="status"
        data-testid="approval-done"
        className="flex gap-3 rounded-container bg-success-subtle p-3 text-success"
      >
        <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-1 text-sm">
          <p className="font-semibold">
            {t("payrollPayoutReview.approval.approved.title")}
          </p>
          <p>{t("payrollPayoutReview.approval.approved.description")}</p>
          {batch.approvalExpiresAt && (
            <p>
              {t("payrollPayoutReview.approval.approved.expires", {
                time: formatDateTime(batch.approvalExpiresAt),
              })}
            </p>
          )}
        </div>
      </div>
    );
  }
  const key: MessageKey =
    batch.status === "draft"
      ? "payrollPayoutReview.approval.notPending.draft"
      : batch.status === "cancelled"
        ? "payrollPayoutReview.approval.notPending.cancelled"
        : "payrollPayoutReview.approval.notPending.other";
  return (
    <p
      role="status"
      className="rounded-container bg-surface-2 p-3 text-sm text-muted-foreground"
    >
      {t(key)}
    </p>
  );
}
