// Stock-count sessions (PRD §16 "Stok Opname", Alur J): every session with
// its type, location, date, blind flag and status. Rows open the count screen
// where the physical quantities are entered and approved.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, EyeOff, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStockCounts } from "../opname-hooks";
import { useStockLocations } from "../hooks";
import {
  countMatchesFilter,
  matchesCountSearch,
  typeLabelKey,
  type CountFilter,
} from "../opname-lib";
import { formatBusinessDate } from "../stock-lib";
import { CountStatusBadge } from "./count-status";
import { CountFormDialog } from "./count-form-dialog";

export function CountsPage({ canCount }: { canCount: boolean }) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<CountFilter>("all");
  const [formOpen, setFormOpen] = React.useState(false);

  const countsQuery = useStockCounts();
  const locationsQuery = useStockLocations();

  const locationName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const location of locationsQuery.data?.data ?? [])
      map.set(location.id, location.name);
    return map;
  }, [locationsQuery.data]);

  const counts = React.useMemo(
    () => countsQuery.data?.data ?? [],
    [countsQuery.data],
  );
  const rows = React.useMemo(
    () =>
      counts
        .filter((count) => countMatchesFilter(count, filter))
        .filter((count) =>
          matchesCountSearch(
            count,
            locationName.get(count.locationId) ??
              t("opname.list.unknownLocation"),
            search,
          ),
        ),
    [counts, filter, locationName, search, t],
  );

  const state: DataState =
    countsQuery.isPending || locationsQuery.isPending
      ? "loading"
      : countsQuery.isError || locationsQuery.isError
        ? "error"
        : counts.length === 0
          ? "empty"
          : "ready";

  const addButton = canCount ? (
    <Button size="sm" onClick={() => setFormOpen(true)}>
      <Plus aria-hidden="true" />
      {t("opname.list.newCount")}
    </Button>
  ) : null;

  return (
    <DataTableShell
      title={t("opname.list.title")}
      description={t("opname.list.description")}
      state={state}
      onRetry={() => {
        void countsQuery.refetch();
        void locationsQuery.refetch();
      }}
      search={{
        value: search,
        onChange: setSearch,
        label: t("common.search"),
      }}
      actions={
        <>
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as CountFilter)}
          >
            <SelectTrigger
              className="h-control-sm w-full sm:w-40"
              aria-label={t("opname.list.filterLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("opname.list.filters.all")}
              </SelectItem>
              <SelectItem value="active">
                {t("opname.list.filters.active")}
              </SelectItem>
              <SelectItem value="pending">
                {t("opname.list.filters.pending")}
              </SelectItem>
              <SelectItem value="done">
                {t("opname.list.filters.done")}
              </SelectItem>
            </SelectContent>
          </Select>
          {addButton}
        </>
      }
      noResults={state === "ready" && rows.length === 0}
      rowCount={rows.length}
      empty={{
        title: t("opname.list.empty"),
        description: t("opname.list.emptyHint"),
        action: addButton,
      }}
    >
      <ul className="divide-y">
        {rows.map((count) => (
          <li key={count.id}>
            <Link
              to="/kelola/inventori/opname/$countId"
              params={{ countId: count.id }}
              className="grid gap-2 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-accent/60 focus-visible:bg-accent/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3"
            >
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-(length:--density-text) font-semibold">
                    {t(typeLabelKey(count.type))} ·{" "}
                    {locationName.get(count.locationId) ??
                      t("opname.list.unknownLocation")}
                  </span>
                  {count.blind && (
                    <Badge tone="neutral">
                      <EyeOff aria-hidden="true" />
                      {t("opname.list.blind")}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  <span className="tabular">
                    {formatBusinessDate(count.businessDate)}
                  </span>
                  {count.note ? ` · ${count.note}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                <CountStatusBadge status={count.status} />
                <ChevronRight
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {canCount && (
        <CountFormDialog open={formOpen} onOpenChange={setFormOpen} />
      )}
    </DataTableShell>
  );
}
