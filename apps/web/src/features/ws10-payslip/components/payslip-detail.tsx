// One payslip behind the 6-digit PIN gate (PRD v1.7 §3 F30 "Slip Gaji":
// "dilindungi PIN", history, PDF; HR-01 own rows only; HR-03 salary data).
//
// The PIN is sent once, in a POST body, with an idempotency key. A successful
// open lives in component state only: the payslip body is never written to the
// query cache, so navigating away and back asks for the PIN again (no
// persisted PIN, no cached amounts). Wrong attempts and the lock are the API's
// codes (PAYSLIP_PIN_INVALID with remainingAttempts / PAYSLIP_PIN_LOCKED with
// lockedUntil). The PIN status is read first: not set sends the employee
// through <PinSetup>, locked shows the lock screen. The mutation is reset
// after every attempt (gcTime 0), so neither the PIN nor the amounts linger in
// the MutationCache, and an opened slip locks itself again after
// PAYSLIP_UNLOCK_TTL_MS.
//
// HR-01: the id in the URL is only a lookup key. A malformed id never reaches
// the API, and a well-formed id that is not the caller's answers NOT_FOUND,
// shown as "not found", never as a PIN problem.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, FileX, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import type { Payslip, PayslipLine } from "@starter/shared/hris/payroll";
import { payslipIdSchema } from "@starter/shared/hris/payroll";
import { SectionEmpty } from "@/features/ws10-hris-employee/components/section-states";
import { API_MOCK } from "@/lib/api/mock-flag";
import { Skeleton } from "@/components/ui/skeleton";
import { newIdempotencyKey } from "@/lib/idempotency";
import { formatBusinessDate, formatQuantity } from "../format.ts";
import { useMyPayslips, useViewMyPayslip } from "../hooks.ts";
import { usePayslipPinStatus } from "../pin-hooks.ts";
import {
  classifyPinError,
  isCompletePin,
  minutesUntil,
  pinStatusView,
} from "../pin-state.ts";
import {
  PAYSLIP_UNLOCK_TTL_MS,
  paymentMethodKey,
  quantityUnitKey,
} from "../state.ts";
import { PageHeader } from "./page-header.tsx";
import { PayslipFileActions } from "./payslip-file-actions.tsx";
import { PinCodeInput } from "./pin-code-input.tsx";
import { PinLayout } from "./pin-layout.tsx";
import { PinLocked } from "./pin-locked.tsx";
import { PinSetup } from "./pin-setup.tsx";

function SummaryRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm leading-5 text-muted-foreground">{label}</dt>
      <dd>
        <Money amount={amount} className="font-medium" />
      </dd>
    </div>
  );
}

function LineGroup({
  title,
  lines,
}: {
  title: string;
  lines: readonly PayslipLine[];
}) {
  const t = useT();
  if (lines.length === 0) return null;
  return (
    <Card className="gap-2">
      <p className="type-heading pb-2">{title}</p>
      <ul className="divide-y divide-border">
        {lines.map((line, index) => {
          const quantity = formatQuantity(line.quantity);
          const unitKey = quantityUnitKey(line.category);
          return (
            <li
              key={`${line.componentCode}-${index}`}
              className="flex items-start justify-between gap-3 py-2.5"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="text-sm leading-5 font-medium">{line.name}</p>
                {quantity !== null && unitKey !== null && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("payslip.detail.quantityValue", {
                      value: quantity,
                      unit: t(unitKey),
                    })}
                  </p>
                )}
              </div>
              <Money amount={line.amountIdr} className="font-medium" />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PayslipContent({ payslip }: { payslip: Payslip }) {
  const t = useT();
  const earnings = payslip.lines.filter((line) => line.kind === "earning");
  const deductions = payslip.lines.filter((line) => line.kind === "deduction");

  return (
    <>
      <Card className="gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t("payslip.detail.netTitle")}
        </p>
        <Money amount={payslip.netIdr} size="hero" className="font-brand" />
        <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-sm">
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("payslip.detail.periodLabel")}
            </dt>
            <dd className="font-medium tabular">
              {t("payslip.history.periodValue", {
                start: formatBusinessDate(payslip.periodStart),
                end: formatBusinessDate(payslip.periodEnd),
              })}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("payslip.detail.payDateLabel")}
            </dt>
            <dd className="font-medium tabular">
              {formatBusinessDate(payslip.payDate)}
            </dd>
          </div>
          <div className="col-span-2 grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("payslip.detail.employeeLabel")}
            </dt>
            <dd className="truncate font-medium">
              {payslip.positionName === null
                ? payslip.employeeName
                : t("payslip.detail.employeeWithPosition", {
                    name: payslip.employeeName,
                    position: payslip.positionName,
                  })}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="type-heading">
            {t("payslip.detail.summaryTitle")}
          </CardTitle>
        </CardHeader>
        <dl className="grid gap-2">
          <SummaryRow
            label={t("payslip.detail.gross")}
            amount={payslip.grossIdr}
          />
          <SummaryRow
            label={t("payslip.detail.deductions")}
            amount={payslip.deductionsIdr}
          />
          <SummaryRow
            label={t("payslip.detail.pph21")}
            amount={payslip.pph21Idr}
          />
          <SummaryRow
            label={t("payslip.detail.bpjsEmployee")}
            amount={payslip.bpjsEmployeeIdr}
          />
          <SummaryRow
            label={t("payslip.detail.bpjsCompany")}
            amount={payslip.bpjsCompanyIdr}
          />
          <SummaryRow
            label={t("payslip.detail.serviceCharge")}
            amount={payslip.serviceChargeIdr}
          />
          <SummaryRow
            label={t("payslip.detail.overtime")}
            amount={payslip.overtimeIdr}
          />
          <div className="flex items-baseline justify-between gap-3 border-t pt-2">
            <dt className="text-sm leading-5 font-semibold">
              {t("payslip.detail.netTitle")}
            </dt>
            <dd>
              <Money amount={payslip.netIdr} className="font-semibold" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-sm leading-5 text-muted-foreground">
              {t("payslip.paymentMethod.label")}
            </dt>
            <dd className="text-sm leading-5 font-medium">
              {t(paymentMethodKey(payslip.paymentMethod))}
            </dd>
          </div>
        </dl>
      </Card>

      <LineGroup title={t("payslip.detail.earningsTitle")} lines={earnings} />
      <LineGroup
        title={t("payslip.detail.deductionsTitle")}
        lines={deductions}
      />

      <PayslipFileActions fileUrl={payslip.fileUrl} />

      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link to="/karyawan/slip-gaji">{t("payslip.backToHistory")}</Link>
      </Button>
    </>
  );
}

type GateError =
  | { kind: "incomplete" }
  | { kind: "invalid"; remainingAttempts: number | null }
  | { kind: "other" };

// Autofocus only where a hardware keyboard is likely: on a touch screen it
// would pop the keypad open before the employee has read the page.
function hasFinePointer() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches
  );
}

function BackLink() {
  const t = useT();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to="/karyawan/slip-gaji">
        <ChevronLeft aria-hidden="true" />
        {t("payslipPin.layout.back")}
      </Link>
    </Button>
  );
}

function ForgotPinLink() {
  const t = useT();
  return (
    <Button asChild variant="link" className="w-full">
      <Link to="/karyawan/slip-gaji/lupa-pin">
        {t("payslipPin.common.forgotPin")}
      </Link>
    </Button>
  );
}

function GateLoading() {
  const t = useT();
  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.bukaSlip.title")}
      description={t("payslipPin.bukaSlip.description")}
      busy
    >
      <div role="status" className="grid gap-3">
        <span className="sr-only">{t("payslipPin.gate.loadingStatus")}</span>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-12 w-full max-w-xs" />
        <Skeleton className="h-12 w-full" />
      </div>
    </PinLayout>
  );
}

function GateStatusError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.gate.statusErrorTitle")}
      description={t("payslipPin.gate.statusErrorHint")}
      side={t("payslipPin.gate.statusErrorSide")}
    >
      <div role="alert" className="sr-only">
        {t("payslipPin.gate.statusErrorTitle")}
      </div>
      <Button type="button" size="lg" className="w-full" onClick={onRetry}>
        {t("payslipPin.common.retry")}
      </Button>
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link to="/karyawan/slip-gaji">
          {t("payslipPin.common.backToList")}
        </Link>
      </Button>
    </PinLayout>
  );
}

function GateLocked({
  lockedUntil,
  onUnlocked,
}: {
  lockedUntil: string | null;
  onUnlocked: () => void;
}) {
  const t = useT();
  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.terkunci.title")}
      description={t("payslipPin.terkunci.description")}
      side={t("payslipPin.terkunci.side")}
    >
      <PinLocked lockedUntil={lockedUntil} onUnlocked={onUnlocked} />
    </PinLayout>
  );
}

export function PayslipDetail({ payslipId }: { payslipId: string }) {
  const t = useT();
  const view = useViewMyPayslip();
  const status = usePayslipPinStatus();
  const [pin, setPin] = useState("");
  const [payslip, setPayslip] = useState<Payslip | null>(null);
  const [gateError, setGateError] = useState<GateError | null>(null);
  // Set by a 423 on this screen; null lockedUntil means "locked, no clock".
  const [lockedLocally, setLockedLocally] = useState<{
    until: string | null;
  } | null>(null);
  // Keeps <PinSetup> mounted after the save flips the cached status to active,
  // so its "PIN tersimpan" card shows until onDone.
  const [setupOpen, setSetupOpen] = useState(false);
  // The id that answered 404; derived per payslipId so a new id starts clean.
  const [notFoundId, setNotFoundId] = useState<string | null>(null);
  const notFound =
    notFoundId === payslipId || !payslipIdSchema.safeParse(payslipId).success;
  const pinRef = useRef<HTMLInputElement>(null);
  const myPayslips = useMyPayslips();
  const [expired, setExpired] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const summary = myPayslips.payslips.find((item) => item.id === payslipId);

  const statusView = status.data ? pinStatusView(status.data, now) : null;
  if (statusView === "create" && !setupOpen) setSetupOpen(true);

  // An opened slip locks again after the TTL: the amounts leave the DOM and
  // the employee re-enters the PIN.
  useEffect(() => {
    if (payslip === null) return;
    const timer = window.setTimeout(() => {
      setPayslip(null);
      setExpired(true);
    }, PAYSLIP_UNLOCK_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [payslip]);

  const lockedUntil =
    lockedLocally !== null
      ? lockedLocally.until
      : status.data?.status === "locked"
        ? status.data.lockedUntil
        : null;
  const lockMinutes = minutesUntil(lockedUntil, now);
  const isLocked =
    (lockedLocally !== null || statusView === "locked") && lockMinutes !== 0;

  // PinLocked ticks the clock; when the lock has passed, show the form again
  // and re-read the status.
  function handleUnlocked() {
    setLockedLocally(null);
    setNow(new Date());
    void status.refetch();
  }

  const submitting = view.isPending;

  // After a failed submit, put the caret back in the PIN field. The field is
  // disabled while the request runs, so wait until it is enabled again.
  useEffect(() => {
    if (gateError !== null && !submitting) pinRef.current?.focus();
  }, [gateError, submitting]);

  function handlePinChange(value: string) {
    setPin(value);
    if (gateError !== null) setGateError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!isCompletePin(pin)) {
      setGateError({ kind: "incomplete" });
      return;
    }
    setGateError(null);
    setExpired(false);
    try {
      const opened = await view.mutateAsync({
        payslipId,
        body: { pin, idempotencyKey: newIdempotencyKey() },
      });
      setPayslip(opened);
      setLockedLocally(null);
      setPin("");
    } catch (error) {
      const failure = classifyPinError(error);
      setPin("");
      setNow(new Date());
      if (failure.kind === "not_found") {
        setNotFoundId(payslipId);
      } else if (failure.kind === "locked") {
        setLockedLocally({ until: failure.lockedUntil });
      } else if (failure.kind === "not_set") {
        setSetupOpen(true);
      } else if (failure.kind === "invalid") {
        setGateError({
          kind: "invalid",
          remainingAttempts: failure.remainingAttempts,
        });
      } else {
        setGateError({ kind: "other" });
      }
    } finally {
      // Drop the PIN (variables) and the body (data) from the MutationCache.
      view.reset();
    }
  }

  if (payslip !== null || notFound) {
    const periodText = payslip
      ? t("payslip.history.periodValue", {
          start: formatBusinessDate(payslip.periodStart),
          end: formatBusinessDate(payslip.periodEnd),
        })
      : t("payslip.history.subtitle");
    return (
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
            <Link to="/karyawan/slip-gaji">
              <ChevronLeft aria-hidden="true" />
              {t("payslip.backToHistory")}
            </Link>
          </Button>
          <PageHeader title={t("payslip.detail.title")} subtitle={periodText} />
        </div>
        {payslip !== null ? (
          <PayslipContent payslip={payslip} />
        ) : (
          <Card>
            <SectionEmpty
              icon={FileX}
              title={t("payslip.detail.notFound")}
              description={t("payslip.detail.notFoundHint")}
            />
          </Card>
        )}
      </div>
    );
  }

  if (setupOpen || statusView === "create") {
    return <PinSetup onDone={() => setSetupOpen(false)} />;
  }

  if (status.isPending) return <GateLoading />;
  if (status.isError || statusView === null) {
    return <GateStatusError onRetry={() => void status.refetch()} />;
  }
  if (isLocked) {
    return <GateLocked lockedUntil={lockedUntil} onUnlocked={handleUnlocked} />;
  }

  const invalid = gateError?.kind === "invalid" ? gateError : null;
  const errorText =
    gateError?.kind === "incomplete"
      ? t("payslipPin.validation.incomplete")
      : invalid
        ? invalid.remainingAttempts === null
          ? `${t("payslipPin.pinSalah.noticeTitle")}. ${t("payslipPin.gate.wrongPinNoCount")}`
          : `${t("payslipPin.pinSalah.noticeTitle")}. ${t("payslipPin.pinSalah.notice")} ${t("payslipPin.pinSalah.attemptsLeft", { count: invalid.remainingAttempts })}`
        : undefined;

  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.bukaSlip.title")}
      description={t("payslipPin.bukaSlip.description")}
      side={t("payslipPin.bukaSlip.side")}
      busy={submitting}
    >
      {summary !== undefined && (
        <div className="grid gap-0.5 rounded-field border p-4">
          <p className="text-sm leading-5 font-semibold">
            {t("payslipPin.common.periodTitle", {
              period: t("payslip.history.periodValue", {
                start: formatBusinessDate(summary.periodStart),
                end: formatBusinessDate(summary.periodEnd),
              }),
            })}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payslipPin.common.periodLabel")}
          </p>
        </div>
      )}
      {expired && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          {t("payslip.pin.expired")}
        </p>
      )}
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
        aria-busy={submitting || undefined}
      >
        <FormField
          label={t("payslipPin.common.pinLabel")}
          hint={t("payslipPin.common.pinDigitsHint")}
          error={errorText}
          required
        >
          <PinCodeInput
            ref={pinRef}
            name="payslip-pin"
            value={pin}
            onChange={handlePinChange}
            disabled={submitting}
            autoFocus={hasFinePointer()}
          />
        </FormField>

        {API_MOCK && (
          <p className="flex items-center gap-1.5 text-sm leading-5 text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
            {t("payslip.pin.demoPin")}
          </p>
        )}

        {gateError?.kind === "other" && (
          <div role="alert" className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold text-danger">
              {t("payslip.pin.errorTitle")}
            </p>
            <p className="text-sm leading-5">{t("payslip.pin.errorHint")}</p>
          </div>
        )}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting
            ? t("payslipPin.bukaSlip.submitting")
            : invalid || gateError?.kind === "other"
              ? t("payslipPin.pinSalah.submit")
              : t("payslipPin.bukaSlip.submit")}
        </Button>
        <ForgotPinLink />
      </form>
    </PinLayout>
  );
}
