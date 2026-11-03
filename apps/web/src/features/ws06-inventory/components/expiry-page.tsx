// Batch expiry and FEFO order (PRD §16 "Batch & Kedaluwarsa"): the batches
// closest to expiry first, the warning window from tenant configuration
// (a constant until the settings endpoint lands), and a "use first" list.
import * as React from "react";
import { CalendarClock } from "lucide-react";
import { useT } from "@/components/i18n";
import {
  Card,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useInventoryItems,
  useStockBatches,
  useStockLocations,
  useUnits,
} from "../stock-hooks";
import {
  EXPIRY_WARN_DAYS,
  PAGE_SIZE,
  STOCK_LIST_LIMIT,
  businessDateToday,
  expiryRows,
  formatBusinessDate,
  listPage,
  closestExpiryBatches,
  matchesQuery,
  type ExpiryRow,
} from "../stock-lib";
import { ExpiryStatusPill } from "./stock-status";

const ALL = "all";

type ExpiryFilter = "all" | "expired" | "expiring" | "no_expiry";

export function ExpiryPage() {
  const t = useT();
  // Expiry "days left" is relative to the outlet's business date (D-CORE-7);
  // with no outlet the hook returns the documented Jakarta 04:00 default.
  const { clock } = useOutletClock();
  const [search, setSearch] = React.useState("");
  const [locationId, setLocationId] = React.useState(ALL);
  const [status, setStatus] = React.useState<ExpiryFilter>("all");
  const [page, setPage] = React.useState(1);

  const batchesQuery = useStockBatches();
  const itemsQuery = useInventoryItems({ limit: STOCK_LIST_LIMIT });
  const locationsQuery = useStockLocations();
  const unitsQuery = useUnits({ limit: STOCK_LIST_LIMIT });

  const batches = React.useMemo(
    () => batchesQuery.data?.data ?? [],
    [batchesQuery.data],
  );
  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const locations = React.useMemo(
    () => locationsQuery.data?.data ?? [],
    [locationsQuery.data],
  );
  const uoms = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const today = businessDateToday(new Date(), clock.timeZone, clock.cutoff);

  const rows = React.useMemo(
    () => expiryRows({ batches, items, locations, uoms }, today),
    [batches, items, locations, uoms, today],
  );
  const useFirst = React.useMemo(() => closestExpiryBatches(rows), [rows]);

  const filtered = React.useMemo(
    () =>
      rows.filter((row) => {
        if (status === "expired" && row.status !== "expired") return false;
        if (status === "expiring" && row.status !== "expiring_soon")
          return false;
        if (status === "no_expiry" && row.status !== "no_expiry") return false;
        if (locationId !== ALL && row.batch.locationId !== locationId)
          return false;
        return matchesQuery(
          [
            row.batch.batchCode,
            row.item?.name ?? "",
            row.item?.category ?? "",
            row.location?.name ?? "",
          ].join(" "),
          search,
        );
      }),
    [rows, status, locationId, search],
  );

  const pagination = listPage(filtered, page, PAGE_SIZE);
  const pending =
    batchesQuery.isPending ||
    itemsQuery.isPending ||
    locationsQuery.isPending ||
    unitsQuery.isPending;
  const failed =
    batchesQuery.isError ||
    itemsQuery.isError ||
    locationsQuery.isError ||
    unitsQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : filtered.length === 0
        ? "empty"
        : "ready";
  const filtersActive = status !== "all" || locationId !== ALL || search !== "";

  const daysLabel = (row: ExpiryRow): string => {
    if (row.days === null) return t("inventoryStock.expiry.status.no_expiry");
    if (row.days < 0)
      return t("inventoryStock.expiry.daysAgo", { count: -row.days });
    if (row.days === 0) return t("inventoryStock.expiry.today");
    if (row.days === 1) return t("inventoryStock.expiry.tomorrow");
    return t("inventoryStock.expiry.daysLeft", { count: row.days });
  };

  return (
    <div className="grid min-w-0 gap-5">
      <CardShell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              {t("inventoryStock.expiry.useFirstTitle")}
            </CardTitle>
            <CardDescription>
              {t("inventoryStock.expiry.useFirstHint")}{" "}
              {t("inventoryStock.expiry.warnDays", { days: EXPIRY_WARN_DAYS })}
            </CardDescription>
          </CardHeader>
          {pending ? (
            <div className="grid gap-2">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-control" />
              <Skeleton className="h-control" />
            </div>
          ) : failed ? (
            <ErrorState
              onRetry={() => {
                void batchesQuery.refetch();
                void itemsQuery.refetch();
                void locationsQuery.refetch();
                void unitsQuery.refetch();
              }}
            />
          ) : useFirst.length === 0 ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryStock.expiry.useFirstEmpty")}
            </p>
          ) : (
            <ul className="grid gap-2 divide-y divide-border">
              {useFirst.map((row) => (
                <li
                  key={row.batch.id}
                  className="flex flex-wrap items-center justify-between gap-2 pt-2 first:pt-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold tabular">
                      {row.fefoRank}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">
                        {row.batch.batchCode} · {row.item?.name ?? "—"}
                      </p>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {row.location?.name ?? "—"} ·{" "}
                        {row.batch.expiresOn
                          ? `${formatBusinessDate(row.batch.expiresOn)} · ${daysLabel(row)}`
                          : t("inventoryStock.expiry.status.no_expiry")}
                      </p>
                    </div>
                  </div>
                  <ExpiryStatusPill status={row.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </CardShell>

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<ExpiryFilter>
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          label={t("inventoryStock.expiry.statusLabel")}
          options={[
            { value: "all", label: t("inventoryStock.expiry.statusAll") },
            {
              value: "expired",
              label: t("inventoryStock.expiry.statusExpired"),
            },
            { value: "expiring", label: t("inventoryStock.expiry.statusSoon") },
            {
              value: "no_expiry",
              label: t("inventoryStock.expiry.statusNoExpiry"),
            },
          ]}
        />
        <Select
          value={locationId}
          onValueChange={(value) => {
            setLocationId(value);
            setPage(1);
          }}
        >
          <SelectTrigger
            className="h-control-sm sm:w-48"
            aria-label={t("inventoryStock.filters.location")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("inventoryStock.filters.allLocations")}
            </SelectItem>
            {locations.map((location) => (
              <SelectItem key={location.id} value={location.id}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTableShell
        title={t("inventoryStock.expiry.title")}
        description={t("inventoryStock.expiry.description")}
        state={state}
        onRetry={() => {
          void batchesQuery.refetch();
          void itemsQuery.refetch();
          void locationsQuery.refetch();
          void unitsQuery.refetch();
        }}
        search={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setPage(1);
          },
          label: t("inventoryStock.expiry.searchLabel"),
        }}
        empty={{
          title: filtersActive
            ? t("inventoryStock.expiry.emptyFilterTitle")
            : t("inventoryStock.expiry.emptyTitle"),
          description: filtersActive
            ? t("inventoryStock.expiry.emptyFilterHint")
            : t("inventoryStock.expiry.emptyHint"),
        }}
        page={{
          page: pagination.page,
          total: pagination.totalPages,
          onChange: setPage,
        }}
        rowCount={filtered.length}
        loadingRows={6}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead numeric>{t("inventoryStock.columns.fefo")}</TableHead>
              <TableHead>{t("inventoryStock.columns.batch")}</TableHead>
              <TableHead>{t("inventoryStock.columns.item")}</TableHead>
              <TableHead>{t("inventoryStock.columns.location")}</TableHead>
              <TableHead>{t("inventoryStock.columns.received")}</TableHead>
              <TableHead>{t("inventoryStock.columns.expires")}</TableHead>
              <TableHead>{t("inventoryStock.columns.remaining")}</TableHead>
              <TableHead>{t("inventoryStock.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.rows.map((row) => (
              <TableRow key={row.batch.id}>
                <TableCell numeric>{row.fefoRank}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  {row.batch.batchCode}
                </TableCell>
                <TableCell className="min-w-40">
                  <span className="block font-medium">
                    {row.item?.name ?? "—"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {row.item?.category ?? ""}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.location?.name ?? "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatBusinessDate(row.batch.receivedAt.slice(0, 10))}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.batch.expiresOn ? (
                    formatBusinessDate(row.batch.expiresOn)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {daysLabel(row)}
                </TableCell>
                <TableCell>
                  <ExpiryStatusPill status={row.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
