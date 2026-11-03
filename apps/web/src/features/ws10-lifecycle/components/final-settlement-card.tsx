// "Ringkasan penyelesaian akhir" (PRD v1.7 §3 D26 "Offboarding": perhitungan
// hak akhir).
//
// There is no final-settlement endpoint yet, so the card reads the payroll
// contract's own endpoints and does only the contract's math: THR pro rata via
// `resolveStatutoryTable` + `computeThr` (tenure by exact date up to the exit
// date), the kasbon balance still owed and the approved reimbursements not paid
// out. Every line is an estimate until the payroll run that settles it is
// locked; the card never adds the lines up and never computes pesangon or
// leave payout (no contract).
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
import { useSettlementSources } from "../hooks.ts";
import {
  formatBusinessDate,
  outstandingLoans,
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

function SettlementLines({ employee }: { employee: Employee }) {
  const t = useT();
  const sources = useSettlementSources(employee.id, true);

  if (sources.isPending)
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-row" />
        ))}
      </div>
    );

  if (sources.isError)
    return (
      <ErrorState
        title={t("lifecycle.settlement.errorTitle")}
        description={t("lifecycle.settlement.errorHint")}
        onRetry={sources.refetch}
      />
    );

  const thr = thrEstimate({
    employee,
    tables: sources.tables,
    rows: sources.rows,
    components: sources.components,
  });
  const loans = outstandingLoans(sources.loans);
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
          loans.count === 0
            ? t("lifecycle.settlement.loanNone")
            : t("lifecycle.settlement.loanSource", { count: loans.count })
        }
        amountIdr={loans.count === 0 ? null : loans.amountIdr}
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
  canViewSalary,
}: {
  employee: Employee;
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
        <SettlementLines employee={employee} />
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
