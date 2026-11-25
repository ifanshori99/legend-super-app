// /fasilitas — the tablet-first booth status board (bead legend-1oi9; PRD v1.7
// §3 F25 "Siklus Kebersihan", FAC-06). Four units grouped by area, the "Perlu
// tindakan" strip first (DESIGN.md §4: solid pill for the urgent count), then
// one tile per unit with its session/cleaning timing and the actions that move
// it through the contract's unit machine.
import * as React from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import {
  useCreateCleaningTask,
  useStaffFacility,
  useUnitBoard,
  useUpdateFacilityUnit,
} from "../hooks.ts";
import { areaName, boardCounts, groupRowsByArea } from "../view.ts";
import { MaintenanceDialog } from "./maintenance-dialog.tsx";
import {
  OfflineNotice,
  StaffEmpty,
  StaffError,
  StaffLoading,
  StaffPageHeader,
  StaffSubNav,
} from "./staff-chrome.tsx";
import { UnitTile } from "./unit-tile.tsx";
import { useOutletClock } from "@/lib/tenant-context";
import type { FacilityUnitBoardRow } from "@starter/shared/facility";

export function BoardScreen({ facilityId }: { facilityId?: string }) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const { facilities, facility, config } = useStaffFacility(facilityId, { releasedOnly: true });
  const board = useUnitBoard(facility?.id ?? null);
  const createCleaning = useCreateCleaningTask();
  const updateUnit = useUpdateFacilityUnit();
  const [maintenanceRow, setMaintenanceRow] =
    React.useState<FacilityUnitBoardRow | null>(null);
  const [maintenanceError, setMaintenanceError] = React.useState<string | null>(
    null,
  );

  const loading =
    facilities.isPending ||
    (facility !== null && (config.isPending || board.isPending));
  const failed = facilities.isError || config.isError || board.isError;

  const retry = () => {
    void facilities.refetch();
    void config.refetch();
    void board.refetch();
  };

  const rows = board.data?.rows ?? [];
  const serverTime = board.data?.serverTime;
  const counts = boardCounts(rows);
  const groups =
    config.data && rows.length > 0
      ? groupRowsByArea(rows, config.data.areas)
      : [];

  const busyFor = (unitId: string) =>
    (createCleaning.isPending && createCleaning.variables?.unitId === unitId) ||
    (updateUnit.isPending && updateUnit.variables?.unitId === unitId);

  const markCleaning = (row: FacilityUnitBoardRow) => {
    createCleaning.mutate(
      { unitId: row.unit.id },
      {
        onSuccess: () =>
          toast({
            title: t("facilityStaff.board.toast.cleaningRequested", {
              unit: row.unit.code,
            }),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityStaff.board.toast.failed"),
            description: error.message,
            tone: "danger",
          }),
      },
    );
  };

  const releaseMaintenance = (row: FacilityUnitBoardRow) => {
    updateUnit.mutate(
      { unitId: row.unit.id, body: { action: "release_maintenance" } },
      {
        onSuccess: () =>
          toast({
            title: t("facilityStaff.board.toast.maintenanceReleased", {
              unit: row.unit.code,
            }),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityStaff.board.toast.failed"),
            description: error.message,
            tone: "danger",
          }),
      },
    );
  };

  const confirmMaintenance = (note?: string) => {
    if (!maintenanceRow) return;
    updateUnit.mutate(
      {
        unitId: maintenanceRow.unit.id,
        body: { action: "flag_maintenance", note },
      },
      {
        onSuccess: () => {
          toast({
            title: t("facilityStaff.board.toast.maintenanceFlagged", {
              unit: maintenanceRow.unit.code,
            }),
            tone: "success",
          });
          setMaintenanceError(null);
          setMaintenanceRow(null);
        },
        onError: (error) => setMaintenanceError(error.message),
      },
    );
  };

  return (
    <div
      data-slot="facility-staff-screen"
      data-screen="board"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4"
    >
      <StaffPageHeader
        titleKey="facilityStaff.board.title"
        hintKey="facilityStaff.board.hint"
        facilityName={facility?.name}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void board.refetch()}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" />
            {t("facilityStaff.common.refresh")}
          </Button>
        }
      />

      <StaffSubNav current="board" facilityId={facility?.id} />
      <OfflineNotice />

      {loading && <StaffLoading labelKey="common.loading" />}

      {!loading && failed && (
        <StaffError
          titleKey="facilityStaff.board.error.title"
          hintKey="facilityStaff.board.error.hint"
          onRetry={retry}
          error={facilities.error ?? config.error ?? board.error}
        />
      )}

      {!loading && !failed && (!facility || rows.length === 0) && (
        <StaffEmpty
          titleKey="facilityStaff.board.empty.title"
          hintKey="facilityStaff.board.empty.hint"
          action={
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              {t("facilityStaff.common.refresh")}
            </Button>
          }
        />
      )}

      {!loading && !failed && facility && rows.length > 0 && (
        <>
          <Card
            data-slot="needs-action"
            role="region"
            aria-label={t("facilityStaff.board.needsAction.title")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="type-eyebrow">
                {t("facilityStaff.board.needsAction.title")}
              </h2>
              <StatusPill
                status="warning"
                solid={counts.urgent > 0}
                className="text-sm"
              >
                {t("facilityStaff.board.needsAction.urgent", {
                  count: counts.urgent,
                })}
              </StatusPill>
              <Badge tone="info">
                {t("facilityStaff.board.needsAction.cleaning", {
                  count: counts.cleaning,
                })}
              </Badge>
              <Badge tone="neutral">
                {t("facilityStaff.board.needsAction.maintenance", {
                  count: counts.maintenance,
                })}
              </Badge>
              <Badge tone="neutral">
                {t("facilityStaff.board.needsAction.inUse", {
                  count: counts.inUse,
                })}
              </Badge>
              <Badge tone="success">
                {t("facilityStaff.board.needsAction.available", {
                  count: counts.available,
                })}
              </Badge>
              <span className="ms-auto text-sm font-semibold tabular">
                {t("facilityStaff.board.needsAction.bookable", {
                  count: counts.available,
                })}
              </span>
            </div>
            {counts.urgent === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("facilityStaff.board.needsAction.calm")}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("facilityStaff.board.facRule")}
            </p>
          </Card>

          {serverTime && (
            <p className="text-sm text-muted-foreground tabular">
              {t("facilityStaff.board.updatedAt", {
                time: new Intl.DateTimeFormat("id-ID", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone,
                }).format(new Date(serverTime)),
              })}
            </p>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            {groups.map((group) => (
              <section
                key={group.area.id}
                aria-labelledby={`area-${group.area.id}`}
                className="grid content-start gap-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id={`area-${group.area.id}`} className="type-title">
                    {group.area.name}
                  </h2>
                  <span className="text-sm text-muted-foreground tabular">
                    {t("facilityStaff.board.areaCount", {
                      count: group.rows.length,
                    })}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {group.rows.map((row) => (
                    <UnitTile
                      key={row.unit.id}
                      row={row}
                      areaName={areaName(
                        config.data?.areas ?? [],
                        row.unit.areaId,
                      )}
                      facility={facility}
                      timeZone={timeZone}
                      serverTime={serverTime ?? new Date().toISOString()}
                      busy={busyFor(row.unit.id)}
                      onMarkCleaning={() => markCleaning(row)}
                      onFlagMaintenance={() => {
                        setMaintenanceError(null);
                        setMaintenanceRow(row);
                      }}
                      onReleaseMaintenance={() => releaseMaintenance(row)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      <MaintenanceDialog
        key={maintenanceRow?.unit.id ?? "closed"}
        unit={maintenanceRow ? maintenanceRow.unit : null}
        pending={updateUnit.isPending}
        error={maintenanceError}
        onClose={() => {
          setMaintenanceError(null);
          setMaintenanceRow(null);
        }}
        onConfirm={confirmMaintenance}
      />
    </div>
  );
}
