// "Ringkasan penyelesaian akhir" (PRD v1.7 §3 D26 "Offboarding": perhitungan
// hak akhir).
//
// The kasbon lines come straight from the API's final-settlement summary
// (`outstandingLoans`, already net of the installments a payroll run reserved,
// and `pendingPayrollDeductions`); the client never recomputes or re-subtracts
// them. THR pro rata still reads the payroll contract's endpoints and does the
// contract's math (`resolveStatutoryTable` + `computeThr`, tenure by exact date
// up to the exit date), next to the approved reimbursements not paid out. Every
// line is an estimate until the payroll run that settles it is locked; the card
// never adds the lines up and never computes pesangon or leave payout.
//
// Salary data (HR-03): a viewer without payroll.view sees no amount and the
// reads are never requested.
import { Lock, ReceiptText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import type { Employee } from "@starter/shared/hris";
import { useFinalSettlement, useSettlementSources } from "../hooks.ts";
import {
  formatBusinessDate,
  thrEstimate,
  unpaidReimbursements,
} from "../lib.ts";

function Line({
  label,
  source,
  amountIdr,
}: {
  label: string;
  source: string;
  amountIdr: number | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-(length:--density-text) font-medium">{label}</dt>
        <dd className="text-sm leading-5 text-muted-foreground">{source}</dd>
      </div>
      <dd className="text-right">
        {amountIdr === null ? (
          <span className="text-sm text-muted-foreground">
            {t("lifecycle.common.noValue")}
          </span>
        ) : (
          <Money amount={amountIdr} size="lg" />
        )}
      </dd>
    </div>
  );
}

function SettlementLines({
  employee,
  offboardingId,
}: {
  employee: Employee;
  offboardingId: string | null;
}) {
  const t = useT();
  const sources = useSettlementSources(employee.id, true);
  const summary = useFinalSettlement(offboardingId, true);

  if (sources.isPending || (offboardingId !== null && summary.isPending))
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-row" />
        ))}
      </div>
    );

  // A failed summary only blanks the kasbon lines below (shown as
  // unavailable); THR and reimbursement come from the sources and still show.
  if (sources.isError)
    return (
      <ErrorState
        title={t("lifecycle.settlement.errorTitle")}
        description={t("lifecycle.settlement.errorHint")}
        onRetry={() => {
          sources.refetch();
        }}
      />
    );

  const thr = thrEstimate({
    employee,
    tables: sources.tables,
    rows: sources.rows,
    components: sources.components,
  });
  // The API's numbers, shown as they are. No summary (no offboarding record
  // yet) shows no amount rather than a figure computed here.
  const loans = summary.data?.data.outstandingLoans ?? null;
  const deductions = summary.data?.data.pendingPayrollDeductions ?? null;
  const claims = unpaidReimbursements(sources.claims);

  const thrSource =
    thr.kind === "ok"
      ? t("lifecycle.settlement.thrSource", {
          months: thr.tenureMonths,
          date: formatBusinessDate(employee.endDate ?? ""),
        })
      : t(`lifecycle.settlement.thrMissing.${thr.kind}`);

  return (
    <dl className="grid">
      <Line
        label={t("lifecycle.settlement.thr")}
        source={thrSource}
        amountIdr={thr.kind === "ok" ? thr.amountIdr : null}
      />
      <Line
        label={t("lifecycle.settlement.loan")}
        source={
          loans === null
            ? t("lifecycle.settlement.loanUnavailable")
            : loans.count === 0
              ? t("lifecycle.settlement.loanNone")
              : t("lifecycle.settlement.loanSource", { count: loans.count })
        }
        amountIdr={loans === null || loans.count === 0 ? null : loans.amountIdr}
      />
      <Line
        label={t("lifecycle.settlement.pendingDeduction")}
        source={
          deductions === null
            ? t("lifecycle.settlement.loanUnavailable")
            : deductions.count === 0
              ? t("lifecycle.settlement.pendingDeductionNone")
              : t("lifecycle.settlement.pendingDeductionSource", {
                  count: deductions.count,
                })
        }
        amountIdr={
          deductions === null || deductions.count === 0
            ? null
            : deductions.amountIdr
        }
      />
      <Line
        label={t("lifecycle.settlement.reimbursement")}
        source={
          claims.count === 0
            ? t("lifecycle.settlement.reimbursementNone", {
                pending: claims.pendingCount,
              })
            : t("lifecycle.settlement.reimbursementSource", {
                count: claims.count,
                pending: claims.pendingCount,
              })
        }
        amountIdr={claims.count === 0 ? null : claims.amountIdr}
      />
    </dl>
  );
}

export function FinalSettlementCard({
  employee,
  offboardingId,
  canViewSalary,
}: {
  employee: Employee;
  /** The offboarding the API summarises; null until one exists. */
  offboardingId: string | null;
  /** payroll.view (HR-03): without it no amount is requested or shown. */
  canViewSalary: boolean;
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle>{t("lifecycle.settlement.title")}</CardTitle>
            <CardDescription>
              {t("lifecycle.settlement.description")}
            </CardDescription>
          </div>
          <Badge tone="neutral">
            <ReceiptText aria-hidden="true" />
            {t("lifecycle.settlement.estimate")}
          </Badge>
        </div>
      </CardHeader>
      {canViewSalary ? (
        <SettlementLines employee={employee} offboardingId={offboardingId} />
      ) : (
        <p className="flex items-start gap-1.5 text-sm leading-5 text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("lifecycle.settlement.restricted")}
        </p>
      )}
      <p className="text-sm leading-5 text-muted-foreground">
        {t("lifecycle.settlement.estimateNote")}
      </p>
    </Card>
  );
}
