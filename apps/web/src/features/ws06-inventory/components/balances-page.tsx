// Balances per location and par levels (PRD §16 "Lokasi Stok", "Metode Biaya",
// "Par Level & Saran Pembelian"): the derived balance, its moving-average
// value, the effective par level, and the critical-stock alerts that feed the
// purchase suggestions.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useInventoryItems,
  useParLevels,
  useStockBalances,
  useStockBatches,
  useStockLocations,
  useUnits,
} from "../stock-hooks";
import {
  EXPIRY_WARN_DAYS,
  PAGE_SIZE,
  STOCK_LIST_LIMIT,
  attentionBatches,
  balanceRows,
  businessDateToday,
  criticalRows,
  expiryRows,
  formatQuantity,
  listPage,
  matchesQuery,
  parRows,
  totalStockValueIdr,
} from "../stock-lib";
import { ParStatusPill } from "./stock-status";

const ALL = "all";

export function BalancesPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [locationId, setLocationId] = React.useState(ALL);
  const [page, setPage] = React.useState(1);

  const balancesQuery = useStockBalances();
  const parLevelsQuery = useParLevels();
  const itemsQuery = useInventoryItems({ limit: STOCK_LIST_LIMIT });
  const locationsQuery = useStockLocations();
  const unitsQuery = useUnits({ limit: STOCK_LIST_LIMIT });
  const batchesQuery = useStockBatches();

  const balances = React.useMemo(
    () => balancesQuery.data?.data ?? [],
    [balancesQuery.data],
  );
  const parLevels = React.useMemo(
    () => parLevelsQuery.data?.data ?? [],
    [parLevelsQuery.data],
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
  const batches = React.useMemo(
    () => batchesQuery.data?.data ?? [],
    [batchesQuery.data],
  );
  const today = businessDateToday();

  const rows = React.useMemo(
    () =>
      balanceRows({
        balances,
        parLevels,
        items,
        locations,
        uoms,
      }),
    [balances, parLevels, items, locations, uoms],
  );
  const pars = React.useMemo(
    () => parRows({ balances, parLevels, items, locations, uoms }),
    [balances, parLevels, items, locations, uoms],
  );
  const alerts = React.useMemo(() => criticalRows(pars), [pars]);
  const expiring = React.useMemo(
    () =>
      attentionBatches(expiryRows({ batches, items, locations, uoms }, today)),
    [batches, items, locations, uoms, today],
  );

  const filtered = React.useMemo(
    () =>
      rows.filter((row) => {
        if (locationId !== ALL && row.balance.locationId !== locationId)
          return false;
        return matchesQuery(
          [
            row.item?.name ?? "",
            row.item?.category ?? "",
            row.location?.name ?? "",
          ].join(" "),
          search,
        );
      }),
    [rows, locationId, search],
  );

  const pagination = listPage(filtered, page, PAGE_SIZE);
  const pending =
    balancesQuery.isPending ||
    parLevelsQuery.isPending ||
    itemsQuery.isPending ||
    locationsQuery.isPending ||
    unitsQuery.isPending ||
    batchesQuery.isPending;
  const failed =
    balancesQuery.isError ||
    parLevelsQuery.isError ||
    itemsQuery.isError ||
    locationsQuery.isError ||
    unitsQuery.isError ||
    batchesQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : filtered.length === 0
        ? "empty"
        : "ready";
  const filtersActive = locationId !== ALL || search !== "";

  const retry = () => {
    void balancesQuery.refetch();
    void parLevelsQuery.refetch();
    void itemsQuery.refetch();
    void locationsQuery.refetch();
    void unitsQuery.refetch();
    void batchesQuery.refetch();
  };

  // Never print a derived 0 while the data is loading or failed: a fake
  // metric is worse than an explicit placeholder.
  const stat = (ready: React.ReactNode) =>
    pending ? (
      <Skeleton className="h-8 w-24" />
    ) : failed ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      ready
    );
  const statContext = (text: string) => (pending || failed ? undefined : text);
  const showCount = !pending && !failed;

  return (
    <div className="grid min-w-0 gap-5">
      {/* Owner Q30 (DESIGN.md v2): one strip, hairline dividers. */}
      <StatStrip label={t("inventoryStock.balances.summaryLabel")} columns={3}>
        <StatTile
          label={t("inventoryStock.balances.statBelowPar")}
          value={stat(<NumberDisplay value={alerts.length} />)}
          context={statContext(
            t("inventoryStock.balances.statBelowParContext", {
              count: pars.length,
            }),
          )}
          source={
            <Link to="/kelola/inventori/saran">
              {t("inventoryStock.balances.statBelowParSource")}
            </Link>
          }
        />
        <StatTile
          label={t("inventoryStock.balances.statExpiring")}
          value={stat(<NumberDisplay value={expiring.length} />)}
          context={statContext(
            t("inventoryStock.balances.statExpiringContext", {
              days: EXPIRY_WARN_DAYS,
            }),
          )}
          source={
            <Link to="/kelola/inventori/kedaluwarsa">
              {t("inventoryStock.balances.statExpiringSource")}
            </Link>
          }
        />
        <StatTile
          label={t("inventoryStock.balances.statValue")}
          value={stat(<Money amount={totalStockValueIdr(rows)} />)}
          context={statContext(t("inventoryStock.balances.statValueContext"))}
        />
      </StatStrip>

      <CardShell aria-labelledby="stock-alerts-title">
        <CardShellBody className="gap-3 p-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="stock-alerts-title" className="type-title">
                {t("inventoryStock.balances.alertsTitle")}
              </h2>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("inventoryStock.balances.alertsHint")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {showCount && (
                <Badge tone={alerts.length > 0 ? "danger" : "neutral"}>
                  {alerts.length > 0 && <TriangleAlert aria-hidden="true" />}
                  {t("inventoryStock.balances.alertsCount", {
                    count: alerts.length,
                  })}
                </Badge>
              )}
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/inventori/saran">
                  {t("inventoryStock.balances.suggestionsLink")}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
          {pending ? (
            <div className="grid gap-2">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-control" />
              <Skeleton className="h-control" />
              <Skeleton className="h-control" />
            </div>
          ) : failed ? (
            <ErrorState onRetry={retry} />
          ) : alerts.length === 0 ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryStock.balances.alertsEmpty")}
            </p>
          ) : (
            <ul className="grid gap-2 divide-y divide-border">
              {alerts.map((alert) => (
                <li
                  key={alert.key}
                  className="flex flex-wrap items-center justify-between gap-2 pt-2 first:pt-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{alert.item.name}</p>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {alert.location?.name ?? "—"} ·{" "}
                      {t("inventoryStock.balances.alertDetail", {
                        onHand: formatQuantity(alert.onHand),
                        unit: alert.unit,
                        parMin: formatQuantity(alert.parMin),
                      })}
                    </p>
                  </div>
                  <StatusPill status="danger">
                    {t("inventoryStock.parStatus.below_min")}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </CardShellBody>
      </CardShell>

      <div className="flex flex-wrap gap-2">
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
        title={t("inventoryStock.balances.title")}
        description={t("inventoryStock.balances.description")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setPage(1);
          },
          label: t("inventoryStock.balances.searchLabel"),
        }}
        empty={{
          title: filtersActive
            ? t("inventoryStock.balances.emptyFilterTitle")
            : t("inventoryStock.balances.emptyTitle"),
          description: filtersActive
            ? t("inventoryStock.balances.emptyFilterHint")
            : t("inventoryStock.balances.emptyHint"),
        }}
        page={{
          page: pagination.page,
          total: pagination.totalPages,
          onChange: setPage,
        }}
        rowCount={filtered.length}
        loadingRows={8}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventoryStock.columns.item")}</TableHead>
              <TableHead>{t("inventoryStock.columns.location")}</TableHead>
              <TableHead numeric>
                {t("inventoryStock.columns.onHand")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryStock.columns.avgCost")}
              </TableHead>
              <TableHead numeric>{t("inventoryStock.columns.value")}</TableHead>
              <TableHead>{t("inventoryStock.columns.par")}</TableHead>
              <TableHead>{t("inventoryStock.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="min-w-44">
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
                <TableCell numeric>
                  {formatQuantity(row.balance.quantity)}{" "}
                  <span className="text-muted-foreground">{row.unit}</span>
                </TableCell>
                <TableCell numeric>
                  <Money amount={Number(row.balance.avgCostIdr)} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.valueIdr} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular">
                  {row.parMin !== null && row.parMax !== null
                    ? t("inventoryStock.par.range", {
                        min: formatQuantity(row.parMin),
                        max: formatQuantity(row.parMax),
                        unit: row.unit,
                      })
                    : t("inventoryStock.par.unset")}
                </TableCell>
                <TableCell>
                  {row.status ? (
                    <ParStatusPill status={row.status} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
