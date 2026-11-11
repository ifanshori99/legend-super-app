// Food-safety temperature log (PRD v1.7 §3 F41 "Log Keamanan Pangan", OPS-02).
// Scheduled checks per chiller/freezer, the "Perlu tindakan" strip first
// (DESIGN.md §5 Operations), an out-of-range reading that cannot be saved
// without a corrective action, and the history with who/when.
import * as React from "react";
import { cn } from "cn";
import { Thermometer, TriangleAlert } from "lucide-react";
import { businessDateOf } from "@starter/shared/core";
import type { Equipment, TemperatureLog } from "@starter/shared/operations";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import {
  useCreateTemperatureLog,
  useTemperatureEquipment,
  useTemperatureLogs,
} from "../hooks.ts";
import {
  formatClock,
  formatDateTime,
  formatTemperature,
  fromDateTimeLocalValue,
  normalizeReadingInput,
  personName,
  readingOutOfRange,
  shortId,
  formatThresholdRange,
  toDateTimeLocalValue,
} from "../logic.ts";
import { FOOD_SAFETY_LIST_LIMIT } from "../outlet.ts";
import { useMinuteClock } from "../use-minute-clock.ts";

function categoryLabel(t: ReturnType<typeof useT>, equipment: Equipment) {
  if (equipment.category === "chiller")
    return t("opsFoodSafety.temperature.category.chiller");
  if (equipment.category === "freezer")
    return t("opsFoodSafety.temperature.category.freezer");
  return t("opsFoodSafety.temperature.category.other");
}

function FoodSafetyTemperatureScreenContent() {
  const t = useT();
  const toast = useToast();
  const { clock } = useOutletClock();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const now = useMinuteClock();

  const equipmentResult = useTemperatureEquipment(outlet?.id, {
    limit: FOOD_SAFETY_LIST_LIMIT,
  });
  const logsResult = useTemperatureLogs(outlet?.id, {
    limit: FOOD_SAFETY_LIST_LIMIT,
  });
  const createLog = useCreateTemperatureLog();

  const equipment = React.useMemo(
    () =>
      [...(equipmentResult.data?.data ?? [])]
        .filter((row) => row.temperatureThreshold !== null)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [equipmentResult.data],
  );
  const logs = React.useMemo(
    () =>
      [...(logsResult.data?.data ?? [])].sort(
        (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
      ),
    [logsResult.data],
  );

  const today = businessDateOf(now, clock);
  const todayLogs = React.useMemo(
    () => logs.filter((log) => businessDateOf(log.recordedAt, clock) === today),
    [logs, clock, today],
  );
  const latestToday = React.useMemo(() => {
    const latest = new Map<string, TemperatureLog>();
    for (const log of todayLogs)
      if (!latest.has(log.equipmentId)) latest.set(log.equipmentId, log);
    return latest;
  }, [todayLogs]);
  const outOfRangeCount = todayLogs.filter((log) => !log.inRange).length;
  const uncheckedCount = equipment.filter(
    (row) => !latestToday.has(row.id),
  ).length;
  const allClear =
    equipment.length > 0 && outOfRangeCount === 0 && uncheckedCount === 0;

  const equipmentById = React.useMemo(() => {
    const map = new Map<string, Equipment>();
    for (const row of equipmentResult.data?.data ?? []) map.set(row.id, row);
    return map;
  }, [equipmentResult.data]);

  // Form state. The measurement time comes from the outlet wall clock in the
  // outlet's zone, never the device zone (D-CORE-6).
  const [equipmentId, setEquipmentId] = React.useState("");
  const [reading, setReading] = React.useState("");
  // The outlet wall clock, not the device clock, fills the measurement time.
  const [measuredAt, setMeasuredAt] = React.useState(() =>
    toDateTimeLocalValue(new Date(), clock.timeZone),
  );
  const [corrective, setCorrective] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();

  const selectedEquipment =
    equipment.find((row) => row.id === equipmentId) ?? null;
  const selectedThreshold = selectedEquipment?.temperatureThreshold ?? null;
  const outOfRange = readingOutOfRange(reading, selectedThreshold);

  function pickEquipment(row: Equipment) {
    setEquipmentId(row.id);
    setErrors((current) => ({ ...current, equipment: undefined }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    if (selectedEquipment === null)
      nextErrors.equipment = t(
        "opsFoodSafety.temperature.form.errors.equipment",
      );
    const normalizedReading = normalizeReadingInput(reading);
    if (normalizedReading === null)
      nextErrors.reading = t("opsFoodSafety.temperature.form.errors.reading");
    const recordedAt = fromDateTimeLocalValue(measuredAt, clock.timeZone);
    if (recordedAt === null)
      nextErrors.measuredAt = t(
        "opsFoodSafety.temperature.form.errors.measuredAt",
      );
    const requiresCorrective =
      selectedThreshold !== null &&
      normalizedReading !== null &&
      readingOutOfRange(normalizedReading, selectedThreshold) === true;
    const trimmedCorrective = corrective.trim();
    if (requiresCorrective && trimmedCorrective === "")
      nextErrors.corrective = t(
        "opsFoodSafety.temperature.form.errors.corrective",
      );

    setErrors(nextErrors);
    setFormError(undefined);
    if (Object.values(nextErrors).some(Boolean)) return;
    if (
      outlet === null ||
      selectedEquipment === null ||
      normalizedReading === null ||
      recordedAt === null
    )
      return;

    createLog.mutate(
      {
        outletId: outlet.id,
        equipmentId: selectedEquipment.id,
        readingCelsius: normalizedReading,
        recordedAt,
        correctiveAction: requiresCorrective ? trimmedCorrective : null,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          toast({
            title: t("opsFoodSafety.temperature.form.saved"),
            tone: "success",
          });
          setReading("");
          setCorrective("");
          setErrors({});
          setMeasuredAt(toDateTimeLocalValue(new Date(), clock.timeZone));
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const details: Record<string, string> = {};
            for (const detail of error.details ?? [])
              details[detail.field] ??= detail.message;
            setErrors({
              equipment: details["equipmentId"],
              reading: details["readingCelsius"],
              measuredAt: details["recordedAt"],
              corrective:
                error.code === "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED"
                  ? t("opsFoodSafety.temperature.form.errors.corrective")
                  : details["correctiveAction"],
            });
          }
          setFormError(t("opsFoodSafety.temperature.form.saveFailed"));
        },
      },
    );
  }

  const pending =
    outlet !== null && (equipmentResult.isPending || logsResult.isPending);
  const failed = equipmentResult.isError || logsResult.isError;
  const firstError = equipmentResult.error ?? logsResult.error;
  const offline =
    firstError instanceof ApiError && firstError.code === "NETWORK_ERROR";
  const retry = () => {
    void equipmentResult.refetch();
    void logsResult.refetch();
  };

  return (
    <div
      data-slot="food-safety-temperature"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4"
    >
      <header className="grid gap-1">
        <h1 className="type-display">{t("opsFoodSafety.temperature.title")}</h1>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("opsFoodSafety.temperature.subtitle")}
        </p>
      </header>

      {pending && (
        <Card aria-busy="true">
          <span className="sr-only">
            {t("opsFoodSafety.temperature.loading")}
          </span>
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </Card>
      )}

      {!pending && failed && (
        <Card>
          <ErrorState
            error={firstError}
            title={t("opsFoodSafety.temperature.errorTitle")}
            description={
              offline
                ? t("opsFoodSafety.temperature.offline")
                : t("opsFoodSafety.temperature.errorHint")
            }
            onRetry={retry}
          />
        </Card>
      )}

      {!pending && !failed && (
        <>
          <Card
            data-slot="temperature-action-strip"
            role="region"
            aria-label={t("opsFoodSafety.temperature.action.title")}
            className="gap-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="type-title">
                {t("opsFoodSafety.temperature.action.title")}
              </h2>
              {outOfRangeCount > 0 && (
                <StatusPill status="danger" solid>
                  {t("opsFoodSafety.temperature.action.outOfRange", {
                    count: outOfRangeCount,
                  })}
                </StatusPill>
              )}
              {uncheckedCount > 0 && (
                <Badge tone="warning">
                  <TriangleAlert aria-hidden="true" />
                  {t("opsFoodSafety.temperature.action.unchecked", {
                    count: uncheckedCount,
                  })}
                </Badge>
              )}
              {allClear && (
                <StatusPill status="success">
                  {t("opsFoodSafety.temperature.action.allClear")}
                </StatusPill>
              )}
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {allClear
                ? t("opsFoodSafety.temperature.action.allClearHint")
                : t("opsFoodSafety.temperature.action.hint")}
            </p>
          </Card>

          <Card
            data-slot="temperature-schedule"
            role="region"
            aria-label={t("opsFoodSafety.temperature.schedule.title")}
          >
            <CardHeader>
              <CardTitle>
                {t("opsFoodSafety.temperature.schedule.title")}
              </CardTitle>
              <CardDescription>
                {t("opsFoodSafety.temperature.schedule.hint")}
              </CardDescription>
            </CardHeader>
            {equipment.length === 0 ? (
              <EmptyState
                icon={Thermometer}
                title={t("opsFoodSafety.temperature.schedule.emptyTitle")}
                description={t("opsFoodSafety.temperature.schedule.emptyHint")}
              />
            ) : (
              <ul className="grid gap-2">
                {equipment.map((row) => {
                  const threshold = row.temperatureThreshold;
                  if (!threshold) return null;
                  const latest = latestToday.get(row.id) ?? null;
                  const range = formatThresholdRange(threshold);
                  return (
                    <li
                      key={row.id}
                      data-slot="temperature-equipment"
                      className="flex min-w-0 flex-col gap-3 rounded-container border-(length:--border-w) bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="grid min-w-0 gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{row.name}</span>
                          <Badge tone="neutral">{categoryLabel(t, row)}</Badge>
                          {latest ? (
                            <StatusPill
                              status={latest.inRange ? "success" : "danger"}
                              solid={!latest.inRange}
                            >
                              {latest.inRange
                                ? t("opsFoodSafety.temperature.history.inRange")
                                : t(
                                    "opsFoodSafety.temperature.history.outOfRange",
                                  )}
                            </StatusPill>
                          ) : (
                            <Badge tone="warning">
                              <TriangleAlert aria-hidden="true" />
                              {t(
                                "opsFoodSafety.temperature.schedule.unchecked",
                              )}
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular">
                          <span>
                            {t("opsFoodSafety.temperature.schedule.threshold", {
                              range,
                            })}
                          </span>
                          <span>
                            {t(
                              "opsFoodSafety.temperature.schedule.todayCount",
                              {
                                count: todayLogs.filter(
                                  (log) => log.equipmentId === row.id,
                                ).length,
                              },
                            )}
                          </span>
                          {latest && (
                            <span>
                              {t(
                                "opsFoodSafety.temperature.schedule.lastReading",
                                {
                                  value: formatTemperature(
                                    latest.readingCelsius,
                                  ),
                                  time: formatClock(
                                    latest.recordedAt,
                                    clock.timeZone,
                                  ),
                                },
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => pickEquipment(row)}
                      >
                        <Thermometer aria-hidden="true" />
                        {t("opsFoodSafety.temperature.schedule.record")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            data-slot="temperature-form"
            role="region"
            aria-label={t("opsFoodSafety.temperature.form.title")}
          >
            <CardHeader>
              <CardTitle>{t("opsFoodSafety.temperature.form.title")}</CardTitle>
              <CardDescription>
                {t("opsFoodSafety.temperature.form.hint")}
              </CardDescription>
            </CardHeader>
            <form className="grid gap-4" noValidate onSubmit={submit}>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <FormField
                  label={t("opsFoodSafety.temperature.form.equipment")}
                  id="food-safety-equipment"
                  required
                  error={errors.equipment}
                >
                  <Select
                    value={equipmentId}
                    onValueChange={(value) => {
                      setEquipmentId(value);
                      setErrors((current) => ({
                        ...current,
                        equipment: undefined,
                        corrective: undefined,
                      }));
                    }}
                  >
                    <SelectTrigger id="food-safety-equipment">
                      <SelectValue
                        placeholder={t(
                          "opsFoodSafety.temperature.form.equipmentPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {equipment.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  label={t("opsFoodSafety.temperature.form.measuredAt")}
                  required
                  error={errors.measuredAt}
                >
                  <Input
                    type="datetime-local"
                    value={measuredAt}
                    onChange={(event) => setMeasuredAt(event.target.value)}
                  />
                </FormField>
              </div>

              <FormField
                label={t("opsFoodSafety.temperature.form.reading")}
                hint={t("opsFoodSafety.temperature.form.readingHint")}
                required
                error={errors.reading}
              >
                <Input
                  inputMode="decimal"
                  autoComplete="off"
                  value={reading}
                  onChange={(event) => setReading(event.target.value)}
                />
              </FormField>

              {selectedThreshold && outOfRange !== null && (
                <p
                  aria-live="polite"
                  className={cn(
                    "text-sm leading-5 font-medium",
                    outOfRange ? "text-danger" : "text-success",
                  )}
                >
                  {t(
                    outOfRange
                      ? "opsFoodSafety.temperature.form.outOfRangeHint"
                      : "opsFoodSafety.temperature.form.inRangeHint",
                    {
                      range: formatThresholdRange(selectedThreshold),
                    },
                  )}
                </p>
              )}

              <FormField
                label={t("opsFoodSafety.temperature.form.corrective")}
                hint={
                  outOfRange === true
                    ? t("opsFoodSafety.temperature.form.correctiveHint")
                    : t("opsFoodSafety.temperature.form.correctiveNotNeeded")
                }
                required={outOfRange === true}
                error={errors.corrective}
              >
                <Textarea
                  rows={3}
                  maxLength={1000}
                  value={corrective}
                  onChange={(event) => setCorrective(event.target.value)}
                />
              </FormField>

              {formError && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {formError}
                </p>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  loading={createLog.isPending}
                  data-slot="temperature-save"
                >
                  {t("opsFoodSafety.temperature.form.save")}
                </Button>
              </div>
            </form>
          </Card>

          <Card
            data-slot="temperature-history"
            role="region"
            aria-label={t("opsFoodSafety.temperature.history.title")}
          >
            <CardHeader>
              <CardTitle>
                {t("opsFoodSafety.temperature.history.title")}
              </CardTitle>
              <CardDescription>
                {t("opsFoodSafety.temperature.history.hint")}
              </CardDescription>
            </CardHeader>
            {logs.length === 0 ? (
              <EmptyState
                icon={Thermometer}
                title={t("opsFoodSafety.temperature.history.emptyTitle")}
                description={t("opsFoodSafety.temperature.history.emptyHint")}
              />
            ) : (
              <ul className="grid gap-2">
                {logs.map((log) => {
                  const row = equipmentById.get(log.equipmentId);
                  const name =
                    row?.name ?? t("opsFoodSafety.common.unknownEquipment");
                  const nameOfPerson =
                    personName(log.recordedBy) ?? shortId(log.recordedBy);
                  return (
                    <li
                      key={log.id}
                      data-slot="temperature-log"
                      data-in-range={log.inRange ? "true" : "false"}
                      className={cn(
                        "relative min-w-0 overflow-hidden rounded-container border-(length:--border-w) bg-background p-3",
                        !log.inRange && "border-2 border-danger",
                      )}
                    >
                      {!log.inRange && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-0 start-0 w-1.5 bg-danger"
                        />
                      )}
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="text-lg leading-6 font-bold tabular">
                            {formatTemperature(log.readingCelsius)}{" "}
                            {t("opsFoodSafety.common.unitCelsius")}
                          </span>
                          <span className="truncate text-sm font-semibold">
                            {name}
                          </span>
                          <StatusPill
                            status={log.inRange ? "success" : "danger"}
                            solid={!log.inRange}
                          >
                            {log.inRange
                              ? t("opsFoodSafety.temperature.history.inRange")
                              : t(
                                  "opsFoodSafety.temperature.history.outOfRange",
                                )}
                          </StatusPill>
                        </div>
                        <span className="text-sm text-muted-foreground tabular">
                          {formatDateTime(log.recordedAt, clock.timeZone)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("opsFoodSafety.temperature.history.recordedBy", {
                          name: nameOfPerson,
                        })}
                      </p>
                      {!log.inRange && log.correctiveAction && (
                        <div className="mt-2 rounded-container bg-danger-subtle p-2.5">
                          <p className="type-eyebrow text-danger">
                            {t("opsFoodSafety.temperature.history.corrective")}
                          </p>
                          <p className="mt-0.5 text-sm leading-5">
                            {log.correctiveAction}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell resets the form and
 * selections, so nothing typed for the previous outlet carries over.
 */
export function FoodSafetyTemperatureScreen() {
  const { outlet } = useTenantContext();
  return <FoodSafetyTemperatureScreenContent key={outlet?.id ?? "none"} />;
}
