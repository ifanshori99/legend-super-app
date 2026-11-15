// Dialogs of the Status tab: record a manual transfer result (paid with a bank
// reference; failed / not sent with a proof photo and a note, uploaded first),
// record funds that came back after a paid transfer (proof photo and note),
// confirm a cash hand-over, and read one item's detail. Money results ask for
// a step-up when the server says so; the server's refusal is always shown in
// the dialog.
import * as React from "react";
import { RadioGroup } from "radix-ui";
import { formatRupiah } from "@starter/shared/i18n";
import type {
  PayrollDisbursementItemDto,
  PayrollPayoutProposalDto,
} from "@starter/shared/types";
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
import { useStorageCapabilities } from "../../storage/capabilities";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { evidenceUploadMessage } from "../errors";
import {
  useConfirmBatch,
  useConfirmCash,
  useOpenPayoutEvidence,
  useResolveBatch,
  useReturnBatch,
  useUploadPayoutEvidence,
} from "../hooks";
import { itemStatusMeta } from "../lib";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { reviewErrorMessage } from "./status-errors";

type Person = { name: string; bank: string };
type Outcome = "succeeded" | "failed" | "not_sent";

const PHOTO_TYPES = ["image/jpeg", "image/png"];
const PDF_TYPE = "application/pdf";

/**
 * A proof photo and a note, shared by "failed / not sent" and "funds came
 * back". The file is uploaded first; its key is kept so a retry after the
 * step-up sends the result without uploading the photo twice.
 */
function useProofForm(batchId: string, options: { noFile?: boolean } = {}) {
  const t = useT();
  const upload = useUploadPayoutEvidence();
  // A PDF is offered only once the server says it can scan one.
  const { documentsAccepted } = useStorageCapabilities();
  const [file, setFile] = React.useState<File | null>(null);
  const [note, setNote] = React.useState("");
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  const [noteProblem, setNoteProblem] = React.useState<string | null>(null);
  const uploaded = React.useRef<{ file: File; key: string } | null>(null);

  const pick = (next: File | null) => {
    setFileProblem(null);
    if (
      next &&
      !PHOTO_TYPES.includes(next.type) &&
      !(documentsAccepted && next.type === PDF_TYPE)
    ) {
      setFile(null);
      setFileProblem(
        t(
          documentsAccepted
            ? "payrollPayoutReview.error.evidenceFileOnly"
            : "payrollPayoutReview.error.evidencePhotoOnly",
        ),
      );
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
    const noFile = !options.noFile && file === null;
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
  /**
   * Uploads the photo (once), then hands its key to `onKey`. The upload runs
   * the same step-up as the action, so the dialog's `password` goes along.
   */
  const withKey = (
    onKey: (evidenceKey: string) => void,
    onFail: (failure: unknown) => void,
    password?: string,
  ) => {
    if (!file) return;
    if (uploaded.current?.file === file) {
      onKey(uploaded.current.key);
      return;
    }
    upload.mutate(
      { batchId, file, password },
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
    setNote: (value: string) => {
      setNote(value);
      // The reason shown under the field goes away as soon as it is fixed.
      setNoteProblem(null);
    },
    fileProblem,
    noteProblem,
    documentsAccepted,
    pick,
    reset,
    validate,
    withKey,
    uploading: upload.isPending,
  };
}

type ProofForm = ReturnType<typeof useProofForm>;

/**
 * The native file input speaks the browser's language ("Choose File"), so it
 * stays invisible: a button opens it and the chosen name is shown in
 * Indonesian. FormField's id and aria props land on the real input.
 */
function EvidencePicker({
  file,
  disabled,
  documentsAccepted,
  onPick,
  ...inputProps
}: Omit<React.ComponentProps<"input">, "onChange" | "type" | "value"> & {
  file: File | null;
  documentsAccepted: boolean;
  onPick: (file: File | null) => void;
}) {
  const t = useT();
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        {...inputProps}
        ref={input}
        type="file"
        accept={
          documentsAccepted
            ? "image/jpeg,image/png,application/pdf"
            : "image/jpeg,image/png"
        }
        data-testid="payout-evidence-file"
        disabled={disabled}
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          onPick(event.target.files?.[0] ?? null);
          // So choosing the same photo again after a refusal still fires.
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {t(
          file
            ? "payrollPayoutReview.result.changeFile"
            : "payrollPayoutReview.result.pickFile",
        )}
      </Button>
      <span
        data-testid="payout-evidence-file-name"
        className="min-w-0 text-sm break-words text-muted-foreground"
      >
        {file ? file.name : t("payrollPayoutReview.result.noFile")}
      </span>
    </div>
  );
}

function ProofFields({
  form,
  busy,
  variant,
  withFile = true,
}: {
  form: ProofForm;
  busy: boolean;
  variant: "resolve" | "return";
  /** False for the second person: the proof comes from the first proposal. */
  withFile?: boolean;
}) {
  const t = useT();
  return (
    <>
      {withFile && (
        <>
          <FormField
            label={t("payrollPayoutReview.result.evidenceFile")}
            hint={t(
              variant === "return"
                ? form.documentsAccepted
                  ? "payrollPayoutReview.result.returnFileHintPdf"
                  : "payrollPayoutReview.result.returnFileHint"
                : form.documentsAccepted
                  ? "payrollPayoutReview.result.evidenceFileHintPdf"
                  : "payrollPayoutReview.result.evidenceFileHint",
            )}
            error={form.fileProblem ?? undefined}
            required
          >
            <EvidencePicker
              file={form.file}
              disabled={busy}
              documentsAccepted={form.documentsAccepted}
              onPick={form.pick}
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
        </>
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

/** A new tab, opened on the click so a pop-up blocker lets it through. */
function openInNewTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/**
 * What the first person recorded: the result, who, when, the note and a link
 * to their proof. The proof address is fetched on the click (it expires in a
 * minute), never kept.
 */
function ProposalPanel({
  batchId,
  proposal,
  mine,
}: {
  batchId: string;
  proposal: PayrollPayoutProposalDto;
  mine: boolean;
}) {
  const t = useT();
  const open = useOpenPayoutEvidence();
  const [problem, setProblem] = React.useState<string | null>(null);
  // The tab opened on the click, until the link arrives. Closing the dialog
  // meanwhile would leave it blank forever (the callbacks no longer run).
  const pendingTab = React.useRef<Window | null>(null);
  React.useEffect(
    () => () => {
      pendingTab.current?.close();
      pendingTab.current = null;
    },
    [],
  );
  const outcomeKey =
    proposal.kind === "return"
      ? "payrollPayoutReview.result.proposal.outcomeReturn"
      : proposal.outcome === "not_sent"
        ? "payrollPayoutReview.result.proposal.outcomeNotSent"
        : "payrollPayoutReview.result.proposal.outcomeFailed";
  const evidenceKey = proposal.evidenceKey;
  const view = () => {
    if (!evidenceKey || open.isPending) return;
    setProblem(null);
    const tab = openInNewTab();
    pendingTab.current = tab;
    open.mutate(
      { batchId, key: evidenceKey },
      {
        onSuccess: (result) => {
          const url = result.url;
          pendingTab.current = null;
          if (tab) tab.location.href = url;
          else window.open(url, "_blank", "noopener,noreferrer");
        },
        onError: () => {
          pendingTab.current = null;
          tab?.close();
          setProblem(t("payrollPayoutReview.result.proposal.openFailed"));
        },
      },
    );
  };
  return (
    <section
      aria-label={t("payrollPayoutReview.result.proposal.title")}
      data-testid="payout-proposal-panel"
      className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3"
    >
      <p className="font-semibold">
        {t("payrollPayoutReview.result.proposal.title")}
      </p>
      <dl className="grid">
        <DetailRow label={t("payrollPayoutReview.result.proposal.outcome")}>
          <span data-testid="payout-proposal-outcome">{t(outcomeKey)}</span>
        </DetailRow>
        <DetailRow label={t("payrollPayoutReview.result.proposal.by")}>
          <span data-testid="payout-proposal-by">
            {mine
              ? t("payrollPayoutReview.result.proposal.you")
              : (proposal.proposedByName ??
                t("payrollPayoutReview.result.proposal.other"))}
          </span>
        </DetailRow>
        <DetailRow label={t("payrollPayoutReview.result.proposal.at")}>
          <span data-testid="payout-proposal-at">
            {formatDateTime(proposal.proposedAt)}
          </span>
        </DetailRow>
        {proposal.note && (
          <DetailRow label={t("payrollPayoutReview.result.proposal.note")}>
            <span
              data-testid="payout-proposal-note"
              className="break-words whitespace-pre-wrap"
            >
              {proposal.note}
            </span>
          </DetailRow>
        )}
      </dl>
      {evidenceKey && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-fit"
          data-testid="payout-proposal-evidence"
          loading={open.isPending}
          onClick={view}
        >
          {t("payrollPayoutReview.result.proposal.viewEvidence")}
        </Button>
      )}
      {open.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("payrollPayoutReview.result.proposal.opening")}
        </p>
      )}
      {problem && (
        <p
          role="alert"
          data-testid="payout-proposal-open-error"
          className="text-sm font-medium text-danger"
        >
          {problem}
        </p>
      )}
    </section>
  );
}

/** Second person's view: the result is locked, only their own note is asked. */
function ProposalLock({
  batchId,
  proposal,
  mine,
  form,
  busy,
  variant,
}: {
  batchId: string;
  proposal: PayrollPayoutProposalDto;
  mine: boolean;
  form: ProofForm;
  busy: boolean;
  variant: "resolve" | "return";
}) {
  const t = useT();
  return (
    <>
      <ProposalPanel batchId={batchId} proposal={proposal} mine={mine} />
      {mine ? (
        <p
          role="status"
          data-testid="payout-proposal-waiting"
          className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
        >
          {t("payrollPayoutReview.result.proposal.waiting")}
        </p>
      ) : (
        <>
          <p
            data-testid="payout-proposal-locked"
            className="text-sm text-muted-foreground"
          >
            {t("payrollPayoutReview.result.proposal.locked")}
          </p>
          <ProofFields
            form={form}
            busy={busy}
            variant={variant}
            withFile={false}
          />
        </>
      )}
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
  proposal,
  mine = false,
  onClose,
}: {
  batchId: string;
  item: PayrollDisbursementItemDto;
  person: Person;
  /** The first person's proposal, when there is one: this is the second step. */
  proposal?: PayrollPayoutProposalDto;
  /** True when the signed-in user made that proposal. */
  mine?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirmBatch();
  const resolve = useResolveBatch();
  const stepUp = useStepUp({ acceptsPassword: false });
  const locked = proposal !== undefined;
  const waiting = locked && mine;
  const proof = useProofForm(batchId, { noFile: locked });
  const refInput = React.useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = React.useState<Outcome>(
    proposal ? (proposal.outcome ?? "failed") : "succeeded",
  );
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
    if (!proposal && outcome === "succeeded") {
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
    if (waiting) return;
    if (!proof.validate()) return;
    // Step 2 always repeats the proposal's outcome (the server rejects others).
    const resolveOutcome: "failed" | "not_sent" | null = proposal
      ? (proposal.outcome ?? "failed")
      : outcome === "succeeded"
        ? null
        : outcome;
    if (resolveOutcome === null) return;
    const send = (evidenceKey: string) => {
      resolve.mutate(
        {
          batchId,
          itemIds: [item.id],
          outcome: resolveOutcome,
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
    };
    if (proposal) {
      // Second person: the proof is the first person's, never a new upload.
      if (!proposal.evidenceKey) {
        setError(t("payrollPayoutReview.error.evidenceInvalid"));
        return;
      }
      send(proposal.evidenceKey);
      return;
    }
    proof.withKey(send, onFailure, password);
  };

  const fields = (
    <div className="grid gap-3">
      {proposal ? (
        <ProposalLock
          batchId={batchId}
          proposal={proposal}
          mine={mine}
          form={proof}
          busy={busy}
          variant="resolve"
        />
      ) : (
        <OutcomeChoice value={outcome} disabled={busy} onChange={onOutcome} />
      )}
      {proposal ? null : outcome === "succeeded" ? (
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
              <Button
                type="submit"
                className="min-h-11"
                loading={busy}
                disabled={waiting}
              >
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
  proposal,
  mine = false,
  onClose,
}: {
  batchId: string;
  item: PayrollDisbursementItemDto;
  person: Person;
  /** The first person's record of the funds, when there is one. */
  proposal?: PayrollPayoutProposalDto;
  /** True when the signed-in user made that proposal. */
  mine?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const giveBack = useReturnBatch();
  const stepUp = useStepUp({ acceptsPassword: false });
  const waiting = proposal !== undefined && mine;
  const proof = useProofForm(batchId, { noFile: proposal !== undefined });
  const [error, setError] = React.useState<string | null>(null);
  const busy = giveBack.isPending || proof.uploading;

  const onFailure = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    setError(reviewErrorMessage(failure, t));
  };
  const submit = (password?: string) => {
    if (busy) return;
    setError(null);
    if (waiting) return;
    if (!proof.validate()) return;
    const send = (evidenceKey: string) => {
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
    };
    if (proposal) {
      // Second person: the proof is the first person's, never a new upload.
      if (!proposal.evidenceKey) {
        setError(t("payrollPayoutReview.error.evidenceInvalid"));
        return;
      }
      send(proposal.evidenceKey);
      return;
    }
    proof.withKey(send, onFailure, password);
  };

  const fields = (
    <div className="grid gap-3">
      <p
        data-testid="payout-return-warning"
        className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
      >
        {t("payrollPayoutReview.result.returnWarning")}
      </p>
      {proposal ? (
        <ProposalLock
          batchId={batchId}
          proposal={proposal}
          mine={mine}
          form={proof}
          busy={busy}
          variant="return"
        />
      ) : (
        <ProofFields form={proof} busy={busy} variant="return" />
      )}
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
              <Button
                type="submit"
                className="min-h-11"
                loading={busy}
                disabled={waiting}
              >
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
