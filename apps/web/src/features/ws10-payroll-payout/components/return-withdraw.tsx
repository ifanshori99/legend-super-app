// Withdraw an open return claim, two people (legend-snwnn / legend-o2b4m).
// A claim of funds that came back and is not yet confirmed can be taken back:
// one finance person proposes with a written reason and their password, a
// different person approves with theirs. The proposer sees the approve button
// switched off with the reason why. Nothing is paid from here and the payment
// status never changes. Buttons are switched off for clarity only; the server
// stays the checker and its refusals are always shown.
import * as React from "react";
import type { PayoutReturnClaimDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import {
  useApproveReturnWithdrawal,
  useActingUserId,
  useBatchReturnClaims,
  useProposeReturnWithdrawal,
} from "../hooks";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { reviewErrorMessage } from "./status-errors";

const REASON_MIN = 10;
const REASON_MAX = 500;

// The claim or its item changed under the screen: reload and offer a new proposal.
const CONFLICT_CODES = new Set([
  "PAYOUT_RETURN_WITHDRAW_REFUSED",
  "PAYOUT_RETURN_WITHDRAW_STATE",
  "PAYOUT_RETURN_CLAIM_NOT_FOUND",
  "PAYOUT_RETURN_WITHDRAWAL_NOT_FOUND",
]);

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && CONFLICT_CODES.has(error.code ?? "");
}

type ActiveDialog = {
  kind: "propose" | "approve";
  claim: PayoutReturnClaimDto;
};

type StatusKey = "open" | "proposed" | "consumed" | "withdrawn";

function statusOf(claim: PayoutReturnClaimDto): StatusKey {
  if (claim.status === "open" && claim.withdrawal) return "proposed";
  return claim.status;
}

const STATUS_TONE = {
  open: "neutral",
  proposed: "warning",
  consumed: "success",
  withdrawn: "info",
} as const;

function refText(claim: PayoutReturnClaimDto): string {
  return claim.bankRef ? ` · ${claim.bankRef}` : "";
}

/** The claims of one batch with the withdraw actions. Manual-bank batches only. */
export function ReturnWithdrawSection({
  batchId,
  currentUserId: sessionUserId,
  isCreator,
}: {
  batchId: string;
  currentUserId: string;
  /** The requester of the batch may not propose or approve (server refuses). */
  isCreator: boolean;
}) {
  const t = useT();
  const currentUserId = useActingUserId(sessionUserId);
  const query = useBatchReturnClaims(batchId);
  const [dialog, setDialog] = React.useState<ActiveDialog | null>(null);
  const claims = query.data ?? [];

  return (
    <section
      aria-label={t("payrollPayoutReview.returnWithdraw.title")}
      data-testid="return-withdraw"
      className="grid gap-4 rounded-shell border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="type-title">
            {t("payrollPayoutReview.returnWithdraw.title")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("payrollPayoutReview.returnWithdraw.description")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          loading={query.isFetching && !query.isPending}
          onClick={() => void query.refetch()}
        >
          {t("payrollPayoutReview.returnWithdraw.refresh")}
        </Button>
      </div>
      {query.isPending ? (
        <div
          role="status"
          aria-label={t("payrollPayoutReview.returnWithdraw.loading")}
          className="grid gap-3"
        >
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          title={t("payrollPayoutReview.returnWithdraw.error.title")}
          description={t(
            "payrollPayoutReview.returnWithdraw.error.description",
          )}
          onRetry={() => void query.refetch()}
        />
      ) : claims.length === 0 ? (
        <EmptyState
          data-testid="return-withdraw-empty"
          title={t("payrollPayoutReview.returnWithdraw.empty.title")}
          description={t(
            "payrollPayoutReview.returnWithdraw.empty.description",
          )}
        />
      ) : (
        <ul className="grid gap-3">
          {claims.map((claim) => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              currentUserId={currentUserId}
              isCreator={isCreator}
              onAction={(kind) => setDialog({ kind, claim })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "propose" && (
        <ProposeDialog
          batchId={batchId}
          claim={dialog.claim}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "approve" && dialog.claim.withdrawal && (
        <ApproveDialog
          batchId={batchId}
          claim={dialog.claim}
          currentUserId={currentUserId}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function ClaimRow({
  claim,
  currentUserId,
  isCreator,
  onAction,
}: {
  claim: PayoutReturnClaimDto;
  currentUserId: string;
  isCreator: boolean;
  onAction: (kind: "propose" | "approve") => void;
}) {
  const t = useT();
  const status = statusOf(claim);
  const withdrawal = claim.withdrawal;
  const mine = withdrawal?.proposedBy === currentUserId;
  const blockKey = isCreator
    ? "creator"
    : status === "proposed" && mine
      ? "self"
      : status === "consumed"
        ? "consumed"
        : null;
  const hintId = `return-claim-${claim.id}-hint`;

  return (
    <li
      data-testid="return-claim"
      data-status={status}
      className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="font-semibold tabular">
            {t("payrollPayoutReview.returnWithdraw.claim.items", {
              count: claim.itemCount,
            })}
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {claim.bankRef
              ? t("payrollPayoutReview.returnWithdraw.claim.bankRef", {
                  ref: claim.bankRef,
                })
              : t("payrollPayoutReview.returnWithdraw.claim.noBankRef")}
            {" · "}
            {t("payrollPayoutReview.returnWithdraw.claim.createdAt", {
              time: formatDateTime(claim.createdAt),
            })}
          </p>
        </div>
        <Badge tone={STATUS_TONE[status]}>
          {t(`payrollPayoutReview.returnWithdraw.status.${status}`)}
        </Badge>
      </div>
      {withdrawal && status === "proposed" && (
        <dl className="grid gap-1 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.by")}
            </dt>
            <dd className="font-medium">
              {t(
                mine
                  ? "payrollPayoutReview.returnWithdraw.proposal.you"
                  : "payrollPayoutReview.returnWithdraw.proposal.other",
              )}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.at")}
            </dt>
            <dd className="tabular">{formatDateTime(withdrawal.proposedAt)}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.reason")}
            </dt>
            <dd className="break-words whitespace-pre-wrap">
              {withdrawal.reason}
            </dd>
          </div>
        </dl>
      )}
      {status !== "withdrawn" && (
        <div className="grid gap-2">
          {status !== "consumed" && (
            <Button
              type="button"
              className="min-h-11 w-full min-[700px]:w-fit"
              variant={status === "open" ? "outline" : "default"}
              disabled={blockKey !== null}
              aria-describedby={blockKey ? hintId : undefined}
              data-testid={
                status === "open"
                  ? "return-withdraw-propose"
                  : "return-withdraw-approve"
              }
              onClick={() =>
                onAction(status === "open" ? "propose" : "approve")
              }
            >
              {t(
                status === "open"
                  ? "payrollPayoutReview.returnWithdraw.action.propose"
                  : "payrollPayoutReview.returnWithdraw.action.approve",
              )}
            </Button>
          )}
          {blockKey && (
            <p id={hintId} className="text-sm text-muted-foreground">
              {t(`payrollPayoutReview.returnWithdraw.blocked.${blockKey}`)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function claimVars(claim: PayoutReturnClaimDto) {
  return { count: claim.itemCount, ref: refText(claim) };
}

function ProposeDialog({
  batchId,
  claim,
  onClose,
}: {
  batchId: string;
  claim: PayoutReturnClaimDto;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const propose = useProposeReturnWithdrawal(batchId);
  const stepUp = useStepUp({ acceptsPassword: true });
  const [reason, setReason] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const check = () => {
    const short = reason.trim().length < REASON_MIN;
    setProblem(
      short
        ? t("payrollPayoutReview.returnWithdraw.propose.reasonShort")
        : null,
    );
    return !short;
  };

  // The password lives only in the panel for the one retry: it is sent as an
  // argument, never kept in state, logged or stored.
  const submit = (password?: string) => {
    if (propose.isPending) return;
    setError(null);
    if (!check()) return;
    propose.mutate(
      { claimId: claim.id, reason: reason.trim(), password },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayoutReview.returnWithdraw.propose.done"),
            tone: "success",
          });
          onClose();
        },
        onError: (failure) => {
          if (stepUp.capture(failure)) return;
          if (isConflict(failure)) {
            // The list reloads on its own; offer a new proposal from there.
            toast({
              title: t("payrollPayoutReview.returnWithdraw.conflict"),
              tone: "danger",
            });
            onClose();
            return;
          }
          setError(reviewErrorMessage(failure, t));
        },
      },
    );
  };

  const fields = (
    <div className="grid gap-3">
      <p
        data-testid="return-withdraw-warning"
        className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
      >
        {t("payrollPayoutReview.returnWithdraw.propose.warning")}
      </p>
      <FormField
        label={t("payrollPayoutReview.returnWithdraw.propose.reasonLabel")}
        hint={t("payrollPayoutReview.returnWithdraw.propose.reasonHint")}
        error={problem ?? undefined}
        required
      >
        <Textarea
          value={reason}
          maxLength={REASON_MAX}
          rows={4}
          disabled={stepUp.active || propose.isPending}
          data-testid="return-withdraw-reason"
          onChange={(event) => setReason(event.target.value)}
          onBlur={(event) => {
            // Moving to Batal must not raise a problem on a dialog being left.
            if (event.relatedTarget instanceof HTMLButtonElement) return;
            if (reason !== "") check();
          }}
        />
      </FormField>
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !propose.isPending && onClose()}
    >
      <DialogContent data-testid="return-withdraw-propose-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("payrollPayoutReview.returnWithdraw.propose.title")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "payrollPayoutReview.returnWithdraw.propose.description",
              claimVars(claim),
            )}
          </DialogDescription>
        </DialogHeader>
        {stepUp.active ? (
          <div className="grid gap-4">
            {fields}
            <VerifyPanel
              key={stepUp.round}
              needs={stepUp.needs}
              busy={propose.isPending}
              error={error}
              onVerified={submit}
              onCancel={onClose}
            />
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {fields}
            {error && (
              <p role="alert" className="text-sm font-medium text-danger">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={propose.isPending}
                onClick={onClose}
              >
                {t("payrollPayoutReview.returnWithdraw.propose.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                loading={propose.isPending}
              >
                {propose.isPending
                  ? t("payrollPayoutReview.returnWithdraw.propose.submitting")
                  : t("payrollPayoutReview.returnWithdraw.propose.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApproveDialog({
  batchId,
  claim,
  currentUserId,
  onClose,
}: {
  batchId: string;
  claim: PayoutReturnClaimDto;
  currentUserId: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const approve = useApproveReturnWithdrawal(batchId);
  const stepUp = useStepUp({ acceptsPassword: true });
  const [error, setError] = React.useState<string | null>(null);
  const withdrawal = claim.withdrawal;

  const submit = (password?: string) => {
    if (approve.isPending || !withdrawal) return;
    setError(null);
    approve.mutate(
      { withdrawalId: withdrawal.id, password },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayoutReview.returnWithdraw.approve.done"),
            tone: "success",
          });
          onClose();
        },
        onError: (failure) => {
          if (stepUp.capture(failure)) return;
          if (isConflict(failure)) {
            // The list reloads on its own; offer a new proposal from there.
            toast({
              title: t("payrollPayoutReview.returnWithdraw.conflict"),
              tone: "danger",
            });
            onClose();
            return;
          }
          setError(reviewErrorMessage(failure, t));
        },
      },
    );
  };

  const fields = (
    <div className="grid gap-3">
      <p
        data-testid="return-withdraw-warning"
        className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
      >
        {t("payrollPayoutReview.returnWithdraw.approve.warning")}
      </p>
      {withdrawal && (
        <dl className="grid gap-1 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.by")}
            </dt>
            <dd className="font-medium">
              {t(
                withdrawal.proposedBy === currentUserId
                  ? "payrollPayoutReview.returnWithdraw.proposal.you"
                  : "payrollPayoutReview.returnWithdraw.proposal.other",
              )}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.at")}
            </dt>
            <dd className="tabular">{formatDateTime(withdrawal.proposedAt)}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("payrollPayoutReview.returnWithdraw.proposal.reason")}
            </dt>
            <dd
              data-testid="return-withdraw-proposal-reason"
              className="break-words whitespace-pre-wrap"
            >
              {withdrawal.reason}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !approve.isPending && onClose()}
    >
      <DialogContent data-testid="return-withdraw-approve-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("payrollPayoutReview.returnWithdraw.approve.title")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "payrollPayoutReview.returnWithdraw.approve.description",
              claimVars(claim),
            )}
          </DialogDescription>
        </DialogHeader>
        {stepUp.active ? (
          <div className="grid gap-4">
            {fields}
            <VerifyPanel
              key={stepUp.round}
              needs={stepUp.needs}
              busy={approve.isPending}
              error={error}
              onVerified={submit}
              onCancel={onClose}
            />
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {fields}
            {error && (
              <p role="alert" className="text-sm font-medium text-danger">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={approve.isPending}
                onClick={onClose}
              >
                {t("payrollPayoutReview.returnWithdraw.approve.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                loading={approve.isPending}
              >
                {approve.isPending
                  ? t("payrollPayoutReview.returnWithdraw.approve.submitting")
                  : t("payrollPayoutReview.returnWithdraw.approve.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
