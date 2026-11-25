// /fasilitas/darurat — the emergency alert screen (PRD v1.7 §3 F25
// "Keselamatan", FAC-08). One big "Darurat" per booth raises a panic incident;
// the signals list shows elapsed seconds and a one-press Tangani, and the
// acknowledgement (who reached the booth, how many seconds it took) stays
// visible because it is also the incident log entry.
import { useRef } from "react";
import { RefreshCw, ShieldAlert, Siren, WifiOff } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type {
  FacilityIncident,
  FacilityUnitBoardRow,
} from "@starter/shared/facility";
import { newIdempotencyKey } from "@/lib/idempotency.ts";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useIncidents,
  useRaiseFacilityIncident,
  useRespondFacilityIncident,
  useStaffFacility,
  useUnitBoard,
} from "../hooks.ts";
import {
  INCIDENT_TYPE_KEYS,
  areaName,
  clock,
  isEmergencySignal,
  responseSeconds,
  sortActiveAlerts,
  useElapsedSeconds,
} from "../view.ts";
import { boardFacility } from "../staff-facility.ts";
import {
  OfflineNotice,
  StaffEmpty,
  StaffError,
  StaffPageHeader,
  StaffSubNav,
} from "./staff-chrome.tsx";

function unitOf(
  incident: FacilityIncident,
  rows: readonly FacilityUnitBoardRow[],
  areas: Parameters<typeof areaName>[0],
): { code: string | null; areaLabel: string } {
  const row = rows.find((candidate) => candidate.unit.id === incident.unitId);
  if (!row) return { code: null, areaLabel: "" };
  return {
    code: row.unit.code,
    areaLabel: areaName(areas, row.unit.areaId),
  };
}

function ActiveAlertCard({
  incident,
  unitCode,
  areaLabel,
  serverTime,
  timeZone,
  pending,
  onRespond,
}: {
  incident: FacilityIncident;
  unitCode: string | null;
  areaLabel: string;
  serverTime: string;
  timeZone: string;
  pending: boolean;
  onRespond: () => void;
}) {
  const t = useT();
  const elapsed = useElapsedSeconds(incident.triggeredAt, serverTime);
  const label = unitCode
    ? t("facilityStaff.cleaning.taskUnit", {
        unit: unitCode,
        area: areaLabel,
      })
    : t("facilityStaff.incident.unitNoneLong");
  return (
    <li>
      <Card
        data-slot="emergency-alert"
        data-incident-id={incident.id}
        data-unit-code={unitCode ?? "none"}
        className="h-full border-2 border-s-[6px] border-danger"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill
              status={
                incident.type === "panic"
                  ? "danger"
                  : incident.type === "damage"
                    ? "warning"
                    : "info"
              }
              solid={incident.type === "panic"}
              className="text-sm"
            >
              {t(INCIDENT_TYPE_KEYS[incident.type])}
            </StatusPill>
            {incident.offline && (
              <Badge tone="warning">
                <WifiOff aria-hidden="true" />
                {t("facilityStaff.incident.offline")}
              </Badge>
            )}
          </div>
          <span className="text-sm text-muted-foreground tabular">
            {t("facilityStaff.incident.raisedAt", {
              time: clock(incident.triggeredAt, timeZone),
            })}
          </span>
        </div>

        <h3 className="type-title tabular">{label}</h3>

        <p className="text-xl font-bold tabular" aria-live="off">
          {t("facilityStaff.emergency.elapsedLabel", { seconds: elapsed })}
        </p>

        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="mt-auto w-full"
          loading={pending}
          aria-label={t("facilityStaff.emergency.respondAria", {
            unit: unitCode ?? t("facilityStaff.incident.unitNoneLong"),
          })}
          onClick={onRespond}
        >
          {t("facilityStaff.emergency.respond")}
        </Button>
      </Card>
    </li>
  );
}

export function EmergencyScreen({ facilityId }: { facilityId?: string }) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const { facilities, facility, config } = useStaffFacility(facilityId);
  // 1269 F0: the board and incident links never lead to a deferred shower.
  const list = facilities.data?.data ?? [];
  const boardTarget = boardFacility(list, facility);
  const boardsOpen = list.length === 0 || boardTarget !== null;
  const board = useUnitBoard(facility?.id ?? null);
  const incidents = useIncidents(facility?.id ?? null);
  const raise = useRaiseFacilityIncident();
  const respond = useRespondFacilityIncident();
  // One key per booth until its raise succeeds: a failed press that is pressed
  // again replays the same key instead of risking a second incident.
  const raiseKeys = useRef(new Map<string, string>());

  const loading =
    facilities.isPending ||
    (facility !== null &&
      (config.isPending || board.isPending || incidents.isPending));
  const failed =
    facilities.isError || config.isError || board.isError || incidents.isError;
  const retry = () => {
    void facilities.refetch();
    void config.refetch();
    void board.refetch();
    void incidents.refetch();
  };

  const rows = board.data?.rows ?? [];
  const serverTime = board.data?.serverTime;
  const areas = config.data?.areas ?? [];
  // Damage reports live in the incident log only (see isEmergencySignal).
  const all = (incidents.data?.data ?? []).filter(isEmergencySignal);
  const active = sortActiveAlerts(all);
  const responded = all
    .filter((incident) => incident.respondedAt !== null)
    .sort(
      (a, b) =>
        Date.parse(b.respondedAt ?? "") - Date.parse(a.respondedAt ?? ""),
    );

  const raisePanic = (row: FacilityUnitBoardRow) => {
    const unitId = row.unit.id;
    const idempotencyKey = raiseKeys.current.get(unitId) ?? newIdempotencyKey();
    raiseKeys.current.set(unitId, idempotencyKey);
    raise.mutate(
      { body: { type: "panic", unitId }, idempotencyKey },
      {
        onSuccess: () => {
          raiseKeys.current.delete(unitId);
          toast({
            title: t("facilityStaff.emergency.raised", {
              unit: row.unit.code,
            }),
            tone: "success",
          });
        },
        onError: (error) =>
          toast({
            title: t("facilityStaff.emergency.raiseFailed"),
            description: error.message,
            tone: "danger",
          }),
      },
    );
  };

  const acknowledge = (incident: FacilityIncident) => {
    const unit = unitOf(incident, rows, areas);
    respond.mutate(
      {
        incidentId: incident.id,
        body: { resolution: t("facilityStaff.emergency.defaultResolution") },
      },
      {
        onSuccess: (updated) =>
          toast({
            title: t("facilityStaff.emergency.respondDone", {
              unit: unit.code ?? t("facilityStaff.incident.unitNoneLong"),
              seconds: responseSeconds(updated) ?? 0,
            }),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityStaff.emergency.respondFailed"),
            description: error.message,
            tone: "danger",
          }),
      },
    );
  };

  return (
    <div
      data-slot="facility-staff-screen"
      data-screen="emergency"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4"
    >
      <StaffPageHeader
        titleKey="facilityStaff.emergency.title"
        hintKey="facilityStaff.emergency.hint"
        facilityName={facility?.name}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void board.refetch();
              void incidents.refetch();
            }}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" />
            {t("facilityStaff.common.refresh")}
          </Button>
        }
      />

      <StaffSubNav
        current="emergency"
        facilityId={facility?.id}
        boardFacilityId={boardTarget?.id}
        boardsOpen={boardsOpen}
      />
      <OfflineNotice hintKey="facilityStaff.emergency.offlineHint" />

      {loading && (
        <Card aria-busy="true" data-slot="facility-staff-loading">
          <span role="status" className="sr-only">
            {t("common.loading")}
          </span>
          <Skeleton className="h-24 w-full rounded-container" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-container" />
            ))}
          </div>
        </Card>
      )}

      {!loading && failed && (
        <StaffError
          titleKey="facilityStaff.emergency.error.title"
          hintKey="facilityStaff.emergency.error.hint"
          onRetry={retry}
          error={
            facilities.error ?? config.error ?? board.error ?? incidents.error
          }
        />
      )}

      {!loading && !failed && !facility && (
        <StaffEmpty
          titleKey="facilityStaff.emergency.empty.title"
          hintKey="facilityStaff.emergency.empty.hint"
          icon={ShieldAlert}
          action={
            boardsOpen && (
              <Button asChild variant="outline" size="sm">
                <Link to="/fasilitas" search={{ facilityId: boardTarget?.id }}>
                  {t("facilityStaff.common.openBoard")}
                </Link>
              </Button>
            )
          }
        />
      )}

      {!loading && !failed && facility && rows.length === 0 && (
        <StaffEmpty
          titleKey="facilityStaff.emergency.empty.title"
          hintKey="facilityStaff.emergency.empty.hint"
          icon={ShieldAlert}
          action={
            boardsOpen && (
              <Button asChild variant="outline" size="sm">
                <Link to="/fasilitas" search={{ facilityId: boardTarget?.id }}>
                  {t("facilityStaff.common.openBoard")}
                </Link>
              </Button>
            )
          }
        />
      )}

      {!loading && !failed && facility && rows.length > 0 && serverTime && (
        <>
          {active.length > 0 ? (
            <Card
              data-slot="emergency-alarm"
              role="alert"
              className="border-2 border-danger bg-danger text-danger-foreground"
            >
              <div className="flex items-start gap-3">
                <Siren className="mt-0.5 size-8 shrink-0" aria-hidden="true" />
                <div className="grid gap-1">
                  <h2 className="type-title">
                    {t("facilityStaff.emergency.alarmTitle")}
                  </h2>
                  <p className="text-xl font-bold tabular">
                    {t("facilityStaff.emergency.alarmCount", {
                      count: active.length,
                    })}
                  </p>
                  <p className="text-sm font-medium">
                    {t("facilityStaff.emergency.alarmHint")}
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            <Card
              data-slot="emergency-calm"
              className="border-success border-(length:--border-w) bg-success-subtle"
            >
              <div className="flex items-start gap-3">
                <ShieldAlert
                  className="mt-0.5 size-6 shrink-0 text-success"
                  aria-hidden="true"
                />
                <div className="grid gap-1">
                  <h2 className="type-title">
                    {t("facilityStaff.emergency.calmTitle")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("facilityStaff.emergency.calmHint")}
                  </p>
                </div>
              </div>
            </Card>
          )}

          <section
            aria-labelledby="emergency-units-heading"
            className="grid gap-3"
          >
            <div className="grid gap-0.5">
              <h2 id="emergency-units-heading" className="type-title">
                {t("facilityStaff.emergency.unitsTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("facilityStaff.emergency.unitsHint")}
              </p>
            </div>
            <ul className="grid list-none grid-cols-2 gap-3 lg:grid-cols-4">
              {rows
                .slice()
                .sort((a, b) => a.unit.sortOrder - b.unit.sortOrder)
                .map((row) => (
                  <li key={row.unit.id}>
                    {/* Outline in the danger colour: solid red stays reserved
                        for the live alarm and its Tangani action (Q25). */}
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      data-slot="emergency-unit-button"
                      data-unit-code={row.unit.code}
                      aria-label={t("facilityStaff.emergency.raiseAria", {
                        unit: row.unit.code,
                        area: areaName(areas, row.unit.areaId),
                      })}
                      loading={
                        raise.isPending &&
                        raise.variables?.body.unitId === row.unit.id
                      }
                      className="h-auto min-h-28 w-full flex-col gap-1 border-danger py-4 text-danger hover:bg-danger-subtle"
                      onClick={() => raisePanic(row)}
                    >
                      <Siren className="size-7" aria-hidden="true" />
                      <span className="type-title">
                        {t("facilityStaff.emergency.raise")}
                      </span>
                      <span className="text-sm font-semibold tabular">
                        {row.unit.code}
                        <span aria-hidden="true"> · </span>
                        {areaName(areas, row.unit.areaId)}
                      </span>
                    </Button>
                  </li>
                ))}
            </ul>
          </section>

          <section
            aria-labelledby="emergency-alerts-heading"
            className="grid gap-3"
          >
            <div className="grid gap-0.5">
              <h2 id="emergency-alerts-heading" className="type-title">
                {t("facilityStaff.emergency.alertsTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("facilityStaff.emergency.alertsHint")}
              </p>
            </div>
            {active.length === 0 ? (
              <Card>
                <p className="text-sm text-muted-foreground">
                  {t("facilityStaff.emergency.noAlerts")}
                </p>
              </Card>
            ) : (
              <ul className="grid list-none gap-3 lg:grid-cols-2">
                {active.map((incident) => {
                  const unit = unitOf(incident, rows, areas);
                  return (
                    <ActiveAlertCard
                      key={incident.id}
                      incident={incident}
                      unitCode={unit.code}
                      areaLabel={unit.areaLabel}
                      serverTime={serverTime}
                      timeZone={timeZone}
                      pending={
                        respond.isPending &&
                        respond.variables?.incidentId === incident.id
                      }
                      onRespond={() => acknowledge(incident)}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="emergency-ack-heading"
            className="grid gap-3"
          >
            <div className="grid gap-0.5">
              <h2 id="emergency-ack-heading" className="type-title">
                {t("facilityStaff.emergency.respondedTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("facilityStaff.emergency.respondedHint")}
              </p>
            </div>
            {responded.length === 0 ? (
              <Card>
                <p className="text-sm text-muted-foreground">
                  {t("facilityStaff.emergency.noAlerts")}
                </p>
              </Card>
            ) : (
              <ul className="grid list-none gap-3 lg:grid-cols-2">
                {responded.map((incident) => {
                  const unit = unitOf(incident, rows, areas);
                  const seconds = responseSeconds(incident);
                  return (
                    <li key={incident.id}>
                      <Card
                        data-slot="emergency-ack"
                        data-incident-id={incident.id}
                        data-unit-code={unit.code ?? "none"}
                        className="h-full"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill status="success" className="text-sm">
                              {t("facilityStaff.incident.status.responded")}
                            </StatusPill>
                            {seconds !== null && (
                              <Badge tone="success">
                                {t("facilityStaff.incident.responseSeconds", {
                                  seconds,
                                })}
                              </Badge>
                            )}
                          </div>
                          <span className="text-sm text-muted-foreground tabular">
                            {t("facilityStaff.incident.respondedAt", {
                              time: clock(incident.respondedAt ?? "", timeZone),
                            })}
                          </span>
                        </div>
                        <h3 className="type-title tabular">
                          {unit.code
                            ? t("facilityStaff.cleaning.taskUnit", {
                                unit: unit.code,
                                area: unit.areaLabel,
                              })
                            : t("facilityStaff.incident.unitNoneLong")}
                        </h3>
                        <p className="text-sm">
                          {incident.resolution ??
                            t("facilityStaff.incident.noResolution")}
                        </p>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Card data-slot="emergency-log-note">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <h2 className="type-title">
                  {t("facilityStaff.emergency.logTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("facilityStaff.emergency.logHint")}
                </p>
              </div>
              {boardsOpen && (
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/fasilitas/insiden"
                    search={{ facilityId: boardTarget?.id }}
                  >
                    <ShieldAlert aria-hidden="true" />
                    {t("facilityStaff.common.openIncidents")}
                  </Link>
                </Button>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
