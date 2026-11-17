// Refund recon holds (legend-vp4ta): a refund the provider made that does not
// match any refund of ours blocks refund, payout and fund on that payment.
// Finance closes the hold with a decision and a note. Closing never pays
// anyone; "counted" records the money as already returned to the guest.
import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
  RefundReconHoldResolution,
  RefundReconHoldView,
} from "@starter/shared/payment/admin";
import { formatMoment } from "../format";
import { useRefundReconHolds, useResolveRefundReconHold } from "../hooks";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type HoldFilter = "open" | "resolved";

export function RefundHoldsPanel() {
  const t = useT();
  const [status, setStatus] = React.useState<HoldFilter>("open");
  const holds = useRefundReconHolds(status);
  const [resolving, setResolving] = React.useState<RefundReconHoldView | null>(
    null,
  );
  const rows = holds.data?.data ?? [];
  const state = holds.isPending
    ? "loading"
    : holds.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("paymentAdmin.refundHolds.title")}
        description={t("paymentAdmin.refundHolds.hint")}
        state={state}
        rowCount={rows.length}
        error={holds.error}
        onRetry={() => void holds.refetch()}
        actions={
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as HoldFilter)}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              aria-label={t("paymentAdmin.refundHolds.filter")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">
                {t("paymentAdmin.refundHolds.statusOpen")}
              </SelectItem>
              <SelectItem value="resolved">
                {t("paymentAdmin.refundHolds.statusResolved")}
              </SelectItem>
            </SelectContent>
          </Select>
        }
        empty={{
          title: t("paymentAdmin.refundHolds.emptyTitle"),
          description: t("paymentAdmin.refundHolds.emptyHint"),
        }}
      >
        <ul className="divide-y divide-border">
          {rows.map((hold) => (
            <li
              key={hold.id}
              className="flex flex-col gap-3 p-card sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-semibold break-all">
                  {hold.providerRefundId ??
                    t("paymentAdmin.refundHolds.noProviderRefund")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("paymentAdmin.refundHolds.payment")}{" "}
                  <span className="tabular break-all">
                    {hold.paymentIntentId}
                  </span>{" "}
                  · {t("paymentAdmin.refundHolds.flaggedAt")}{" "}
                  {formatMoment(hold.flaggedAt)}
                </p>
                <p className="text-sm text-muted-foreground">{hold.reason}</p>
                {hold.resolvedAt && hold.resolution && (
                  <p className="text-sm text-muted-foreground">
                    {t(resolutionLabelKey(hold.resolution))} ·{" "}
                    {formatMoment(hold.resolvedAt)}
                    {hold.resolutionNote ? ` · ${hold.resolutionNote}` : ""}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                <div className="text-right">
                  {hold.amountIdr > 0 ? (
                    <Money amount={hold.amountIdr} size="lg" />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("paymentAdmin.refundHolds.amountUnknown")}
                    </p>
                  )}
                </div>
                <StatusPill status={hold.resolvedAt ? "success" : "warning"}>
                  {t(
                    hold.resolvedAt
                      ? "paymentAdmin.refundHolds.statusResolved"
                      : "paymentAdmin.refundHolds.statusOpen",
                  )}
                </StatusPill>
                {!hold.resolvedAt && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setResolving(hold)}
                  >
                    {t("paymentAdmin.refundHolds.resolve")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      {resolving && (
        <ResolveHoldDialog
          hold={resolving}
          onClose={() => setResolving(null)}
        />
      )}
    </>
  );
}

function resolutionLabelKey(resolution: RefundReconHoldResolution) {
  return resolution === "counted_against_intent"
    ? "paymentAdmin.refundHolds.resolvedCounted"
    : "paymentAdmin.refundHolds.resolvedNotThis";
}

function ResolveHoldDialog({
  hold,
  onClose,
}: {
  hold: RefundReconHoldView;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const resolve = useResolveRefundReconHold();
  // No default: finance must choose, so a hold is never closed by habit.
  const [resolution, setResolution] =
    React.useState<RefundReconHoldResolution | null>(null);
  const [note, setNote] = React.useState("");
  // One key per dialog so a retry never records the refund twice.
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());
  const [error, setError] = React.useState<string | undefined>();
  const [choiceError, setChoiceError] = React.useState<string | undefined>();
  const groupName = React.useId();
  // Without a provider refund id or an amount there is nothing to count.
  const canCount = hold.providerRefundId !== null && hold.amountIdr > 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setChoiceError(undefined);
    setError(undefined);
    if (!resolution) {
      setChoiceError(t("paymentAdmin.refundHolds.resolutionRequired"));
      return;
    }
    if (note.trim().length < 4) {
      setError(t("paymentAdmin.refundHolds.noteRequired"));
      return;
    }
    resolve.mutate(
      {
        holdId: hold.id,
        body: { idempotencyKey, resolution, note: note.trim() },
      },
      {
        onSuccess: () => {
          toast({ title: t("paymentAdmin.refundHolds.resolved") });
          onClose();
        },
        onError: (mutationError) => setError(mutationError.message),
      },
    );
  };

  const options: {
    value: RefundReconHoldResolution;
    label: string;
    hint: string;
    disabled: boolean;
  }[] = [
    {
      value: "not_this_intent",
      label: t("paymentAdmin.refundHolds.notThisIntent"),
      hint: t("paymentAdmin.refundHolds.notThisIntentHint"),
      disabled: false,
    },
    {
      value: "counted_against_intent",
      label: t("paymentAdmin.refundHolds.countedAgainstIntent"),
      hint: t("paymentAdmin.refundHolds.countedAgainstIntentHint"),
      disabled: !canCount,
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("paymentAdmin.refundHolds.resolveTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("paymentAdmin.refundHolds.resolveBody")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <fieldset
            className="grid gap-2"
            aria-describedby={choiceError ? `${groupName}-error` : undefined}
          >
            <legend className="mb-1 text-sm font-medium">
              {t("paymentAdmin.refundHolds.resolution")}
            </legend>
            {options.map((option) => (
              <label
                key={option.value}
                className="flex min-h-11 items-start gap-3 rounded-control border border-border p-3 has-[:checked]:border-foreground has-[:disabled]:opacity-60"
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={resolution === option.value}
                  disabled={option.disabled}
                  onChange={() => setResolution(option.value)}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="grid gap-0.5">
                  <span className="text-sm font-semibold">{option.label}</span>
                  <span className="text-sm text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
            {choiceError && (
              <p
                id={`${groupName}-error`}
                role="alert"
                className="text-sm text-danger"
              >
                {choiceError}
              </p>
            )}
          </fieldset>
          {resolution === "counted_against_intent" && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-control bg-warning-subtle p-3 text-sm text-warning"
            >
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("paymentAdmin.refundHolds.countedWarning")}
            </p>
          )}
          <FormField
            label={t("paymentAdmin.refundHolds.note")}
            required
            error={error}
            hint={t("paymentAdmin.refundHolds.noteHint")}
          >
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={resolve.isPending}>
              {t("paymentAdmin.refundHolds.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
