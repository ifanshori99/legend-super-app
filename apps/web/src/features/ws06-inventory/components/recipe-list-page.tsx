// Recipe list (PRD v1.7 §3 F17 "Resep Bertingkat", §17): every versioned
// recipe with its output item, yield, active status and theoretical HPP per
// yield unit. Rows open the BOM editor; "Resep baru" creates the first version.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
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
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import { useInventoryItems, useUnits } from "../hooks";
import { formatQuantity, LIST_LIMIT, uomCode } from "../lib";
import {
  idrFromDecimal4,
  recipeMatchesFilter,
  recipeMatchesSearch,
  RECIPE_PAGE_SIZE,
  type RecipeFilter,
} from "../recipe-lib";
import { useRecipes } from "../recipe-hooks";
import { formatDateTime, listPage, shortId } from "../stock-lib";
import { RecipeActiveBadge } from "./recipe-status";
import { RecipeCreateDialog } from "./recipe-create-dialog";

export function RecipeListPage({
  canManage,
  canViewCost,
}: {
  canManage: boolean;
  canViewCost: boolean;
}) {
  const t = useT();
  const online = useOnline();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<RecipeFilter>("all");
  const [page, setPage] = React.useState(1);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const recipesQuery = useRecipes();
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
  const itemsById = React.useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const recipes = React.useMemo(
    () => recipesQuery.data?.data ?? [],
    [recipesQuery.data],
  );

  const rows = React.useMemo(
    () =>
      recipes
        .filter((recipe) => recipeMatchesFilter(recipe, filter))
        .filter((recipe) =>
          recipeMatchesSearch(
            recipe,
            recipe.outputItemId
              ? (itemsById.get(recipe.outputItemId)?.name ?? "")
              : "",
            search,
          ),
        ),
    [recipes, filter, itemsById, search],
  );
  const pagination = listPage(rows, page, RECIPE_PAGE_SIZE);

  const error = recipesQuery.error ?? itemsQuery.error ?? unitsQuery.error;
  const offline =
    !online || (error instanceof ApiError && error.code === "NETWORK_ERROR");
  const state: DataState =
    recipesQuery.isPending || itemsQuery.isPending || unitsQuery.isPending
      ? "loading"
      : recipesQuery.isError || itemsQuery.isError || unitsQuery.isError
        ? "error"
        : recipes.length === 0
          ? "empty"
          : "ready";

  const newButton = canManage ? (
    <Button size="sm" onClick={() => setDialogOpen(true)}>
      <Plus aria-hidden="true" />
      {t("inventoryRecipe.list.newRecipe")}
    </Button>
  ) : null;

  return (
    <div className="grid min-w-0 gap-3">
      {offline && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) bg-warning-subtle px-3 py-2 text-sm font-medium text-warning"
        >
          {t("inventoryRecipe.errors.offline")}
        </p>
      )}
      <DataTableShell
        title={t("inventoryRecipe.list.title")}
        description={t("inventoryRecipe.list.description")}
        state={state}
        onRetry={() => {
          void recipesQuery.refetch();
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
              value={filter}
              onValueChange={(value) => {
                setFilter(value as RecipeFilter);
                setPage(1);
              }}
            >
              <SelectTrigger
                className="h-control-sm w-full sm:w-44"
                aria-label={t("inventoryRecipe.list.filterLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("inventoryRecipe.list.filters.all")}
                </SelectItem>
                <SelectItem value="active">
                  {t("inventoryRecipe.list.filters.active")}
                </SelectItem>
                <SelectItem value="inactive">
                  {t("inventoryRecipe.list.filters.inactive")}
                </SelectItem>
              </SelectContent>
            </Select>
            {newButton}
          </>
        }
        noResults={state === "ready" && rows.length === 0}
        page={
          state === "ready" && rows.length > 0
            ? {
                page: pagination.page,
                total: pagination.totalPages,
                onChange: setPage,
              }
            : undefined
        }
        rowCount={rows.length}
        empty={{
          title: t("inventoryRecipe.list.empty"),
          description: t("inventoryRecipe.list.emptyHint"),
          action: newButton,
        }}
      >
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventoryRecipe.list.columns.name")}</TableHead>
              <TableHead>{t("inventoryRecipe.list.columns.output")}</TableHead>
              <TableHead numeric>
                {t("inventoryRecipe.list.columns.yield")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryRecipe.list.columns.version")}
              </TableHead>
              <TableHead>{t("inventoryRecipe.list.columns.status")}</TableHead>
              <TableHead numeric>
                {t("inventoryRecipe.list.columns.cost")}
              </TableHead>
              <TableHead>{t("inventoryRecipe.list.columns.updated")}</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">{t("common.next")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.rows.map((recipe) => {
              const output = recipe.outputItemId
                ? itemsById.get(recipe.outputItemId)
                : undefined;
              return (
                <TableRow key={recipe.id}>
                  <TableCell className="font-semibold">
                    <Link
                      to="/kelola/inventori/resep/$recipeId"
                      params={{ recipeId: recipe.id }}
                      aria-label={t("inventoryRecipe.list.openRecipe", {
                        name: recipe.name,
                      })}
                      className="rounded-xs underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {recipe.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {recipe.outputItemId
                      ? (output?.name ?? t("inventoryRecipe.unknownItem"))
                      : t("inventoryRecipe.menuOutput")}
                  </TableCell>
                  <TableCell numeric>
                    {formatQuantity(recipe.yieldQuantity)}{" "}
                    {uomCode(units, recipe.yieldUomId)}
                  </TableCell>
                  <TableCell numeric>
                    {t("inventoryRecipe.list.versionValue", {
                      version: recipe.version,
                    })}
                  </TableCell>
                  <TableCell>
                    <RecipeActiveBadge isActive={recipe.isActive} />
                  </TableCell>
                  <TableCell numeric>
                    {canViewCost ? (
                      <Money
                        amount={idrFromDecimal4(recipe.theoreticalCostIdr)}
                      />
                    ) : (
                      <span className="text-sm font-normal text-muted-foreground">
                        {t("inventoryRecipe.list.costUnavailable")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="grid gap-0.5 text-sm">
                      <time dateTime={recipe.updatedAt}>
                        {formatDateTime(recipe.updatedAt)}
                      </time>
                      <span className="text-muted-foreground">
                        {t("inventoryRecipe.list.updatedBy", {
                          user: shortId(recipe.updatedBy),
                        })}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/kelola/inventori/resep/$recipeId"
                      params={{ recipeId: recipe.id }}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="grid size-8 place-items-center rounded-control text-muted-foreground hover:bg-surface-2"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {canManage && (
        <RecipeCreateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
    </div>
  );
}
