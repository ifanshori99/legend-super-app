// "Slip gaji" — the employee's payslip history (PRD v1.7 §3 F30 "Slip Gaji":
// riwayat, dilindungi PIN, unduh PDF). Every row comes from
// `myPayslipSummarySchema`, which carries no amounts: the salary data only
// appears after the PIN on the detail screen (HR-03, HR-01).
import { Link } from "@tanstack/react-router";
import { ChevronLeft, FileText, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SectionEmpty,
  SectionError,
} from "@/features/ws10-hris-employee/components/section-states";
import { formatBusinessDate } from "../format.ts";
import { useMyPayslips } from "../hooks.ts";
import { PageHeader } from "./page-header.tsx";
import { StateBadge } from "./state-badge.tsx";

function PinInfoCard() {
  const t = useT();
  return (
    <Card className="gap-0">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <div className="grid gap-0.5">
          <p className="text-sm leading-5 font-semibold">
            {t("payslip.history.pinTitle")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payslip.history.pinBody")}
          </p>
        </div>
      </div>
    </Card>
  );
}

export function PayslipHistory() {
  const t = useT();
  const query = useMyPayslips();

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("payslip.backHome")}
          </Link>
        </Button>
        <PageHeader
          title={t("payslip.history.title")}
          subtitle={t("payslip.history.subtitle")}
        />
      </div>

      <PinInfoCard />

      {query.isPending ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only" role="status">
            {t("common.loading")}
          </span>
          <Skeleton className="h-32 w-full rounded-container" />
          <Skeleton className="h-32 w-full rounded-container" />
        </div>
      ) : query.isError ? (
        <Card>
          <SectionError
            title={t("payslip.history.errorTitle")}
            description={t("payslip.history.errorHint")}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : query.payslips.length === 0 ? (
        <Card>
          <SectionEmpty
            icon={FileText}
            title={t("payslip.history.emptyTitle")}
            description={t("payslip.history.emptyDescription")}
          />
        </Card>
      ) : (
        <ul className="grid gap-3">
          {query.payslips.map((summary) => (
            <li key={summary.id}>
              <Card className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid min-w-0 gap-1">
                    <p className="type-eyebrow text-muted-foreground">
                      {t("payslip.history.period")}
                    </p>
                    <p className="font-brand type-title tabular">
                      {t("payslip.history.periodValue", {
                        start: formatBusinessDate(summary.periodStart),
                        end: formatBusinessDate(summary.periodEnd),
                      })}
                    </p>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {t("payslip.history.payDate", {
                        date: formatBusinessDate(summary.payDate),
                      })}
                    </p>
                  </div>
                  <StateBadge tone="success">
                    {t("payslip.history.paid")}
                  </StateBadge>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <span className="text-sm leading-5 text-muted-foreground">
                    {summary.viewedAt
                      ? t("payslip.history.opened")
                      : t("payslip.history.unopened")}
                  </span>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/karyawan/slip-gaji/$payslipId"
                      params={{ payslipId: summary.id }}
                    >
                      {t("payslip.history.view")}
                    </Link>
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? t("payslip.state.loadingMore")
            : t("payslip.state.loadMore")}
        </Button>
      )}
    </div>
  );
}
