// Item categories as a dimension of the catalog (PRD §16 "kategori"): counts,
// base units and perishable items per category, with a way into the filtered
// item list. Categories are item data, not their own editable entity.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInventoryItems, useUnits } from "../hooks";
import { categorySummaries, LIST_LIMIT } from "../lib";

export function CategoriesPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");

  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });

  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const summaries = React.useMemo(
    () => categorySummaries(items, units),
    [items, units],
  );
  const query = search.trim().toLocaleLowerCase("id-ID");
  const filtered = summaries.filter((row) =>
    row.category.toLocaleLowerCase("id-ID").includes(query),
  );

  const state: DataState =
    itemsQuery.isPending || unitsQuery.isPending
      ? "loading"
      : itemsQuery.isError || unitsQuery.isError
        ? "error"
        : summaries.length === 0
          ? "empty"
          : "ready";

  return (
    <DataTableShell
      title={t("inventory.categories.title")}
      description={t("inventory.categories.description")}
      state={state}
      onRetry={() => {
        void itemsQuery.refetch();
        void unitsQuery.refetch();
      }}
      search={{
        value: search,
        onChange: setSearch,
        label: t("common.search"),
      }}
      noResults={state === "ready" && filtered.length === 0}
      rowCount={filtered.length}
      empty={{
        title: t("inventory.categories.empty"),
        description: t("inventory.categories.emptyHint"),
      }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inventory.categories.columns.category")}</TableHead>
            <TableHead numeric>
              {t("inventory.categories.columns.items")}
            </TableHead>
            <TableHead>{t("inventory.categories.columns.baseUnits")}</TableHead>
            <TableHead numeric>
              {t("inventory.categories.columns.perishable")}
            </TableHead>
            <TableHead className="text-right">
              {t("inventory.list.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((row) => (
            <TableRow key={row.category}>
              <TableCell className="font-medium">{row.category}</TableCell>
              <TableCell numeric>{row.itemCount}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.baseUnits.map((unit) => (
                    <Badge key={unit} tone="neutral">
                      {unit}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell numeric>
                {row.perishableCount === 0
                  ? "—"
                  : t("inventory.categories.perishableCount", {
                      count: row.perishableCount,
                    })}
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      to="/kelola/inventori"
                      search={{ category: row.category }}
                    >
                      {t("inventory.categories.view")}
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
