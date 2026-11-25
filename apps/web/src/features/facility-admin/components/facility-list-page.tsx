// /kelola/fasilitas — the facility configuration index (PRD v1.7 §3 F25
// "Model Generik"). One StatStrip for the metrics (DESIGN.md v3 §5
// management), then the DataTableShell list; each row opens the config editor.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
} from "lucide-react";
import { isFacilityTypeReleased } from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import { useFacilities } from "../hooks.ts";
import {
  facilityStatusKey,
  facilityTypeLabel,
  LIST_PAGE_LIMIT,
  summarizeOperatingHours,
} from "../lib.ts";

export function FacilityListPage() {
  const t = useT();
  const { outlet } = useTenantContext();
  const [search, setSearch] = React.useState("");

  const listQuery = useFacilities({ limit: LIST_PAGE_LIMIT });
  // 1269 F0: shower rooms stay out of the list while the shower is deferred.
  const facilities = (listQuery.data?.data ?? []).filter((facility) =>
    isFacilityTypeReleased(facility.type),
  );

  const loading = listQuery.isPending;
  const failed = listQuery.isError;
  const empty = !loading && !failed && facilities.length === 0;
  const state: DataState = loading
    ? "loading"
    : failed
      ? "error"
      : empty
        ? "empty"
        : "ready";

  const offline =
    listQuery.error instanceof ApiError &&
    listQuery.error.code === "NETWORK_ERROR";

  const needle = search.trim().toLocaleLowerCase("id-ID");
  const filtered = facilities.filter((facility) =>
    facility.name.toLocaleLowerCase("id-ID").includes(needle),
  );

  const totals = facilities.reduce(
    (sum, facility) => ({
      areas: sum.areas + facility.areaCount,
      units: sum.units + facility.unitCount,
      activeUnits: sum.activeUnits + facility.activeUnitCount,
    }),
    { areas: 0, units: 0, activeUnits: 0 },
  );

  const outletContext = outlet?.name ?? t("facilityAdmin.list.statContext");

  function retry() {
    void listQuery.refetch();
  }

  return (
    <div data-slot="facility-admin-list" className="grid min-w-0 gap-5">
      {loading ? (
        <div
          aria-busy="true"
          data-slot="facility-stat-skeleton"
          className="grid gap-(--border-w) overflow-hidden rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
        >
          <span className="sr-only">{t("common.loading")}</span>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 rounded-container" />
          ))}
        </div>
      ) : (
        !failed && (
          <StatStrip label={t("facilityAdmin.list.statLabel")} columns={4}>
            <StatTile
              label={t("facilityAdmin.list.statFacilities")}
              value={<NumberDisplay value={facilities.length} size="stat" />}
              context={outletContext}
            />
            <StatTile
              label={t("facilityAdmin.list.statAreas")}
              value={<NumberDisplay value={totals.areas} size="stat" />}
              context={outletContext}
            />
            <StatTile
              label={t("facilityAdmin.list.statUnits")}
              value={<NumberDisplay value={totals.units} size="stat" />}
              context={outletContext}
            />
            <StatTile
              label={t("facilityAdmin.list.statActiveUnits")}
              value={<NumberDisplay value={totals.activeUnits} size="stat" />}
              context={outletContext}
            />
          </StatStrip>
        )
      )}

      {failed ? (
        <CardShell>
          <CardShellBody>
            <ErrorState
              title={
                offline
                  ? t("facilityAdmin.list.offlineTitle")
                  : t("facilityAdmin.list.loadError")
              }
              description={
                offline
                  ? t("facilityAdmin.list.offlineHint")
                  : t("facilityAdmin.list.loadErrorHint")
              }
              onRetry={retry}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <DataTableShell
          title={t("facilityAdmin.list.title")}
          description={t("facilityAdmin.list.subtitle")}
          state={state}
          onRetry={retry}
          search={{
            value: search,
            onChange: setSearch,
            label: t("facilityAdmin.list.searchLabel"),
          }}
          noResults={state === "ready" && filtered.length === 0}
          rowCount={state === "ready" ? filtered.length : undefined}
          empty={{
            title: t("facilityAdmin.list.emptyTitle"),
            description: t("facilityAdmin.list.emptyHint"),
          }}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("facilityAdmin.list.columnsName")}</TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.list.columnsAreas")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.list.columnsUnits")}
                </TableHead>
                <TableHead>{t("facilityAdmin.list.columnsSession")}</TableHead>
                <TableHead>{t("facilityAdmin.list.columnsHours")}</TableHead>
                <TableHead>{t("facilityAdmin.list.columnsStatus")}</TableHead>
                <TableHead className="text-right">
                  {t("facilityAdmin.list.columnsActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((facility) => {
                const units = {
                  total: facility.unitCount,
                  active: facility.activeUnitCount,
                };
                const statusKey = facilityStatusKey(units);
                const statusTone =
                  units.total === 0
                    ? "neutral"
                    : units.active > 0
                      ? "success"
                      : "neutral";
                const StatusIcon =
                  units.total === 0
                    ? CircleDashed
                    : units.active > 0
                      ? CircleCheck
                      : CircleSlash;
                const hours = summarizeOperatingHours(
                  facility.operatingHours,
                  t,
                );
                return (
                  <TableRow
                    key={facility.id}
                    data-slot="facility-row"
                    data-facility-id={facility.id}
                  >
                    <TableCell>
                      <div className="grid gap-1">
                        <span className="font-medium">{facility.name}</span>
                        <Badge tone="neutral" className="w-fit">
                          {t(facilityTypeLabel[facility.type])}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell numeric>{facility.areaCount}</TableCell>
                    <TableCell numeric>{units.total}</TableCell>
                    <TableCell>
                      {t("facilityAdmin.list.sessionSummary", {
                        session: facility.sessionMinutes,
                        cleaning: facility.cleaningMinutes,
                      })}
                    </TableCell>
                    <TableCell>
                      {hours.length === 0 ? (
                        t("facilityAdmin.common.notSet")
                      ) : (
                        <div className="grid gap-0.5">
                          {hours.map((line, index) => (
                            <span key={index}>{line}</span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={statusTone}>
                        <StatusIcon aria-hidden="true" />
                        {t(statusKey)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          data-slot="facility-open"
                        >
                          <Link
                            to="/kelola/fasilitas/$facilityId"
                            params={{ facilityId: facility.id }}
                          >
                            {t("facilityAdmin.list.openConfig")}
                            <ArrowRight aria-hidden="true" />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DataTableShell>
      )}
    </div>
  );
}
