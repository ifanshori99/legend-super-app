// Kitchen station config and pacing (PRD §3 F12 "KDS per Stasiun" and "Order
// Pacing"). One card per station: its KDS tab config, target time, current
// pacing and every capacity window; the dialog replaces the station's rules.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  CapacityLevel,
  CapacityRule,
  CapacityRuleInput,
  StationConfig,
} from "@starter/shared/kitchen";
import type { Station } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import {
  useCapacityRules,
  useKitchenStations,
  useMenuStations,
  usePacing,
  useUpdateCapacityRules,
} from "../hooks.ts";
import { DAY_NUMBERS } from "../lib.ts";
import { CapacityRuleEditor } from "./capacity-rule-dialog.tsx";

const STATUS: Record<
  CapacityLevel,
  {
    status: "onTrack" | "near" | "late";
    labelKey:
      | "kitchenConfig.capacity.status.available"
      | "kitchenConfig.capacity.status.near_capacity"
      | "kitchenConfig.capacity.status.at_capacity";
  }
> = {
  available: {
    status: "onTrack",
    labelKey: "kitchenConfig.capacity.status.available",
  },
  near_capacity: {
    status: "near",
    labelKey: "kitchenConfig.capacity.status.near_capacity",
  },
  at_capacity: {
    status: "late",
    labelKey: "kitchenConfig.capacity.status.at_capacity",
  },
};

const DAY_SHORT: Record<number, MessageKey> = {
  0: "kitchenConfig.capacity.dialog.dayShort.0",
  1: "kitchenConfig.capacity.dialog.dayShort.1",
  2: "kitchenConfig.capacity.dialog.dayShort.2",
  3: "kitchenConfig.capacity.dialog.dayShort.3",
  4: "kitchenConfig.capacity.dialog.dayShort.4",
  5: "kitchenConfig.capacity.dialog.dayShort.5",
  6: "kitchenConfig.capacity.dialog.dayShort.6",
};

function CapacityStatus({ level }: { level: CapacityLevel }) {
  const t = useT();
  const meta = STATUS[level];
  return <StatusPill status={meta.status}>{t(meta.labelKey)}</StatusPill>;
}

type EditorTarget = {
  config: StationConfig;
  name: string;
  rules: CapacityRule[];
};

export function CapacityPage() {
  const t = useT();
  const toast = useToast();
  const outletId = useTenantContext().outlet?.id ?? null;
  const stations = useKitchenStations(outletId);
  const menuStations = useMenuStations(outletId);
  const rules = useCapacityRules(outletId);
  const pacing = usePacing(outletId);
  const save = useUpdateCapacityRules(outletId);
  const [editor, setEditor] = React.useState<EditorTarget | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const menuById = new Map<string, Station>(
    (menuStations.data ?? []).map((station) => [station.id, station]),
  );
  const configs = [...(stations.data ?? [])].sort(
    (a, b) => a.displayOrder - b.displayOrder,
  );
  const pacingById = new Map(
    (pacing.data?.stations ?? []).map((row) => [row.stationId, row]),
  );

  const pending =
    stations.isPending ||
    menuStations.isPending ||
    rules.isPending ||
    pacing.isPending;
  const failed =
    (stations.isError && !stations.data) ||
    (rules.isError && !rules.data) ||
    (pacing.isError && !pacing.data);

  function retry() {
    void stations.refetch();
    void menuStations.refetch();
    void rules.refetch();
    void pacing.refetch();
  }

  function openEditor(config: StationConfig) {
    setSaveError(null);
    setEditor({
      config,
      name:
        menuById.get(config.stationId)?.name ??
        t("kitchenConfig.capacity.unknownStation"),
      rules: (rules.data ?? []).filter(
        (rule) => rule.stationId === config.stationId,
      ),
    });
  }

  function saveRules(input: CapacityRuleInput[]) {
    const target = editor;
    if (!target) return;
    setSaveError(null);
    save.mutate(
      { stationId: target.config.stationId, rules: input },
      {
        onSuccess: () => {
          toast({
            title: t("kitchenConfig.capacity.savedToast", {
              station: target.name,
            }),
            tone: "success",
          });
          setEditor(null);
        },
        onError: (error) =>
          setSaveError(
            error instanceof ApiError
              ? error.message
              : t("kitchenConfig.capacity.dialog.saveFailed"),
          ),
      },
    );
  }

  if (pending) {
    return (
      <section aria-busy="true" className="grid gap-3">
        <span className="sr-only">{t("kitchenConfig.capacity.loading")}</span>
        {[0, 1, 2].map((card) => (
          <Skeleton key={card} className="h-52 w-full rounded-container" />
        ))}
      </section>
    );
  }

  if (failed) {
    return (
      <ErrorState
        title={t("kitchenConfig.capacity.errorTitle")}
        description={t("kitchenConfig.capacity.errorHint")}
        onRetry={retry}
      />
    );
  }

  if (configs.length === 0) {
    return (
      <EmptyState
        title={t("kitchenConfig.capacity.emptyTitle")}
        description={t("kitchenConfig.capacity.emptyHint")}
        action={
          <Button asChild variant="outline">
            <Link to="/kelola/menu/stasiun">
              {t("kitchenConfig.capacity.manageStations")}
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="grid gap-3">
        {configs.map((config) => {
          const station = menuById.get(config.stationId);
          const stationRules = (rules.data ?? []).filter(
            (rule) => rule.stationId === config.stationId,
          );
          const current = pacingById.get(config.stationId);
          return (
            <article key={config.id}>
              <CardShell>
                <Card className="gap-4">
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid min-w-0 gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="type-title">
                          {station?.name ??
                            t("kitchenConfig.capacity.unknownStation")}
                        </h2>
                        {!config.isActive && (
                          <Badge tone="neutral">
                            {t("kitchenConfig.capacity.inactive")}
                          </Badge>
                        )}
                        {current && <CapacityStatus level={current.status} />}
                      </div>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("kitchenConfig.capacity.displayOrder", {
                          order: config.displayOrder + 1,
                        })}
                        {" · "}
                        {config.autoPrintFallback
                          ? t("kitchenConfig.capacity.autoPrint")
                          : t("kitchenConfig.capacity.noAutoPrint")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openEditor(config)}
                    >
                      {stationRules.length === 0 ? (
                        <Plus aria-hidden="true" />
                      ) : (
                        <Pencil aria-hidden="true" />
                      )}
                      {stationRules.length === 0
                        ? t("kitchenConfig.capacity.addRules")
                        : t("kitchenConfig.capacity.editRules")}
                    </Button>
                  </header>

                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("kitchenConfig.capacity.targetLabel")}
                      </dt>
                      <dd className="text-sm font-medium">
                        {station?.targetSeconds != null
                          ? t("kitchenConfig.capacity.targetValue", {
                              seconds: station.targetSeconds,
                            })
                          : t("kitchenConfig.capacity.noTarget")}
                      </dd>
                    </div>
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("kitchenConfig.capacity.pacingTitle")}
                      </dt>
                      <dd className="text-sm font-medium tabular">
                        {current
                          ? t("kitchenConfig.capacity.pacingUsed", {
                              used: formatNumber(current.usedPoints),
                              capacity: formatNumber(current.capacityPoints),
                            })
                          : t("kitchenConfig.remake.none")}
                      </dd>
                    </div>
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("kitchenConfig.capacity.dialog.window")}
                      </dt>
                      <dd className="text-sm font-medium tabular">
                        {current
                          ? t("kitchenConfig.capacity.pacingWindow", {
                              minutes: current.windowMinutes,
                            })
                          : t("kitchenConfig.remake.none")}
                      </dd>
                    </div>
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("kitchenConfig.capacity.rulesTitle")}
                      </dt>
                      <dd className="text-sm font-medium tabular">
                        {stationRules.length}
                      </dd>
                    </div>
                  </dl>

                  <section aria-label={t("kitchenConfig.capacity.rulesTitle")}>
                    {stationRules.length === 0 ? (
                      <div className="grid gap-1 rounded-container bg-surface-2 p-3">
                        <p className="text-sm font-medium">
                          {t("kitchenConfig.capacity.noRules")}
                        </p>
                        <p className="text-sm leading-5 text-muted-foreground">
                          {t("kitchenConfig.capacity.noRulesHint")}
                        </p>
                      </div>
                    ) : (
                      <ul className="grid gap-2">
                        {stationRules.map((rule) => (
                          <li
                            key={rule.id}
                            className="grid gap-1 rounded-container bg-surface-2 p-3"
                          >
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                              <span className="font-semibold tabular">
                                {t("kitchenConfig.capacity.ruleWindow", {
                                  minutes: rule.windowMinutes,
                                })}
                              </span>
                              <span className="tabular">
                                {t("kitchenConfig.capacity.ruleCapacity", {
                                  points: formatNumber(rule.capacityPoints),
                                })}
                              </span>
                              <span className="text-muted-foreground tabular">
                                {t("kitchenConfig.capacity.ruleNear", {
                                  percent: formatNumber(
                                    rule.nearCapacityBp / 100,
                                  ),
                                })}
                              </span>
                            </div>
                            <div className="grid gap-1 text-sm text-muted-foreground">
                              {rule.schedule.map((entry, index) => (
                                <span key={index} className="tabular">
                                  {t("kitchenConfig.capacity.ruleSchedule", {
                                    days: entry.daysOfWeek
                                      .slice()
                                      .sort(
                                        (a, b) =>
                                          DAY_NUMBERS.indexOf(
                                            a as (typeof DAY_NUMBERS)[number],
                                          ) -
                                          DAY_NUMBERS.indexOf(
                                            b as (typeof DAY_NUMBERS)[number],
                                          ),
                                      )
                                      .map((day) => t(DAY_SHORT[day]))
                                      .join(", "),
                                    start: entry.start,
                                    end: entry.end,
                                  })}
                                </span>
                              ))}
                              <span>
                                {t("kitchenConfig.capacity.ruleChannels", {
                                  channels: rule.channelPriority
                                    .map((channel) =>
                                      t(`menu.prices.channels.${channel}`),
                                    )
                                    .join(" → "),
                                })}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </Card>
              </CardShell>
            </article>
          );
        })}
      </div>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setEditor(null);
        }}
      >
        {editor && (
          <CapacityRuleEditor
            stationName={editor.name}
            rules={editor.rules}
            pending={save.isPending}
            saveError={saveError}
            onSave={saveRules}
            onCancel={() => setEditor(null)}
          />
        )}
      </Dialog>
    </>
  );
}
