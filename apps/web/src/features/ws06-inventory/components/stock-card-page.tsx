// Stock card (PRD §16 "Kartu Stok Append-only", INV-01): every movement with
// its source document. The ledger is read-only here — corrections are
// approved `adjustment` rows, so the screen offers no edit or delete action.
import * as React from "react";
import { ArrowDownToLine, ArrowUpFromLine, FilterX } from "lucide-react";
import { cn } from "cn";
import type {
  StockMovementType,
  StockSourceType,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
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
  useStockBatches,
  useStockLedger,
  useStockLocations,
  useUnits,
} from "../hooks";
import {
  PAGE_SIZE,
  STOCK_LIST_LIMIT,
  formatDateTime,
  formatSignedQuantity,
  ledgerLineValueIdr,
  ledgerRows,
  listPage,
  matchesQuery,
  movementDirection,
  shortId,
  sourceKey,
} from "../lib";
import { MOVEMENT_LABEL, SOURCE_LABEL } from "./stock-status";

const ALL = "all";

/** Compact labelled filter: labels stay visible after a value is picked. */
function FilterField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <Label
        htmlFor={htmlFor}
        className="text-xs leading-4 font-medium text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}
const MOVEMENT_TYPES: readonly StockMovementType[] = [
  "receipt",
  "sale",
  "production_in",
  "production_out",
  "transfer_in",
  "transfer_out",
  "waste",
  "adjustment",
  "duty_meal",
  "return",
];

export function StockCardPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [locationId, setLocationId] = React.useState(ALL);
  const [itemId, setItemId] = React.useState(ALL);
  const [movementType, setMovementType] = React.useState(ALL);
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");
  const [source, setSource] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const itemFilterId = React.useId();
  const locationFilterId = React.useId();
  const movementFilterId = React.useId();
  const fromFilterId = React.useId();
  const toFilterId = React.useId();

  const ledgerQuery = useStockLedger({
    locationId: locationId === ALL ? undefined : locationId,
    inventoryItemId: itemId === ALL ? undefined : itemId,
    movementType:
      movementType === ALL ? undefined : (movementType as StockMovementType),
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });
  const itemsQuery = useInventoryItems({ limit: STOCK_LIST_LIMIT });
  const locationsQuery = useStockLocations();
  const batchesQuery = useStockBatches();
  const unitsQuery = useUnits({ limit: STOCK_LIST_LIMIT });

  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const locations = React.useMemo(
    () => locationsQuery.data?.data ?? [],
    [locationsQuery.data],
  );

  const rows = React.useMemo(
    () =>
      ledgerRows({
        ledger: ledgerQuery.data?.data ?? [],
        items,
        locations,
        batches: batchesQuery.data?.data ?? [],
        uoms: unitsQuery.data?.data ?? [],
      }),
    [ledgerQuery.data, items, locations, batchesQuery.data, unitsQuery.data],
  );

  const filtered = React.useMemo(
    () =>
      rows.filter(({ entry, item, location, batch }) => {
        if (source && sourceKey(entry) !== source) return false;
        return matchesQuery(
          [
            item?.name ?? "",
            item?.category ?? "",
            location?.name ?? "",
            batch?.batchCode ?? "",
            entry.sourceId,
          ].join(" "),
          search,
        );
      }),
    [rows, source, search],
  );

  const pagination = listPage(filtered, page, PAGE_SIZE);
  const filtersActive =
    locationId !== ALL ||
    itemId !== ALL ||
    movementType !== ALL ||
    fromDate !== "" ||
    toDate !== "" ||
    source !== null;

  const pending =
    ledgerQuery.isPending ||
    itemsQuery.isPending ||
    locationsQuery.isPending ||
    batchesQuery.isPending ||
    unitsQuery.isPending;
  const failed =
    ledgerQuery.isError ||
    itemsQuery.isError ||
    locationsQuery.isError ||
    batchesQuery.isError ||
    unitsQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : filtered.length === 0
        ? "empty"
        : "ready";

  const sourceType = source?.split(":")[0] as StockSourceType | undefined;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-2">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
          <FilterField
            label={t("inventoryStock.filters.item")}
            htmlFor={itemFilterId}
            className="col-span-2 sm:w-52"
          >
            <Select
              value={itemId}
              onValueChange={(value) => {
                setItemId(value);
                setPage(1);
              }}
            >
              <SelectTrigger id={itemFilterId} className="h-control-sm w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("inventoryStock.filters.allItems")}
                </SelectItem>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField
            label={t("inventoryStock.filters.location")}
            htmlFor={locationFilterId}
          >
            <Select
              value={locationId}
              onValueChange={(value) => {
                setLocationId(value);
                setPage(1);
              }}
            >
              <SelectTrigger
                id={locationFilterId}
                className="h-control-sm w-full"
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
          </FilterField>
          <FilterField
            label={t("inventoryStock.filters.movement")}
            htmlFor={movementFilterId}
            className="sm:w-44"
          >
            <Select
              value={movementType}
              onValueChange={(value) => {
                setMovementType(value);
                setPage(1);
              }}
            >
              <SelectTrigger
                id={movementFilterId}
                className="h-control-sm w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("inventoryStock.filters.allMovements")}
                </SelectItem>
                {MOVEMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(MOVEMENT_LABEL[type])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField
            label={t("inventoryStock.filters.fromDate")}
            htmlFor={fromFilterId}
            className="sm:w-40"
          >
            <Input
              id={fromFilterId}
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPage(1);
              }}
              className="h-control-sm w-full"
            />
          </FilterField>
          <FilterField
            label={t("inventoryStock.filters.toDate")}
            htmlFor={toFilterId}
            className="sm:w-40"
          >
            <Input
              id={toFilterId}
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
                setPage(1);
              }}
              className="h-control-sm w-full"
            />
          </FilterField>
        </div>
        {source && sourceType && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">
              {t("inventoryStock.stock.sourceFilter", {
                source: t(SOURCE_LABEL[sourceType]),
              })}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSource(null);
                setPage(1);
              }}
            >
              <FilterX aria-hidden="true" />
              {t("inventoryStock.stock.clearSource")}
            </Button>
          </div>
        )}
      </div>

      <DataTableShell
        title={t("inventoryStock.stock.title")}
        description={t("inventoryStock.stock.description")}
        state={state}
        onRetry={() => {
          void ledgerQuery.refetch();
          void itemsQuery.refetch();
          void locationsQuery.refetch();
          void batchesQuery.refetch();
          void unitsQuery.refetch();
        }}
        search={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setPage(1);
          },
          label: t("inventoryStock.stock.searchLabel"),
        }}
        empty={{
          title: filtersActive
            ? t("inventoryStock.stock.emptyFilterTitle")
            : t("inventoryStock.stock.emptyTitle"),
          description: filtersActive
            ? t("inventoryStock.stock.emptyFilterHint")
            : t("inventoryStock.stock.emptyHint"),
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
              <TableHead>{t("inventoryStock.columns.time")}</TableHead>
              <TableHead>{t("inventoryStock.columns.item")}</TableHead>
              <TableHead>{t("inventoryStock.columns.location")}</TableHead>
              <TableHead>{t("inventoryStock.columns.movement")}</TableHead>
              <TableHead numeric>
                {t("inventoryStock.columns.quantity")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryStock.columns.unitCost")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryStock.columns.lineValue")}
              </TableHead>
              <TableHead>{t("inventoryStock.columns.source")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.rows.map(({ entry, item, location, batch, unit }) => {
              const direction = movementDirection(entry);
              return (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {formatDateTime(entry.occurredAt)}
                  </TableCell>
                  <TableCell className="min-w-40">
                    <span className="block font-medium">
                      {item?.name ?? "—"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {item?.category ?? ""}
                      {batch
                        ? ` · ${t("inventoryStock.stock.batchLabel", {
                            code: batch.batchCode,
                          })}`
                        : ""}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {location?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      {direction === "in" ? (
                        <ArrowDownToLine
                          className="size-4 text-success"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowUpFromLine
                          className="size-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      {t(MOVEMENT_LABEL[entry.movementType])}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <span
                      className={cn(
                        "font-medium",
                        direction === "in" ? "text-success" : "text-foreground",
                      )}
                    >
                      {formatSignedQuantity(entry.quantity)}{" "}
                      <span className="text-muted-foreground">{unit}</span>
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={Number(entry.unitCostIdr)} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={ledgerLineValueIdr(entry)} />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => {
                        setSource(sourceKey(entry));
                        setPage(1);
                      }}
                      title={t("inventoryStock.stock.sourceHint")}
                      className="text-left text-primary underline underline-offset-4"
                    >
                      <span className="block font-medium">
                        {t(SOURCE_LABEL[entry.sourceType])}
                      </span>
                      <span
                        title={entry.sourceId}
                        className="block font-mono text-xs text-muted-foreground no-underline"
                      >
                        {shortId(entry.sourceId)}
                      </span>
                    </button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
