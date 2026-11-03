// /kelola/pengadaan/supplier — supplier master data (PRD v1.7 §3 F18
// "Supplier"). Rows open the detail route; the dialog creates a supplier with
// the contract's createSupplierInputSchema. Search is client-side over the
// loaded page; the status filter is the contract's `isActive` query param.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { NumberDisplay } from "@/components/ui/money";
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
import { useOnline } from "@/lib/use-online";
import { useSupplierCatalogCounts, useSupplierList } from "../supplier-hooks";
import {
  catalogItemIds,
  listPage,
  matchesSupplier,
  SUPPLIER_PAGE_SIZE,
} from "../supplier-lib";
import type { SupplierStatusFilter } from "../supplier-queries";
import { SupplierFormDialog } from "./supplier-form-dialog";
import { SupplierActiveState, SupplierRating } from "./supplier-rating";

export function SuppliersPage() {
  const t = useT();
  const online = useOnline();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<SupplierStatusFilter>("all");
  const [page, setPage] = React.useState(1);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const listQuery = useSupplierList(status);
  const suppliers = React.useMemo(
    () => listQuery.data?.data ?? [],
    [listQuery.data],
  );
  const filtered = React.useMemo(
    () => suppliers.filter((supplier) => matchesSupplier(supplier, search)),
    [suppliers, search],
  );
  const paged = listPage(filtered, page, SUPPLIER_PAGE_SIZE);
  const visibleIds = paged.rows.map((supplier) => supplier.id);
  const countQueries = useSupplierCatalogCounts(visibleIds);

  const counts = new Map<string, number | null>();
  visibleIds.forEach((id, index) => {
    const data = countQueries[index]?.data?.data;
    counts.set(id, data ? catalogItemIds(data).length : null);
  });

  const state: DataState = listQuery.isPending
    ? "loading"
    : listQuery.isError
      ? "error"
      : suppliers.length === 0
        ? "empty"
        : "ready";
  const noResults =
    state === "ready" && search.trim() !== "" && filtered.length === 0;

  return (
    <div className="grid min-w-0 gap-5">
      {!online && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) bg-card p-card text-sm leading-5 text-muted-foreground shadow-hairline"
        >
          {t("inventorySuppliers.errors.offline")}
        </p>
      )}
      <DataTableShell
        title={t("inventorySuppliers.list.title")}
        description={t("inventorySuppliers.list.description")}
        state={state}
        search={{
          value: search,
          label: t("inventorySuppliers.list.searchLabel"),
          onChange: (value) => {
            setSearch(value);
            setPage(1);
          },
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as SupplierStatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger
                aria-label={t("inventorySuppliers.list.filterLabel")}
                className="h-control-sm sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("inventorySuppliers.list.allStatuses")}
                </SelectItem>
                <SelectItem value="true">
                  {t("inventorySuppliers.list.activeOnly")}
                </SelectItem>
                <SelectItem value="false">
                  {t("inventorySuppliers.list.inactiveOnly")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden="true" />
              {t("inventorySuppliers.list.add")}
            </Button>
          </div>
        }
        onRetry={() => void listQuery.refetch()}
        empty={{
          title: t("inventorySuppliers.list.emptyTitle"),
          description: t("inventorySuppliers.list.emptyHint"),
          action: (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden="true" />
              {t("inventorySuppliers.list.add")}
            </Button>
          ),
        }}
        noResults={noResults}
        page={{
          page: paged.page,
          total: paged.totalPages,
          onChange: setPage,
        }}
        rowCount={filtered.length}
        loadingRows={6}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventorySuppliers.columns.name")}</TableHead>
              <TableHead>{t("inventorySuppliers.columns.contact")}</TableHead>
              <TableHead numeric>
                {t("inventorySuppliers.columns.paymentTerms")}
              </TableHead>
              <TableHead numeric>
                {t("inventorySuppliers.columns.catalogItems")}
              </TableHead>
              <TableHead>{t("inventorySuppliers.columns.rating")}</TableHead>
              <TableHead>{t("inventorySuppliers.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.rows.map((supplier) => {
              const count = counts.get(supplier.id);
              return (
                <TableRow key={supplier.id}>
                  <TableCell>
                    <Link
                      to="/kelola/pengadaan/supplier/$supplierId"
                      params={{ supplierId: supplier.id }}
                      aria-label={t("inventorySuppliers.columns.open", {
                        name: supplier.name,
                      })}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {supplier.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {supplier.contactName ? (
                      <>
                        <span className="block">{supplier.contactName}</span>
                        <span className="block text-sm text-muted-foreground tabular">
                          {supplier.phone ??
                            t("inventorySuppliers.columns.noValue")}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t("inventorySuppliers.columns.noContact")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell numeric>
                    {t("inventorySuppliers.days", {
                      days: supplier.paymentTermsDays,
                    })}
                  </TableCell>
                  <TableCell numeric>
                    {count === null || count === undefined ? (
                      <span className="text-muted-foreground">
                        {t("inventorySuppliers.columns.noValue")}
                      </span>
                    ) : (
                      <NumberDisplay value={count} />
                    )}
                  </TableCell>
                  <TableCell>
                    <SupplierRating rating={supplier.rating} />
                  </TableCell>
                  <TableCell>
                    <SupplierActiveState active={supplier.isActive} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      <SupplierFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
