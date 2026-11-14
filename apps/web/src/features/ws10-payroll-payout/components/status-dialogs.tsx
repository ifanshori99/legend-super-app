// Dialogs of the Status tab: record a manual transfer result (success with
// bank reference, or failed / not sent with evidence), confirm a cash
// hand-over, and read one item's detail. Money results ask for a step-up when
// the server says so; the server's refusal is always shown in the dialog.
import * as React from "react";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { payoutErrorMessage } from "../errors";
import { useConfirmBatch, useConfirmCash, useResolveBatch } from "../hooks";
import { itemStatusMeta } from "../lib";
import { VerifyPanel, useStepUp } from "./approval-verify";

type Outcome = "succeeded" | "failed" | "not_sent";

type Person = { name: string; bank: string };

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
  const resolve = useResolveBatch();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [outcome, setOutcome] = React.useState<Outcome>("succeeded");
  const [bankRef, setBankRef] = React.useState("");
  const [evidence, setEvidence] = React.useState("");
  const [note, setNote] = React.useState("");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const busy = confirm.isPending || resolve.isPending;

  const onFailure = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    setError(payoutErrorMessage(failure, t));
  };
  const onDone = (messageKey: "confirmed" | "resolved") => {
    toast({
      title: t(`payrollPayoutReview.status.success.${messageKey}`),
      tone: "success",
    });
    onClose();
  };

  const submit = (password?: string) => {
    if (busy) return;
    const next: Record<string, string> = {};
    if (outcome === "succeeded") {
      if (bankRef.trim() === "")
        next.bankRef = t("payrollPayoutReview.result.bankRefRequired");
    } else {
      if (evidence.trim() === "")
        next.evidence = t("payrollPayoutReview.result.evidenceRequired");
      if (note.trim() === "")
        next.note = t("payrollPayoutReview.result.noteRequired");
    }
    setProblems(next);
    setError(null);
    if (Object.keys(next).length > 0) return;
    if (outcome === "succeeded") {
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
        { onSuccess: () => onDone("confirmed"), onError: onFailure },
      );
      return;
    }
    resolve.mutate(
      {
        batchId,
        itemIds: [item.id],
        outcome,
        evidenceKey: evidence.trim(),
        note: note.trim(),
        password,
      },
      { onSuccess: () => onDone("resolved"), onError: onFailure },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="payout-result-dialog">
        <DialogHeader>
          <DialogTitle>{t("payrollPayoutReview.result.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.result.description", {
              name: person.name,
              amount: formatRupiah(item.amountIdr),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SegmentedControl<Outcome>
            label={t("payrollPayoutReview.result.outcome")}
            value={outcome}
            onValueChange={setOutcome}
            options={[
              {
                value: "succeeded",
                label: t("payrollPayoutReview.result.succeeded"),
              },
              {
                value: "failed",
                label: t("payrollPayoutReview.result.failed"),
              },
              {
                value: "not_sent",
                label: t("payrollPayoutReview.result.not_sent"),
              },
            ]}
          />
          {outcome !== "succeeded" && (
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutReview.result.outcomeHint")}
            </p>
          )}
          {outcome === "succeeded" ? (
            <FormField
              label={t("payrollPayoutReview.result.bankRef")}
              hint={t("payrollPayoutReview.result.bankRefHint")}
              error={problems.bankRef}
              required
            >
              <Input
                value={bankRef}
                maxLength={64}
                className="min-h-11"
                onChange={(event) => setBankRef(event.target.value)}
              />
            </FormField>
          ) : (
            <>
              <FormField
                label={t("payrollPayoutReview.result.evidence")}
                hint={t("payrollPayoutReview.result.evidenceHint")}
                error={problems.evidence}
                required
              >
                <Input
                  value={evidence}
                  maxLength={200}
                  className="min-h-11"
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </FormField>
              <FormField
                label={t("payrollPayoutReview.result.note")}
                hint={t("payrollPayoutReview.result.noteHint")}
                error={problems.note}
                required
              >
                <Textarea
                  value={note}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                />
              </FormField>
            </>
          )}
        </div>
        {stepUp.active ? (
          <VerifyPanel
            key={stepUp.round}
            needs={stepUp.needs}
            busy={busy}
            error={error}
            onVerified={submit}
          />
        ) : (
          <>
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
                type="button"
                className="min-h-11"
                loading={busy}
                onClick={() => submit()}
              >
                {t("payrollPayoutReview.result.submit")}
              </Button>
            </DialogFooter>
          </>
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
  const [evidence, setEvidence] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = (password?: string) => {
    if (cash.isPending) return;
    setError(null);
    cash.mutate(
      {
        batchId,
        itemIds: [item.id],
        evidenceKey: evidence.trim() === "" ? undefined : evidence.trim(),
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
          setError(payoutErrorMessage(failure, t));
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
        <FormField label={t("payrollPayoutReview.result.cashEvidence")}>
          <Input
            value={evidence}
            maxLength={200}
            className="min-h-11"
            onChange={(event) => setEvidence(event.target.value)}
          />
        </FormField>
        {stepUp.active ? (
          <VerifyPanel
            key={stepUp.round}
            needs={stepUp.needs}
            busy={cash.isPending}
            error={error}
            onVerified={submit}
          />
        ) : (
          <>
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
                type="button"
                className="min-h-11"
                loading={cash.isPending}
                onClick={() => submit()}
              >
                {t("payrollPayoutReview.result.cashSubmit")}
              </Button>
            </DialogFooter>
          </>
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
