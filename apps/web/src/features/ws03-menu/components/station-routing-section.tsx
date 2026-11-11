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

  const outletsPending = outletsQuery.isPending;
  const allSettled = stationQueries.every((query) => !query.isPending);

  // The override lives in one outlet: open on that outlet when the item has
  // one, otherwise on the first outlet.
  const stationsByOutlet = outlets.map(
    (_, index) => stationQueries[index]?.data?.data ?? [],
  );
  const overrideIndex = stationsByOutlet.findIndex((rows) =>
    rows.some((row) => row.id === stationId),
  );
  // A saved override that no loaded outlet lists, while some outlet failed to
  // load: it may sit in a failed outlet, so it cannot be checked yet.
  const unresolved =
    allSettled && stationId !== NO_STATION && overrideIndex < 0;
  const firstErrorIndex = stationQueries.findIndex((query) => query.isError);
  const unchecked = unresolved && firstErrorIndex >= 0;
  const selectedIndex = (() => {
    const picked = outlets.findIndex((outlet) => outlet.id === pickedOutletId);
    if (picked >= 0) return picked;
    if (overrideIndex >= 0) return overrideIndex;
    return unchecked ? firstErrorIndex : 0;
  })();
  const outlet = outlets[selectedIndex];
  const selectedQuery = stationQueries[selectedIndex];
  // Only the selected outlet's stations gate the override list. Before the
  // user picks an outlet, a saved override may still sit in an outlet that has
  // not answered yet, so wait for all of them instead of showing the wrong
  // outlet first.
  const stationsPending =
    Boolean(selectedQuery?.isPending) ||
    (pickedOutletId === null &&
      stationId !== NO_STATION &&
      overrideIndex < 0 &&
      !allSettled);
  const stationsFailed = Boolean(selectedQuery?.isError);
  const stations = stationsByOutlet[selectedIndex] ?? [];
  const station = stations.find((row) => row.id === stationId);
  // A saved override that no loaded outlet lists (deleted or moved station):
  // keep it visible instead of silently showing "follow the type".
  const unavailable = unresolved && !unchecked;

  const typeLabel = (value: string) =>
    (STATION_TYPES as readonly string[]).includes(value)
      ? t(`menu.stations.types.${value as StationTypeValue}`)
      : undefined;

  const destination = station
    ? t("menu.editor.station.customStation", { name: station.name })
    : unchecked
      ? t("menu.editor.station.unchecked")
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

        {outletsPending ? (
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
        ) : outletsQuery.isError ? (
          <ErrorState
            title={t("menu.editor.station.loadErrorTitle")}
            description={t("menu.editor.station.loadErrorHint")}
            onRetry={() => void outletsQuery.refetch()}
          />
        ) : (
          <>
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

            {outlet ? (
              <div className="grid gap-4">
                <FormField label={t("menu.editor.station.outlet")}>
                  <Select
                    value={outlet.id}
                    // Switching outlet only changes which stations are listed;
                    // a saved override stays until another station is picked.
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

                {stationsPending ? (
                  <div
                    className="grid gap-3"
                    aria-busy="true"
                    aria-label={t("menu.editor.station.loading")}
                  >
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-11 w-4/5" />
                    <p className="text-sm leading-5 text-muted-foreground">
                      {t("menu.editor.station.loading")}
                    </p>
                  </div>
                ) : stationsFailed ? (
                  <>
                    <ErrorState
                      title={t("menu.editor.station.loadErrorTitle")}
                      description={t("menu.editor.station.loadErrorHint")}
                      onRetry={() => void selectedQuery?.refetch()}
                    />
                    {unchecked && (
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("menu.editor.station.unchecked")}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <FormField
                      label={t("menu.editor.station.override")}
                      hint={
                        stations.length === 0 && !unavailable
                          ? t("menu.editor.station.overrideEmpty")
                          : t("menu.editor.station.overrideScopeHint")
                      }
                    >
                      <Select
                        value={
                          station || unavailable || unchecked
                            ? stationId
                            : NO_STATION
                        }
                        // Pin the outlet so clearing or changing the override
                        // does not make the section jump to another outlet.
                        onValueChange={(value) => {
                          setPickedOutletId(outlet.id);
                          onChange({ stationId: value });
                        }}
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
                          {unchecked && (
                            <SelectItem value={stationId}>
                              {t("menu.editor.station.uncheckedItem")}
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
                        {t("menu.editor.station.destination", {
                          outlet: outlet.name,
                        })}
                      </strong>
                      <span className="text-sm leading-5">{destination}</span>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("menu.editor.station.noOutlets")}
              </p>
            )}
          </>
        )}
      </Card>
    </CardShell>
  );
}
