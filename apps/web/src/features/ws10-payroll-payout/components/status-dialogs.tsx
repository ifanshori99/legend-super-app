// Dialogs of the Status tab: record a manual transfer result (paid with a bank
// reference; failed / not sent with a proof photo and a note, uploaded first),
// record funds that came back after a paid transfer (proof photo and note),
// confirm a cash hand-over, and read one item's detail. Money results ask for
// a step-up when the server says so; the server's refusal is always shown in
// the dialog.
import * as React from "react";
import { RadioGroup } from "radix-ui";
import { formatRupiah } from "@starter/shared/i18n";
import type { PayrollDisbursementItemDto } from "@starter/shared/types";
import { PAYOUT_EVIDENCE_MAX_BYTES } from "@starter/shared/validators/payroll-payout";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { evidenceUploadMessage } from "../errors";
import {
  useConfirmBatch,
  useConfirmCash,
  useResolveBatch,
  useReturnBatch,
  useUploadPayoutEvidence,
} from "../hooks";
import { itemStatusMeta } from "../lib";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { reviewErrorMessage } from "./status-errors";

type Person = { name: string; bank: string };
type Outcome = "succeeded" | "failed" | "not_sent";

const PROOF_TYPES = ["image/jpeg", "image/png"];

/**
 * A proof photo and a note, shared by "failed / not sent" and "funds came
 * back". The file is uploaded first; its key is kept so a retry after the
 * step-up sends the result without uploading the photo twice.
 */
function useProofForm(batchId: string) {
  const t = useT();
  const upload = useUploadPayoutEvidence();
  const [file, setFile] = React.useState<File | null>(null);
  const [note, setNote] = React.useState("");
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  const [noteProblem, setNoteProblem] = React.useState<string | null>(null);
  const uploaded = React.useRef<{ file: File; key: string } | null>(null);

  const pick = (next: File | null) => {
    setFileProblem(null);
    if (next && !PROOF_TYPES.includes(next.type)) {
      setFile(null);
      setFileProblem(t("payrollPayoutReview.error.evidencePhotoOnly"));
      return;
    }
    if (next && next.size > PAYOUT_EVIDENCE_MAX_BYTES) {
      setFile(null);
      setFileProblem(t("payrollPayoutReview.error.evidenceTooLarge"));
      return;
    }
    setFile(next);
  };
  const reset = () => {
    setFile(null);
    setFileProblem(null);
    setNoteProblem(null);
  };
  /** False (with the reason shown in place) while the file or note is missing. */
  const validate = () => {
    const noFile = file === null;
    const noNote = note.trim() === "";
    if (noFile)
      setFileProblem(
        (current) =>
          current ?? t("payrollPayoutReview.result.evidenceFileRequired"),
      );
    setNoteProblem(
      noNote ? t("payrollPayoutReview.result.noteRequired") : null,
    );
    return !noFile && !noNote;
  };
  /** Uploads the photo (once), then hands its key to `onKey`. */
  const withKey = (
    onKey: (evidenceKey: string) => void,
    onFail: (failure: unknown) => void,
  ) => {
    if (!file) return;
    if (uploaded.current?.file === file) {
      onKey(uploaded.current.key);
      return;
    }
    upload.mutate(
      { batchId, file },
      {
        onSuccess: (result) => {
          uploaded.current = { file, key: result.evidenceKey };
          onKey(result.evidenceKey);
        },
        onError: (failure) => {
          const message = evidenceUploadMessage(failure, file, t);
          if (message) {
            setFileProblem(message);
            return;
          }
          onFail(failure);
        },
      },
    );
  };

  return {
    file,
    note,
    setNote,
    fileProblem,
    noteProblem,
    pick,
    reset,
    validate,
    withKey,
    uploading: upload.isPending,
  };
}

type ProofForm = ReturnType<typeof useProofForm>;

function ProofFields({
  form,
  busy,
  variant,
}: {
  form: ProofForm;
  busy: boolean;
  variant: "resolve" | "return";
}) {
  const t = useT();
  return (
    <>
      <FormField
        label={t("payrollPayoutReview.result.evidenceFile")}
        hint={t(
          variant === "return"
            ? "payrollPayoutReview.result.returnFileHint"
            : "payrollPayoutReview.result.evidenceFileHint",
        )}
        error={form.fileProblem ?? undefined}
        required
      >
        <Input
          type="file"
          accept="image/jpeg,image/png"
          data-testid="payout-evidence-file"
          disabled={busy}
          className="min-h-11"
          onChange={(event) => form.pick(event.target.files?.[0] ?? null)}
        />
      </FormField>
      {form.uploading && (
        <p
          role="status"
          data-testid="payout-evidence-uploading"
          className="text-sm text-muted-foreground"
        >
          {t("payrollPayoutReview.result.uploading")}
        </p>
      )}
      <FormField
        label={t("payrollPayoutReview.result.note")}
        hint={t("payrollPayoutReview.result.noteHint")}
        error={form.noteProblem ?? undefined}
        required
      >
        <Textarea
          data-testid="payout-evidence-note"
          value={form.note}
          maxLength={500}
          disabled={busy}
          onChange={(event) => form.setNote(event.target.value)}
        />
      </FormField>
    </>
  );
}

/** The three outcomes of a manual transfer; the choice is the dialog's. */
function OutcomeChoice({
  value,
  disabled,
  onChange,
}: {
  value: Outcome;
  disabled: boolean;
  onChange: (value: Outcome) => void;
}) {
  const t = useT();
  const options = [
    { value: "succeeded", label: t("payrollPayoutReview.result.succeeded") },
    { value: "failed", label: t("payrollPayoutReview.result.failed") },
    { value: "not_sent", label: t("payrollPayoutReview.result.not_sent") },
  ] as const;
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onChange(next as Outcome)}
      disabled={disabled}
      aria-label={t("payrollPayoutReview.result.outcome")}
      orientation="horizontal"
      className="inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-control border-(length:--border-w) bg-surface-2 p-1"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          data-testid={`payout-outcome-${option.value}`}
          className="inline-flex min-h-[calc(var(--control-h-sm)-0.5rem)] shrink-0 items-center rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-3 text-sm font-medium whitespace-nowrap text-muted-foreground data-[state=checked]:bg-card data-[state=checked]:font-semibold data-[state=checked]:text-foreground data-[state=checked]:shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)]"
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
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
  const resolve = useResolveBatch();
  const stepUp = useStepUp({ acceptsPassword: false });
  const proof = useProofForm(batchId);
  const refInput = React.useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = React.useState<Outcome>("succeeded");
  const [bankRef, setBankRef] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const busy = confirm.isPending || resolve.isPending || proof.uploading;

  const onFailure = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    setError(reviewErrorMessage(failure, t));
  };
  const onOutcome = (next: Outcome) => {
    setOutcome(next);
    setError(null);
    if (next === "succeeded") proof.reset();
  };
  const submit = (password?: string) => {
    if (busy) return;
    setError(null);
    if (outcome === "succeeded") {
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
      return;
    }
    if (!proof.validate()) return;
    proof.withKey((evidenceKey) => {
      resolve.mutate(
        {
          batchId,
          itemIds: [item.id],
          outcome,
          evidenceKey,
          note: proof.note.trim(),
          password,
        },
        {
          onSuccess: (result) => {
            toast({
              title: t(
                result.data.resolved > 0
                  ? "payrollPayoutReview.result.resolved"
                  : "payrollPayoutReview.result.proposed",
              ),
              tone: "success",
            });
            onClose();
          },
          onError: onFailure,
        },
      );
    }, onFailure);
  };

  const fields = (
    <div className="grid gap-3">
      <OutcomeChoice value={outcome} disabled={busy} onChange={onOutcome} />
      {outcome === "succeeded" ? (
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
      ) : (
        <>
          <p
            role="status"
            data-testid="payout-resolve-warning"
            className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
          >
            {t("payrollPayoutReview.result.resolveWarning")}
          </p>
          <ProofFields form={proof} busy={busy} variant="resolve" />
        </>
      )}
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

/**
 * Funds came back after a paid transfer: a proof photo and a note, uploaded
 * first. Two different people must each record it before the item is returned.
 */
export function ReturnDialog({
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
  const giveBack = useReturnBatch();
  const stepUp = useStepUp({ acceptsPassword: false });
  const proof = useProofForm(batchId);
  const [error, setError] = React.useState<string | null>(null);
  const busy = giveBack.isPending || proof.uploading;

  const onFailure = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    setError(reviewErrorMessage(failure, t));
  };
  const submit = (password?: string) => {
    if (busy) return;
    setError(null);
    if (!proof.validate()) return;
    proof.withKey((evidenceKey) => {
      giveBack.mutate(
        {
          batchId,
          itemIds: [item.id],
          evidenceKey,
          note: proof.note.trim(),
          password,
        },
        {
          onSuccess: (result) => {
            toast({
              title: t(
                result.data.proposed > 0
                  ? "payrollPayoutReview.result.returnProposed"
                  : "payrollPayoutReview.result.returnDone",
              ),
              tone: "success",
            });
            onClose();
          },
          onError: onFailure,
        },
      );
    }, onFailure);
  };

  const fields = (
    <div className="grid gap-3">
      <p
        data-testid="payout-return-warning"
        className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
      >
        {t("payrollPayoutReview.result.returnWarning")}
      </p>
      <ProofFields form={proof} busy={busy} variant="return" />
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="payout-return-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("payrollPayoutReview.result.returnTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.result.returnDescription", {
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
                {t("payrollPayoutReview.result.returnSubmit")}
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
  onReturn,
}: {
  item: PayrollDisbursementItemDto;
  person: Person;
  onClose: () => void;
  /** Set when funds that came back may be recorded for this item. */
  onReturn?: () => void;
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
          {onReturn && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid="payout-return-action"
              onClick={onReturn}
            >
              {t("payrollPayoutReview.result.returnAction")}
            </Button>
          )}
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
