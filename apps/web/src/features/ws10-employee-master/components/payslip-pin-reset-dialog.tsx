// HR resets an employee's payslip PIN (bead legend-ilzrj, mockup hr-reset).
// The dialog states the consequence, collects a 3-500 character reason, and
// sends it with one idempotency key per open. HR never sees or sets a PIN: the
// employee creates a new one the next time they open a payslip.
import * as React from "react";
import type { Employee } from "@starter/shared/hris";
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
import { newIdempotencyKey } from "@/lib/idempotency";
import { useResetPayslipPin } from "../pin-reset-hooks";

const REASON_MIN = 3;
const REASON_MAX = 500;

export function PayslipPinResetDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("payslipPin.hrReset.title")}</DialogTitle>
          <DialogDescription>
            {t("payslipPin.hrReset.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: each attempt starts with an empty reason
            and a fresh idempotency key (no setState in an effect). */}
        {open ? <ResetForm employee={employee} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ResetForm({
  employee,
  onDone,
}: {
  employee: Employee;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const reset = useResetPayslipPin();
  const [reason, setReason] = React.useState("");
  const [reasonError, setReasonError] = React.useState<string>();
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      setReasonError(t("payslipPin.hrReset.reasonError"));
      return;
    }
    setReasonError(undefined);
    reset.mutate(
      {
        employeeId: employee.id,
        body: { reason: trimmed, idempotencyKey: idempotencyKey.current },
      },
      {
        onSuccess: () => {
          toast({
            title: t("payslipPin.hrReset.success"),
            tone: "success",
          });
          onDone();
        },
        onError: () => setFormError(t("payslipPin.hrReset.error")),
      },
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <div className="grid gap-0.5 rounded-container border-(length:--border-w) bg-shell px-4 py-3">
        <p className="text-sm leading-5 font-semibold">{employee.fullName}</p>
        <p className="text-sm leading-5 text-muted-foreground tabular">
          {employee.employeeNo}
        </p>
      </div>
      <p className="text-sm leading-6">{t("payslipPin.hrReset.body")}</p>
      <FormField
        label={t("payslipPin.hrReset.reasonLabel")}
        id="payslip-pin-reset-reason"
        hint={t("payslipPin.hrReset.reasonHint")}
        error={reasonError}
        required
      >
        <Textarea
          id="payslip-pin-reset-reason"
          rows={3}
          maxLength={REASON_MAX}
          autoComplete="off"
          placeholder={t("payslipPin.hrReset.reasonPlaceholder")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
      <p
        className="-mt-2 text-right text-xs leading-4 text-muted-foreground tabular"
        aria-live="off"
      >
        {reason.length}/{REASON_MAX}
      </p>
      {formError && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("payslipPin.hrReset.cancel")}
        </Button>
        <Button type="submit" loading={reset.isPending}>
          {t("payslipPin.hrReset.confirm")}
        </Button>
      </DialogFooter>
    </form>
  );
}
