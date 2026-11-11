// Station routing of one menu item (legend-0frf): the brand-level station type
// every outlet resolves to its own station, plus an optional override station
// that applies only inside its own outlet (legend-s2dh).
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardShell } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletStations, useOutlets } from "../hooks";

export const STATION_TYPES = [
  "coffee_bar",
  "beverage_bar",
  "hot_kitchen",
  "cold_kitchen",
  "pastry",
] as const;

export type StationTypeValue = (typeof STATION_TYPES)[number];

/** Select value for "no override": Radix Select forbids an empty item value. */
export const NO_STATION = "none";

export function StationRoutingSection({
  stationType,
  stationId,
  typeError,
  onChange,
}: {
  /** "" while no type is chosen. */
  stationType: string;
  /** Override station id, or NO_STATION. */
  stationId: string;
  typeError?: string;
  onChange: (patch: { stationType?: string; stationId?: string }) => void;
}) {
  const t = useT();
  const outletsQuery = useOutlets({ limit: 100 });
  const outlets = React.useMemo(
    () => outletsQuery.data?.data ?? [],
    [outletsQuery.data],
  );
  const stationQueries = useOutletStations(outlets.map((outlet) => outlet.id));
  const [pickedOutletId, setPickedOutletId] = React.useState<string | null>(
    null,
  );

  const pending =
    outletsQuery.isPending || stationQueries.some((query) => query.isPending);
  const failed = outletsQuery.isError || stationQueries.some((q) => q.isError);

  // The override lives in one outlet: open on that outlet when the item has
  // one, otherwise on the first outlet.
  const stationsByOutlet = outlets.map(
    (_, index) => stationQueries[index]?.data?.data ?? [],
  );
  const overrideIndex = stationsByOutlet.findIndex((rows) =>
    rows.some((row) => row.id === stationId),
  );
  const selectedIndex = (() => {
    const picked = outlets.findIndex((outlet) => outlet.id === pickedOutletId);
    if (picked >= 0) return picked;
    return overrideIndex >= 0 ? overrideIndex : 0;
  })();
  const outlet = outlets[selectedIndex];
  const stations = stationsByOutlet[selectedIndex] ?? [];
  const station = stations.find((row) => row.id === stationId);
  // A saved override that no loaded outlet lists (deleted or moved station):
  // keep it visible instead of silently showing "follow the type".
  const unavailable =
    !pending && !failed && stationId !== NO_STATION && overrideIndex < 0;

  const typeLabel = (value: string) =>
    (STATION_TYPES as readonly string[]).includes(value)
      ? t(`menu.stations.types.${value as StationTypeValue}`)
      : undefined;

  const destination = station
    ? t("menu.editor.station.customStation", { name: station.name })
    : unavailable
      ? t("menu.editor.station.customStation", {
          name: t("menu.editor.station.unavailable"),
        })
      : stationType && typeLabel(stationType)
        ? t("menu.editor.station.followsType", {
            type: typeLabel(stationType) ?? "",
          })
        : t("menu.editor.station.followsNone");

  return (
    <CardShell>
      <Card className="gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="type-title">{t("menu.editor.station.title")}</h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("menu.editor.station.description")}
            </p>
          </div>
          <Badge tone="neutral">{t("menu.editor.station.brandBadge")}</Badge>
        </div>

        <FormField
          label={t("menu.editor.station.typeLabel")}
          hint={t("menu.editor.station.typeHint")}
          error={typeError}
          required
        >
          <Select
            value={stationType}
            onValueChange={(value) => onChange({ stationType: value })}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={t("menu.editor.station.typePlaceholder")}
              />
            </SelectTrigger>
            <SelectContent>
              {STATION_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`menu.stations.types.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <div className="grid gap-1 border-t pt-4">
          <h3 className="type-title">
            {t("menu.editor.station.overrideTitle")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("menu.editor.station.overrideHint")}
          </p>
        </div>

        {pending ? (
          <div
            className="grid gap-3"
            aria-busy="true"
            aria-label={t("menu.editor.station.loading")}
          >
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-11 w-4/5" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-11 w-4/5" />
            <p className="text-sm leading-5 text-muted-foreground">
              {t("menu.editor.station.loading")}
            </p>
          </div>
        ) : failed ? (
          <ErrorState
            title={t("menu.editor.station.loadErrorTitle")}
            description={t("menu.editor.station.loadErrorHint")}
            onRetry={() => {
              void outletsQuery.refetch();
              stationQueries.forEach((query) => void query.refetch());
            }}
          />
        ) : outlet ? (
          <div className="grid gap-4">
            <FormField label={t("menu.editor.station.outlet")}>
              <Select
                value={outlet.id}
                // Switching outlet only changes which stations are listed; a
                // saved override stays until another station is picked.
                onValueChange={setPickedOutletId}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {outlets.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("menu.editor.station.override")}
              hint={
                stations.length === 0 && !unavailable
                  ? t("menu.editor.station.overrideEmpty")
                  : t("menu.editor.station.overrideScopeHint")
              }
            >
              <Select
                value={station || unavailable ? stationId : NO_STATION}
                onValueChange={(value) => onChange({ stationId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_STATION}>
                    {t("menu.editor.station.useType")}
                  </SelectItem>
                  {unavailable && (
                    <SelectItem value={stationId}>
                      {t("menu.editor.station.unavailable")}
                    </SelectItem>
                  )}
                  {stations.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div
              className="grid gap-0.5 rounded-control bg-shell px-4 py-3"
              aria-live="polite"
            >
              <strong className="text-sm font-semibold">
                {t("menu.editor.station.destination", { outlet: outlet.name })}
              </strong>
              <span className="text-sm leading-5">{destination}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("menu.editor.station.noOutlets")}
          </p>
        )}
      </Card>
    </CardShell>
  );
}
