// "Slip gaji" — the employee's payslip history (PRD v1.7 §3 F30 "Slip Gaji":
// riwayat, dilindungi PIN, unduh PDF). Every row comes from
// `myPayslipSummarySchema`, which carries no amounts: the salary data only
// appears after the PIN on the detail screen (HR-03, HR-01).
import { Link } from "@tanstack/react-router";
import { ChevronLeft, KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBusinessDate } from "../format.ts";
import { useMyPayslips } from "../hooks.ts";
import { usePayslipPinStatus } from "../pin-hooks.ts";
import { PageHeader } from "./page-header.tsx";
import { PinLayout } from "./pin-layout.tsx";

function PinInfoCard({ canChangePin }: { canChangePin: boolean }) {
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
          {canChangePin && (
            <Button
              asChild
              variant="link"
              size="sm"
              className="mt-1 h-auto min-h-11 w-fit justify-start p-0 sm:min-h-0"
            >
              <Link to="/karyawan/slip-gaji/ubah-pin">
                <KeyRound aria-hidden="true" />
                {t("payslipPin.list.changePin")}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function ListNotice({
  tone,
  title,
  children,
}: {
  tone: "info" | "danger";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={
        tone === "danger"
          ? "grid gap-0.5 rounded-container border-l-4 border-danger bg-danger-subtle px-4 py-3 text-sm leading-5"
          : "grid gap-0.5 rounded-container border-l-4 border-primary bg-success-subtle px-4 py-3 text-sm leading-5"
      }
    >
      <p className="font-bold">{title}</p>
      <p>{children}</p>
    </div>
  );
}

function ListBackLink() {
  const t = useT();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to="/karyawan">
        <ChevronLeft aria-hidden="true" />
        {t("payslipPin.layout.back")}
      </Link>
    </Button>
  );
}

export function PayslipHistory() {
  const t = useT();
  const query = useMyPayslips();
  const pinStatus = usePayslipPinStatus();

  // Error and empty follow the approved mockups (error, kosong): the shared
  // PIN layout with an info panel. Loading keeps the loaded list's shape so
  // nothing jumps when the rows arrive. No amounts in any state.
  if (query.isPending) {
    return (
      <div aria-busy="true" className="grid gap-4">
        <div className="grid gap-2">
          <ListBackLink />
          <PageHeader
            title={t("payslip.history.title")}
            subtitle={t("payslip.history.subtitle")}
          />
        </div>
        <PinInfoCard canChangePin={pinStatus.data?.status === "active"} />
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <div className="grid gap-3">
          <Skeleton className="h-32 w-full rounded-container" />
          <Skeleton className="h-32 w-full rounded-container" />
          <Skeleton className="h-32 w-full rounded-container" />
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <PinLayout
        backLink={<ListBackLink />}
        title={t("payslipPin.error.title")}
        description={t("payslipPin.error.description")}
        side={t("payslipPin.error.side")}
      >
        <ListNotice tone="danger" title={t("payslipPin.error.noticeTitle")}>
          {t("payslipPin.error.notice")}
        </ListNotice>
        <Button
          type="button"
          size="lg"
          className="w-full"
          loading={query.isRefetching}
          onClick={() => void query.refetch()}
        >
          {t("payslipPin.error.retry")}
        </Button>
      </PinLayout>
    );
  }

  if (query.payslips.length === 0) {
    return (
      <PinLayout
        backLink={<ListBackLink />}
        title={t("payslipPin.kosong.title")}
        description={t("payslipPin.kosong.description")}
        side={t("payslipPin.kosong.side")}
      >
        <ListNotice tone="info" title={t("payslipPin.kosong.noticeTitle")}>
          {t("payslipPin.kosong.notice")}
        </ListNotice>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          loading={query.isRefetching}
          onClick={() => void query.refetch()}
        >
          {t("payslipPin.kosong.reload")}
        </Button>
      </PinLayout>
    );
  }

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

      <PinInfoCard canChangePin={pinStatus.data?.status === "active"} />

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
