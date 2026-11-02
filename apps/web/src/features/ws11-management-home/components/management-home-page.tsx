// Management home per role (PRD v1.7 §3.36 "Dashboard Manajemen" → "Beranda
// per Role", bead legend-6na6). The page is a composition of the dashboard
// layout the API returns: the caller's work queue for the selected role, the
// shared approval box, and the report/audit shortcuts. It renders no number
// the layout does not define (DASH-01) and hides every tile whose extra
// permission the visitor lacks (RBAC §3.7, presentation only).
import { Building2, CalendarDays, Clock, LayoutDashboard, RefreshCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AreaAccess } from "@/lib/areas/access";
import { ApiError } from "@/lib/api/errors";
import type { ManagementRole } from "@starter/shared/dashboard";
import { formatBusinessDate, formatClock } from "../format";
import { useManagementLayout, useRefreshManagementLayout } from "../hooks";
import { ROLE_HINT_KEYS, ROLE_LABEL_KEYS } from "../labels";
import {
  defaultRole,
  permittedTiles,
  roleWorkTiles,
  rolesInLayout,
  sectionTiles,
} from "../lib";
import { LinkTileRow } from "./link-row";
import { TileCard } from "./tile-card";

function SectionHeading({
  id,
  title,
  hint,
}: {
  id: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <h3 id={id} className="text-base leading-6 font-semibold">
        {title}
      </h3>
      {hint && (
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function HomeSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="grid gap-1">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

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
  const refresh = useRefreshManagementLayout();

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

  const data = layout.data;
  const visible = permittedTiles(data.tiles, access.permissions);
  const roles = rolesInLayout(visible);
  const activeRole =
    role !== null && roles.includes(role) ? role : defaultRole(visible);
  const workTiles =
    activeRole === null ? [] : roleWorkTiles(visible, activeRole);
  const approvals = sectionTiles(visible, "approvals");
  const reports = sectionTiles(visible, "reports");

  return (
    <section aria-labelledby="management-home-title" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
          <h2
            id="management-home-title"
            className="text-xl leading-7 font-semibold tracking-tight"
          >
            {t("managementHome.title")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("managementHome.subtitle")}
          </p>
          <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm leading-5 text-muted-foreground">
            <li className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-4" aria-hidden="true" />
              <span className="tabular">
                {t("managementHome.businessDate", {
                  date: formatBusinessDate(data.businessDate),
                })}
              </span>
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Building2 className="size-4" aria-hidden="true" />
              <span className="tabular">
                {t("managementHome.outletCount", {
                  count: data.availableOutlets.length,
                })}
              </span>
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Clock className="size-4" aria-hidden="true" />
              <span className="tabular">
                {t("managementHome.generatedAt", {
                  time: formatClock(data.generatedAt),
                })}
              </span>
            </li>
          </ul>
        </div>
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
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-3 xl:items-start">
        <section
          aria-labelledby="management-work-queue-title"
          className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:col-span-2"
        >
          <SectionHeading
            id="management-work-queue-title"
            title={t("managementHome.section.workQueue")}
            hint={t("managementHome.section.workQueueHint")}
          />
          {activeRole === null ? (
            <EmptyState
              icon={LayoutDashboard}
              title={t("managementHome.noRoles")}
              description={t("managementHome.noRolesHint")}
            />
          ) : (
            <Tabs
              value={activeRole}
              onValueChange={(value) => onRoleChange(value as ManagementRole)}
            >
              <TabsList aria-label={t("managementHome.rolesLabel")}>
                {roles.map((candidate) => (
                  <TabsTrigger key={candidate} value={candidate}>
                    {t(ROLE_LABEL_KEYS[candidate])}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value={activeRole} className="grid grid-cols-[minmax(0,1fr)] gap-3">
                <p className="text-sm leading-5 text-muted-foreground">
                  {t(ROLE_HINT_KEYS[activeRole])}
                </p>
                {workTiles.length === 0 ? (
                  <EmptyState
                    title={t("managementHome.emptyWorkQueue")}
                    description={t("managementHome.emptyWorkQueueHint")}
                  />
                ) : (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                    {workTiles.map((tile) => (
                      <TileCard key={tile.key} tile={tile} />
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </section>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {approvals.length > 0 && (
            <section aria-labelledby="management-approvals-title" className="grid gap-3">
              <SectionHeading
                id="management-approvals-title"
                title={t("managementHome.section.approvals")}
              />
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                {approvals.map((tile) => (
                  <TileCard key={tile.key} tile={tile} hideTitle />
                ))}
              </div>
            </section>
          )}

          {reports.length > 0 && (
            <section aria-labelledby="management-reports-title" className="grid gap-3">
              <SectionHeading
                id="management-reports-title"
                title={t("managementHome.section.reports")}
                hint={t("managementHome.section.reportsHint")}
              />
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {reports.map((tile) =>
                  tile.kind === "link" ? (
                    <LinkTileRow key={tile.key} tile={tile} />
                  ) : (
                    <li key={tile.key}>
                      <TileCard tile={tile} />
                    </li>
                  ),
                )}
              </ul>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
