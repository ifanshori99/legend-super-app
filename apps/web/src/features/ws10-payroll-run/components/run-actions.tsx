// Every money-moving action of the run wizard lives here behind one confirm
// dialog per action. The dialogs state the people and rupiah affected before
// the write (jumlah karyawan + total neto) and the consequences the contract
// fixes: PAYR-01 (two approvals, two people, then lock), PAYR-02 (a locked run
// is frozen) and PAYR-05 (a reversal posts a reversing journal).
import * as React from "react";
import {
  Ban,
  Calculator,
  Lock,
  ShieldCheck,
  Undo2,
  Wallet,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { formatRupiah } from "@starter/shared/i18n";
import type {
  BankTransferFile,
  PayrollRun,
} from "@starter/shared/hris/payroll";
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
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { payrollErrorMessage } from "../errors";
import {
  useDecideReversal,
  useMarkPaid,
  useRequestReversal,
  useReturnToDraft,
  useRunAction,
} from "../hooks";
import { formatDateTime, shortId } from "../lib";

export type RunDialog =
  | "simulate"
  | "approve_hr"
  | "approve_final"
  | "lock"
  | "mark_paid"
  | "return_to_draft"
  | "request_reversal"
  | "decide_reversal";

const CONFIRM_ACTION_LIST = [
  "simulate",
  "approve_hr",
  "approve_final",
  "lock",
  "mark_paid",
] as const;
type ConfirmAction = (typeof CONFIRM_ACTION_LIST)[number];
const CONFIRM_ACTIONS: ReadonlySet<RunDialog> = new Set(CONFIRM_ACTION_LIST);

const isConfirmAction = (dialog: RunDialog | null): dialog is ConfirmAction =>
  dialog !== null && CONFIRM_ACTIONS.has(dialog);

const CONFIRM_TEXT: Record<
  ConfirmAction,
  {
    title: MessageKey;
    description: MessageKey;
    submit: MessageKey;
    done: MessageKey;
  }
> = {
  simulate: {
    title: "payrollRun.dialog.simulateTitle",
    description: "payrollRun.dialog.simulateBody",
    submit: "payrollRun.action.simulate",
    done: "payrollRun.toast.simulated",
  },
  approve_hr: {
    title: "payrollRun.dialog.approveHrTitle",
    description: "payrollRun.dialog.approveHrBody",
    submit: "payrollRun.action.approveHr",
    done: "payrollRun.toast.approvedHr",
  },
  approve_final: {
    title: "payrollRun.dialog.approveFinalTitle",
    description: "payrollRun.dialog.approveFinalBody",
    submit: "payrollRun.action.approveFinal",
    done: "payrollRun.toast.approvedFinal",
  },
  lock: {
    title: "payrollRun.dialog.lockTitle",
    description: "payrollRun.dialog.lockBody",
    submit: "payrollRun.action.lock",
    done: "payrollRun.toast.locked",
  },
  mark_paid: {
    title: "payrollRun.dialog.markPaidTitle",
    description: "payrollRun.dialog.markPaidBody",
    submit: "payrollRun.action.markPaid",
    done: "payrollRun.toast.paid",
  },
};

function ImpactSummary({ run }: { run: PayrollRun }) {
  const t = useT();
  if (!run.totals)
    return (
      <p className="rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
        {t("payrollRun.dialog.noTotals")}
      </p>
    );
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-container bg-surface-2 p-3 text-sm">
      <div className="grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">
          {t("payrollRun.dialog.employeeCount")}
        </dt>
        <dd className="font-semibold tabular">
          <NumberDisplay value={run.totals.employeeCount} />
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">
          {t("payrollRun.dialog.netTotal")}
        </dt>
        <dd className="font-semibold">
          <Money amount={run.totals.netIdr} />
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">
          {t("payrollRun.dialog.grossTotal")}
        </dt>
        <dd>
          <Money amount={run.totals.grossIdr} />
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">
          {t("payrollRun.dialog.deductionsTotal")}
        </dt>
        <dd>
          <Money amount={run.totals.deductionsIdr} />
        </dd>
      </div>
      <div className="col-span-2 grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">
          {t("payrollRun.dialog.netSplit")}
        </dt>
        <dd className="tabular">
          {t("payrollRun.dialog.netSplitValue", {
            transfer: formatRupiah(run.totals.bankTransferIdr),
            cash: formatRupiah(run.totals.cashIdr),
          })}
        </dd>
      </div>
    </dl>
  );
}

export function RunActionDialogs({
  run,
  files,
  dialog,
  canDecideReversal,
  onClose,
}: {
  run: PayrollRun;
  files: readonly BankTransferFile[];
  dialog: RunDialog | null;
  canDecideReversal: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const runAction = useRunAction();
  const markPaid = useMarkPaid();
  const returnToDraft = useReturnToDraft();
  const requestReversal = useRequestReversal();
  const decideReversal = useDecideReversal();
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [bankFileId, setBankFileId] = React.useState("none");

  const isConfirm = isConfirmAction(dialog);
  const pending =
    runAction.isPending ||
    markPaid.isPending ||
    returnToDraft.isPending ||
    requestReversal.isPending ||
    decideReversal.isPending;

  function close() {
    setError(null);
    setReason("");
    onClose();
  }

  function failed(cause: unknown) {
    setError(payrollErrorMessage(cause, t));
  }

  function submitConfirm() {
    if (!isConfirmAction(dialog)) return;
    const action = dialog;
    const done = CONFIRM_TEXT[action].done;
    const onSuccess = () => {
      toast({ title: t(done), tone: "success" });
      close();
    };
    if (action === "mark_paid") {
      markPaid.mutate(
        {
          runId: run.id,
          bankTransferFileId: bankFileId === "none" ? null : bankFileId,
        },
        { onSuccess, onError: failed },
      );
      return;
    }
    runAction.mutate(
      {
        action,
        runId: run.id,
        expectedSimulationCount: run.simulationCount,
      },
      { onSuccess, onError: failed },
    );
  }

  function submitReason(kind: "return_to_draft" | "request_reversal") {
    const trimmed = reason.trim();
    if (trimmed === "") {
      setError(t("payrollRun.dialog.reasonRequired"));
      return;
    }
    const onSuccess = () => {
      toast({
        title: t(
          kind === "return_to_draft"
            ? "payrollRun.toast.returnedToDraft"
            : "payrollRun.toast.reversalRequested",
        ),
        tone: "success",
      });
      close();
    };
    if (kind === "return_to_draft")
      returnToDraft.mutate(
        { runId: run.id, reason: trimmed },
        { onSuccess, onError: failed },
      );
    else
      requestReversal.mutate(
        { runId: run.id, reason: trimmed },
        { onSuccess, onError: failed },
      );
  }

  function submitDecision(action: "approve" | "reject") {
    decideReversal.mutate(
      { runId: run.id, action },
      {
        onSuccess: () => {
          toast({
            title: t(
              action === "approve"
                ? "payrollRun.toast.reversalApproved"
                : "payrollRun.toast.reversalRejected",
            ),
            tone: action === "approve" ? "danger" : "success",
          });
          close();
        },
        onError: failed,
      },
    );
  }

  return (
    <>
      <Dialog open={isConfirm} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {isConfirmAction(dialog) && (
            <ConfirmBody
              action={dialog}
              run={run}
              files={files}
              bankFileId={bankFileId}
              onBankFile={setBankFileId}
              error={error}
              pending={pending}
              onClose={close}
              onSubmit={submitConfirm}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "return_to_draft"}
        onOpenChange={(open) => !open && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("payrollRun.dialog.returnTitle")}</DialogTitle>
            <DialogDescription>
              {t("payrollRun.dialog.returnBody")}
            </DialogDescription>
          </DialogHeader>
          <ImpactSummary run={run} />
          <FormField
            label={t("payrollRun.dialog.reason")}
            hint={t("payrollRun.dialog.reasonHint")}
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={returnToDraft.isPending}
              onClick={() => submitReason("return_to_draft")}
            >
              <Undo2 aria-hidden="true" />
              {t("payrollRun.dialog.returnSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "request_reversal"}
        onOpenChange={(open) => !open && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("payrollRun.dialog.reversalTitle")}</DialogTitle>
            <DialogDescription>
              {t("payrollRun.dialog.reversalBody")}
            </DialogDescription>
          </DialogHeader>
          <ImpactSummary run={run} />
          <FormField
            label={t("payrollRun.dialog.reason")}
            hint={t("payrollRun.dialog.reversalReasonHint")}
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={requestReversal.isPending}
              onClick={() => submitReason("request_reversal")}
            >
              <Ban aria-hidden="true" />
              {t("payrollRun.dialog.reversalSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "decide_reversal"}
        onOpenChange={(open) => !open && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("payrollRun.dialog.decideTitle")}</DialogTitle>
            <DialogDescription>
              {t("payrollRun.dialog.decideBody")}
            </DialogDescription>
          </DialogHeader>
          {run.reversal && (
            <div className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm">
              <p className="type-eyebrow text-muted-foreground">
                {t("payrollRun.dialog.reversalReason")}
              </p>
              <p className="leading-5">{run.reversal.reason}</p>
              <p className="text-muted-foreground tabular">
                {t("payrollRun.dialog.requestedBy", {
                  actor: shortId(run.reversal.requestedBy),
                  at: formatDateTime(run.reversal.requestedAt),
                })}
              </p>
            </div>
          )}
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.dialog.separationHint")}
          </p>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              loading={decideReversal.isPending}
              disabled={!canDecideReversal}
              onClick={() => submitDecision("reject")}
            >
              {t("payrollRun.dialog.reject")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={decideReversal.isPending}
              disabled={!canDecideReversal}
              onClick={() => submitDecision("approve")}
            >
              {t("payrollRun.dialog.approveReversal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConfirmBody({
  action,
  run,
  files,
  bankFileId,
  onBankFile,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  action: ConfirmAction;
  run: PayrollRun;
  files: readonly BankTransferFile[];
  bankFileId: string;
  onBankFile: (id: string) => void;
  error: string | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const text = CONFIRM_TEXT[action];
  const Icon =
    action === "lock"
      ? Lock
      : action === "mark_paid"
        ? Wallet
        : action === "approve_final"
          ? ShieldCheck
          : Calculator;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(text.title)}</DialogTitle>
        <DialogDescription>{t(text.description)}</DialogDescription>
      </DialogHeader>
      <ImpactSummary run={run} />
      {action === "mark_paid" && (
        <FormField
          label={t("payrollRun.dialog.bankFile")}
          hint={t("payrollRun.dialog.bankFileHint")}
        >
          <Select value={bankFileId} onValueChange={onBankFile}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("payrollRun.dialog.noBankFile")}
              </SelectItem>
              {files.map((file) => (
                <SelectItem key={file.id} value={file.id}>
                  {`${file.format.toUpperCase()} · ${formatRupiah(file.totalIdr)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={pending} onClick={onSubmit}>
          <Icon aria-hidden="true" />
          {t(text.submit)}
        </Button>
      </DialogFooter>
    </>
  );
}
