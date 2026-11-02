// One payslip behind the 6-digit PIN gate (PRD v1.7 §3 F30 "Slip Gaji":
// "dilindungi PIN", history, PDF; HR-01 own rows only; HR-03 salary data).
//
// The PIN is sent once, in a POST body, with an idempotency key. A successful
// open lives in component state only: the payslip body is never written to the
// query cache, so navigating away and back asks for the PIN again (no
// persisted PIN, no cached amounts). Wrong attempts and the lock are the API's
// codes (PAYSLIP_PIN_INVALID / PAYSLIP_PIN_LOCKED); the mock burns three tries
// before it locks.
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Download, Printer, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import type { Payslip, PayslipLine } from "@starter/shared/hris/payroll";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { formatBusinessDate, formatQuantity } from "../format.ts";
import { useViewMyPayslip } from "../hooks.ts";
import {
  PAYSLIP_PIN_LENGTH,
  PAYSLIP_PIN_MAX_ATTEMPTS,
  paymentMethodKey,
  pinErrorKind,
  quantityUnitKey,
} from "../state.ts";
import { PageHeader } from "./page-header.tsx";

type PinErrorKind = "invalid" | "locked" | "other";

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

      {payslip.fileUrl !== null ? (
        <div className="grid gap-1">
          <Button asChild variant="outline" className="w-full">
            <a href={payslip.fileUrl} target="_blank" rel="noreferrer">
              <Download aria-hidden="true" />
              {t("payslip.detail.download")}
            </a>
          </Button>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payslip.detail.downloadHint")}
          </p>
        </div>
      ) : (
        <div className="grid gap-1">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => window.print()}
          >
            <Printer aria-hidden="true" />
            {t("payslip.detail.print")}
          </Button>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payslip.detail.printHint")}
          </p>
        </div>
      )}

      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link to="/karyawan/slip-gaji">{t("payslip.backToHistory")}</Link>
      </Button>
    </>
  );
}

export function PayslipDetail({ payslipId }: { payslipId: string }) {
  const t = useT();
  const view = useViewMyPayslip();
  const [pin, setPin] = useState("");
  const [payslip, setPayslip] = useState<Payslip | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [locked, setLocked] = useState(false);
  const [errorKind, setErrorKind] = useState<PinErrorKind | null>(null);

  const submitting = view.isPending;
  const errorText =
    errorKind === "locked"
      ? t("payslip.pin.locked")
      : errorKind === "invalid"
        ? API_MOCK && attempts < PAYSLIP_PIN_MAX_ATTEMPTS
          ? t("payslip.pin.invalidWithAttempts", {
              count: PAYSLIP_PIN_MAX_ATTEMPTS - attempts,
            })
          : t("payslip.pin.invalid")
        : undefined;

  function handlePinChange(value: string) {
    setPin(value.replace(/\D/g, "").slice(0, PAYSLIP_PIN_LENGTH));
    if (errorKind === "invalid" || errorKind === "other") setErrorKind(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pin.length !== PAYSLIP_PIN_LENGTH || locked || submitting) return;
    setErrorKind(null);
    try {
      const opened = await view.mutateAsync({
        payslipId,
        body: { pin, idempotencyKey: newIdempotencyKey() },
      });
      setPayslip(opened);
      setAttempts(0);
      setPin("");
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const kind = pinErrorKind(code);
      setPin("");
      if (kind === "locked") {
        setLocked(true);
        setErrorKind("locked");
        return;
      }
      if (kind === "invalid") {
        setAttempts((current) => current + 1);
        setErrorKind("invalid");
        return;
      }
      setErrorKind("other");
    }
  }

  const periodText = payslip
    ? t("payslip.history.periodValue", {
        start: formatBusinessDate(payslip.periodStart),
        end: formatBusinessDate(payslip.periodEnd),
      })
    : t("payslip.pin.subtitle");

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
          <CardHeader>
            <CardTitle className="font-brand type-title">
              {t("payslip.pin.title")}
            </CardTitle>
            <CardDescription>{t("payslip.pin.subtitle")}</CardDescription>
          </CardHeader>
          <form
            className="grid gap-3"
            noValidate
            onSubmit={(event) => void handleSubmit(event)}
          >
            <FormField
              label={t("payslip.pin.label")}
              hint={t("payslip.pin.hint")}
              error={errorText}
              required
            >
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={PAYSLIP_PIN_LENGTH}
                value={pin}
                onChange={(event) => handlePinChange(event.target.value)}
                placeholder={t("payslip.pin.placeholder")}
                disabled={locked || submitting}
                className="text-center tracking-[0.4em]"
              />
            </FormField>

            {API_MOCK && (
              <p className="flex items-center gap-1.5 text-sm leading-5 text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
                {t("payslip.pin.demoPin")}
              </p>
            )}

            {errorKind === "other" && (
              <div role="alert" className="grid gap-0.5">
                <p className="text-sm leading-5 font-semibold text-danger">
                  {t("payslip.pin.errorTitle")}
                </p>
                <p className="text-sm leading-5">
                  {t("payslip.pin.errorHint")}
                </p>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={submitting}
              disabled={locked || pin.length !== PAYSLIP_PIN_LENGTH}
            >
              {submitting
                ? t("payslip.pin.submitting")
                : t("payslip.pin.submit")}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
