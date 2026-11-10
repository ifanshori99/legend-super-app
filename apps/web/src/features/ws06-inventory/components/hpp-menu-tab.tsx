// HPP per menu (PRD §17 "HPP Menu"): the theoretical cost per portion from a
// complete recipe, the selling price, and the gross margin. A menu without a
// complete recipe stays sellable and is flagged with no cost — never Rp 0
// (PRD §17 "Kelengkapan Resep", R13; menuCostSchema).
import * as React from "react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantContext } from "@/lib/tenant-context";
import { useMenuCosts } from "../hpp-hooks";
import {
  costIdrOf,
  formatBasisPoints,
  menuNameOf,
  sortMenuCosts,
} from "../hpp-lib";
import {
  PAGE_SIZE,
  formatDateTime,
  listPage,
  matchesQuery,
  shortId,
} from "../stock-lib";

export function HppMenuTab() {
  const t = useT();
  const { outlet } = useTenantContext();
  const query = useMenuCosts(outlet?.id);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);

  const rows = React.useMemo(
    () => sortMenuCosts(query.data?.data ?? []),
    [query.data],
  );

  const filtered = React.useMemo(
    () =>
      rows.filter((row) => matchesQuery(menuNameOf(row.menuItemId), search)),
    [rows, search],
  );

  const pagination = listPage(filtered, page, PAGE_SIZE);
  const state: DataState = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("inventoryHpp.menuCost.title")}
      description={t("inventoryHpp.menuCost.description")}
      state={state}
      error={query.error}
      onRetry={() => void query.refetch()}
      search={{
        value: search,
        onChange: (value) => {
          setSearch(value);
          setPage(1);
        },
        label: t("inventoryHpp.menuCost.searchLabel"),
      }}
      empty={{
        title: t("inventoryHpp.menuCost.emptyTitle"),
        description: t("inventoryHpp.menuCost.emptyHint"),
      }}
      page={{
        page: pagination.page,
        total: pagination.totalPages,
        onChange: setPage,
      }}
      rowCount={filtered.length}
      loadingRows={5}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inventoryHpp.menuCost.columns.menu")}</TableHead>
            <TableHead numeric>
              {t("inventoryHpp.menuCost.columns.price")}
            </TableHead>
            <TableHead numeric>
              {t("inventoryHpp.menuCost.columns.cost")}
            </TableHead>
            <TableHead numeric>
              {t("inventoryHpp.menuCost.columns.margin")}
            </TableHead>
            <TableHead>{t("inventoryHpp.menuCost.columns.status")}</TableHead>
            <TableHead>
              {t("inventoryHpp.menuCost.columns.computedAt")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => {
            // A cost row is one menu item, variant or modifier; the report has
            // no name for a variant/modifier yet, so the row shows its id tail.
            const facet = row.variantId
              ? t("inventoryHpp.menuCost.variant", {
                  id: shortId(row.variantId),
                })
              : row.modifierId
                ? t("inventoryHpp.menuCost.modifier", {
                    id: shortId(row.modifierId),
                  })
                : null;
            return (
              <TableRow
                key={`${row.menuItemId}:${row.variantId ?? "-"}:${
                  row.modifierId ?? "-"
                }`}
              >
                <TableCell className="min-w-40">
                  <span className="block font-medium">
                    {menuNameOf(row.menuItemId)}
                  </span>
                  {facet && (
                    <span className="block text-xs text-muted-foreground">
                      {facet}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.priceIdr} />
                </TableCell>
                <TableCell numeric>
                  {row.theoreticalCostIdr === null ? (
                    "—"
                  ) : (
                    <Money amount={costIdrOf(row.theoreticalCostIdr)} />
                  )}
                </TableCell>
                <TableCell numeric>
                  {row.grossMarginBp === null
                    ? "—"
                    : formatBasisPoints(row.grossMarginBp)}
                </TableCell>
                <TableCell>
                  {row.recipeComplete ? (
                    <StatusPill status="success">
                      {t("inventoryHpp.menuCost.status.complete")}
                    </StatusPill>
                  ) : (
                    <StatusPill status="warning">
                      {t("inventoryHpp.menuCost.status.incomplete")}
                    </StatusPill>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(row.computedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
