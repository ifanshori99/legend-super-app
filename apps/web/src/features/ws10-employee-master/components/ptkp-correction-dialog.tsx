// Koreksi status PTKP (bead 1223, PMK 168/2023): HR with payroll access sets
// the PTKP status with the day it is in force. The API owns every rule (which
// days are allowed, the closed tax year); this form offers the two allowed
// days, collects the reason, and maps the error codes to plain Indonesian.
import * as React from "react";
import type { Employee, PtkpStatus } from "@starter/shared/hris";
import { ptkpStatusSchema } from "@starter/shared/hris";
import type { EmployeePtkpChange } from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useCorrectEmployeePtkp } from "../hooks";
import { businessDateToday, formatBusinessDate } from "../lib";

const REASON_MIN = 5;
const REASON_MAX = 500;

const ERROR_BY_CODE: Record<string, MessageKey> = {
  PTKP_TAX_YEAR_CLOSED: "employeeMaster.profile.ptkp.errors.yearClosed",
  PTKP_EFFECTIVE_DATE_INVALID: "employeeMaster.profile.ptkp.errors.dateInvalid",
  FORBIDDEN: "employeeMaster.profile.ptkp.errors.forbidden",
};

type DayChoice = "anchor" | "today";

export function PtkpCorrectionDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const correct = useCorrectEmployeePtkp();
  // Saving is in flight: closing now would hide the outcome of a tax change.
  const pending = correct.isPending;
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (!pending) close();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        hideClose={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("employeeMaster.profile.ptkp.title", {
              name: employee.fullName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("employeeMaster.profile.ptkp.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: each attempt starts clean with a fresh
            idempotency key. */}
        {open ? (
          <PtkpForm employee={employee} correct={correct} onDone={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PtkpForm({
  employee,
  correct,
  onDone,
}: {
  employee: Employee;
  correct: ReturnType<typeof useCorrectEmployeePtkp>;
  onDone: () => void;
}) {
  const t = useT();
  const today = businessDateToday();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const joinedThisYear = employee.joinDate > yearStart;
  const anchor = joinedThisYear ? employee.joinDate : yearStart;

  const [status, setStatus] = React.useState<PtkpStatus | "">(
    employee.ptkpStatus ?? "",
  );
  const [day, setDay] = React.useState<DayChoice>("anchor");
  const [reason, setReason] = React.useState("");
  const [statusError, setStatusError] = React.useState<string>();
  const [reasonError, setReasonError] = React.useState<string>();
  const [formError, setFormError] = React.useState<string>();
  const [result, setResult] = React.useState<EmployeePtkpChange>();
  const formRef = React.useRef<HTMLFormElement>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  // One key per distinct input: it changes only when the input changes, so a
  // retry of the same input after a failure is deduplicated by the API.
  const idempotencyKey = React.useRef(newIdempotencyKey());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const parsed = ptkpStatusSchema.safeParse(status);
    const trimmed = reason.trim();
    const reasonBad =
      trimmed.length < REASON_MIN || trimmed.length > REASON_MAX;
    setStatusError(
      parsed.success ? undefined : t("employeeMaster.profile.ptkp.statusError"),
    );
    setReasonError(
      reasonBad ? t("employeeMaster.profile.ptkp.reasonError") : undefined,
    );
    if (!parsed.success) {
      formRef.current?.querySelector<HTMLElement>("#ptkp-status")?.focus();
      return;
    }
    if (reasonBad) {
      reasonRef.current?.focus();
      return;
    }
    correct.mutate(
      {
        params: { employeeId: employee.id },
        body: {
          ptkpStatus: parsed.data,
          effectiveFrom: day === "anchor" ? anchor : today,
          reason: trimmed,
          idempotencyKey: idempotencyKey.current,
        },
      },
      {
        onSuccess: (response) => setResult(response.data),
        onError: (error) => {
          setFormError(
            t(
              (error instanceof ApiError && ERROR_BY_CODE[error.code]) ||
                "employeeMaster.profile.ptkp.errors.generic",
            ),
          );
        },
      },
    );
  }

  const anchorLabel = t(
    joinedThisYear
      ? "employeeMaster.profile.ptkp.effectiveAnchorJoin"
      : "employeeMaster.profile.ptkp.effectiveAnchor",
    { date: formatBusinessDate(anchor) },
  );

  return (
    <>
      {/* Present before the result so assistive tech announces the change. */}
      <p className="sr-only" role="status" aria-live="polite">
        {result ? t("employeeMaster.profile.ptkp.resultTitle") : ""}
      </p>
      {result ? (
        <PtkpResult result={result} onDone={onDone} />
      ) : (
        <form ref={formRef} className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("employeeMaster.profile.ptkp.statusLabel")}
            id="ptkp-status"
            error={statusError}
            required
          >
            <Select
              value={status}
              disabled={correct.isPending}
              onValueChange={(next) => {
                setStatus(next as PtkpStatus);
                idempotencyKey.current = newIdempotencyKey();
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "employeeMaster.profile.ptkp.statusPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {ptkpStatusSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("employeeMaster.profile.ptkp.effectiveLabel")}
            id="ptkp-effective"
            hint={t("employeeMaster.profile.ptkp.effectiveHint")}
            required
          >
            <Select
              value={day}
              disabled={correct.isPending}
              onValueChange={(next) => {
                setDay(next as DayChoice);
                idempotencyKey.current = newIdempotencyKey();
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anchor">{anchorLabel}</SelectItem>
                {anchor !== today && (
                  <SelectItem value="today">
                    {t("employeeMaster.profile.ptkp.effectiveNextYear", {
                      date: formatBusinessDate(today),
                    })}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("employeeMaster.profile.ptkp.reasonLabel")}
            id="ptkp-reason"
            hint={
              <span className="flex flex-wrap justify-between gap-x-3">
                <span>{t("employeeMaster.profile.ptkp.reasonHint")}</span>
                <span className="tabular">
                  {reason.length}/{REASON_MAX}
                </span>
              </span>
            }
            error={reasonError}
            required
          >
            <Textarea
              ref={reasonRef}
              id="ptkp-reason"
              name="reason"
              rows={3}
              maxLength={REASON_MAX}
              autoComplete="off"
              readOnly={correct.isPending}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                idempotencyKey.current = newIdempotencyKey();
              }}
            />
          </FormField>
          {formError && (
            <p
              className="text-sm leading-5 font-medium text-danger"
              role="alert"
            >
              {formError}
            </p>
          )}
          <DialogFooter className="sticky bottom-0 -mx-card border-t-(length:--border-w) bg-card px-card pt-3 sm:static sm:mx-0 sm:border-t-0 sm:px-0 sm:pt-0">
            <Button
              type="button"
              variant="outline"
              disabled={correct.isPending}
              onClick={onDone}
            >
              {t("employeeMaster.profile.ptkp.cancel")}
            </Button>
            <Button type="submit" loading={correct.isPending}>
              {t("employeeMaster.profile.ptkp.save")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}

function PtkpResult({
  result,
  onDone,
}: {
  result: EmployeePtkpChange;
  onDone: () => void;
}) {
  const t = useT();
  const closeRef = React.useRef<HTMLButtonElement>(null);
  // The form that held focus is gone: move focus to the one action left.
  React.useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div className="grid gap-4">
      <p className="text-sm leading-5 font-semibold">
        {t("employeeMaster.profile.ptkp.resultTitle")}
      </p>
      <dl className="grid gap-3 rounded-container border-(length:--border-w) bg-shell px-4 py-3">
        <div className="grid gap-0.5">
          <dt className="text-sm leading-5 text-muted-foreground">
            {t("employeeMaster.profile.ptkp.resultThisYear", {
              year: String(result.taxYear),
            })}
          </dt>
          <dd className="text-sm leading-5 font-semibold tabular">
            {result.taxYearPtkpStatus}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-sm leading-5 text-muted-foreground">
            {t("employeeMaster.profile.ptkp.resultNext")}
          </dt>
          <dd className="text-sm leading-5 font-semibold">
            {result.next
              ? t("employeeMaster.profile.ptkp.resultNextValue", {
                  status: result.next.ptkpStatus,
                  date: formatBusinessDate(result.next.effectiveFrom),
                })
              : t("employeeMaster.profile.ptkp.resultNone")}
          </dd>
        </div>
      </dl>
      <p className="text-sm leading-6">
        {t("employeeMaster.profile.ptkp.resultPayslipNote")}
      </p>
      <DialogFooter>
        <Button ref={closeRef} type="button" onClick={onDone}>
          {t("employeeMaster.profile.ptkp.close")}
        </Button>
      </DialogFooter>
    </div>
  );
}
