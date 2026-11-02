// The floor plan used for table assignment: one card per table, grouped by
// zone, with the tables another reservation already holds during the slot
// highlighted and locked (RSV-01). Presentational only — the dialogs own the
// queries, the selection state and the write.
import * as React from "react";
import { Users } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FloorZone, TableId } from "@starter/shared/qr-order";
import type { Reservation } from "@starter/shared/reservation";
import { assignableTables, type AssignTable } from "../lib";

const ALL_ZONES = "all";

export function TablePicker({
  tables,
  zones,
  conflicts,
  value,
  onChange,
  formatTime,
}: {
  tables: AssignTable["table"][];
  zones: readonly FloorZone[];
  /** Table id → the reservation that holds it in this slot. */
  conflicts: ReadonlyMap<string, Reservation>;
  value: readonly TableId[];
  onChange: (next: TableId[]) => void;
  /** Outlet clock for the conflict hint ("P1 · 19.30"). */
  formatTime: (instant: string) => string;
}) {
  const t = useT();
  const [zoneId, setZoneId] = React.useState<string>(ALL_ZONES);
  const selected = new Set<string>(value);

  const zoneCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const table of tables)
      counts.set(table.zoneId, (counts.get(table.zoneId) ?? 0) + 1);
    return counts;
  }, [tables]);

  const visible = React.useMemo(
    () =>
      assignableTables({
        tables,
        zones,
        conflicts,
        zoneId: zoneId === ALL_ZONES ? null : zoneId,
      }),
    [tables, zones, conflicts, zoneId],
  );

  const toggle = (tableId: TableId) => {
    onChange(
      selected.has(tableId)
        ? value.filter((id) => id !== tableId)
        : [...value, tableId],
    );
  };

  return (
    <div className="grid min-w-0 gap-3">
      <Tabs value={zoneId} onValueChange={setZoneId} className="min-w-0">
        <TabsList aria-label={t("reservation.assign.zoneTabs")} className="min-w-0">
          <TabsTrigger value={ALL_ZONES}>
            {t("reservation.assign.zoneAll")} ({tables.length})
          </TabsTrigger>
          {zones.map((zone) => (
            <TabsTrigger key={zone.id} value={zone.id}>
              {zone.name} ({zoneCounts.get(zone.id) ?? 0})
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          {t("reservation.assign.emptyZoneHint")}
        </p>
      ) : (
        <ul className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((row) => {
            const isSelected = selected.has(row.table.id);
            const locked = row.state !== "available" && !isSelected;
            const stateLabel = t(
              isSelected
                ? "reservation.assign.state.selected"
                : row.state === "conflict"
                  ? "reservation.assign.state.conflict"
                  : row.state === "inactive"
                    ? "reservation.assign.state.inactive"
                    : "reservation.assign.state.available",
            );
            return (
              <li key={row.table.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={locked}
                  onClick={() => toggle(row.table.id)}
                  aria-label={t("reservation.assign.tableAria", {
                    code: row.table.code,
                    capacity: row.table.capacity,
                    state: stateLabel,
                  })}
                  className={cn(
                    "flex min-h-16 w-full flex-col gap-1 rounded-xl border-(length:--border-w) bg-card p-2.5 text-left text-foreground transition-colors duration-(--duration-fast)",
                    "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    isSelected && "border-primary bg-accent",
                    row.state === "conflict" &&
                      !isSelected &&
                      "border-danger bg-danger-subtle",
                    locked && "cursor-not-allowed opacity-70 hover:bg-card",
                  )}
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="text-xl leading-7 font-bold tabular">
                      {row.table.code}
                    </span>
                    <span className="flex items-center gap-1 text-sm text-muted-foreground tabular">
                      <Users className="size-4" aria-hidden="true" />
                      {row.table.capacity}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    {isSelected && (
                      <Badge tone="solid">
                        {t("reservation.assign.state.selected")}
                      </Badge>
                    )}
                    {row.state === "conflict" && (
                      <Badge tone="danger">
                        {t("reservation.assign.conflictBadge")}
                      </Badge>
                    )}
                    {row.state === "inactive" && (
                      <Badge tone="neutral">
                        {t("reservation.assign.inactiveBadge")}
                      </Badge>
                    )}
                    {row.zone && (
                      <span className="text-xs text-muted-foreground">
                        {row.zone.name}
                      </span>
                    )}
                  </span>
                  {row.conflict && row.state === "conflict" && (
                    <span className="truncate text-xs text-danger">
                      {t("reservation.assign.conflictWith", {
                        name: row.conflict.guestName,
                        time: formatTime(row.conflict.reservedFor),
                      })}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
