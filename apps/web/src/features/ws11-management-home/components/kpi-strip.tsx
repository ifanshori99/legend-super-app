// The role's KPI numbers: one StatStrip (DESIGN.md v3 / owner Q30), not a row
// of separate cards. Every cell is a registry metric (label) with the value of
// the source report run for the dashboard's period and outlets, and the strip
// carries one source link to that report (DASH-01). A missing figure reads
// "Belum ada data", never zero.
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import type {
  DashboardLayout,
  ManagementRole,
  MetricDashboardTile,
  ReportResult,
} from "@starter/shared/dashboard";
import { formatBusinessDate } from "../format";
import { PERIOD_LABEL_KEYS, ROLE_LABEL_KEYS } from "../labels";
import {
  formatPercent,
  isRunEmpty,
  kpiLines,
  resolveTilePeriod,
  secondsToMinutes,
  tileDrillDownPath,
  tileReportName,
  type KpiLine,
} from "../lib";
import { contractHref, useRouteAvailable } from "./href";

/** One figure in the type tier of a stat value (§3 money display). */
function KpiValue({ line }: { line: KpiLine }) {
  const t = useT();
  const value = line.value;
  if (value === null)
    return (
      <span className="type-heading font-normal text-muted-foreground">
        {t("managementHome.kpiEmpty")}
      </span>
    );
  if (value.unit === "idr")
    return <Money amount={value.valueIdr} size="stat" />;
  if (value.unit === "count")
    return <NumberDisplay value={value.value} size="stat" />;
  if (value.unit === "percent")
    return (
      <span className="type-money-display">
        {formatPercent(value.value)}
        <span className="ms-0.5 align-[0.32em] text-[0.6em] font-medium text-muted-foreground">
          {t("managementHome.unitSuffix.percent")}
        </span>
      </span>
    );
  if (value.unit === "seconds")
    return (
      <span className="type-money-display">
        {secondsToMinutes(value.value)}
        <span className="ms-1 align-[0.32em] text-[0.6em] font-medium text-muted-foreground">
          {t("managementHome.unitSuffix.minutes")}
        </span>
      </span>
    );
  return (
    <NumberDisplay value={Number(value.value)} fractionDigits={2} size="stat" />
  );
}

export function KpiStrip({
  tile,
  layout,
  run,
  failed = false,
  role,
}: {
  tile: MetricDashboardTile;
  layout: DashboardLayout;
  run: ReportResult | undefined;
  /** The source report run failed: say so instead of a skeleton or "no data". */
  failed?: boolean;
  role: ManagementRole;
}) {
  const t = useT();
  const routeAvailable = useRouteAvailable();
  const lines = kpiLines(tile, run);
  const period = resolveTilePeriod(tile, layout);
  const pending = run === undefined && !failed;
  const empty = isRunEmpty(run);
  const context = `${t(PERIOD_LABEL_KEYS[period.preset])} · ${formatBusinessDate(layout.businessDate)}`;
  const href = tileDrillDownPath(tile, layout);
  const reportName = tileReportName(tile);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <StatStrip
        label={t("managementHome.kpiLabel", { role: t(ROLE_LABEL_KEYS[role]) })}
        columns={lines.length >= 3 ? 3 : 2}
      >
        {lines.map((line) => (
          <StatTile
            key={line.code}
            label={line.name}
            value={
              pending ? (
                <Skeleton className="h-7 w-28" />
              ) : failed ? (
                <span className="type-heading font-normal text-muted-foreground">
                  {t("managementHome.kpiFailed")}
                </span>
              ) : (
                <KpiValue line={empty ? { ...line, value: null } : line} />
              )
            }
            context={context}
          />
        ))}
      </StatStrip>
      {href !== null && reportName !== null && (
        <p className="px-2 text-sm leading-5 text-muted-foreground">
          {t("managementHome.sourceLabel")}{" "}
          {!routeAvailable(href) ? (
            <span className="font-medium text-foreground">{reportName}</span>
          ) : (
            <Link
              to={contractHref(href)}
              className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {reportName}
              <ArrowUpRight
                className="ms-0.5 inline size-3.5"
                aria-hidden="true"
              />
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
