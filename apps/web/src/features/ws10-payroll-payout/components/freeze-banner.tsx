// A batch frozen by a "not me" claim (legend-l2zru): the banner on the batch
// screens, the "Dibekukan" badge, and the dialog that lifts the freeze. Only
// someone holding payroll.disburse.approve sees the button; the server decides
// who may really open it (owner or finance who took no part in the batch) and
// its refusal is shown in the dialog.
import * as React from "react";
import { Snowflake } from "lucide-react";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { payoutErrorMessage } from "../errors";
import { useUnfreezeBatch } from "../hooks";
import { VerifyPanel, useStepUp } from "./approval-verify";

const UNFREEZE_REASON_MIN = 10;
const UNFREEZE_REASON_MAX = 500;
/** Statuses where the bank may already hold a transfer of this batch. */
const SENT_STATUSES = ["exported", "sending", "completed"];

export function FreezeBadge({ batch }: { batch: PayrollDisbursementBatchDto }) {
  const t = useT();
  if (!batch.freeze.frozen) return null;
  return (
    <Badge tone="danger" data-testid="payout-freeze-badge">
      <Snowflake aria-hidden="true" />
      {t("payrollPayout.freeze.badge")}
    </Badge>
  );
}

export function FreezeBanner({
  batch,
  canUnfreeze,
}: {
  batch: PayrollDisbursementBatchDto;
  /** Holds payroll.disburse.approve: shows the button (the server checks). */
  canUnfreeze: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  if (!batch.freeze.frozen) return null;
  const { disputes } = batch.freeze;
  const sent = disputes.some((row) =>
    SENT_STATUSES.includes(row.batchStatusAt),
  );
  return (
    <section
      role="alert"
      aria-label={t("payrollPayout.freeze.banner.title")}
      data-testid="payout-freeze-banner"
      className="grid gap-3 rounded-container bg-danger p-4 text-danger-foreground"
    >
      <div className="flex gap-3">
        <Snowflake className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-1">
          <p className="font-semibold">
            {t("payrollPayout.freeze.banner.title")}
          </p>
          <p className="text-sm">{t("payrollPayout.freeze.banner.body")}</p>
          {sent && (
            <p className="text-sm font-medium">
              {t("payrollPayout.freeze.banner.sentNote")}
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">
          {t("payrollPayout.freeze.banner.disputes", {
            count: disputes.length,
          })}
        </p>
        <ul className="grid gap-2">
          {disputes.map((row) => (
            <li
              key={row.id}
              className="grid gap-0.5 rounded-container bg-card p-3 text-sm text-foreground"
            >
              <p className="font-medium">
                {t(
                  row.mine
                    ? "payrollPayout.freeze.banner.mine"
                    : "payrollPayout.freeze.banner.other",
                )}
                <span className="tabular font-normal text-muted-foreground">
                  {" · "}
                  {formatDateTime(row.createdAt)}
                </span>
              </p>
              <p className="break-words text-muted-foreground">
                {row.reason ?? t("payrollPayout.freeze.banner.noReason")}
              </p>
            </li>
          ))}
        </ul>
      </div>
      {canUnfreeze && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full bg-card text-foreground min-[700px]:w-fit"
          data-testid="payout-unfreeze-open"
          onClick={() => setOpen(true)}
        >
          {t("payrollPayout.freeze.unfreeze.action")}
        </Button>
      )}
      {open && (
        <UnfreezeDialog
          batchId={disputes[0]?.batchId ?? batch.id}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

function UnfreezeDialog({
  batchId,
  onClose,
}: {
  batchId: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const unfreeze = useUnfreezeBatch();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [reason, setReason] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const check = () => {
    const short = reason.trim().length < UNFREEZE_REASON_MIN;
    setProblem(short ? t("payrollPayout.freeze.unfreeze.reasonShort") : null);
    return !short;
  };

  const submit = (password?: string) => {
    if (unfreeze.isPending) return;
    setError(null);
    if (!check()) return;
    unfreeze.mutate(
      { batchId, reason: reason.trim(), password },
      {
        onSuccess: () => {
          toast({
            title: t("payrollPayout.freeze.unfreeze.done"),
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

  const field = (
    <FormField
      label={t("payrollPayout.freeze.unfreeze.reasonLabel")}
      hint={t("payrollPayout.freeze.unfreeze.reasonHint")}
      error={problem ?? undefined}
      required
    >
      <Textarea
        value={reason}
        maxLength={UNFREEZE_REASON_MAX}
        rows={4}
        disabled={stepUp.active}
        onChange={(event) => setReason(event.target.value)}
        onBlur={() => reason !== "" && check()}
      />
    </FormField>
  );

  return (
    <PendingDialog
      pending={unfreeze.isPending}
      open
      onOpenChange={(next) => !next && onClose()}
    >
      <PendingDialogContent data-testid="payout-unfreeze-dialog">
        <DialogHeader>
          <DialogTitle>{t("payrollPayout.freeze.unfreeze.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollPayout.freeze.unfreeze.description")}
          </DialogDescription>
        </DialogHeader>
        {stepUp.active ? (
          <div className="grid gap-4">
            {field}
            <VerifyPanel
              key={stepUp.round}
              needs={stepUp.needs}
              busy={unfreeze.isPending}
              error={error}
              onVerified={submit}
              onCancel={onClose}
            />
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {field}
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
                disabled={unfreeze.isPending}
                onClick={onClose}
              >
                {t("payrollPayout.freeze.unfreeze.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                loading={unfreeze.isPending}
              >
                {unfreeze.isPending
                  ? t("payrollPayout.freeze.unfreeze.confirming")
                  : t("payrollPayout.freeze.unfreeze.confirm")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </PendingDialogContent>
    </PendingDialog>
  );
}
