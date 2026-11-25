// Facility & WFC report hub (WS-09 FE, bead legend-zx8k; PRD v1.7 §3 F25
// "Laporan" and "Pengukuran WFC"). Reads the static report catalog: the six
// definitions are contract rows, so this screen has no loader, no API call and
// no loading/error state. Management density, one CardShell per report, no own
// page title (the management topbar owns it, DESIGN.md v3 §5).
import { Link } from "@tanstack/react-router";
import { ChartColumn, ChevronRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import {
  reportMetricByCode,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  useDimensionLabel,
  usePresetLabel,
} from "@/features/ws11-reports/components/labels";
import { reportHasData } from "@/features/ws11-reports/lib";
import { facilityReportDefinitions, missingFacilityReportCount } from "../lib";

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2">
      <dt className="type-eyebrow pt-0.5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm leading-5 text-muted-foreground">
        {value}
      </dd>
    </div>
  );
}

function ReportCard({ report }: { report: ReportDefinition }) {
  const t = useT();
  const dimensionLabel = useDimensionLabel();
  const presetLabel = usePresetLabel();
  const metrics = report.metrics
    .map((code) => reportMetricByCode.get(code)?.name ?? code)
    .join(" · ");
  const dimensions =
    report.dimensions.map((key) => dimensionLabel(key)).join(" · ") || "—";
  const periods = report.periodPresets
    .map((preset) => presetLabel(preset))
    .join(" · ");
  // Same rule as the report catalog: no metric source on the server yet means
  // "Segera hadir", not a link to an empty screen.
  const available = reportHasData(report, { mock: API_MOCK });
  const cardClass =
    "flex h-full min-w-0 flex-col gap-3 rounded-container p-card";
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="type-title">{report.name}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {report.description}
          </p>
        </div>
      </div>
      <dl className="grid gap-2">
        <DetailLine label={t("facilityReport.hub.metrics")} value={metrics} />
        <DetailLine
          label={t("facilityReport.hub.dimensions")}
          value={dimensions}
        />
        <DetailLine label={t("facilityReport.hub.periods")} value={periods} />
      </dl>
      {available ? (
        <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
          {t("facilityReport.hub.open")}
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      ) : (
        <span className="mt-auto">
          <Badge tone="info">{t("reportViewer.catalog.soon")}</Badge>
        </span>
      )}
    </>
  );
  return (
    <li data-slot="facility-report-card" className="min-w-0">
      <CardShell className="h-full">
        <CardShellBody className="h-full">
          {available ? (
            <Link
              to={report.route as "/"}
              className={`${cardClass} transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
            >
              {content}
            </Link>
          ) : (
            <div className={cardClass}>{content}</div>
          )}
        </CardShellBody>
      </CardShell>
    </li>
  );
}

function ReadingBlock() {
  const t = useT();
  const sections = [
    {
      title: t("facilityReport.hub.reading.revpashTitle"),
      body: t("facilityReport.hub.reading.revpashBody"),
    },
    {
      title: t("facilityReport.hub.reading.utilizationTitle"),
      body: t("facilityReport.hub.reading.utilizationBody"),
    },
    {
      title: t("facilityReport.hub.reading.quotaTitle"),
      body: t("facilityReport.hub.reading.quotaBody"),
    },
  ];
  return (
    <CardShell data-slot="facility-report-reading">
      <CardShellBody>
        <div className="border-b p-card">
          <h2 className="type-title">
            {t("facilityReport.hub.reading.title")}
          </h2>
        </div>
        <div className="grid gap-4 p-card md:grid-cols-2 xl:grid-cols-3">
          {sections.map((section) => (
            <section key={section.title} className="grid content-start gap-1">
              <h3 className="type-heading">{section.title}</h3>
              <p className="text-sm leading-5 text-muted-foreground">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      </CardShellBody>
    </CardShell>
  );
}

export function FacilityReportHub() {
  const t = useT();
  const reports = facilityReportDefinitions();
  const missing = missingFacilityReportCount();
  return (
    <div
      data-slot="facility-report-hub"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5"
    >
      <CardShell>
        <CardShellBody>
          <div className="grid gap-3 p-card">
            <p className="max-w-4xl text-sm leading-5 text-muted-foreground">
              {t("facilityReport.hub.intro")}
            </p>
            {API_MOCK && (
              <p className="flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground">
                <Badge tone="neutral">{t("common.sampleData")}</Badge>
                {t("facilityReport.hub.sampleNote")}
              </p>
            )}
          </div>
        </CardShellBody>
      </CardShell>

      {reports.length === 0 ? (
        <CardShell>
          <CardShellBody>
            <EmptyState
              icon={ChartColumn}
              title={t("facilityReport.hub.empty.title")}
              description={t("facilityReport.hub.empty.hint")}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <>
          {missing > 0 && (
            <p className="text-xs leading-5 text-muted-foreground">
              {t("facilityReport.hub.missing")}
            </p>
          )}
          <ul
            aria-label={t("facilityReport.hub.title")}
            className="grid list-none grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2"
          >
            {reports.map((report) => (
              <ReportCard key={report.code} report={report} />
            ))}
          </ul>
        </>
      )}

      <ReadingBlock />
    </div>
  );
}
