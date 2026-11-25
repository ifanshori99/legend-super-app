// Refund follow-up (beads legend-kfkt, legend-hn5q): one dialog that shows
// where a refund stands and offers only the actions refundActions() allows.
// Money rules: a payout that may already have been sent is only looked up
// ("Periksa status"), never retried; every write carries one idempotency key
// per dialog or attempt and its button is disabled while pending.
import * as React from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { MessageKey } from "@starter/shared/i18n";
import type { RefundView } from "@starter/shared/payment/admin";
import { cn } from "cn";
import { ANONYMOUS_ACCESS, type AreaAccess } from "@/lib/areas/access";
import { formatMoment, methodLabelKey } from "../format";
import {
  useRefunds,
  refundMutationKey,
  useRejectRefund,
  useReleaseQuarantinedRefund,
  useReopenQuarantinedRefund,
  useRetryRefundPayout,
  useSettleRefundManually,
} from "../hooks";
import {
  MANUAL_SETTLE_CHANNELS,
  canSettleManually,
  checkManualSettlement,
  manualSettlementRefusalKey,
  type ManualSettlementField,
  type ManualSettlementForm,
} from "../manual-settlement.ts";
import {
  needsEvidenceMapping,
  payoutErrorKey,
  refundActions,
  refundOrderId,
  refundFailureKey,
  refundUiLabelKey,
  refundUiState,
  refundUiTone,
  type RefundUiState,
} from "../refund-actions.ts";
import { ApiError } from "../../../lib/api/errors.ts";
import { useRetainedAttempt } from "../../../lib/use-retained-attempt.ts";

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
  // Retry, release, re-open and manual settle each run their own mutation in
  // this dialog: none may be cut off by closing it.
  const mutating =
    useIsMutating({ mutationKey: refundMutationKey(refundId) }) > 0;
  const refund = refunds.data?.data.find((entry) => entry.id === refundId);
  const [rejecting, setRejecting] = React.useState(false);
  // "Catat refund manual" is a two-step form inside this dialog. Presentation
  // only: the API re-checks payment.reconcile, state and MFA.
  const [settling, setSettling] = React.useState(false);
  const { access } = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  // Release and re-open confirm as a step inside this dialog (no dialog on dialog).
  const [quarantine, setQuarantine] = React.useState<
    "release" | "reopen" | null
  >(null);
  // Set once the release succeeded: the dialog then shows "Karantina dilepas"
  // with the trail instead of the failed state the refetched refund now has.
  const [released, setReleased] = React.useState<ReleasedInfo | null>(null);
  const trailRef = React.useRef<HTMLElement>(null);
  // The API answered 409 REFUND_PAYOUT_MAYBE_SENT: it knows of a payout try the
  // view cannot show (payoutPendingPolls is not in RefundView). Release and
  // re-open stay hidden; only the provider lookup is safe.
  const [serverMaybeSent, setServerMaybeSent] = React.useState(false);

  if (!refund) return null;
  const state = refundUiState(refund);
  const baseActions = refundActions(refund);
  const actions = serverMaybeSent
    ? {
        ...baseActions,
        release: false,
        reopen: false,
        checkStatus: baseActions.checkStatus || state === "quarantined",
      }
    : baseActions;
  const tone = refundUiTone(state);
  const failure = refundFailureKey(refund);
  const lastError = refund.lastPayoutError ?? null;
  const lastErrorKey = lastError ? payoutErrorKey(lastError) : null;
  const mapping = needsEvidenceMapping(refund);
  const orderId = refundOrderId();
  const noticeBody = mapping
    ? t(key("evidenceMapping.body"))
    : REASON_STATES.has(state)
      ? state === "rejected"
        ? (refund.note ?? (failure ? t(failure) : ""))
        : failure
          ? t(failure)
          : ""
      : t(key(`noticeBody.${state}`));
  const finalState = state === "failed_final" || state === "rejected";
  const showTrail = state === "quarantined" && !mapping;

  return (
    <>
      <PendingDialog
        pending={mutating}
        open
        onOpenChange={(open) => (!open ? onClose() : undefined)}
      >
        <PendingDialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {settling ? (
            <ManualSettleStep
              refund={refund}
              onBack={() => setSettling(false)}
              onClose={onClose}
            />
          ) : quarantine ? (
            <QuarantineStep
              refund={refund}
              action={quarantine}
              onBack={() => setQuarantine(null)}
              onClose={onClose}
              onReleased={(info) => {
                setReleased(info);
                setQuarantine(null);
              }}
              onMaybeSent={() => {
                setServerMaybeSent(true);
                setQuarantine(null);
              }}
            />
          ) : released ? (
            <ReleasedView
              refund={refund}
              released={released}
              onClose={onClose}
            />
          ) : (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle>
                    {t(
                      key(
                        mapping
                          ? "evidenceMapping.heading"
                          : `heading.${state}`,
                      ),
                    )}
                  </DialogTitle>
                  <StatusPill status={tone}>
                    {t(refundUiLabelKey(state))}
                  </StatusPill>
                </div>
                <DialogDescription>
                  {t(key("refundOrder"), {
                    reference: refund.paymentReference,
                  })}
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
                {refund.approvalRequestId && (
                  <Detail label={t(key("approvalRequestId"))}>
                    <span className="tabular-nums">
                      {refund.approvalRequestId}
                    </span>
                  </Detail>
                )}
                {refund.approvedByName && refund.decidedAt && (
                  <Detail label={t(key("decidedBy"))}>
                    {refund.approvedByName} · {formatMoment(refund.decidedAt)}
                  </Detail>
                )}
                {lastError && (
                  <Detail label={t(key("lastPayoutError"))}>
                    {lastErrorKey
                      ? t(lastErrorKey)
                      : t(key("payoutError.other"))}
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
                    key(
                      mapping
                        ? "evidenceMapping.title"
                        : `noticeTitle.${state}`,
                    ),
                  )}
                </p>
                {noticeBody && (
                  <p className="text-sm leading-5">{noticeBody}</p>
                )}
              </div>

              {serverMaybeSent && (
                <div
                  role="alert"
                  className={cn(
                    "grid gap-1 rounded-control border-(length:--border-w) p-card",
                    NOTICE_TONE.warning,
                  )}
                >
                  <p className="font-semibold">{t(key("maybeSent.title"))}</p>
                  <p className="text-sm leading-5">
                    {t(key("maybeSent.body"))}
                  </p>
                </div>
              )}

              {showTrail && <Trail refund={refund} sectionRef={trailRef} />}

              <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={mutating}
                  onClick={onClose}
                >
                  {t(key(finalState ? "action.backToList" : "action.close"))}
                </Button>
                {showTrail && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      trailRef.current?.scrollIntoView({ block: "nearest" });
                      trailRef.current?.focus();
                    }}
                  >
                    {t(key("action.trail"))}
                  </Button>
                )}
                {actions.reject && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRejecting(true)}
                  >
                    {t(key("action.reject"))}
                  </Button>
                )}
                {canSettleManually(
                  refund,
                  (access ?? ANONYMOUS_ACCESS).permissions,
                ) && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSettling(true)}
                  >
                    {t("paymentAdmin.manualSettle.open")}
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
                {actions.release && (
                  <Button
                    type="button"
                    onClick={() => setQuarantine("release")}
                  >
                    {t(key("action.reviewRelease"))}
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
                {state === "failed_final" && orderId && (
                  <Button asChild>
                    <Link
                      to="/pos/pesanan/$orderId/koreksi"
                      params={{ orderId }}
                      search={{ mode: "refund" }}
                    >
                      {t(key("action.newRefund"))}
                    </Link>
                  </Button>
                )}
                {state === "rejected" && orderId && (
                  <Button asChild>
                    <Link to="/pos/pesanan/$orderId" params={{ orderId }}>
                      {t(key("action.viewOrder"))}
                    </Link>
                  </Button>
                )}
              </DialogFooter>
              <FootnoteFor state={state} />
            </>
          )}
        </PendingDialogContent>
      </PendingDialog>

      {rejecting && (
        <RejectRefundDialog
          refund={refund}
          onClose={() => setRejecting(false)}
        />
      )}
    </>
  );
}

type ReleasedInfo = { note: string; at: string };

type TrailEntry = { at: string; label: string; detail?: string };

/** Audit trail built from what the refund view already carries. */
function trailEntries(
  refund: RefundView,
  t: ReturnType<typeof useT>,
  released?: ReleasedInfo,
): TrailEntry[] {
  const entries: TrailEntry[] = [
    {
      at: refund.createdAt,
      label: `${t(key("trail.requested"))} · ${refund.requestedByName}`,
    },
  ];
  if (refund.decidedAt) {
    entries.push({
      at: refund.decidedAt,
      label: refund.approvedByName
        ? `${t(key("trail.decided"))} · ${refund.approvedByName}`
        : t(key("trail.decided")),
    });
  }
  if (refund.escalatedAt) {
    entries.push({ at: refund.escalatedAt, label: t(key("trail.escalated")) });
  }
  if (refund.completedAt) {
    entries.push({ at: refund.completedAt, label: t(key("trail.completed")) });
  }
  if (released) {
    entries.push({
      at: released.at,
      label: t(key("trail.released")),
      detail: t(key("trail.reason"), { note: released.note }),
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function Trail({
  refund,
  released,
  sectionRef,
}: {
  refund: RefundView;
  released?: ReleasedInfo;
  sectionRef?: React.Ref<HTMLElement>;
}) {
  const t = useT();
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={`trail-${refund.id}`}
      className="grid gap-2 outline-none"
    >
      <h3 id={`trail-${refund.id}`} className="font-semibold">
        {t(key("trail.title"))}
      </h3>
      <ol className="grid gap-2 text-sm leading-5">
        {trailEntries(refund, t, released).map((entry) => (
          <li key={`${entry.at}-${entry.label}`} className="grid gap-0.5">
            <span>
              {formatMoment(entry.at)} · {entry.label}
            </span>
            {entry.detail && (
              <span className="text-muted-foreground">{entry.detail}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** After release: the refund is final-failed and its reserved amount is free. */
function ReleasedView({
  refund,
  released,
  onClose,
}: {
  refund: RefundView;
  released: ReleasedInfo;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle>{t(key("released.heading"))}</DialogTitle>
          <StatusPill status="success">{t(key("released.heading"))}</StatusPill>
        </div>
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
          NOTICE_TONE.success,
        )}
      >
        <p className="font-semibold">{t(key("released.heading"))}</p>
        <p className="text-sm leading-5">{t(key("release.done"))}</p>
      </div>
      <Trail refund={refund} released={released} />
      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" onClick={onClose}>
          {t(key("action.viewAll"))}
        </Button>
      </DialogFooter>
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
  const retry = useRetryRefundPayout(refund.id);
  const attempt = useRetainedAttempt(`refund.${mode}.${refund.id}`);
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
  const reject = useRejectRefund(refund.id);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Kept per refund across close and reopen: a lost response then replays.
  const attempt = useRetainedAttempt(`refund.reject.${refund.id}`);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setError(t(key("rejectDialog.reasonRequired")));
      return;
    }
    setError(null);
    reject.mutate(
      {
        refundId: refund.id,
        body: {
          idempotencyKey: attempt.keyFor({ reason: trimmed }),
          reason: trimmed,
        },
      },
      {
        onSuccess: () => {
          attempt.settle();
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
    <PendingDialog
      pending={reject.isPending}
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <PendingDialogContent>
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
            <Button
              type="button"
              variant="outline"
              disabled={reject.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={reject.isPending}>
              {t(key("rejectDialog.submit"))}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}

/** Release ends the refund as failed; re-open returns it to approval. */
function QuarantineStep({
  refund,
  action,
  onBack,
  onClose,
  onReleased,
  onMaybeSent,
}: {
  refund: RefundView;
  action: "release" | "reopen";
  onBack: () => void;
  onClose: () => void;
  onReleased: (info: ReleasedInfo) => void;
  /** The API says the payout may have been sent: the parent hides this action. */
  onMaybeSent: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const release = useReleaseQuarantinedRefund(refund.id);
  const reopen = useReopenQuarantinedRefund(refund.id);
  const mutation = action === "release" ? release : reopen;
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // One key per step, kept across close and reopen: a double click or retry
  // replays, never acts twice.
  const attempt = useRetainedAttempt(`refund.${action}.${refund.id}`);

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
      {
        refundId: refund.id,
        body: {
          idempotencyKey: attempt.keyFor({ note: trimmed }),
          note: trimmed,
        },
      },
      {
        onSuccess: () => {
          attempt.settle();
          if (action === "release") {
            onReleased({ note: trimmed, at: new Date().toISOString() });
            return;
          }
          toast({ title: t(key("reopen.done")) });
          onClose();
        },
        onError: (cause) => {
          if (
            cause instanceof ApiError &&
            cause.status === 409 &&
            cause.code === "REFUND_PAYOUT_MAYBE_SENT"
          ) {
            onMaybeSent();
            return;
          }
          setError(cause.message);
        },
      },
    );
  };

  return (
    <>
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
      {action === "reopen" && (
        <h3 className="font-semibold">{t(key("reopen.heading"))}</h3>
      )}
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
          <>
            <h3 className="font-semibold">{t(key("release.recordTitle"))}</h3>
            <p className="text-sm leading-5">{t(key("release.body"))}</p>
          </>
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
          <Button type="button" variant="outline" onClick={onBack}>
            {t(key("action.back"))}
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
    </>
  );
}

const EMPTY_SETTLEMENT: ManualSettlementForm = {
  paidAtLocal: "",
  channel: "",
  externalReference: "",
  amountIdr: "",
  note: "",
};

/**
 * Two steps: fill in the proof, then confirm what will be recorded. One
 * idempotency key per user attempt (a repeat after a failure replays); the
 * server decides state, amount, provider lookup and MFA, and its refusal code
 * is shown in Bahasa Indonesia.
 */
function ManualSettleStep({
  refund,
  onBack,
  onClose,
}: {
  refund: RefundView;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const settle = useSettleRefundManually(refund.id);
  const attempt = useRetainedAttempt(`refund.settle.${refund.id}`);
  const [form, setForm] =
    React.useState<ManualSettlementForm>(EMPTY_SETTLEMENT);
  const [confirming, setConfirming] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<{
    field: ManualSettlementField;
    message: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const set = (patch: Partial<ManualSettlementForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFieldError(null);
  };
  const errorOf = (field: ManualSettlementField) =>
    fieldError?.field === field ? fieldError.message : undefined;

  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const check = checkManualSettlement(refund, form);
    if (!check.ok) {
      setFieldError({ field: check.field, message: t(check.messageKey) });
      return;
    }
    setFieldError(null);
    setConfirming(true);
  };

  const submit = () => {
    const check = checkManualSettlement(refund, form);
    if (!check.ok) {
      setConfirming(false);
      setFieldError({ field: check.field, message: t(check.messageKey) });
      return;
    }
    setError(null);
    const idempotencyKey = attempt.keyFor({
      refundId: refund.id,
      ...check.body,
    });
    settle.mutate(
      { refundId: refund.id, body: { ...check.body, idempotencyKey } },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.manualSettle.done", {
              reference: refund.paymentReference,
            }),
          });
          onClose();
        },
        onError: (cause) => {
          const refusal =
            cause instanceof ApiError
              ? manualSettlementRefusalKey(cause.status, cause.code)
              : null;
          setError(
            refusal ? t(refusal) : t("paymentAdmin.manualSettle.failed"),
          );
        },
      },
    );
  };

  const channelLabel = (channel: string) =>
    t(`paymentAdmin.manualSettle.channels.${channel}` as MessageKey);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("paymentAdmin.manualSettle.title")}</DialogTitle>
        <DialogDescription>
          {t(key("refundOrder"), { reference: refund.paymentReference })}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          {t("paymentAdmin.manualSettle.amountLabel")}
        </p>
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
          {t("paymentAdmin.manualSettle.warnTitle")}
        </p>
        <p className="text-sm leading-5">
          {t("paymentAdmin.manualSettle.warnBody")}
        </p>
        <p className="text-sm leading-5">
          {t("paymentAdmin.manualSettle.mfaHint")}
        </p>
      </div>
      <p className="text-sm font-semibold">
        {t(
          confirming
            ? "paymentAdmin.manualSettle.stepConfirm"
            : "paymentAdmin.manualSettle.stepRecord",
        )}
      </p>
      {confirming ? (
        <div className="grid gap-4">
          <h3 className="font-semibold">
            {t("paymentAdmin.manualSettle.confirmTitle")}
          </h3>
          <p className="text-sm leading-5">
            {t("paymentAdmin.manualSettle.confirmBody")}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label={t("paymentAdmin.manualSettle.amountPaid")}>
              <Money amount={refund.amountIdr} className="font-semibold" />
            </Detail>
            <Detail label={t("paymentAdmin.manualSettle.paidAt")}>
              {formatMoment(new Date(form.paidAtLocal).toISOString())}
            </Detail>
            <Detail label={t("paymentAdmin.manualSettle.channel")}>
              {channelLabel(form.channel)}
            </Detail>
            <Detail label={t("paymentAdmin.manualSettle.externalReference")}>
              {form.externalReference.trim()}
            </Detail>
            <Detail label={t("paymentAdmin.manualSettle.note")}>
              {form.note.trim()}
            </Detail>
          </dl>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={settle.isPending}
              onClick={() => setConfirming(false)}
            >
              {t("paymentAdmin.manualSettle.back")}
            </Button>
            <Button type="button" onClick={submit} loading={settle.isPending}>
              {t("paymentAdmin.manualSettle.confirmSubmit")}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={review} noValidate>
          <FormField
            label={t("paymentAdmin.manualSettle.paidAt")}
            required
            error={errorOf("paidAt")}
          >
            <Input
              type="datetime-local"
              value={form.paidAtLocal}
              onChange={(event) => set({ paidAtLocal: event.target.value })}
            />
          </FormField>
          <FormField
            label={t("paymentAdmin.manualSettle.channel")}
            required
            error={errorOf("channel")}
          >
            <Select
              value={form.channel}
              onValueChange={(value) =>
                set({ channel: value as ManualSettlementForm["channel"] })
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "paymentAdmin.manualSettle.channelPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_SETTLE_CHANNELS.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {channelLabel(channel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("paymentAdmin.manualSettle.externalReference")}
            hint={t("paymentAdmin.manualSettle.externalReferenceHint")}
            required
            error={errorOf("externalReference")}
          >
            <Input
              value={form.externalReference}
              maxLength={100}
              onChange={(event) =>
                set({ externalReference: event.target.value })
              }
            />
          </FormField>
          <FormField
            label={t("paymentAdmin.manualSettle.amountPaid")}
            hint={t("paymentAdmin.manualSettle.amountPaidHint")}
            required
            error={errorOf("amountIdr")}
          >
            <Input
              inputMode="numeric"
              value={form.amountIdr}
              onChange={(event) => set({ amountIdr: event.target.value })}
            />
          </FormField>
          <FormField
            label={t("paymentAdmin.manualSettle.note")}
            required
            error={errorOf("note")}
          >
            <Textarea
              value={form.note}
              rows={3}
              placeholder={t("paymentAdmin.manualSettle.notePlaceholder")}
              onChange={(event) => set({ note: event.target.value })}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onBack}>
              {t("paymentAdmin.manualSettle.back")}
            </Button>
            <Button type="submit">
              {t("paymentAdmin.manualSettle.review")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}
