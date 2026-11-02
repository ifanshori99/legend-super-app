// Menu items list (PRD §8 "Struktur Menu" + "Konten Menu"): search, filter,
// sort, display order, and the 86 quick action. Rows join categories,
// availability and the effective dine-in price list in features/ws03-menu/lib.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  CircleSlash,
  GripVertical,
  Pencil,
  RotateCcw,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
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
import { useToast } from "@/components/ui/toast";
import {
  useAvailability,
  useCategories,
  useDeleteItem,
  useItems,
  usePriceListItems,
  usePriceLists,
  useReorderItems,
  useSetAvailabilityStatus,
  useStations,
} from "../hooks";
import {
  businessDateToday,
  effectivePriceList,
  filterItemRows,
  itemRows,
  reorderIds,
  sortItemRows,
  type ItemRow,
  type ItemSort,
  type ItemStatus,
} from "../lib";
import { ConfirmDialog } from "./confirm-dialog";
import { ReorderButtons } from "./reorder-buttons";
import { ItemStatusBadge } from "./status-badge";

const PAGE_SIZE = 20;
const ALL = "all";

type FilterState = {
  search: string;
  categoryId: string;
  stationId: string;
  status: string;
  sort: ItemSort;
};

const INITIAL_FILTERS: FilterState = {
  search: "",
  categoryId: ALL,
  stationId: ALL,
  status: ALL,
  sort: "category",
};

function RowActions({
  row,
  pending,
  onToggle,
  onDelete,
}: {
  row: ItemRow;
  pending: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-1">
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.list.edit")}
      >
        <Link to="/kelola/menu/$itemId" params={{ itemId: row.item.id }}>
          <Pencil aria-hidden="true" />
        </Link>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={
          row.status === "sold_out"
            ? t("menu.list.restore")
            : t("menu.list.sellOut")
        }
        disabled={!row.availability || pending}
        onClick={onToggle}
      >
        {row.status === "sold_out" ? (
          <RotateCcw aria-hidden="true" />
        ) : (
          <CircleSlash aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.list.delete")}
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function ItemListPage() {
  const t = useT();
  const toast = useToast();
  const [filters, setFilters] = React.useState<FilterState>(INITIAL_FILTERS);
  const [page, setPage] = React.useState(1);
  const [deleting, setDeleting] = React.useState<ItemRow | null>(null);
  const [restoring, setRestoring] = React.useState<ItemRow | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);

  const itemsQuery = useItems({ limit: 100 });
  const categoriesQuery = useCategories({ limit: 100 });
  const stationsQuery = useStations({ limit: 100 });
  const availabilityQuery = useAvailability({ limit: 100 });
  const priceListsQuery = usePriceLists({ limit: 100 });

  const priceLists = priceListsQuery.data?.data ?? [];
  const activePriceList = effectivePriceList(
    priceLists,
    "dine_in",
    businessDateToday(),
  );
  const priceItemsQuery = usePriceListItems(activePriceList?.id);

  const deleteItem = useDeleteItem();
  const reorder = useReorderItems();
  const setStatus = useSetAvailabilityStatus();

  const update = (patch: Partial<FilterState>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const categories = React.useMemo(
    () => categoriesQuery.data?.data ?? [],
    [categoriesQuery.data],
  );
  const stations = stationsQuery.data?.data ?? [];

  const data = React.useMemo(() => {
    const items = itemsQuery.data?.data ?? [];
    const rows = itemRows({
      items,
      categories,
      availability: availabilityQuery.data?.data ?? [],
      priceListItems: priceItemsQuery.data?.data ?? [],
    });
    const status =
      filters.status === ALL ? undefined : (filters.status as ItemStatus);
    const filtered = sortItemRows(
      filterItemRows(rows, {
        search: filters.search,
        categoryId: filters.categoryId === ALL ? undefined : filters.categoryId,
        stationId: filters.stationId === ALL ? undefined : filters.stationId,
        status,
      }),
      filters.sort,
    );
    return { items, filtered };
  }, [
    itemsQuery.data,
    categories,
    availabilityQuery.data,
    priceItemsQuery.data,
    filters,
  ]);

  const totalPages = Math.max(1, Math.ceil(data.filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = data.filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  const reorderEnabled =
    filters.categoryId !== ALL &&
    filters.stationId === ALL &&
    filters.status === ALL &&
    filters.search.trim() === "" &&
    filters.sort !== "name";

  const loading =
    itemsQuery.isPending ||
    categoriesQuery.isPending ||
    stationsQuery.isPending ||
    availabilityQuery.isPending ||
    priceListsQuery.isPending ||
    // A disabled query (no price list yet) stays "pending" forever; only wait
    // for it when there is a list to read.
    (activePriceList !== undefined && priceItemsQuery.isPending);
  // A failure in any query the table reads must surface, not render as empty.
  const failed =
    itemsQuery.isError ||
    categoriesQuery.isError ||
    stationsQuery.isError ||
    availabilityQuery.isError ||
    (activePriceList !== undefined && priceItemsQuery.isError);

  function retry() {
    void itemsQuery.refetch();
    void categoriesQuery.refetch();
    void stationsQuery.refetch();
    void availabilityQuery.refetch();
    void priceListsQuery.refetch();
    if (activePriceList) void priceItemsQuery.refetch();
  }

  function move(row: ItemRow, direction: -1 | 1) {
    const ids = data.filtered.map((entry) => entry.item.id);
    const target = ids[ids.indexOf(row.item.id) + direction];
    if (!target) return;
    const ordered = reorderIds(ids, row.item.id, target);
    if (!ordered) return;
    reorder.mutate(
      { orderedIds: ordered },
      {
        onSuccess: () =>
          toast({ title: t("menu.list.reorderSaved"), tone: "success" }),
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  function dropBefore(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const ids = data.filtered.map((entry) => entry.item.id);
    const ordered = reorderIds(ids, dragging, targetId);
    setDragging(null);
    if (!ordered) return;
    reorder.mutate(
      { orderedIds: ordered },
      {
        onSuccess: () =>
          toast({ title: t("menu.list.reorderSaved"), tone: "success" }),
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  function toggleStatus(row: ItemRow) {
    if (!row.availability) return;
    if (row.status === "sold_out") {
      setRestoring(row);
      return;
    }
    setStatus.mutate(
      {
        availabilityId: row.availability.id,
        body: { action: "sell_out", idempotencyKey: crypto.randomUUID() },
      },
      {
        onSuccess: () =>
          toast({
            title: t("menu.list.soldOutToast", { name: row.item.name }),
            tone: "success",
          }),
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  function confirmRestore() {
    if (!restoring?.availability) return;
    setStatus.mutate(
      {
        availabilityId: restoring.availability.id,
        body: { action: "restore", idempotencyKey: crypto.randomUUID() },
      },
      {
        onSuccess: () => {
          toast({
            title: t("menu.list.restoredToast", { name: restoring.item.name }),
            tone: "success",
          });
          setRestoring(null);
        },
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteItem.mutate(deleting.item.id, {
      onSuccess: () => {
        toast({
          title: t("menu.list.deletedToast", { name: deleting.item.name }),
          tone: "success",
        });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  return (
    <>
      <div className="grid min-w-0 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Select
          value={filters.categoryId}
          onValueChange={(value) => update({ categoryId: value })}
        >
          <SelectTrigger
            className="h-control-sm w-full sm:w-44"
            aria-label={t("menu.list.filters.category")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("menu.list.filters.allCategories")}
            </SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.stationId}
          onValueChange={(value) => update({ stationId: value })}
        >
          <SelectTrigger
            className="h-control-sm w-full sm:w-44"
            aria-label={t("menu.list.filters.station")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("menu.list.filters.allStations")}
            </SelectItem>
            {stations.map((station) => (
              <SelectItem key={station.id} value={station.id}>
                {station.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status}
          onValueChange={(value) => update({ status: value })}
        >
          <SelectTrigger
            className="h-control-sm w-full sm:w-40"
            aria-label={t("menu.list.filters.status")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("menu.list.filters.allStatuses")}
            </SelectItem>
            <SelectItem value="available">
              {t("menu.list.status.available")}
            </SelectItem>
            <SelectItem value="sold_out">
              {t("menu.list.status.sold_out")}
            </SelectItem>
            <SelectItem value="inactive">
              {t("menu.list.status.inactive")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.sort}
          onValueChange={(value) => update({ sort: value as ItemSort })}
        >
          <SelectTrigger
            className="h-control-sm w-full sm:w-44"
            aria-label={t("menu.list.filters.sort")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="display">
              {t("menu.list.sort.display")}
            </SelectItem>
            <SelectItem value="name">{t("menu.list.sort.name")}</SelectItem>
            <SelectItem value="category">
              {t("menu.list.sort.category")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTableShell
        title={t("menu.list.title")}
        description={t("menu.list.description")}
        state={
          loading
            ? "loading"
            : failed
              ? "error"
              : data.items.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: filters.search,
          onChange: (value) => update({ search: value }),
          label: t("menu.list.searchPlaceholder"),
        }}
        actions={
          <Button asChild>
            <Link to="/kelola/menu/$itemId" params={{ itemId: "baru" }}>
              <UtensilsCrossed aria-hidden="true" />
              {t("menu.list.add")}
            </Link>
          </Button>
        }
        onRetry={retry}
        empty={{
          title: t("menu.list.emptyTitle"),
          description: t("menu.list.emptyHint"),
          action: (
            <Button asChild variant="outline">
              <Link to="/kelola/menu/$itemId" params={{ itemId: "baru" }}>
                {t("menu.list.add")}
              </Link>
            </Button>
          ),
        }}
        noResults={data.filtered.length === 0 && data.items.length > 0}
        page={{ page: safePage, total: totalPages, onChange: setPage }}
        rowCount={data.filtered.length}
        loadingRows={6}
      >
        <p className="border-b px-card py-2 text-sm leading-5 text-muted-foreground">
          {reorderEnabled
            ? t("menu.list.reorderHint")
            : t("menu.list.reorderDisabledHint")}
        </p>
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                {reorderEnabled && (
                  <TableHead className="w-20">
                    {t("menu.categories.columns.order")}
                  </TableHead>
                )}
                <TableHead>{t("menu.list.columns.item")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("menu.list.columns.category")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("menu.list.columns.station")}
                </TableHead>
                <TableHead numeric>{t("menu.list.columns.price")}</TableHead>
                <TableHead>{t("menu.list.columns.status")}</TableHead>
                <TableHead numeric>{t("menu.list.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, index) => (
                <TableRow
                  key={row.item.id}
                  draggable={reorderEnabled}
                  onDragStart={() => setDragging(row.item.id)}
                  onDragOver={(event) => {
                    if (reorderEnabled) event.preventDefault();
                  }}
                  onDrop={() => dropBefore(row.item.id)}
                  onDragEnd={() => setDragging(null)}
                >
                  {reorderEnabled && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <GripVertical
                          aria-hidden="true"
                          className="size-4 text-muted-foreground"
                        />
                        <ReorderButtons
                          index={index}
                          count={pageRows.length}
                          labelUp={t("menu.list.moveUp", {
                            name: row.item.name,
                          })}
                          labelDown={t("menu.list.moveDown", {
                            name: row.item.name,
                          })}
                          disabled={reorder.isPending}
                          onMove={(direction) => move(row, direction)}
                        />
                      </div>
                    </TableCell>
                  )}
                  <TableCell className="min-w-56">
                    <div className="grid gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {row.item.name}
                        {row.item.type === "combo" && (
                          <Badge tone="brand">
                            {t("menu.editor.type.combo")}
                          </Badge>
                        )}
                        {row.item.labels.slice(0, 2).map((label) => (
                          <Badge key={label} tone="info">
                            {label}
                          </Badge>
                        ))}
                        {/* Q23: without a photo the item can never be shown. */}
                        {!row.item.mediaId && (
                          <Badge tone="warning">
                            {t("menu.list.photoRequired")}
                          </Badge>
                        )}
                      </span>
                      {row.item.description && (
                        <span className="line-clamp-1 text-sm text-muted-foreground">
                          {row.item.description}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {row.category?.name ?? t("menu.list.noCategory")}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {stations.find(
                      (station) => station.id === row.item.stationId,
                    )?.name ?? t("menu.list.noStation")}
                  </TableCell>
                  <TableCell numeric>
                    {row.priceIdr === undefined ? (
                      <span className="text-sm text-muted-foreground">
                        {t("menu.list.noPrice")}
                      </span>
                    ) : (
                      <Money amount={row.priceIdr} size="sm" />
                    )}
                  </TableCell>
                  <TableCell>
                    <ItemStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell numeric>
                    <RowActions
                      row={row}
                      pending={setStatus.isPending}
                      onToggle={() => toggleStatus(row)}
                      onDelete={() => setDeleting(row)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {pageRows.map((row, index) => (
            <li
              key={row.item.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {row.item.name}
                    {row.item.type === "combo" && (
                      <Badge tone="brand">{t("menu.editor.type.combo")}</Badge>
                    )}
                    {row.item.labels.slice(0, 2).map((label) => (
                      <Badge key={label} tone="info">
                        {label}
                      </Badge>
                    ))}
                    {!row.item.mediaId && (
                      <Badge tone="warning">
                        {t("menu.list.photoRequired")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {row.category?.name ?? t("menu.list.noCategory")} ·{" "}
                    {row.priceIdr === undefined ? (
                      t("menu.list.noPrice")
                    ) : (
                      <Money amount={row.priceIdr} size="sm" />
                    )}
                  </span>
                </div>
                <ItemStatusBadge status={row.status} />
              </div>
              <div className="flex items-center justify-between gap-2">
                {reorderEnabled ? (
                  <ReorderButtons
                    index={index}
                    count={pageRows.length}
                    labelUp={t("menu.list.moveUp", { name: row.item.name })}
                    labelDown={t("menu.list.moveDown", {
                      name: row.item.name,
                    })}
                    disabled={reorder.isPending}
                    onMove={(direction) => move(row, direction)}
                  />
                ) : (
                  <span />
                )}
                <RowActions
                  row={row}
                  pending={setStatus.isPending}
                  onToggle={() => toggleStatus(row)}
                  onDelete={() => setDeleting(row)}
                />
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.list.deleteTitle", { name: deleting?.item.name ?? "" })}
        description={t("menu.list.deleteBody")}
        confirmLabel={t("menu.list.delete")}
        pending={deleteItem.isPending}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={t("menu.availability.confirmRestoreTitle", {
          name: restoring?.item.name ?? "",
        })}
        description={t("menu.availability.confirmRestoreBody")}
        confirmLabel={t("menu.availability.restore")}
        destructive={false}
        pending={setStatus.isPending}
        onConfirm={confirmRestore}
      />
    </>
  );
}
