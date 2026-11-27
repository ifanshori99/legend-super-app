// Duitku settlement import (C4b, legend-osqou.8): pick the outlet, name the
// report and its period, choose the CSV (Legend template), see what the server
// matched. The browser sends the file as text and no amount: the server reads
// and sums every rupiah. The API needs payment.reconcile at the outlet and a
// session verified with the second factor (same check as the EDC upload):
// MFA_REQUIRED opens the step-up panel and the same upload is sent again with
// the same idempotency key. The step-up is its own form beside the upload
// form, never inside it: a submit in the panel must not send the upload.
import * as React from "react";
import { CircleAlert, Download, Upload } from "lucide-react";
import { Link, useSearch } from "@tanstack/react-router";
import type { OutletId } from "@starter/shared/core";
import type { SettlementImportView } from "@starter/shared/payment/admin";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useStepUp,
  VerifyPanel,
} from "@/features/ws10-payroll-payout/components/approval-verify";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useImportGatewaySettlementCsv } from "../hooks";
import {
  checkPeriod,
  checkSettlementCsv,
  dataRowCount,
  settlementErrorView,
  settlementTemplateCsv,
  type PeriodCheck,
  type SettlementCsvCheck,
  type SettlementErrorView,
} from "../settlement-lib";
import { useAttemptKey } from "../use-attempt-key";
import { SettlementImportResult } from "./settlement-import-result";
import { SettlementList, useAccountOutlets } from "./settlement-list";

type Picked = { name: string; csv: string; lines: number };

function ErrorNotice({ view }: { view: SettlementErrorView }) {
  const t = useT();
  if (view.kind === "rows")
    return (
      <div
        role="alert"
        className="grid gap-2 rounded-container border-(length:--border-w) bg-danger-subtle px-4 py-3 text-sm leading-5 text-danger"
      >
        <p className="flex items-start gap-2 font-semibold">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("gatewaySettlement.errors.rowsTitle")}
        </p>
        <p>{t("gatewaySettlement.errors.rows")}</p>
        <ul className="grid gap-1">
          {view.rows.map((entry) => (
            <li key={entry.row} className="flex flex-wrap items-center gap-2">
              <Badge tone="danger">
                {t("gatewaySettlement.errors.row", { row: entry.row })}
              </Badge>
              <span>
                {t(`gatewaySettlement.errors.reason.${entry.reason}`)}
              </span>
            </li>
          ))}
        </ul>
        {view.rows.length >= 20 && (
          <p>{t("gatewaySettlement.errors.moreRows")}</p>
        )}
      </div>
    );
  const text =
    view.kind === "rateLimited"
      ? view.seconds === null
        ? t("gatewaySettlement.errors.rateLimited")
        : t("gatewaySettlement.errors.rateLimitedSeconds", {
            seconds: view.seconds,
          })
      : t(`gatewaySettlement.errors.${view.kind}`);
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-danger-subtle px-4 py-3 text-sm leading-5 text-danger"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  );
}

function downloadTemplate() {
  const blob = new Blob([settlementTemplateCsv()], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "template-settlement-duitku.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function GatewaySettlementImportPage() {
  const t = useT();
  const outlets = useAccountOutlets();
  const importCsv = useImportGatewaySettlementCsv();
  const stepUp = useStepUp();
  const attempt = useAttemptKey();
  const search = useSearch({ strict: false }) as { outletId?: string };
  const [outletId, setOutletId] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState("");
  const [periodStart, setPeriodStart] = React.useState("");
  const [periodEnd, setPeriodEnd] = React.useState("");
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [check, setCheck] = React.useState<
    SettlementCsvCheck | "unreadable" | null
  >(null);
  const [touched, setTouched] = React.useState(false);
  const [error, setError] = React.useState<SettlementErrorView | null>(null);
  const [result, setResult] = React.useState<SettlementImportView | null>(null);
  // Bumped to remount the file input: a browser keeps the chosen file in it.
  const [fileKey, setFileKey] = React.useState(0);
  // The server asked for the second factor again right after a verification.
  const [stepUpAgain, setStepUpAgain] = React.useState(false);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const referenceRef = React.useRef<HTMLInputElement>(null);
  const periodStartRef = React.useRef<HTMLInputElement>(null);
  const periodEndRef = React.useRef<HTMLInputElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const submitRef = React.useRef<HTMLButtonElement>(null);
  // The reconciliation panel passes the outlet it was showing.
  const linkedOutletId = outlets.some((outlet) => outlet.id === search.outletId)
    ? (search.outletId ?? null)
    : null;
  const selectedOutletId = outletId ?? linkedOutletId ?? outlets[0]?.id ?? null;
  const trimmedReference = reference.trim();
  const periodProblem: PeriodCheck | null = checkPeriod(periodStart, periodEnd);

  const pick = async (file: File | undefined) => {
    setPicked(null);
    setCheck(null);
    setError(null);
    if (!file) return;
    let csv: string;
    try {
      csv = await file.text();
    } catch {
      setCheck("unreadable");
      return;
    }
    const problem = checkSettlementCsv(file.name, csv);
    if (problem) {
      setCheck(problem);
      return;
    }
    setPicked({ name: file.name, csv, lines: dataRowCount(csv) });
  };

  // Closing the step-up returns focus to the upload button.
  const stepUpWasOpen = React.useRef(false);
  React.useEffect(() => {
    if (stepUpWasOpen.current && !stepUp.active) submitRef.current?.focus();
    stepUpWasOpen.current = stepUp.active;
  }, [stepUp.active]);

  const send = async () => {
    if (importCsv.isPending || selectedOutletId === null) return;
    setTouched(true);
    // The first field still missing takes focus, in screen order.
    const firstProblem =
      trimmedReference === ""
        ? referenceRef
        : periodProblem === "periodRequired" && !periodStart
          ? periodStartRef
          : periodProblem !== null
            ? periodEndRef
            : !picked
              ? fileRef
              : null;
    if (firstProblem || !picked) {
      firstProblem?.current?.focus();
      return;
    }
    setError(null);
    const body = {
      outletId: selectedOutletId as OutletId,
      provider: "duitku" as const,
      format: "legend_template_v1" as const,
      reference: trimmedReference,
      periodStart,
      periodEnd,
      fileName: picked.name,
      csv: picked.csv,
    };
    try {
      const response = await importCsv.mutateAsync({
        body,
        idempotencyKey: attempt.keyFor(body),
      });
      attempt.settle();
      stepUp.reset();
      setStepUpAgain(false);
      setResult(response.data);
      setPicked(null);
      setTouched(false);
      setFileKey((n) => n + 1);
    } catch (caught) {
      const wasVerifying = stepUp.active;
      if (stepUp.capture(caught)) {
        setStepUpAgain(wasVerifying);
        return;
      }
      stepUp.reset();
      setStepUpAgain(false);
      setError(settlementErrorView(caught));
    }
  };

  const again = () => {
    setResult(null);
    setError(null);
    setCheck(null);
    setReference("");
    titleRef.current?.focus();
  };

  const form =
    outlets.length === 0 ? (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <EmptyState
          title={t("gatewaySettlement.noOutlets.title")}
          description={t("gatewaySettlement.noOutlets.description")}
        />
      </div>
    ) : (
      <div className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <form
          aria-label={t("gatewaySettlement.form.label")}
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {/* Frozen while the step-up is open: the upload it verifies stays the one sent. */}
          <fieldset disabled={stepUp.active} className="grid min-w-0 gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label={t("gatewaySettlement.form.outlet")} required>
                <Select
                  value={selectedOutletId ?? undefined}
                  onValueChange={(value) => {
                    setOutletId(value);
                    setError(null);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {outlets.map((outlet) => (
                      <SelectItem key={outlet.id} value={outlet.id}>
                        {outlet.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t("gatewaySettlement.form.reference")}
                required
                hint={t("gatewaySettlement.form.referenceHint")}
                error={
                  touched && trimmedReference === ""
                    ? t("gatewaySettlement.form.referenceRequired")
                    : undefined
                }
              >
                <Input
                  ref={referenceRef}
                  value={reference}
                  maxLength={100}
                  autoComplete="off"
                  onChange={(event) => setReference(event.target.value)}
                />
              </FormField>
              <FormField
                label={t("gatewaySettlement.form.periodStart")}
                required
                error={
                  touched && periodProblem === "periodRequired" && !periodStart
                    ? t("gatewaySettlement.form.periodRequired")
                    : undefined
                }
              >
                <Input
                  ref={periodStartRef}
                  type="date"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                />
              </FormField>
              <FormField
                label={t("gatewaySettlement.form.periodEnd")}
                required
                error={
                  touched && periodProblem !== null && periodStart
                    ? t(`gatewaySettlement.form.${periodProblem}`)
                    : undefined
                }
              >
                <Input
                  ref={periodEndRef}
                  type="date"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                />
              </FormField>
            </div>
            <FormField
              label={t("gatewaySettlement.form.file")}
              required
              hint={
                picked && error?.kind !== "rows"
                  ? t("gatewaySettlement.form.fileChosen", {
                      name: picked.name,
                      count: picked.lines,
                    })
                  : t("gatewaySettlement.form.fileHint")
              }
              error={
                check
                  ? t(`gatewaySettlement.checks.${check}`)
                  : touched && !picked
                    ? t("gatewaySettlement.form.needsFile")
                    : undefined
              }
            >
              <Input
                key={fileKey}
                ref={fileRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={(event) => void pick(event.target.files?.[0])}
              />
            </FormField>
          </fieldset>

          {error && !stepUp.active && <ErrorNotice view={error} />}

          {!stepUp.active && (
            <div className="flex flex-wrap gap-2">
              <Button
                ref={submitRef}
                type="submit"
                loading={importCsv.isPending}
                disabled={importCsv.isPending}
              >
                <Upload aria-hidden="true" />
                {importCsv.isPending
                  ? t("gatewaySettlement.form.submitting")
                  : t("gatewaySettlement.form.submit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={downloadTemplate}
              >
                <Download aria-hidden="true" />
                {t("gatewaySettlement.form.template")}
              </Button>
            </div>
          )}
        </form>

        {stepUp.active && (
          <VerifyPanel
            key={stepUp.round}
            copy={{
              title: t("gatewaySettlement.verify.title"),
              mfaHint: t("gatewaySettlement.verify.mfaHint"),
            }}
            needs={stepUp.needs}
            busy={importCsv.isPending}
            error={stepUpAgain ? t("gatewaySettlement.verify.again") : null}
            onVerified={() => void send()}
            onCancel={() => {
              stepUp.reset();
              setStepUpAgain(false);
            }}
          />
        )}
      </div>
    );

  return (
    <section
      aria-labelledby="gateway-settlement-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <nav
        aria-label={t("gatewaySettlement.breadcrumbLabel")}
        className="text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-x-1.5">
          <li>
            <Link
              to="/kelola/pembayaran"
              className="underline-offset-2 hover:underline"
            >
              {t("gatewaySettlement.breadcrumbPayments")}
            </Link>
          </li>
          {/* Each "/" sits with the item after it, so a wrap never leaves it hanging. */}
          <li className="flex items-center gap-x-1.5">
            <span aria-hidden="true">/</span>
            <Link
              to="/kelola/pembayaran"
              search={{ tab: "reconciliation" }}
              className="underline-offset-2 hover:underline"
            >
              {t("gatewaySettlement.breadcrumbReconciliation")}
            </Link>
          </li>
          <li className="flex items-center gap-x-1.5" aria-current="page">
            <span aria-hidden="true">/</span>
            {t("gatewaySettlement.breadcrumbCurrent")}
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs text-muted-foreground">
            {t("gatewaySettlement.eyebrow")}
          </p>
          <h2
            id="gateway-settlement-title"
            ref={titleRef}
            tabIndex={-1}
            className="type-display outline-none"
          >
            {t("gatewaySettlement.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("gatewaySettlement.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </header>

      <p
        role="note"
        className="rounded-container border-(length:--border-w) bg-primary-tint px-4 py-3 text-sm leading-5 text-primary"
      >
        {t("gatewaySettlement.accessBand")}
      </p>

      {result ? (
        <>
          <SettlementImportResult result={result} />
          <div>
            <Button type="button" variant="outline" onClick={again}>
              {t("gatewaySettlement.form.another")}
            </Button>
          </div>
        </>
      ) : (
        form
      )}

      {outlets.length > 0 && <SettlementList outletId={selectedOutletId} />}
    </section>
  );
}
