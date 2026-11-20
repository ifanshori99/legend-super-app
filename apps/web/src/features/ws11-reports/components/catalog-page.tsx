// "/reports" — the report catalog (PRD v1.7 §3 F36 "Laporan": 100+ standard
// reports). GET /api/reports with family and search filters; each row links to
// the report's contract route when its screen exists in this build, otherwise
// the name stays plain text with a "Segera hadir" label (no link to a 404).
import { useDeferredValue, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ShieldAlert, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useRouteAvailable } from "@/lib/use-route-available";
import {
  REPORT_FAMILIES,
  REPORT_FAMILY_INFO,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import { useReportCatalog } from "../hooks";
import { reportFamilyHasData } from "../lib";

const ALL = "all";

function ReportRow({ report }: { report: ReportDefinition }) {
  const t = useT();
  const available =
    useRouteAvailable()(report.route) &&
    reportFamilyHasData(report.family, { mock: API_MOCK });
  const body = (
    <>
      <span className="min-w-0">
        <span className="block font-semibold">{report.name}</span>
        <span className="block text-sm leading-5 text-muted-foreground">
          {report.description}
        </span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{REPORT_FAMILY_INFO[report.family].label}</Badge>
        {report.containsPersonalData && (
          <Badge tone="warning">
            <ShieldAlert aria-hidden="true" />
            {t("reportViewer.personalBadge")}
          </Badge>
        )}
        {available ? (
          <ChevronRight
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Badge tone="info">{t("reportViewer.catalog.soon")}</Badge>
        )}
      </span>
    </>
  );
  const className =
    "flex flex-col gap-2 px-card py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4";
  return (
    <li>
      {available ? (
        <Link
          to={report.route as "/"}
          className={`${className} transition-colors hover:bg-surface-2`}
        >
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}

export function ReportCatalogPage() {
  const t = useT();
  const [family, setFamily] = useState(ALL);
  const [term, setTerm] = useState("");
  const search = useDeferredValue(term.trim().slice(0, 80));
  const catalog = useReportCatalog({
    ...(family !== ALL ? { family } : {}),
    ...(search ? { search } : {}),
  });
  const reports = catalog.data?.pages.flatMap((page) => page.data) ?? [];
  const offline =
    catalog.error instanceof ApiError && catalog.error.status === 0;
  const state: DataState = catalog.isError
    ? "error"
    : catalog.data === undefined
      ? "loading"
      : reports.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
        {t("reportViewer.catalog.intro")}
      </p>
      {offline ? (
        <ErrorState
          icon={WifiOff}
          title={t("reportViewer.offline.title")}
          description={t("reportViewer.offline.hint")}
          onRetry={() => void catalog.refetch()}
        />
      ) : (
        <DataTableShell
          title={t("reportViewer.catalog.title")}
          state={state}
          search={{
            value: term,
            onChange: setTerm,
            label: t("reportViewer.catalog.searchLabel"),
          }}
          actions={
            <Select value={family} onValueChange={setFamily}>
              <SelectTrigger
                aria-label={t("reportViewer.catalog.familyLabel")}
                className="sm:w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("reportViewer.catalog.allFamilies")}
                </SelectItem>
                {REPORT_FAMILIES.map((key) => (
                  <SelectItem key={key} value={key}>
                    {REPORT_FAMILY_INFO[key].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          onRetry={() => void catalog.refetch()}
          empty={{
            title: t("reportViewer.catalog.emptyTitle"),
            description: t("reportViewer.catalog.emptyHint"),
          }}
          rowCount={reports.length}
        >
          <ul className="divide-y">
            {reports.map((report) => (
              <ReportRow key={report.code} report={report} />
            ))}
          </ul>
          {catalog.hasNextPage && (
            <div className="flex justify-center border-t p-card">
              <Button
                variant="outline"
                size="sm"
                loading={catalog.isFetchingNextPage}
                onClick={() => void catalog.fetchNextPage()}
              >
                {t("reportViewer.catalog.more")}
              </Button>
            </div>
          )}
        </DataTableShell>
      )}
    </div>
  );
}
