// Inventory items list (PRD §16 "Item Bahan & Satuan"): search, category and
// type filters, par level, and the way into one item's detail (units,
// conversions, alternates). Categories are item data, so the filter is built
// from the items themselves.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import type {
  InventoryItem,
  InventoryItemType,
} from "@starter/shared/inventory";
import type { MessageKey } from "@starter/shared/i18n";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInventoryItems, useUnits } from "../hooks";
import { filterItems, formatQuantity, listPage, LIST_LIMIT } from "../lib";

const PAGE_SIZE = 20;
const ALL = "all";

const TYPE_LABEL: Record<InventoryItemType, MessageKey> = {
  raw_material: "inventory.types.raw_material",
  semi_finished: "inventory.types.semi_finished",
};

function ParLevel({ item, unit }: { item: InventoryItem; unit: string }) {
  const t = useT();
  if (item.parMin === null || item.parMax === null)
    return (
      <span className="text-muted-foreground">
        {t("inventory.list.parUnset")}
      </span>
    );
  return (
    <span className="tabular">
      {formatQuantity(item.parMin)}–{formatQuantity(item.parMax)} {unit}
    </span>
  );
}

export function ItemsPage({ initialCategory }: { initialCategory?: string }) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState<string>(
    initialCategory ?? ALL,
  );
  const [type, setType] = React.useState<string>(ALL);
  const [page, setPage] = React.useState(1);

  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });

  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const uoms = unitsQuery.data?.data ?? [];

  const categories = React.useMemo(
    () =>
      [...new Set(items.map((item) => item.category))].sort((a, b) =>
        a.localeCompare(b, "id-ID"),
      ),
    [items],
  );

  const filtered = React.useMemo(
    () =>
      filterItems(items, {
        search,
        category: category === ALL ? undefined : category,
        type: type === ALL ? undefined : (type as InventoryItemType),
      }),
    [items, search, category, type],
  );
  const {
    rows,
    page: safePage,
    totalPages,
  } = listPage(filtered, page, PAGE_SIZE);

  const state: DataState =
    itemsQuery.isPending || unitsQuery.isPending
      ? "loading"
      : itemsQuery.isError || unitsQuery.isError
        ? "error"
        : items.length === 0
          ? "empty"
          : "ready";

  return (
    <DataTableShell
      title={t("inventory.list.title")}
      description={t("inventory.list.description")}
      state={state}
      error={itemsQuery.error ?? unitsQuery.error}
      onRetry={() => {
        void itemsQuery.refetch();
        void unitsQuery.refetch();
      }}
      search={{
        value: search,
        onChange: (value) => {
          setSearch(value);
          setPage(1);
        },
        label: t("common.search"),
      }}
      actions={
        <>
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
          >
            <SelectTrigger
              className="h-control-sm w-full sm:w-44"
              aria-label={t("inventory.list.filters.category")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("inventory.list.filters.allCategories")}
              </SelectItem>
              {categories.map((row) => (
                <SelectItem key={row} value={row}>
                  {row}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value);
              setPage(1);
            }}
          >
            <SelectTrigger
              className="h-control-sm w-full sm:w-40"
              aria-label={t("inventory.list.filters.type")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("inventory.list.filters.allTypes")}
              </SelectItem>
              <SelectItem value="raw_material">
                {t("inventory.types.raw_material")}
              </SelectItem>
              <SelectItem value="semi_finished">
                {t("inventory.types.semi_finished")}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button asChild size="sm">
            <Link to="/kelola/inventori/$itemId" params={{ itemId: "baru" }}>
              <Plus aria-hidden="true" />
              {t("inventory.list.add")}
            </Link>
          </Button>
        </>
      }
      noResults={state === "ready" && rows.length === 0}
      rowCount={filtered.length}
      empty={{
        title: t("inventory.list.empty"),
        description: t("inventory.list.emptyHint"),
        action: (
          <Button asChild variant="outline">
            <Link to="/kelola/inventori/$itemId" params={{ itemId: "baru" }}>
              <Plus aria-hidden="true" />
              {t("inventory.list.add")}
            </Link>
          </Button>
        ),
      }}
      page={{ page: safePage, total: totalPages, onChange: setPage }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inventory.list.columns.item")}</TableHead>
            <TableHead>{t("inventory.list.columns.category")}</TableHead>
            <TableHead>{t("inventory.list.columns.type")}</TableHead>
            <TableHead>{t("inventory.list.columns.baseUnit")}</TableHead>
            <TableHead numeric>{t("inventory.list.columns.par")}</TableHead>
            <TableHead>{t("inventory.list.columns.status")}</TableHead>
            <TableHead className="text-right">
              {t("inventory.list.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((item) => {
            const unit =
              uoms.find((uom) => uom.id === item.baseUomId)?.code ?? "—";
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="grid min-w-40 gap-0.5">
                    <Link
                      to="/kelola/inventori/$itemId"
                      params={{ itemId: item.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {item.name}
                    </Link>
                    {item.isPerishable && (
                      <span className="w-fit text-xs leading-4 text-warning">
                        {t("inventory.perishable.yes")}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{item.category}</TableCell>
                <TableCell>
                  <Badge tone="neutral">{t(TYPE_LABEL[item.type])}</Badge>
                </TableCell>
                <TableCell>{unit}</TableCell>
                <TableCell numeric>
                  <ParLevel item={item} unit={unit} />
                </TableCell>
                <TableCell>
                  <Badge tone={item.isActive ? "success" : "neutral"}>
                    {item.isActive
                      ? t("inventory.active.yes")
                      : t("inventory.active.no")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link
                        to="/kelola/inventori/$itemId"
                        params={{ itemId: item.id }}
                        aria-label={`${t("inventory.list.edit")}: ${item.name}`}
                      >
                        <Pencil aria-hidden="true" />
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
