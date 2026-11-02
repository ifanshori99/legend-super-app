// Management home per role (PRD v1.7 §3.36 "Dashboard Manajemen" → "Beranda
// per Role", bead legend-6na6). DESIGN.md v3: the ManagementShell topbar owns
// the page title and the canvas; the screen is a toolbar (role switch +
// refresh) followed by the role's work queue — one StatStrip of KPI numbers
// from the source report, then the queue cards — and the shared approval box
// and report/audit links.
//
// It renders no number the contract does not define (DASH-01/DASH-02) and
// hides every tile whose extra permission the visitor lacks (RBAC §3.7,
// presentation only).
import { cn } from "cn";
import { CalendarDays, LayoutDashboard, RefreshCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AreaAccess } from "@/lib/areas/access";
import { ApiError } from "@/lib/api/errors";
import type { ManagementRole } from "@starter/shared/dashboard";
import { formatBusinessDate, formatClock } from "../format";
import {
  useManagementLayout,
  useRefreshManagementHome,
  useRoleKpiRun,
} from "../hooks";
import { ROLE_HINT_KEYS, ROLE_LABEL_KEYS } from "../labels";
import {
  defaultRole,
  kpiRunInput,
  permittedTiles,
  roleKpiTile,
  roleQueueTiles,
  rolesInLayout,
  sectionQueueTiles,
  sectionTiles,
  showsApprovalBox,
} from "../lib";
import { useRouteAvailable } from "./href";
import { HomeSkeleton } from "./home-skeleton";
import { KpiStrip } from "./kpi-strip";
import { QueueCard } from "./queue-card";
import { ReportLinks } from "./report-links";
import { SectionHeading } from "./section-heading";

export function ManagementHomePage({
  access,
  role,
  onRoleChange,
}: {
  access: AreaAccess;
  role: ManagementRole | null;
  onRoleChange: (role: ManagementRole) => void;
}) {
  const t = useT();
  const layout = useManagementLayout();
  const refresh = useRefreshManagementHome();
  const routeAvailable = useRouteAvailable();

  const data = layout.data;
  const visible = data ? permittedTiles(data.tiles, access.permissions) : [];
  const roles = rolesInLayout(visible);
  const activeRole =
    role !== null && roles.includes(role) ? role : defaultRole(visible);
  const kpiTile = activeRole === null ? null : roleKpiTile(visible, activeRole);
  const kpiInput = data && kpiTile ? kpiRunInput(kpiTile, data) : null;
  const kpiRun = useRoleKpiRun(kpiInput);

  if (layout.isPending) return <HomeSkeleton />;

  if (layout.isError) {
    const offline =
      layout.error instanceof ApiError && layout.error.code === "NETWORK_ERROR";
    return (
      <ErrorState
        title={offline ? t("managementHome.offlineTitle") : undefined}
        description={offline ? t("managementHome.offlineHint") : undefined}
        onRetry={() => {
          void layout.refetch();
        }}
      />
    );
  }

  const layoutData = data;
  if (!layoutData) return <HomeSkeleton />;

  const queueTiles =
    activeRole === null ? [] : roleQueueTiles(visible, activeRole);
  const approvals = sectionQueueTiles(visible, "approvals");
  const showApprovals = showsApprovalBox(queueTiles, approvals);
  const reportTiles = sectionTiles(visible, "reports");
  // Catalog/audit links only once their screens exist (no 404 links).
  const reportLinks = reportTiles.flatMap((tile) =>
    tile.kind === "link" && routeAvailable(tile.targetPath) ? [tile] : [],
  );
  const meta = [
    t("managementHome.businessDate", {
      date: formatBusinessDate(layoutData.businessDate),
    }),
    t("managementHome.outletCount", {
      count: layoutData.availableOutlets.length,
    }),
    t("managementHome.generatedAt", {
      time: formatClock(layoutData.generatedAt),
    }),
  ].join(" · ");

  const toolbar = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {/* A real API sends the caller's own role only: one role needs no switch. */}
      {activeRole !== null && roles.length > 1 && (
        <TabsList aria-label={t("managementHome.rolesLabel")}>
          {roles.map((candidate) => (
            <TabsTrigger key={candidate} value={candidate}>
              {t(ROLE_LABEL_KEYS[candidate])}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground tabular">
          <CalendarDays className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{meta}</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refresh();
          }}
          disabled={layout.isFetching}
        >
          <RefreshCw
            className={layout.isFetching ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          {t("managementHome.refresh")}
        </Button>
      </div>
    </div>
  );

  const workQueue = (
    <section aria-labelledby="work-queue-title" className="grid gap-4">
      <SectionHeading
        id="work-queue-title"
        title={t("managementHome.section.workQueue")}
        hint={
          activeRole === null
            ? t("managementHome.section.workQueueHint")
            : t(ROLE_HINT_KEYS[activeRole])
        }
      />
      {activeRole === null ? (
        <EmptyState
          icon={LayoutDashboard}
          title={t("managementHome.noRoles")}
          description={t("managementHome.noRolesHint")}
        />
      ) : (
        <>
          {kpiTile !== null && (
            <KpiStrip
              tile={kpiTile}
              layout={layoutData}
              run={kpiInput === null ? undefined : kpiRun.data}
              failed={kpiRun.isError && kpiRun.data === undefined}
              role={activeRole}
            />
          )}
          {queueTiles.length === 0 ? (
            <EmptyState
              title={t("managementHome.emptyWorkQueue")}
              description={t("managementHome.emptyWorkQueueHint")}
            />
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              {queueTiles.map((tile) => (
                <QueueCard key={tile.key} tile={tile} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {activeRole === null ? (
        <>
          {toolbar}
          {workQueue}
        </>
      ) : (
        <Tabs
          value={activeRole}
          onValueChange={(value) => onRoleChange(value as ManagementRole)}
        >
          {toolbar}
          <TabsContent value={activeRole} className="mt-5 pt-0">
            {workQueue}
          </TabsContent>
        </Tabs>
      )}

      {((approvals.length > 0 && showApprovals) || reportLinks.length > 0) && (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-5 lg:items-start",
            approvals.length > 0 && showApprovals && reportLinks.length > 0
              ? "lg:grid-cols-2"
              : "lg:grid-cols-1",
          )}
        >
          {approvals.length > 0 && showApprovals && (
            <section aria-labelledby="approvals-title" className="grid gap-3">
              <SectionHeading
                id="approvals-title"
                title={t("managementHome.section.approvals")}
              />
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                {approvals.map((tile) => (
                  <QueueCard key={tile.key} tile={tile} hideTitle />
                ))}
              </div>
            </section>
          )}
          {reportLinks.length > 0 && (
            <section aria-labelledby="reports-title" className="grid gap-3">
              <SectionHeading
                id="reports-title"
                title={t("managementHome.section.reports")}
                hint={t("managementHome.section.reportsHint")}
              />
              <ReportLinks tiles={reportLinks} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
