// "Kalender libur" — national, collective and company holidays of one year,
// grouped by month (bead legend-ydf2; employee, read only). The year is the only
// control: previous/next buttons, no date typing. Loading, error (offline
// wording when the device is offline), empty and the list.
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";
import { useHolidays } from "../hooks.ts";
import {
  countHolidayRows,
  groupHolidaysByMonth,
  yearRange,
} from "./holiday-model.ts";

const TYPE_TONE = {
  national: "danger",
  collective: "warning",
  company: "info",
} as const;

export function HolidayPage() {
  const t = useT();
  const online = useOnline();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const query = useHolidays(yearRange(year));
  const months = useMemo(
    () => groupHolidaysByMonth(query.data ?? [], year),
    [query.data, year],
  );
  const total = countHolidayRows(months);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan/pengajuan">
            <ChevronLeft aria-hidden="true" />
            {t("hrisRequestsMine.holiday.back")}
          </Link>
        </Button>
        <header className="grid gap-1">
          <h1 className="font-brand type-display-xl">
            {t("hrisRequestsMine.holiday.title")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hrisRequestsMine.holiday.subtitle")}
          </p>
        </header>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("hrisRequestsMine.holiday.previousYear")}
          onClick={() => setYear((value) => value - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p className="text-base leading-6 font-semibold" aria-live="polite">
          {t("hrisRequestsMine.holiday.year", { year })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("hrisRequestsMine.holiday.nextYear")}
          onClick={() => setYear((value) => value + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      {query.isPending ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only" role="status">
            {t("hrisRequestsMine.holiday.loading")}
          </span>
          <Skeleton className="h-28 w-full rounded-container" />
          <Skeleton className="h-28 w-full rounded-container" />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          title={t("hrisRequestsMine.holiday.error.title")}
          description={
            online
              ? t("hrisRequestsMine.holiday.error.description")
              : t("hrisRequestsMine.holiday.error.offlineDescription")
          }
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={query.isRefetching}
              onClick={() => void query.refetch()}
            >
              {t("hrisRequestsMine.holiday.error.retry")}
            </Button>
          }
        />
      ) : months.length === 0 ? (
        <EmptyState
          title={t("hrisRequestsMine.holiday.empty.title")}
          description={t("hrisRequestsMine.holiday.empty.description", {
            year,
          })}
        />
      ) : (
        <>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hrisRequestsMine.holiday.count", { count: total })}
          </p>
          {months.map((month) => (
            <section
              key={month.key}
              aria-label={t("hrisRequestsMine.holiday.monthLabel", {
                month: month.label,
              })}
              className="grid gap-2"
            >
              <h2 className="text-sm leading-5 font-bold capitalize">
                {month.label}
              </h2>
              <Card className="gap-0 divide-y divide-border p-0">
                {month.rows.map((row) => (
                  <div key={row.id} className="flex items-start gap-3 p-4">
                    <div className="grid w-10 shrink-0 justify-items-center">
                      <span className="text-xl leading-6 font-bold tabular">
                        {row.day}
                      </span>
                      <span className="text-xs leading-4 text-muted-foreground capitalize">
                        {row.weekday}
                      </span>
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <p className="text-base leading-6 font-semibold">
                        {row.name}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={TYPE_TONE[row.type]}>
                          {t(`hrisRequestsMine.holiday.type.${row.type}`)}
                        </Badge>
                        {row.singleOutlet && (
                          <span className="text-xs leading-5 text-muted-foreground">
                            {t("hrisRequestsMine.holiday.scope.outlet")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
