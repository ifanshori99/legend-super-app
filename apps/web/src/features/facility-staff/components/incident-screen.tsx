// /fasilitas/insiden — the incident log and the raise/respond actions (PRD v1.7
// §3 F25 "Keselamatan", FAC-08). A raise is recorded immediately (the emergency
// screen raises panic entries; this form covers assist/damage and a panic
// without a booth), and every acknowledgement carries the action taken plus the
// seconds it took, so the five-second target is visible.
import * as React from "react";
import { cn } from "cn";
import { RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  isPanicResponseOnTime,
  type FacilityIncident,
  type FacilityIncidentType,
} from "@starter/shared/facility";
import { newIdempotencyKey } from "@/lib/idempotency.ts";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useRaiseFacilityIncident,
  useIncidents,
  useStaffFacility,
} from "../hooks.ts";
import {
  INCIDENT_TYPE_KEYS,
  INCIDENT_TYPE_TONE,
  areaName,
  clock,
  responseSeconds,
  sortIncidentLog,
} from "../view.ts";
import { IncidentRespondDialog } from "./incident-respond-dialog.tsx";
import {
  OfflineNotice,
  StaffEmpty,
  StaffError,
  StaffPageHeader,
  StaffSubNav,
} from "./staff-chrome.tsx";

const NO_UNIT = "none";

const INCIDENT_TYPES: readonly FacilityIncidentType[] = [
  "panic",
  "assist",
  "damage",
];

export function IncidentScreen({ facilityId }: { facilityId?: string }) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const { facilities, facility, config } = useStaffFacility(facilityId, {
    releasedOnly: true,
  });
  const incidents = useIncidents(facility?.id ?? null);
  const raise = useRaiseFacilityIncident();
  const [type, setType] = React.useState<FacilityIncidentType>("assist");
  const [unitId, setUnitId] = React.useState(NO_UNIT);
  const [note, setNote] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [responding, setResponding] = React.useState<FacilityIncident | null>(
    null,
  );
  const unitFieldId = React.useId();
  // The key follows the form content: a retry of the same failed submit replays
  // it, an edited form is a new attempt and gets a fresh key.
  const attempt = React.useRef<{ signature: string; key: string } | null>(null);

  const loading =
    facilities.isPending ||
    (facility !== null && (config.isPending || incidents.isPending));
  const failed = facilities.isError || config.isError || incidents.isError;
  const retry = () => {
    void facilities.refetch();
    void config.refetch();
    void incidents.refetch();
  };

  const areas = config.data?.areas ?? [];
  const units = config.data?.units ?? [];
  const unitLabelOf = (incident: FacilityIncident) => {
    const unit = units.find((item) => item.id === incident.unitId);
    if (!unit) return t("facilityStaff.incident.unitNoneLong");
    return t("facilityStaff.cleaning.taskUnit", {
      unit: unit.code,
      area: areaName(areas, unit.areaId),
    });
  };
  const sorted = sortIncidentLog(incidents.data?.data ?? []);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const body = {
      type,
      unitId: unitId === NO_UNIT ? undefined : unitId,
      note: note.trim() || undefined,
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: newIdempotencyKey() };
    raise.mutate(
      { body, idempotencyKey: attempt.current.key },
      {
        onSuccess: () => {
          attempt.current = null;
          toast({
            title: t("facilityStaff.incident.created"),
            tone: "success",
          });
          setNote("");
          setUnitId(NO_UNIT);
          setType("assist");
        },
        onError: (error) => setFormError(error.message),
      },
    );
  };

  return (
    <div
      data-slot="facility-staff-screen"
      data-screen="incidents"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4"
    >
      <StaffPageHeader
        titleKey="facilityStaff.incident.title"
        hintKey="facilityStaff.incident.hint"
        facilityName={facility?.name}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void incidents.refetch()}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" />
            {t("facilityStaff.common.refresh")}
          </Button>
        }
      />

      <StaffSubNav current="incidents" facilityId={facility?.id} />
      <OfflineNotice />

      {loading && (
        <Card aria-busy="true" data-slot="facility-staff-loading">
          <span role="status" className="sr-only">
            {t("common.loading")}
          </span>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-32 w-full rounded-container" />
          <Skeleton className="h-32 w-full rounded-container" />
        </Card>
      )}

      {!loading && failed && (
        <StaffError
          titleKey="facilityStaff.incident.error.title"
          hintKey="facilityStaff.incident.error.hint"
          onRetry={retry}
          error={facilities.error ?? config.error ?? incidents.error}
        />
      )}

      {!loading && !failed && facility && (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Card
            data-slot="incident-form"
            role="region"
            aria-label={t("facilityStaff.incident.raiseTitle")}
          >
            <div className="grid gap-1">
              <h2 className="type-title">
                {t("facilityStaff.incident.raiseTitle")}
              </h2>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("facilityStaff.incident.raiseHint")}
              </p>
            </div>
            <form className="grid gap-3" onSubmit={submit}>
              <div className="grid gap-1.5">
                <span className="text-sm font-semibold">
                  {t("facilityStaff.incident.typeLabel")}
                </span>
                <SegmentedControl
                  label={t("facilityStaff.incident.typeLabel")}
                  selection="ink"
                  value={type}
                  onValueChange={(next) =>
                    setType(next as FacilityIncidentType)
                  }
                  options={INCIDENT_TYPES.map((value) => ({
                    value,
                    label: t(INCIDENT_TYPE_KEYS[value]),
                  }))}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor={unitFieldId}>
                  {t("facilityStaff.incident.unitLabel")}
                </Label>
                <Select value={unitId} onValueChange={setUnitId}>
                  <SelectTrigger id={unitFieldId}>
                    <SelectValue
                      placeholder={t("facilityStaff.incident.unitNone")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_UNIT}>
                      {t("facilityStaff.incident.unitNone")}
                    </SelectItem>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {t("facilityStaff.cleaning.taskUnit", {
                          unit: unit.code,
                          area: areaName(areas, unit.areaId),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <FormField label={t("facilityStaff.incident.noteLabel")}>
                <Textarea
                  value={note}
                  maxLength={500}
                  placeholder={t("facilityStaff.incident.notePlaceholder")}
                  onChange={(event) => setNote(event.target.value)}
                />
              </FormField>

              {formError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {formError}
                </p>
              )}

              <Button type="submit" loading={raise.isPending}>
                <ShieldAlert aria-hidden="true" />
                {t("facilityStaff.incident.submit")}
              </Button>
            </form>
          </Card>

          <section
            aria-labelledby="incident-log-heading"
            className="grid content-start gap-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="incident-log-heading" className="type-title">
                {t("facilityStaff.incident.listTitle")}
              </h2>
              <span className="text-sm text-muted-foreground tabular">
                {t("facilityStaff.incident.listHint", {
                  count: sorted.length,
                })}
              </span>
            </div>

            {sorted.length === 0 && (
              <Card>
                <EmptyState
                  icon={ShieldAlert}
                  title={t("facilityStaff.incident.empty.title")}
                  description={t("facilityStaff.incident.empty.hint")}
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/fasilitas/darurat"
                        search={{ facilityId: facility?.id }}
                      >
                        <ShieldAlert aria-hidden="true" />
                        {t("facilityStaff.common.openEmergency")}
                      </Link>
                    </Button>
                  }
                />
              </Card>
            )}

            {sorted.length > 0 && (
              <ul className="grid list-none gap-3 lg:grid-cols-2">
                {sorted.map((incident) => {
                  const open = incident.respondedAt === null;
                  const seconds = responseSeconds(incident);
                  const typeBadge = (
                    <Badge tone={INCIDENT_TYPE_TONE[incident.type]}>
                      {t(INCIDENT_TYPE_KEYS[incident.type])}
                    </Badge>
                  );
                  return (
                    <li key={incident.id}>
                      <Card
                        data-slot="facility-incident"
                        data-incident-id={incident.id}
                        data-incident-status={open ? "open" : "responded"}
                        data-incident-type={incident.type}
                        // Urgent (Q25): solid pill + 2px border + 6px start rule.
                        className={cn(
                          "h-full",
                          open && "border-2 border-s-[6px] border-danger",
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {typeBadge}
                            <StatusPill
                              status={open ? "danger" : "success"}
                              solid={open}
                              className="text-sm"
                            >
                              {t(
                                open
                                  ? "facilityStaff.incident.status.open"
                                  : "facilityStaff.incident.status.responded",
                              )}
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

                        <h3 className="type-title">{unitLabelOf(incident)}</h3>

                        <dl className="grid gap-1 text-sm">
                          {incident.respondedAt && (
                            <div className="flex flex-wrap gap-x-2">
                              <dt className="text-muted-foreground">
                                {t("facilityStaff.incident.respondedAt", {
                                  time: clock(incident.respondedAt, timeZone),
                                })}
                              </dt>
                              {seconds !== null && (
                                <dd className="font-semibold tabular">
                                  {t("facilityStaff.incident.responseSeconds", {
                                    seconds,
                                  })}
                                </dd>
                              )}
                            </div>
                          )}
                          {incident.type === "panic" &&
                            incident.respondedAt !== null && (
                              <div>
                                <Badge
                                  tone={
                                    isPanicResponseOnTime(incident)
                                      ? "success"
                                      : "danger"
                                  }
                                >
                                  {t(
                                    isPanicResponseOnTime(incident)
                                      ? "facilityStaff.incident.onTime"
                                      : "facilityStaff.incident.late",
                                  )}
                                </Badge>
                              </div>
                            )}
                          <div>
                            <dt className="text-muted-foreground">
                              {t("facilityStaff.incident.resolutionLabel")}
                            </dt>
                            <dd>
                              {incident.resolution ??
                                t("facilityStaff.incident.noResolution")}
                            </dd>
                          </div>
                        </dl>

                        {open && (
                          <div className="mt-auto">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setResponding(incident)}
                            >
                              {t("facilityStaff.incident.respondAction")}
                            </Button>
                          </div>
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {!loading && !failed && !facility && (
        <StaffEmpty
          titleKey="facilityStaff.board.empty.title"
          hintKey="facilityStaff.board.empty.hint"
          icon={ShieldAlert}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/fasilitas" search={{ facilityId }}>
                {t("facilityStaff.common.openBoard")}
              </Link>
            </Button>
          }
        />
      )}

      <IncidentRespondDialog
        key={responding?.id ?? "closed"}
        incident={responding}
        unitLabel={
          responding
            ? unitLabelOf(responding)
            : t("facilityStaff.incident.unitNoneLong")
        }
        onClose={() => setResponding(null)}
      />
    </div>
  );
}
