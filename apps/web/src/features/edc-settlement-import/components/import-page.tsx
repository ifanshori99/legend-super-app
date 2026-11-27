// Upload of a bank's EDC settlement CSV (X2-UI, legend-wasr7.18): pick the
// outlet and bank, choose the file, see what the server matched. Nothing is
// booked and no amount changes; the file only confirms EDC sales and clears
// their "perlu dicek" flag. The API needs payment.reconcile at the outlet and a
// fresh second factor: MFA_REQUIRED opens the step-up panel and the same upload
// is sent again.
import * as React from "react";
import { CircleAlert, Upload } from "lucide-react";
import type { OutletId } from "@starter/shared/core";
import type { EdcSettlementCsvImportView } from "@starter/shared/payment/admin";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useStepUp,
  VerifyPanel,
} from "@/features/ws10-payroll-payout/components/approval-verify";
import { usePaymentRouting } from "@/features/ws05-payment-admin/hooks";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useImportEdcSettlementCsv } from "../hooks";
import {
  checkCsvUpload,
  EDC_BANKS,
  importErrorView,
  type CsvCheck,
  type EdcBank,
  type ImportErrorView,
} from "../lib";
import { ImportResult } from "./import-result";

type Picked = { name: string; csv: string; lines: number };

function ErrorNotice({ view }: { view: ImportErrorView }) {
  const t = useT();
  if (view.kind === "rows")
    return (
      <div
        role="alert"
        className="grid gap-2 rounded-container border-(length:--border-w) bg-danger-subtle px-4 py-3 text-sm leading-5 text-danger"
      >
        <p className="flex items-start gap-2 font-semibold">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("edcSettlementCsv.errors.rowsTitle")}
        </p>
        <p>{t("edcSettlementCsv.errors.rows")}</p>
        <ul className="flex flex-wrap gap-2">
          {view.rows.map((row) => (
            <li key={row}>
              <Badge tone="danger">
                {t("edcSettlementCsv.errors.row", { row })}
              </Badge>
            </li>
          ))}
        </ul>
        {view.rows.length >= 20 && (
          <p>{t("edcSettlementCsv.errors.moreRows")}</p>
        )}
      </div>
    );
  const text =
    view.kind === "message"
      ? t("edcSettlementCsv.errors.message", { detail: view.detail ?? "" })
      : view.kind === "forbidden"
        ? t("edcSettlementCsv.errors.forbidden")
        : view.kind === "notFound"
          ? t("edcSettlementCsv.errors.notFound")
          : view.kind === "offline"
            ? t("edcSettlementCsv.errors.offline")
            : t("edcSettlementCsv.errors.generic");
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

export function EdcSettlementImportPage() {
  const t = useT();
  const routing = usePaymentRouting(null);
  const outlets = routing.data?.data.outlets ?? [];
  const importCsv = useImportEdcSettlementCsv();
  const stepUp = useStepUp();
  const [outletId, setOutletId] = React.useState<string | null>(null);
  const [bank, setBank] = React.useState<EdcBank>("bca");
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [check, setCheck] = React.useState<CsvCheck | "unreadable" | null>(
    null,
  );
  const [error, setError] = React.useState<ImportErrorView | null>(null);
  const [result, setResult] = React.useState<EdcSettlementCsvImportView | null>(
    null,
  );
  // Bumped to remount the file input: a browser keeps the chosen file in it.
  const [fileKey, setFileKey] = React.useState(0);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const selectedOutletId = outletId ?? outlets[0]?.id ?? null;

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
    const problem = checkCsvUpload(file.name, csv);
    if (problem) {
      setCheck(problem);
      return;
    }
    const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
    setPicked({ name: file.name, csv, lines: Math.max(0, lines.length - 1) });
  };

  const send = async () => {
    if (importCsv.isPending || !picked || selectedOutletId === null) return;
    setError(null);
    try {
      const response = await importCsv.mutateAsync({
        outletId: selectedOutletId as OutletId,
        bank,
        fileName: picked.name,
        csv: picked.csv,
      });
      stepUp.reset();
      setResult(response.data);
      setPicked(null);
      setFileKey((n) => n + 1);
    } catch (caught) {
      if (stepUp.capture(caught)) return;
      stepUp.reset();
      setError(importErrorView(caught));
    }
  };

  const again = () => {
    setResult(null);
    setError(null);
    setCheck(null);
    titleRef.current?.focus();
  };

  const body =
    routing.isPending && outlets.length === 0 ? (
      <Skeleton className="h-72" />
    ) : routing.isError && outlets.length === 0 ? (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <ErrorState
          title={t("edcSettlementCsv.loadError.title")}
          description={t("edcSettlementCsv.loadError.description")}
          onRetry={() => void routing.refetch()}
        />
      </div>
    ) : outlets.length === 0 ? (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <EmptyState
          title={t("edcSettlementCsv.noOutlets.title")}
          description={t("edcSettlementCsv.noOutlets.description")}
        />
      </div>
    ) : (
      <form
        aria-label={t("edcSettlementCsv.form.label")}
        className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label={t("edcSettlementCsv.form.outlet")} required>
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
          <FormField label={t("edcSettlementCsv.form.bank")} required>
            <Select
              value={bank}
              onValueChange={(value) => {
                setBank(value as EdcBank);
                setError(null);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDC_BANKS.map((code) => (
                  <SelectItem key={code} value={code}>
                    {t(`edcSettlementCsv.bank.${code}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <FormField
          label={t("edcSettlementCsv.form.file")}
          required
          hint={
            picked
              ? t("edcSettlementCsv.form.fileChosen", {
                  name: picked.name,
                  count: picked.lines,
                })
              : t("edcSettlementCsv.form.fileHint")
          }
          error={check ? t(`edcSettlementCsv.checks.${check}`) : undefined}
        >
          <Input
            key={fileKey}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </FormField>

        {stepUp.active && (
          <VerifyPanel
            key={stepUp.round}
            copy={{
              title: t("edcSettlementCsv.verify.title"),
              mfaHint: t("edcSettlementCsv.verify.mfaHint"),
            }}
            needs={stepUp.needs}
            busy={importCsv.isPending}
            onVerified={() => void send()}
            onCancel={() => stepUp.reset()}
          />
        )}
        {error && !stepUp.active && <ErrorNotice view={error} />}

        {!stepUp.active && (
          <div>
            <Button
              type="submit"
              loading={importCsv.isPending}
              disabled={!picked || importCsv.isPending}
            >
              <Upload aria-hidden="true" />
              {importCsv.isPending
                ? t("edcSettlementCsv.form.submitting")
                : t("edcSettlementCsv.form.submit")}
            </Button>
          </div>
        )}
      </form>
    );

  return (
    <section
      aria-labelledby="edc-csv-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <nav
        aria-label={t("edcSettlementCsv.breadcrumbLabel")}
        className="text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-x-1.5">
          <li>{t("edcSettlementCsv.breadcrumbPayments")}</li>
          <li aria-hidden="true">/</li>
          <li>{t("edcSettlementCsv.breadcrumbEdc")}</li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{t("edcSettlementCsv.breadcrumbCurrent")}</li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs text-muted-foreground">
            {t("edcSettlementCsv.eyebrow")}
          </p>
          <h2
            id="edc-csv-title"
            ref={titleRef}
            tabIndex={-1}
            className="type-display outline-none"
          >
            {t("edcSettlementCsv.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("edcSettlementCsv.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </header>

      <p
        role="note"
        className="rounded-container border-(length:--border-w) bg-primary-tint px-4 py-3 text-sm leading-5 text-primary"
      >
        {t("edcSettlementCsv.accessBand")}
      </p>

      {result ? (
        <>
          <ImportResult result={result} />
          <div>
            <Button type="button" variant="outline" onClick={again}>
              {t("edcSettlementCsv.form.another")}
            </Button>
          </div>
        </>
      ) : (
        body
      )}
    </section>
  );
}
