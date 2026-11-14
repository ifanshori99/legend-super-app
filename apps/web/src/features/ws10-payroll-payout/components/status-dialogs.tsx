// Dialogs of the Status tab: record a manual transfer result (success with
// bank reference; failed / not sent needs a proof file the app cannot upload
// yet, so that choice only explains), confirm a cash hand-over, and read one
// item's detail. Money results ask for a step-up when
// the server says so; the server's refusal is always shown in the dialog.
import * as React from "react";
import { RadioGroup } from "radix-ui";
import { formatRupiah } from "@starter/shared/i18n";
import type { PayrollDisbursementItemDto } from "@starter/shared/types";
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
import { useToast } from "@/components/ui/toast";
import { cn } from "cn";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { useConfirmBatch, useConfirmCash } from "../hooks";
import { itemStatusMeta } from "../lib";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { reviewErrorMessage } from "./status-errors";

type Person = { name: string; bank: string };

/**
 * The three outcomes of a manual transfer. Only "paid" can be recorded: failed
 * and not sent need a bank proof file the app cannot upload yet, so those two
 * stay visible but off, with the reason right below.
 */
function OutcomeChoice({ reasonId }: { reasonId: string }) {
  const t = useT();
  const options = [
    { value: "succeeded", label: t("payrollPayoutReview.result.succeeded") },
    { value: "failed", label: t("payrollPayoutReview.result.failed") },
    { value: "not_sent", label: t("payrollPayoutReview.result.not_sent") },
  ] as const;
  return (
    <div className="grid gap-2">
      <RadioGroup.Root
        value="succeeded"
        aria-label={t("payrollPayoutReview.result.outcome")}
        orientation="horizontal"
        className="inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-control border-(length:--border-w) bg-surface-2 p-1"
      >
        {options.map((option) => {
          const off = option.value !== "succeeded";
          return (
            <RadioGroup.Item
              key={option.value}
              value={option.value}
              disabled={off}
              aria-describedby={off ? reasonId : undefined}
              className={cn(
                "inline-flex min-h-[calc(var(--control-h-sm)-0.5rem)] shrink-0 items-center rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-3 text-sm font-medium whitespace-nowrap",
                off
                  ? "cursor-not-allowed text-muted-foreground opacity-60"
                  : "bg-card font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)]",
              )}
            >
              {option.label}
            </RadioGroup.Item>
          );
        })}
      </RadioGroup.Root>
      <div
        id={reasonId}
        role="status"
        data-testid="payout-evidence-unavailable"
        className="grid gap-1 rounded-container bg-warning-subtle p-3 text-sm"
      >
        <p className="font-semibold text-warning">
          {t("payrollPayoutReview.result.evidenceUnavailableTitle")}
        </p>
        <p className="text-foreground">
          {t("payrollPayoutReview.result.evidenceUnavailable")}
        </p>
      </div>
    </div>
  );
}

export function ResultDialog({
  batchId,
  item,
  person,
  onClose,
}: {
  batchId: string;
  item: PayrollDisbursementItemDto;
  person: Person;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirmBatch();
  const stepUp = useStepUp({ acceptsPassword: true });
  const reasonId = React.useId();
  const refInput = React.useRef<HTMLInputElement>(null);
  const [bankRef, setBankRef] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const busy = confirm.isPending;

  const onFailure = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    setError(reviewErrorMessage(failure, t));
  };
  const submit = (password?: string) => {
    if (busy) return;
    setError(null);
    if (bankRef.trim() === "") {
      setProblem(t("payrollPayoutReview.result.bankRefRequired"));
      return;
    }
    setProblem(null);
    confirm.mutate(
      {
        batchId,
        results: [
          {
            itemId: item.id,
            result: "succeeded" as const,
            bankRef: bankRef.trim(),
          },
        ],
        password,
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayoutReview.status.success.confirmed"),
            tone: "success",
          });
          onClose();
        },
        onError: onFailure,
      },
    );
  };

  const fields = (
    <div className="grid gap-3">
      <OutcomeChoice reasonId={reasonId} />
      <FormField
        label={t("payrollPayoutReview.result.bankRef")}
        hint={t("payrollPayoutReview.result.bankRefHint")}
        error={problem ?? undefined}
        required
      >
        <Input
          ref={refInput}
          value={bankRef}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          className="min-h-11"
          onChange={(event) => setBankRef(event.target.value)}
        />
      </FormField>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="payout-result-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          refInput.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("payrollPayoutReview.result.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.result.description", {
              name: person.name,
              amount: formatRupiah(item.amountIdr),
            })}
          </DialogDescription>
        </DialogHeader>
        {stepUp.active ? (
          <>
            {fields}
            <VerifyPanel
              key={stepUp.round}
              needs={stepUp.needs}
              busy={busy}
              error={error}
              onVerified={submit}
              onCancel={onClose}
            />
          </>
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
                onClick={onClose}
              >
                {t("payrollPayoutReview.result.cancel")}
              </Button>
              <Button type="submit" className="min-h-11" loading={busy}>
                {t("payrollPayoutReview.result.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CashDialog({
  batchId,
  item,
  person,
  onClose,
}: {
  batchId: string;
  item: PayrollDisbursementItemDto;
  person: Person;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const cash = useConfirmCash();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [error, setError] = React.useState<string | null>(null);

  const submit = (password?: string) => {
    if (cash.isPending) return;
    setError(null);
    cash.mutate(
      {
        batchId,
        itemIds: [item.id],
        password,
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayoutReview.status.success.cash"),
            tone: "success",
          });
          onClose();
        },
        onError: (failure) => {
          if (stepUp.capture(failure)) return;
          setError(reviewErrorMessage(failure, t));
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="payout-cash-dialog">
        <DialogHeader>
          <DialogTitle>{t("payrollPayoutReview.result.cashTitle")}</DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.result.cashDescription", {
              name: person.name,
              amount: formatRupiah(item.amountIdr),
            })}
          </DialogDescription>
        </DialogHeader>
        {stepUp.active ? (
          <VerifyPanel
            key={stepUp.round}
            needs={stepUp.needs}
            busy={cash.isPending}
            error={error}
            onVerified={submit}
            onCancel={onClose}
          />
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
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
                onClick={onClose}
              >
                {t("payrollPayoutReview.result.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                loading={cash.isPending}
              >
                {t("payrollPayoutReview.result.cashSubmit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b-(length:--border-w) py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

export function DetailDialog({
  item,
  person,
  onClose,
}: {
  item: PayrollDisbursementItemDto;
  person: Person;
  onClose: () => void;
}) {
  const t = useT();
  const none = t("payrollPayoutReview.detail.none");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="payout-detail-dialog">
        <DialogHeader>
          <DialogTitle>{t("payrollPayoutReview.detail.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.detail.attempt", { n: item.attemptNo })}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid">
          <DetailRow label={t("payrollPayoutReview.detail.employee")}>
            {person.name}
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.account")}>
            {person.bank}
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.amount")}>
            <Money amount={item.amountIdr} size="sm" />
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.fee")}>
            <Money amount={item.feeIdr} size="sm" />
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.status")}>
            {t(itemStatusMeta(item.status).labelKey)}
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.ref")}>
            {item.confirmationRef ?? none}
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.providerRef")}>
            {item.providerRef ?? none}
          </DetailRow>
          <DetailRow label={t("payrollPayoutReview.detail.settledAt")}>
            {item.settledAt ? formatDateTime(item.settledAt) : none}
          </DetailRow>
        </dl>
        {(item.status === "failed" || item.status === "not_sent") && (
          <p className="rounded-container bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("payrollPayoutReview.detail.failedNote")}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
          >
            {t("payrollPayoutReview.common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
