// Waste and spoilage log (PRD §16 "Waste & Spoilage", §6.E): ingredient or
// menu losses with the standard reason and the rupiah loss. Every entry
// writes a `waste` stock movement on the API side, so this screen never edits
// or deletes a log — it is an append-only record.
import * as React from "react";
import { Camera, Plus } from "lucide-react";
import type { WasteTargetType } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import { useInventoryItems, useStockLocations, useUnits } from "../hooks";
import { useMenuItems, useWasteLogs } from "../opname-hooks";
import { formatQuantity, LIST_LIMIT } from "../lib";
import { formatDateTime } from "../stock-lib";
import {
  matchesWasteSearch,
  wasteLossTotal,
  wasteReasonKey,
  wasteTargetKey,
  WASTE_REASONS,
} from "../opname-lib";
import { WasteFormDialog } from "./waste-form-dialog";
import { StoragePhoto } from "./photo-field";
import { useTenantContext } from "@/lib/tenant-context";

const ALL = "all";

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh list, so a
 * search, filter or open form of the previous outlet cannot carry over.
 */
export function WastePage({ canRecord }: { canRecord: boolean }) {
  const { outlet } = useTenantContext();
  return <WasteContent key={outlet?.id ?? "none"} canRecord={canRecord} />;
}

function WasteContent({ canRecord }: { canRecord: boolean }) {
  const t = useT();
  const { outlet } = useTenantContext();
  const [search, setSearch] = React.useState("");
  const [reasonFilter, setReasonFilter] = React.useState<string>(ALL);
  const [formOpen, setFormOpen] = React.useState(false);

  const logsQuery = useWasteLogs(outlet?.id);
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const menuQuery = useMenuItems();
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const locationsQuery = useStockLocations(outlet?.id);

  const targets = React.useMemo(() => {
    const map = new Map<
      string,
      { name: string; unit: string; targetType: WasteTargetType }
    >();
    const unitCode = new Map<string, string>();
    for (const unit of unitsQuery.data?.data ?? [])
      unitCode.set(unit.id, unit.code);
    for (const item of itemsQuery.data?.data ?? [])
      map.set(item.id, {
        name: item.name,
        unit: unitCode.get(item.baseUomId) ?? "",
        targetType: "inventory_item",
      });
    for (const item of menuQuery.data?.data ?? [])
      map.set(item.id, {
        name: item.name,
        unit: t("waste.unit.portion"),
        targetType: "menu_item",
      });
    return map;
  }, [itemsQuery.data, menuQuery.data, unitsQuery.data, t]);

  const locationName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const location of locationsQuery.data?.data ?? [])
      map.set(location.id, location.name);
    return map;
  }, [locationsQuery.data]);

  const logs = React.useMemo(
    () => logsQuery.data?.data ?? [],
    [logsQuery.data],
  );
  const filtered = React.useMemo(
    () =>
      logs
        .filter((log) => reasonFilter === ALL || log.reason === reasonFilter)
        .filter((log) =>
          matchesWasteSearch(
            log,
            targets.get(log.targetId)?.name ?? t("waste.list.unknownTarget"),
            search,
          ),
        ),
    [logs, reasonFilter, search, targets, t],
  );
  const lossTotal = wasteLossTotal(filtered);

  const state: DataState =
    logsQuery.isPending ||
    itemsQuery.isPending ||
    menuQuery.isPending ||
    unitsQuery.isPending ||
    locationsQuery.isPending
      ? "loading"
      : logsQuery.isError ||
          itemsQuery.isError ||
          menuQuery.isError ||
          unitsQuery.isError ||
          locationsQuery.isError
        ? "error"
        : logs.length === 0
          ? "empty"
          : "ready";

  const recordButton = canRecord ? (
    <Button size="sm" onClick={() => setFormOpen(true)}>
      <Plus aria-hidden="true" />
      {t("waste.record")}
    </Button>
  ) : null;

  return (
    <div className="grid min-w-0 gap-4">
      <StatTile
        label={t("waste.summary.lossLabel")}
        value={<Money amount={lossTotal} size="lg" />}
        context={t("waste.summary.lossContext", { count: filtered.length })}
        source={<a href="#waste-log">{t("waste.summary.source")}</a>}
      />

      <div id="waste-log">
        <DataTableShell
          title={t("waste.list.title")}
          description={t("waste.list.description")}
          state={state}
          error={
            logsQuery.error ??
            itemsQuery.error ??
            menuQuery.error ??
            unitsQuery.error ??
            locationsQuery.error
          }
          onRetry={() => {
            void logsQuery.refetch();
            void itemsQuery.refetch();
            void menuQuery.refetch();
            void unitsQuery.refetch();
            void locationsQuery.refetch();
          }}
          search={{
            value: search,
            onChange: setSearch,
            label: t("common.search"),
          }}
          actions={
            <>
              <Select value={reasonFilter} onValueChange={setReasonFilter}>
                <SelectTrigger
                  className="h-control-sm w-full sm:w-44"
                  aria-label={t("waste.filters.reason")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("waste.filters.allReasons")}
                  </SelectItem>
                  {WASTE_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {t(wasteReasonKey(reason))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {recordButton}
            </>
          }
          noResults={state === "ready" && filtered.length === 0}
          rowCount={filtered.length}
          empty={{
            title: t("waste.list.empty"),
            description: t("waste.list.emptyHint"),
            action: recordButton,
          }}
        >
          <ul className="divide-y">
            {filtered.map((log) => {
              const target = targets.get(log.targetId);
              return (
                <li key={log.id} className="grid gap-2 px-4 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="grid min-w-0 gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-(length:--density-text) font-semibold">
                          {target?.name ?? t("waste.list.unknownTarget")}
                        </span>
                        <Badge tone="neutral">
                          {t(wasteTargetKey(log.targetType))}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <span className="tabular">
                          {formatQuantity(log.quantity)} {target?.unit ?? ""}
                        </span>
                        {locationName.get(log.locationId)
                          ? ` · ${locationName.get(log.locationId)}`
                          : ""}
                      </p>
                    </div>
                    <Money amount={log.valueIdr} size="lg" />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <Badge tone="warning">
                      {t(wasteReasonKey(log.reason))}
                    </Badge>
                    <span className="tabular">
                      {formatDateTime(log.occurredAt)}
                    </span>
                    {log.mediaId && (
                      <Badge tone="info">
                        <Camera aria-hidden="true" />
                        {t("waste.list.photo")}
                      </Badge>
                    )}
                    {log.note && (
                      <span className="min-w-0 truncate">{log.note}</span>
                    )}
                  </div>
                  {log.mediaId && (
                    <StoragePhoto
                      mediaId={log.mediaId}
                      className="size-24 rounded-field border object-cover"
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {canRecord && (
            <WasteFormDialog open={formOpen} onOpenChange={setFormOpen} />
          )}
        </DataTableShell>
      </div>
    </div>
  );
}
