// SH-04: an approved distribution is never edited. The correction is a new
// adjustment distribution that carries that run's split, needs a reason and
// posts a reversing journal; this dialog is the only way to create it.
import * as React from "react";
import { ReceiptText } from "lucide-react";
import type { DistributionRun } from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
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
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFiscalPeriods } from "@/features/ws07-accounting/hooks";
import { useCreateAdjustmentDistribution } from "../hooks";
import {
  formatSharePeriod,
  isClosedPeriod,
  parseAdjustmentIdrInput,
  shortActorRef,
} from "../lib";

export function AdjustmentDialog({
  open,
  onOpenChange,
  legalEntityId,
  target,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  target: DistributionRun | null;
  onCreated: (run: DistributionRun) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {target && (
          <AdjustmentForm
            onOpenChange={onOpenChange}
            legalEntityId={legalEntityId}
            target={target}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AdjustmentForm({
  onOpenChange,
  legalEntityId,
  target,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  target: DistributionRun;
  onCreated: (run: DistributionRun) => void;
}) {
  const t = useT();
  const toast = useToast();
  const periodsQuery = useFiscalPeriods(legalEntityId);
  const create = useCreateAdjustmentDistribution(target.profitEntityId);
  const [periodId, setPeriodId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const periods = periodsQuery.data ?? [];
  const closed = periods.filter((row) => isClosedPeriod(row.status));
  const selected =
    periods.find((row) => row.id === periodId) ?? closed[0] ?? periods[0];
  const parsedAmount = parseAdjustmentIdrInput(amount);
  const pending = create.isPending;

  const submit = async () => {
    setServerError(null);
    const nextErrors: Record<string, string | undefined> = {};
    if (!selected || !isClosedPeriod(selected.status))
      nextErrors.fiscalPeriodId = t("accounting.share.wizard.calc.openWarning");
    if (parsedAmount === null)
      nextErrors.amount = t("accounting.share.wizard.adjustAmountHint");
    if (reason.trim() === "")
      nextErrors.reason = t("accounting.share.wizard.adjustReasonHint");
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    try {
      const run = await create.mutateAsync({
        distributionRunId: target.id,
        body: {
          fiscalPeriodId: selected?.id ?? "",
          adjustmentIdr: parsedAmount ?? 0,
          reason: reason.trim(),
        },
      });
      toast({ title: t("accounting.share.wizard.adjustSaved") });
      onCreated(run);
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.share.wizard.adjustTitle")}</DialogTitle>
        <DialogDescription>
          {t("accounting.share.wizard.adjustDescription")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <dl className="grid gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.share.wizard.adjustTarget", {
                period: formatSharePeriod(target.period),
              })}
            </dt>
            <dd className="font-semibold">
              <Money amount={target.totalNetIdr} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.share.wizard.runMeta.shareVersion", {
                version: target.shareVersion,
              })}
            </dt>
            <dd className="tabular">{shortActorRef(target.id)}</dd>
          </div>
        </dl>

        {periodsQuery.isPending ? (
          <Skeleton className="h-control w-full" />
        ) : (
          <FormField
            label={t("accounting.share.wizard.adjustPeriod")}
            error={errors.fiscalPeriodId}
            required
          >
            <Select
              value={selected?.id ?? ""}
              onValueChange={(value) => setPeriodId(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((period) => (
                  <SelectItem key={period.id} value={period.id}>
                    {formatSharePeriod(period.period)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}

        <FormField
          label={t("accounting.share.wizard.adjustAmount")}
          hint={t("accounting.share.wizard.adjustAmountHint")}
          error={errors.amount}
          required
        >
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="numeric"
            className="tabular"
            autoComplete="off"
          />
        </FormField>

        <FormField
          label={t("accounting.share.wizard.adjustReason")}
          hint={t("accounting.share.wizard.adjustReasonHint")}
          error={errors.reason}
          required
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
          />
        </FormField>

        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            <ReceiptText aria-hidden="true" />
            {t("accounting.share.wizard.adjustSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
