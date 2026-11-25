// Refund queue and creation (PRD §3 F13 "Refund"): a refund can be full or
// partial and always waits for supervisor approval before money moves. The
// server checks the amount against the paid amount; the form only proposes it.
import * as React from "react";
import { Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type {
  RefundView,
  RefundablePayment,
} from "@starter/shared/payment/admin";
import { formatRupiah } from "@starter/shared/i18n";
import { idr } from "@starter/shared/core";
import { formatMoment, methodLabelKey } from "../format";
import {
  filterRefundList,
  refundRefusalKey,
  refundUiLabelKey,
  refundUiState,
  refundUiTone,
  type RefundListFilter,
} from "../refund-actions.ts";
import { RefundFollowupDialog } from "./refund-followup-dialog";
import {
  useApproveRefund,
  useCreateRefund,
  useRefundablePayments,
  useRefunds,
} from "../hooks";
import { ApiError } from "../../../lib/api/errors.ts";
import { retainedAttempt } from "../../../lib/retained-attempt-key.ts";

const ALL = "all";

const STATUS_LABELS = {
  pending: "paymentAdmin.refunds.statusPending",
  approved: "paymentAdmin.refunds.statusApproved",
  completed: "paymentAdmin.refunds.statusCompleted",
  failed: "paymentAdmin.refunds.statusFailed",
} as const;

export function RefundsPanel() {
  const t = useT();
  const refunds = useRefunds();
  const [status, setStatus] = React.useState<RefundListFilter>(ALL);
  const [creating, setCreating] = React.useState(false);
  const [approving, setApproving] = React.useState<RefundView | null>(null);
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const rows = filterRefundList(refunds.data?.data ?? [], status);
  const total = refunds.data?.data.length ?? 0;
  const state = refunds.isPending
    ? "loading"
    : refunds.isError
      ? "error"
      : total === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("paymentAdmin.refunds.title")}
        description={t("paymentAdmin.refunds.hint")}
        state={state}
        rowCount={rows.length}
        noResults={total > 0 && rows.length === 0}
        onRetry={() => void refunds.refetch()}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as RefundListFilter)}
            >
              <SelectTrigger
                className="w-full sm:w-52"
                aria-label={t("paymentAdmin.refunds.filter")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("paymentAdmin.refunds.allStatuses")}
                </SelectItem>
                {(["pending", "approved", "completed", "failed"] as const).map(
                  (entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(STATUS_LABELS[entry])}
                    </SelectItem>
                  ),
                )}
                <SelectItem value="quarantined">
                  {t("paymentAdmin.refundFollowup.quarantine.filter")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("paymentAdmin.refunds.create")}
            </Button>
          </div>
        }
        empty={{
          title: t("paymentAdmin.refunds.emptyTitle"),
          description: t("paymentAdmin.refunds.emptyHint"),
          action: (
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("paymentAdmin.refunds.create")}
            </Button>
          ),
        }}
      >
        <ul className="divide-y divide-border">
          {rows.map((refund) => (
            <li
              key={refund.id}
              className="flex flex-col gap-3 p-card sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-semibold tabular">
                  {refund.paymentReference}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(methodLabelKey(refund.method))} ·{" "}
                  {formatMoment(refund.createdAt)} · {refund.requestedByName}
                </p>
                <p className="max-w-2xl truncate text-sm text-muted-foreground">
                  {refund.reason}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                <div className="text-right">
                  <Money amount={refund.amountIdr} />
                  <p className="text-sm text-muted-foreground">
                    / {formatRupiah(refund.paidAmountIdr)}
                  </p>
                </div>
                <StatusPill status={refundUiTone(refundUiState(refund))}>
                  {t(refundUiLabelKey(refundUiState(refund)))}
                </StatusPill>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReviewingId(refund.id)}
                >
                  {t("paymentAdmin.refundFollowup.review")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      {reviewingId && (
        <RefundFollowupDialog
          refundId={reviewingId}
          onClose={() => setReviewingId(null)}
          onApprove={(refund) => {
            setReviewingId(null);
            setApproving(refund);
          }}
        />
      )}
      {creating && <CreateRefundDialog onClose={() => setCreating(false)} />}
      {approving && (
        <ApproveRefundDialog
          refund={approving}
          onClose={() => setApproving(null)}
        />
      )}
    </>
  );
}

function CreateRefundDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const payments = useRefundablePayments();
  const create = useCreateRefund();
  const options = payments.data?.data.payments ?? [];
  const [paymentId, setPaymentId] = React.useState<string>("");
  const selected = options.find(
    (payment) => payment.paymentIntentId === paymentId,
  );
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  // One key per request, kept across close and reopen: a retry or double
  // submit replays, never refunds twice.
  const attempt = retainedAttempt("refund.create");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});

  const choosePayment = (nextId: string) => {
    setPaymentId(nextId);
    const payment = options.find((entry) => entry.paymentIntentId === nextId);
    setAmount(payment ? String(payment.refundableAmountIdr) : "");
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string | undefined> = {};
    if (!selected) next.paymentId = t("paymentAdmin.refunds.paymentRequired");
    if (reason.trim() === "")
      next.reason = t("paymentAdmin.refunds.reasonRequired");
    const amountIdr = Number(amount);
    if (
      selected &&
      (!Number.isInteger(amountIdr) ||
        amountIdr <= 0 ||
        amountIdr > selected.refundableAmountIdr)
    )
      next.amount = t("paymentAdmin.refunds.overAmount");
    setErrors(next);
    if (!selected || Object.keys(next).length > 0) return;
    const body = {
      paymentIntentId: selected.paymentIntentId,
      amountIdr: idr(amountIdr),
      reason: reason.trim(),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    };
    create.mutate(
      { idempotencyKey: attempt.keyFor(body), ...body },
      {
        onSuccess: () => {
          attempt.settle();
          toast({ title: t("paymentAdmin.refunds.created") });
          onClose();
        },
        onError: (error) => {
          const refusalKey =
            error instanceof ApiError ? refundRefusalKey(error.code) : null;
          setErrors({ form: refusalKey ? t(refusalKey) : error.message });
        },
      },
    );
  };

  return (
    <PendingDialog
      pending={create.isPending}
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>{t("paymentAdmin.refunds.create")}</DialogTitle>
          <DialogDescription>
            {t("paymentAdmin.refunds.hint")}
          </DialogDescription>
        </DialogHeader>
        {payments.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : options.length === 0 ? (
          <EmptyState
            title={t("paymentAdmin.refunds.emptyTitle")}
            description={t("paymentAdmin.refunds.noRefundable")}
          />
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <FormField
              label={t("paymentAdmin.refunds.payment")}
              required
              error={errors.paymentId}
            >
              <Select value={paymentId} onValueChange={choosePayment}>
                <SelectTrigger aria-label={t("paymentAdmin.refunds.payment")}>
                  <SelectValue
                    placeholder={t("paymentAdmin.refunds.paymentPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {options.map((payment: RefundablePayment) => (
                    <SelectItem
                      key={payment.paymentIntentId}
                      value={payment.paymentIntentId}
                    >
                      {payment.reference} · {t(methodLabelKey(payment.method))}{" "}
                      · {formatRupiah(payment.refundableAmountIdr)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("paymentAdmin.refunds.amount")}
              required
              error={errors.amount}
              hint={
                selected
                  ? t("paymentAdmin.refunds.max", {
                      amount: formatRupiah(selected.refundableAmountIdr),
                    })
                  : undefined
              }
            >
              <Input
                inputMode="numeric"
                value={amount}
                onChange={(event) =>
                  setAmount(event.target.value.replace(/[^\d]/g, ""))
                }
              />
            </FormField>
            <FormField
              label={t("paymentAdmin.refunds.reason")}
              required
              error={errors.reason}
            >
              <Input
                value={reason}
                placeholder={t("paymentAdmin.refunds.reasonPlaceholder")}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
            <FormField label={t("paymentAdmin.refunds.note")}>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
              />
            </FormField>
            {errors.form && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {errors.form}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t("paymentAdmin.refunds.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
        {options.length === 0 && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        )}
      </PendingDialogContent>
    </PendingDialog>
  );
}

function ApproveRefundDialog({
  refund,
  onClose,
}: {
  refund: RefundView;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const approve = useApproveRefund();
  const [note, setNote] = React.useState("");
  const attempt = retainedAttempt(`refund.approve.${refund.id}`);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const idempotencyKey = attempt.keyFor({ note: note.trim() });
    approve.mutate(
      {
        refundId: refund.id,
        body:
          note.trim() === ""
            ? { idempotencyKey }
            : { idempotencyKey, note: note.trim() },
      },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.refunds.approved", {
              reference: refund.paymentReference,
            }),
          });
          onClose();
        },
        onError: (error) => toast({ title: error.message, tone: "danger" }),
      },
    );
  };

  return (
    <PendingDialog
      pending={approve.isPending}
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>{t("paymentAdmin.refunds.approveTitle")}</DialogTitle>
          <DialogDescription>
            {t("paymentAdmin.refunds.approveBody", {
              amount: formatRupiah(refund.amountIdr),
              method: t(methodLabelKey(refund.method)),
              reference: refund.paymentReference,
            })}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <FormField label={t("paymentAdmin.refunds.approveNote")}>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={approve.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={approve.isPending}>
              {t("paymentAdmin.refunds.approve")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
