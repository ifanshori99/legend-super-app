// Refund follow-up (beads legend-kfkt, legend-hn5q): one dialog that shows
// where a refund stands and offers only the actions refundActions() allows.
// Money rules: a payout that may already have been sent is only looked up
// ("Periksa status"), never retried; every write carries one idempotency key
// per dialog or attempt and its button is disabled while pending.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { MessageKey } from "@starter/shared/i18n";
import type { RefundView } from "@starter/shared/payment/admin";
import { cn } from "cn";
import { formatMoment, methodLabelKey } from "../format";
import {
  useRefunds,
  useRejectRefund,
  useReleaseQuarantinedRefund,
  useReopenQuarantinedRefund,
  useRetryRefundPayout,
} from "../hooks";
import {
  needsEvidenceMapping,
  payoutErrorKey,
  refundActions,
  refundFailureKey,
  refundUiLabelKey,
  refundUiState,
  refundUiTone,
  type RefundUiState,
} from "../refund-actions.ts";
import { useAttemptKey } from "../use-attempt-key.ts";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const P = "paymentAdmin.refundFollowup";
const key = (suffix: string) => `${P}.${suffix}` as MessageKey;

const NOTICE_TONE: Record<string, string> = {
  danger: "border-danger bg-danger-subtle text-foreground",
  warning: "border-warning bg-warning-subtle text-foreground",
  info: "border-info bg-info-subtle text-foreground",
  success: "border-success bg-success-subtle text-foreground",
};

/** States whose notice body is the server-given reason instead of fixed copy. */
const REASON_STATES: ReadonlySet<RefundUiState> = new Set([
  "failed_final",
  "rejected",
]);

const FUND_KEY: Record<RefundUiState, string> = {
  pending_approval: "notReturned",
  approved_processing: "inProgress",
  unknown_result: "unconfirmed",
  retryable: "inProgress",
  failed_final: "notRefunded",
  rejected: "notReturned",
  quarantined: "unconfirmed",
  completed: "returned",
};

export function RefundFollowupDialog({
  refundId,
  onClose,
  onApprove,
}: {
  refundId: string;
  onClose: () => void;
  /** Approving keeps its own dialog (note, idempotency key). */
  onApprove: (refund: RefundView) => void;
}) {
  const t = useT();
  const refunds = useRefunds();
  const refund = refunds.data?.data.find((entry) => entry.id === refundId);
  const [rejecting, setRejecting] = React.useState(false);
  const [quarantine, setQuarantine] = React.useState<
    "release" | "reopen" | null
  >(null);

  if (!refund) return null;
  const state = refundUiState(refund);
  const actions = refundActions(refund);
  const tone = refundUiTone(state);
  const failure = refundFailureKey(refund);
  const lastError = refund.lastPayoutError ?? null;
  const lastErrorKey = lastError ? payoutErrorKey(lastError) : null;
  const mapping = needsEvidenceMapping(refund);
  const noticeBody = mapping
    ? t(key("evidenceMapping.body"))
    : REASON_STATES.has(state)
      ? state === "rejected"
        ? (refund.note ?? (failure ? t(failure) : ""))
        : failure
          ? t(failure)
          : ""
      : t(key(`noticeBody.${state}`));

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>
                {t(
                  key(mapping ? "evidenceMapping.heading" : `heading.${state}`),
                )}
              </DialogTitle>
              <StatusPill status={tone}>
                {t(refundUiLabelKey(state))}
              </StatusPill>
            </div>
            <DialogDescription>
              {t(key("refundOrder"), { reference: refund.paymentReference })}
            </DialogDescription>
          </DialogHeader>

          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label={t(key("amount"))}>
              <Money amount={refund.amountIdr} className="font-semibold" />
            </Detail>
            <Detail label={t(key("origin"))}>
              {t(methodLabelKey(refund.method))}
            </Detail>
            <Detail label={t(key("requestedAt"))}>
              {formatMoment(refund.createdAt)}
            </Detail>
            <Detail label={t(key("requestedBy"))}>
              {refund.requestedByName}
            </Detail>
            <Detail label={t(key("requestReason"))}>{refund.reason}</Detail>
            {refund.approvedByName && refund.decidedAt && (
              <Detail label={t(key("decidedBy"))}>
                {refund.approvedByName} · {formatMoment(refund.decidedAt)}
              </Detail>
            )}
            {lastError && (
              <Detail label={t(key("lastPayoutError"))}>
                {lastErrorKey ? t(lastErrorKey) : t(key("payoutError.other"))}
                {lastErrorKey === null && (
                  <span className="mt-0.5 block text-sm text-muted-foreground tabular-nums">
                    {lastError}
                  </span>
                )}
              </Detail>
            )}
            <Detail label={t(key("fundStatus"))}>
              {t(key(`fund.${FUND_KEY[state]}`))}
            </Detail>
          </dl>

          <div
            role={tone === "danger" ? "alert" : "status"}
            className={cn(
              "grid gap-1 rounded-control border-(length:--border-w) p-card",
              NOTICE_TONE[tone],
            )}
          >
            <p className="font-semibold">
              {t(
                key(mapping ? "evidenceMapping.title" : `noticeTitle.${state}`),
              )}
            </p>
            {noticeBody && <p className="text-sm leading-5">{noticeBody}</p>}
          </div>

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              {t(key("action.close"))}
            </Button>
            {actions.reject && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setRejecting(true)}
              >
                {t(key("action.reject"))}
              </Button>
            )}
            {actions.release && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setQuarantine("release")}
              >
                {t(key("action.reviewRelease"))}
              </Button>
            )}
            {actions.reopen && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setQuarantine("reopen")}
              >
                {t(key("action.reviewReopen"))}
              </Button>
            )}
            {state === "unknown_result" && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t(key("action.retryLockedHint"))}
              </p>
            )}
            {actions.approve && (
              <Button type="button" onClick={() => onApprove(refund)}>
                {t(key("action.approve"))}
              </Button>
            )}
            {actions.retry && <RetryButton refund={refund} mode="retry" />}
            {actions.checkStatus && (
              <RetryButton refund={refund} mode="checkStatus" />
            )}
          </DialogFooter>
          <FootnoteFor state={state} />
        </DialogContent>
      </Dialog>

      {rejecting && (
        <RejectRefundDialog
          refund={refund}
          onClose={() => setRejecting(false)}
        />
      )}
      {quarantine && (
        <QuarantineActionDialog
          refund={refund}
          action={quarantine}
          onClose={() => setQuarantine(null)}
        />
      )}
    </>
  );
}

function FootnoteFor({ state }: { state: RefundUiState }) {
  const t = useT();
  const footnotes: Partial<Record<RefundUiState, string>> = {
    pending_approval: "footnote.pending_approval",
    unknown_result: "footnote.unknown_result",
    retryable: "footnote.retryable",
    failed_final: "footnote.failed_final",
    rejected: "footnote.rejected",
  };
  const suffix = footnotes[state];
  if (!suffix) return null;
  return (
    <p className="text-sm leading-5 text-muted-foreground">{t(key(suffix))}</p>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

/**
 * "Coba lagi" and "Periksa status" call the same endpoint: once an attempt
 * exists the API only looks the payout up. One key per attempt, reused after a
 * failure so a repeat replays instead of acting twice.
 */
function RetryButton({
  refund,
  mode,
}: {
  refund: RefundView;
  mode: "retry" | "checkStatus";
}) {
  const t = useT();
  const toast = useToast();
  const retry = useRetryRefundPayout();
  const attempt = useAttemptKey();
  const [error, setError] = React.useState<string | null>(null);

  const run = () => {
    setError(null);
    const idempotencyKey = attempt.keyFor({ refundId: refund.id });
    retry.mutate(
      { refundId: refund.id, body: { idempotencyKey } },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t(key(mode === "retry" ? "retried" : "checked")),
          });
        },
        onError: (cause) => setError(cause.message),
      },
    );
  };

  return (
    <>
      <Button type="button" onClick={run} loading={retry.isPending}>
        {t(key(mode === "retry" ? "action.retry" : "action.checkStatus"))}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm font-medium text-danger">
          {t(key("actionFailed"))} {error}
        </p>
      )}
    </>
  );
}

function RejectRefundDialog({
  refund,
  onClose,
}: {
  refund: RefundView;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const reject = useRejectRefund();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setError(t(key("rejectDialog.reasonRequired")));
      return;
    }
    setError(null);
    reject.mutate(
      { refundId: refund.id, body: { idempotencyKey, reason: trimmed } },
      {
        onSuccess: () => {
          toast({
            title: t(key("rejectDialog.done"), {
              reference: refund.paymentReference,
            }),
          });
          onClose();
        },
        onError: (cause) => setError(cause.message),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(key("rejectDialog.title"))}</DialogTitle>
          <DialogDescription>{t(key("rejectDialog.body"))}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t(key("rejectDialog.reason"))}
            required
            error={error ?? undefined}
          >
            <Textarea
              value={reason}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={reject.isPending}>
              {t(key("rejectDialog.submit"))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Release ends the refund as failed; re-open returns it to approval. */
function QuarantineActionDialog({
  refund,
  action,
  onClose,
}: {
  refund: RefundView;
  action: "release" | "reopen";
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const release = useReleaseQuarantinedRefund();
  const reopen = useReopenQuarantinedRefund();
  const mutation = action === "release" ? release : reopen;
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // One key per dialog: a double click or retry replays, never acts twice.
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    const length = Array.from(trimmed).length;
    if (length < 3 || length > 500) {
      setError(t(key("noteRequired")));
      return;
    }
    setError(null);
    mutation.mutate(
      { refundId: refund.id, body: { idempotencyKey, note: trimmed } },
      {
        onSuccess: () => {
          toast({ title: t(key(`${action}.done`)) });
          onClose();
        },
        onError: (cause) => setError(cause.message),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(key(`${action}.title`))}</DialogTitle>
          <DialogDescription>
            {t(key("refundOrder"), { reference: refund.paymentReference })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Money amount={refund.amountIdr} size="lg" />
          <p className="text-sm text-muted-foreground">
            {t(methodLabelKey(refund.method))} · {refund.reason}
          </p>
        </div>
        <div
          role="status"
          className={cn(
            "grid gap-1 rounded-control border-(length:--border-w) p-card",
            NOTICE_TONE.warning,
          )}
        >
          <p className="font-semibold">
            {t(
              key(
                action === "release"
                  ? "release.checkTitle"
                  : "reopen.noticeTitle",
              ),
            )}
          </p>
          <p className="text-sm leading-5">
            {t(key(action === "release" ? "release.checkBody" : "reopen.body"))}
          </p>
        </div>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {action === "release" && (
            <p className="text-sm leading-5">{t(key("release.body"))}</p>
          )}
          <FormField
            label={t(key(`${action}.reason`))}
            required
            error={error ?? undefined}
          >
            <Textarea
              value={note}
              rows={3}
              placeholder={t(key(`${action}.reasonPlaceholder`))}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={action === "release" ? "destructive" : "default"}
              loading={mutation.isPending}
            >
              {t(key(`${action}.submit`))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
