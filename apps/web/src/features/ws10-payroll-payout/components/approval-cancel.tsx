// "Batalkan pengajuan": stops a batch that has not left yet, with a reason.
// Used when an old bank-transfer batch has no locked payee account and cannot
// be approved. The server decides which states may cancel; the button only
// appears where it can work, and the server's refusal is always shown.
import * as React from "react";
import type { PayoutBatchStatus } from "@starter/shared/validators/payroll-payout";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { payoutErrorMessage } from "../errors";
import { useCancelBatch } from "../hooks";

const REASON_MAX = 500;

/** The states the server lets a batch be cancelled from (cancelDisbursementBatch). */
export function canCancelStatus(status: PayoutBatchStatus): boolean {
  return (
    status === "draft" || status === "pending_approval" || status === "approved"
  );
}

export function CancelBatchButton({ batchId }: { batchId: string }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        data-testid="approval-cancel-action"
        onClick={() => setOpen(true)}
      >
        {t("payrollPayoutReview.approval.cancel.action")}
      </Button>
      {open && (
        <CancelBatchDialog batchId={batchId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function CancelBatchDialog({
  batchId,
  onClose,
}: {
  batchId: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const cancel = useCancelBatch();
  const [reason, setReason] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = () => {
    if (cancel.isPending) return;
    setError(null);
    const trimmed = reason.trim();
    if (trimmed === "") {
      setProblem(t("payrollPayoutReview.approval.cancel.reasonRequired"));
      return;
    }
    setProblem(null);
    cancel.mutate(
      { batchId, reason: trimmed },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayoutReview.approval.cancel.success"),
            tone: "success",
          });
          onClose();
        },
        onError: (failure) => setError(payoutErrorMessage(failure, t)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="approval-cancel-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("payrollPayoutReview.approval.cancel.title")}
          </DialogTitle>
          <DialogDescription>
            {t("payrollPayoutReview.approval.cancel.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label={t("payrollPayoutReview.approval.cancel.reason")}
            hint={t("payrollPayoutReview.approval.cancel.reasonHint")}
            error={problem ?? undefined}
            required
          >
            <Textarea
              data-testid="approval-cancel-reason"
              value={reason}
              maxLength={REASON_MAX}
              disabled={cancel.isPending}
              onChange={(event) => {
                setReason(event.target.value);
                setProblem(null);
              }}
            />
          </FormField>
          {error && (
            <p
              role="alert"
              data-testid="approval-cancel-error"
              className="text-sm font-medium text-danger"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={cancel.isPending}
              onClick={onClose}
            >
              {t("payrollPayoutReview.approval.cancel.back")}
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              loading={cancel.isPending}
            >
              {t("payrollPayoutReview.approval.cancel.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
