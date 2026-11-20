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
        {open ? <PtkpForm employee={employee} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PtkpForm({
  employee,
  onDone,
}: {
  employee: Employee;
  onDone: () => void;
}) {
  const t = useT();
  const correct = useCorrectEmployeePtkp();
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
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const idempotencyKey = React.useRef(newIdempotencyKey());

  if (result) return <PtkpResult result={result} onDone={onDone} />;

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
    if (!parsed.success) return;
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
          // A failed attempt may be retried with other input: new key.
          idempotencyKey.current = newIdempotencyKey();
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
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <FormField
        label={t("employeeMaster.profile.ptkp.statusLabel")}
        id="ptkp-status"
        error={statusError}
        required
      >
        <Select
          value={status}
          onValueChange={(next) => {
            setStatus(next as PtkpStatus);
            idempotencyKey.current = newIdempotencyKey();
          }}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={t("employeeMaster.profile.ptkp.statusPlaceholder")}
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
                {t("employeeMaster.profile.ptkp.effectiveToday", {
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
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            idempotencyKey.current = newIdempotencyKey();
          }}
        />
      </FormField>
      {formError && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {formError}
        </p>
      )}
      <DialogFooter>
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
  return (
    <div className="grid gap-4" role="status">
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
        <Button type="button" onClick={onDone}>
          {t("employeeMaster.profile.ptkp.close")}
        </Button>
      </DialogFooter>
    </div>
  );
}
