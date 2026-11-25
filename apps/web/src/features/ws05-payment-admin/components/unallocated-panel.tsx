// Unallocated funds (PAY-04): a double payment or an overpayment is never
// lost — it lands here and is closed by a refund or a guest credit, always
// with an approval note. The table shows the money that has no bill to sit on.
import * as React from "react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
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
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type {
  UnallocatedFundView,
  UnallocatedStatus,
} from "@starter/shared/payment/admin";
import { formatRupiah } from "@starter/shared/i18n";
import {
  filterUnallocated,
  formatMoment,
  methodLabelKey,
  unallocatedLabelKey,
  unallocatedTone,
} from "../format";
import { useResolveUnallocatedFund, useUnallocatedFunds } from "../hooks";
import { retainedAttempt } from "../../../lib/retained-attempt-key.ts";

const ALL = "all";

export function UnallocatedPanel() {
  const t = useT();
  const funds = useUnallocatedFunds();
  const [status, setStatus] = React.useState<UnallocatedStatus | "all">(ALL);
  const [resolving, setResolving] = React.useState<UnallocatedFundView | null>(
    null,
  );
  const all = funds.data?.data ?? [];
  const rows = filterUnallocated(all, status);
  const state = funds.isPending
    ? "loading"
    : funds.isError
      ? "error"
      : all.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("paymentAdmin.unallocated.title")}
        description={t("paymentAdmin.unallocated.hint")}
        state={state}
        rowCount={rows.length}
        noResults={all.length > 0 && rows.length === 0}
        onRetry={() => void funds.refetch()}
        actions={
          <Select
            value={status}
            onValueChange={(value) =>
              setStatus(value as UnallocatedStatus | "all")
            }
          >
            <SelectTrigger
              className="w-full sm:w-52"
              aria-label={t("paymentAdmin.unallocated.filter")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("paymentAdmin.unallocated.allStatuses")}
              </SelectItem>
              <SelectItem value="open">
                {t("paymentAdmin.unallocated.statusOpen")}
              </SelectItem>
              <SelectItem value="resolved">
                {t("paymentAdmin.unallocated.statusResolved")}
              </SelectItem>
              <SelectItem value="needs_review">
                {t("paymentAdmin.unallocated.statusNeedsReview")}
              </SelectItem>
            </SelectContent>
          </Select>
        }
        empty={{
          title: t("paymentAdmin.unallocated.emptyTitle"),
          description: t("paymentAdmin.unallocated.emptyHint"),
        }}
      >
        <ul className="divide-y divide-border">
          {rows.map((fund) => (
            <li
              key={fund.id}
              className="flex flex-col gap-3 p-card sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-semibold tabular">{fund.paymentReference}</p>
                <p className="text-sm text-muted-foreground">
                  {t(methodLabelKey(fund.method))} · {fund.outletName} ·{" "}
                  {formatMoment(fund.detectedAt)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("paymentAdmin.unallocated.paidAmount")}{" "}
                  <Money amount={fund.paidAmountIdr} size="sm" /> ·{" "}
                  {t("paymentAdmin.unallocated.billTotal")}{" "}
                  <Money amount={fund.billTotalIdr} size="sm" />
                </p>
                {fund.status === "needs_review" && (
                  <p className="text-sm text-muted-foreground">
                    {t("paymentAdmin.unallocated.needsReviewHint")}
                  </p>
                )}
                {fund.resolvedByName && (
                  <p className="text-sm text-muted-foreground">
                    {fund.resolvedByName}
                    {fund.note ? ` · ${fund.note}` : ""}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                <div className="text-right">
                  <Money amount={fund.amountIdr} size="lg" />
                  <p className="text-sm text-muted-foreground">
                    {t("paymentAdmin.unallocated.excess")}
                  </p>
                </div>
                <StatusPill status={unallocatedTone(fund.status)}>
                  {t(unallocatedLabelKey(fund.status))}
                </StatusPill>
                {fund.evidenceMismatch && (
                  <StatusPill status="warning">
                    {t("paymentAdmin.unallocated.evidenceMismatch")}
                  </StatusPill>
                )}
                {fund.status === "open" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setResolving(fund)}
                  >
                    {t("paymentAdmin.unallocated.resolve")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      {resolving && (
        <ResolveFundDialog
          fund={resolving}
          onClose={() => setResolving(null)}
        />
      )}
    </>
  );
}

function ResolveFundDialog({
  fund,
  onClose,
}: {
  fund: UnallocatedFundView;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const resolve = useResolveUnallocatedFund();
  const [resolution, setResolution] = React.useState<"refund" | "credit">(
    "refund",
  );
  const [note, setNote] = React.useState("");
  // One key per request, kept across close and reopen, so a retry never books
  // the refund/credit twice.
  const attempt = retainedAttempt(`unallocated.resolve.${fund.id}`);
  const [error, setError] = React.useState<string | undefined>();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (note.trim().length < 4) {
      setError(t("paymentAdmin.unallocated.noteRequired"));
      return;
    }
    resolve.mutate(
      {
        fundId: fund.id,
        body: {
          idempotencyKey: attempt.keyFor({ resolution, note: note.trim() }),
          resolution,
          note: note.trim(),
        },
      },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.unallocated.resolved", {
              amount: formatRupiah(fund.amountIdr),
            }),
          });
          onClose();
        },
        onError: (mutationError) => setError(mutationError.message),
      },
    );
  };

  return (
    <PendingDialog
      pending={resolve.isPending}
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("paymentAdmin.unallocated.resolveTitle", {
              amount: formatRupiah(fund.amountIdr),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("paymentAdmin.unallocated.resolveBody")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField label={t("paymentAdmin.unallocated.resolution")} required>
            <SegmentedControl
              value={resolution}
              label={t("paymentAdmin.unallocated.resolution")}
              onValueChange={setResolution}
              options={[
                {
                  value: "refund",
                  label: t("paymentAdmin.unallocated.resolutionRefund"),
                },
                {
                  value: "credit",
                  label: t("paymentAdmin.unallocated.resolutionCredit"),
                },
              ]}
            />
          </FormField>
          <FormField
            label={t("paymentAdmin.unallocated.note")}
            required
            error={error}
            hint={t("paymentAdmin.unallocated.noteHint")}
          >
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={resolve.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={resolve.isPending}>
              {t("paymentAdmin.unallocated.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
