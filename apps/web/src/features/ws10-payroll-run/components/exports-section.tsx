// Exports of a locked run (Alur K step 4-5, PAYR-04): the bank transfer card,
// the tax export (bukti potong / monthly PPh 21), and the payslip list. Salary
// is paid only through an approved payout batch (legend-66xzn: the legacy
// bank-file POST answers 409 LEGACY_BANK_EXPORT_DISABLED), so the bank card
// links to the payout screen and keeps the archive of earlier files, whose
// total the strip compares with the run's bank-transfer net.
import * as React from "react";
import { Download, Landmark, ReceiptText } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { formatRupiah } from "@starter/shared/i18n";
import {
  payrollTaxExportKindSchema,
  type BankTransferFile,
  type PayrollRun,
  type PayrollTaxExport,
  type Payslip,
} from "@starter/shared/hris/payroll";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";
import { payrollErrorMessage } from "../errors";
import { useCreateTaxExport, useRunPayslips } from "../hooks";
import { formatDateTime } from "../lib";

const MONTHLY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const ANNUAL_PERIOD = /^\d{4}$/;

function DownloadLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
    >
      <Download className="size-4" aria-hidden="true" />
      {label}
    </a>
  );
}

function BankCard({
  run,
  files,
  canExport,
}: {
  run: PayrollRun;
  files: readonly BankTransferFile[];
  canExport: boolean;
}) {
  const t = useT();
  const exportable = run.status === "locked" || run.status === "paid";
  const expected = run.totals?.bankTransferIdr ?? null;
  const latest = [...files].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const matches =
    latest !== undefined && expected !== null && latest.totalIdr === expected;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Landmark
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          {t("payrollRun.exports.bankTitle")}
        </CardTitle>
        <CardDescription>{t("payrollRun.exports.bankBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!exportable ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.bankLockedHint")}
          </p>
        ) : (
          <>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("payrollRun.exports.bankPayoutBody")}
            </p>
            <Button asChild size="sm" className="w-full sm:w-fit">
              <Link
                to="/kelola/payroll/pencairan"
                search={{ tab: "runs", entity: run.legalEntityId }}
              >
                {t("payrollRun.exports.bankPayoutLink")}
              </Link>
            </Button>
          </>
        )}

        {files.length > 0 && (
          <h3 className="mt-2 text-sm font-semibold">
            {t("payrollRun.exports.bankArchiveTitle")}
          </h3>
        )}
        {latest && expected !== null && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {t("payrollRun.exports.bankExpected", {
                total: formatRupiah(expected),
              })}
            </span>
            <StatusPill status={matches ? "success" : "warning"}>
              {matches
                ? t("payrollRun.exports.bankMatches")
                : t("payrollRun.exports.bankMismatch")}
            </StatusPill>
          </div>
        )}
        {files.length > 0 && !canExport && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.bankArchiveNeedLock")}
          </p>
        )}
        {files.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.bankEmpty")}
          </p>
        ) : (
          <ul className="grid gap-2">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-container border-(length:--border-w) p-3 text-sm shadow-hairline"
              >
                <div className="grid gap-0.5">
                  <p className="font-semibold">
                    {t("payrollRun.exports.bankRow", {
                      format: file.format.toUpperCase(),
                      rows: file.rowCount,
                    })}
                  </p>
                  <p className="text-xs leading-4 text-muted-foreground tabular">
                    {formatDateTime(file.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={file.totalIdr} />
                  {canExport && (
                    <DownloadLink
                      href={file.fileUrl}
                      label={t("payrollRun.exports.download")}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TaxCard({ run, canExport }: { run: PayrollRun; canExport: boolean }) {
  // Personal data (NPWP/NIK, income): only from a twice-approved, locked run.
  const exportable = run.status === "locked" || run.status === "paid";
  const t = useT();
  const toast = useToast();
  const createExport = useCreateTaxExport();
  const [kind, setKind] = React.useState<
    "monthly_withholding" | "annual_statement"
  >("monthly_withholding");
  // The pay date decides the tax period (run.ts statutoryVersionsForRun).
  const [period, setPeriod] = React.useState(run.payDate.slice(0, 7));
  const [created, setCreated] = React.useState<PayrollTaxExport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const pattern =
    kind === "monthly_withholding" ? MONTHLY_PERIOD : ANNUAL_PERIOD;

  function submit() {
    setError(null);
    if (!pattern.test(period)) {
      setError(t("payrollRun.exports.taxPeriodInvalid"));
      return;
    }
    createExport.mutate(
      {
        legalEntityId: run.legalEntityId,
        kind,
        taxPeriod: period,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (file) => {
          setCreated(file);
          toast({ title: t("payrollRun.exports.taxCreated"), tone: "success" });
        },
        onError: (cause) => setError(payrollErrorMessage(cause, t)),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          {t("payrollRun.exports.taxTitle")}
        </CardTitle>
        <CardDescription>{t("payrollRun.exports.taxBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!canExport ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.needLock")}
          </p>
        ) : !exportable ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.taxLockedHint")}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <FormField
              label={t("payrollRun.exports.taxKind")}
              className="min-w-48"
            >
              <Select
                value={kind}
                onValueChange={(value) => {
                  const parsed = payrollTaxExportKindSchema.safeParse(value);
                  if (!parsed.success) return;
                  const next = parsed.data;
                  setKind(next);
                  setPeriod(
                    next === "annual_statement"
                      ? period.slice(0, 4)
                      : run.payDate.slice(0, 7),
                  );
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly_withholding">
                    {t("payrollRun.exports.taxKindMonthly")}
                  </SelectItem>
                  <SelectItem value="annual_statement">
                    {t("payrollRun.exports.taxKindAnnual")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("payrollRun.exports.taxPeriod")}
              hint={
                kind === "monthly_withholding"
                  ? t("payrollRun.exports.taxPeriodMonthlyHint")
                  : t("payrollRun.exports.taxPeriodAnnualHint")
              }
            >
              <Input
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                className="tabular"
                inputMode="numeric"
                maxLength={7}
              />
            </FormField>
            <Button
              type="button"
              size="sm"
              loading={createExport.isPending}
              onClick={submit}
            >
              <ReceiptText aria-hidden="true" />
              {t("payrollRun.exports.taxCreate")}
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}

        {created ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-container border-(length:--border-w) p-3 text-sm shadow-hairline">
            <div className="grid gap-0.5">
              <p className="font-semibold">
                {t("payrollRun.exports.taxReady", {
                  period: created.taxPeriod,
                })}
              </p>
              <p className="text-xs leading-4 text-muted-foreground tabular">
                {formatDateTime(created.createdAt)}
              </p>
            </div>
            {created.fileUrl && (
              <DownloadLink
                href={created.fileUrl}
                label={t("payrollRun.exports.download")}
              />
            )}
          </div>
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollRun.exports.taxEmpty")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PayslipCard({
  payslips,
  state,
  restricted,
  onRetry,
}: {
  payslips: readonly Payslip[];
  state: DataState;
  restricted: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <DataTableShell
      title={t("payrollRun.payslips.title")}
      description={t("payrollRun.payslips.description")}
      state={state}
      onRetry={onRetry}
      rowCount={payslips.length}
      empty={{
        title: t("payrollRun.payslips.emptyTitle"),
        description: restricted
          ? t("payrollRun.payslips.restricted")
          : t("payrollRun.payslips.emptyHint"),
      }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("payrollRun.payslips.columnEmployee")}</TableHead>
            <TableHead numeric>
              {t("payrollRun.payslips.columnGross")}
            </TableHead>
            <TableHead numeric>
              {t("payrollRun.payslips.columnDeductions")}
            </TableHead>
            <TableHead numeric>{t("payrollRun.payslips.columnNet")}</TableHead>
            <TableHead numeric>{t("payrollRun.payslips.columnPph")}</TableHead>
            <TableHead>{t("payrollRun.payslips.columnViewed")}</TableHead>
            <TableHead>
              <span className="sr-only">
                {t("payrollRun.payslips.columnFile")}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payslips.map((slip) => (
            <TableRow key={slip.id}>
              <TableCell>
                <p className="font-semibold">{slip.employeeName}</p>
                <p className="text-xs leading-4 text-muted-foreground tabular">
                  {slip.employeeNo}
                </p>
              </TableCell>
              <TableCell numeric>
                <Money amount={slip.grossIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={slip.deductionsIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={slip.netIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={slip.pph21Idr} />
              </TableCell>
              <TableCell>
                {slip.viewedAt === null ? (
                  <span className="text-muted-foreground">
                    {t("payrollRun.payslips.notViewed")}
                  </span>
                ) : (
                  <span className="tabular">
                    {formatDateTime(slip.viewedAt)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right">
                {slip.fileUrl ? (
                  <DownloadLink
                    href={slip.fileUrl}
                    label={t("payrollRun.exports.download")}
                  />
                ) : (
                  <span className="text-muted-foreground">
                    {t("payrollRun.payslips.noFile")}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

export function ExportsSection({
  run,
  files,
  canExport,
  canViewSalaries,
}: {
  run: PayrollRun;
  files: readonly BankTransferFile[];
  canExport: boolean;
  canViewSalaries: boolean;
}) {
  const t = useT();
  const payslips = useRunPayslips(run.id, canViewSalaries);
  const payslipRows = payslips.data?.data ?? [];
  const payslipState: DataState = !canViewSalaries
    ? "empty"
    : payslips.isPending
      ? "loading"
      : payslips.isError
        ? "error"
        : payslipRows.length === 0
          ? "empty"
          : "ready";

  return (
    <section aria-labelledby="payroll-exports-title" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="payroll-exports-title" className="type-title">
          {t("payrollRun.exports.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollRun.exports.subtitle")}
        </p>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <BankCard run={run} files={files} canExport={canExport} />
        <TaxCard run={run} canExport={canExport} />
      </div>
      <PayslipCard
        payslips={payslipRows}
        state={payslipState}
        restricted={!canViewSalaries}
        onRetry={() => void payslips.refetch()}
      />
    </section>
  );
}
