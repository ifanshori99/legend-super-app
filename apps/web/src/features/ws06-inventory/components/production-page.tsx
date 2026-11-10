// Production batch list (PRD v1.7 §3 F17 "Produksi Batch", §17): every
// production order with its recipe, batch quantity, outlet and status. Row
// actions come from the contract state machine, so an invalid transition is
// never offered; "Produksi baru" creates a draft order.
import * as React from "react";
import { Plus } from "lucide-react";
import type {
  ProductionOrder,
  ProductionOrderAction,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
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
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { useUnits } from "../hooks";
import { formatQuantity, uomCode } from "../lib";
import {
  allowedProductionActions,
  productionMatchesFilter,
  RECIPE_PAGE_SIZE,
  type ProductionFilter,
} from "../recipe-lib";
import { useProductionOrders, useRecipes } from "../recipe-hooks";
import { formatDateTime, listPage, shortId } from "../stock-lib";
import { ProductionCreateDialog } from "./production-create-dialog";
import { ProductionTransitionDialog } from "./production-transition-dialog";
import { ProductionStatusBadge } from "./recipe-status";

const ACTION_LABEL: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.actions.start"
  | "inventoryRecipe.production.actions.complete"
  | "inventoryRecipe.production.actions.cancel"
> = {
  start: "inventoryRecipe.production.actions.start",
  complete: "inventoryRecipe.production.actions.complete",
  cancel: "inventoryRecipe.production.actions.cancel",
};

const ACTION_ARIA: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.actions.startLabel"
  | "inventoryRecipe.production.actions.completeLabel"
  | "inventoryRecipe.production.actions.cancelLabel"
> = {
  start: "inventoryRecipe.production.actions.startLabel",
  complete: "inventoryRecipe.production.actions.completeLabel",
  cancel: "inventoryRecipe.production.actions.cancelLabel",
};

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh list, so a
 * filter, page or open dialog of the previous outlet cannot carry over.
 */
export function ProductionPage({ canManage }: { canManage: boolean }) {
  const { outlet } = useTenantContext();
  return <ProductionContent key={outlet?.id ?? "none"} canManage={canManage} />;
}

function ProductionContent({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { outlet } = useTenantContext();
  const online = useOnline();
  const [filter, setFilter] = React.useState<ProductionFilter>("all");
  const [page, setPage] = React.useState(1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [transition, setTransition] = React.useState<{
    order: ProductionOrder;
    action: ProductionOrderAction;
  } | null>(null);

  const ordersQuery = useProductionOrders(outlet?.id);
  const recipesQuery = useRecipes();
  const unitsQuery = useUnits({ limit: 100 });

  const recipes = React.useMemo(
    () => recipesQuery.data?.data ?? [],
    [recipesQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const recipesById = React.useMemo(
    () => new Map(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes],
  );
  const orders = React.useMemo(
    () => ordersQuery.data?.data ?? [],
    [ordersQuery.data],
  );

  const rows = React.useMemo(
    () => orders.filter((order) => productionMatchesFilter(order, filter)),
    [orders, filter],
  );
  const pagination = listPage(rows, page, RECIPE_PAGE_SIZE);

  const error = ordersQuery.error ?? recipesQuery.error ?? unitsQuery.error;
  const offline =
    !online || (error instanceof ApiError && error.code === "NETWORK_ERROR");
  const state: DataState =
    ordersQuery.isPending || recipesQuery.isPending || unitsQuery.isPending
      ? "loading"
      : ordersQuery.isError || recipesQuery.isError || unitsQuery.isError
        ? "error"
        : orders.length === 0
          ? "empty"
          : "ready";

  const newButton = canManage ? (
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus aria-hidden="true" />
      {t("inventoryRecipe.production.newOrder")}
    </Button>
  ) : null;

  const recipeName = (order: ProductionOrder) =>
    recipesById.get(order.recipeId)?.name ?? t("inventoryRecipe.unknownRecipe");

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
        title={t("inventoryRecipe.production.title")}
        description={t("inventoryRecipe.production.description")}
        state={state}
        error={ordersQuery.error ?? recipesQuery.error ?? unitsQuery.error}
        onRetry={() => {
          void ordersQuery.refetch();
          void recipesQuery.refetch();
          void unitsQuery.refetch();
        }}
        actions={
          <>
            <Select
              value={filter}
              onValueChange={(value) => {
                setFilter(value as ProductionFilter);
                setPage(1);
              }}
            >
              <SelectTrigger
                className="h-control-sm w-full sm:w-44"
                aria-label={t("inventoryRecipe.production.filterLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("inventoryRecipe.production.filters.all")}
                </SelectItem>
                <SelectItem value="draft">
                  {t("inventoryRecipe.production.filters.draft")}
                </SelectItem>
                <SelectItem value="in_progress">
                  {t("inventoryRecipe.production.filters.in_progress")}
                </SelectItem>
                <SelectItem value="completed">
                  {t("inventoryRecipe.production.filters.completed")}
                </SelectItem>
                <SelectItem value="cancelled">
                  {t("inventoryRecipe.production.filters.cancelled")}
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
          title: t("inventoryRecipe.production.empty"),
          description: t("inventoryRecipe.production.emptyHint"),
          action: newButton,
        }}
      >
        <Table className="min-w-[58rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("inventoryRecipe.production.columns.recipe")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryRecipe.production.columns.quantity")}
              </TableHead>
              <TableHead>
                {t("inventoryRecipe.production.columns.outlet")}
              </TableHead>
              <TableHead>
                {t("inventoryRecipe.production.columns.status")}
              </TableHead>
              <TableHead>
                {t("inventoryRecipe.production.columns.created")}
              </TableHead>
              <TableHead>
                {t("inventoryRecipe.production.columns.completed")}
              </TableHead>
              <TableHead className="text-right">
                {t("inventoryRecipe.production.columns.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.rows.map((order) => {
              const recipe = recipesById.get(order.recipeId);
              const actions = canManage
                ? allowedProductionActions(order.status)
                : [];
              return (
                <TableRow key={order.id}>
                  <TableCell className="font-semibold">
                    {recipeName(order)}
                  </TableCell>
                  <TableCell numeric>
                    {formatQuantity(order.plannedQty)}{" "}
                    {recipe ? uomCode(units, recipe.yieldUomId) : ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {outlet && order.outletId === outlet.id
                      ? outlet.name
                      : shortId(order.outletId)}
                  </TableCell>
                  <TableCell>
                    <ProductionStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell>
                    <time dateTime={order.createdAt}>
                      {formatDateTime(order.createdAt)}
                    </time>
                  </TableCell>
                  <TableCell>
                    {order.completedAt ? (
                      <time dateTime={order.completedAt}>
                        {formatDateTime(order.completedAt)}
                      </time>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      {actions.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        actions.map((action) => (
                          <Button
                            key={action}
                            type="button"
                            variant={action === "cancel" ? "ghost" : "outline"}
                            size="sm"
                            aria-label={t(ACTION_ARIA[action], {
                              name: recipeName(order),
                            })}
                            onClick={() => setTransition({ order, action })}
                          >
                            {t(ACTION_LABEL[action])}
                          </Button>
                        ))
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {canManage && (
        <ProductionCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {canManage && transition !== null && (
        <ProductionTransitionDialog
          order={transition.order}
          action={transition.action}
          recipeName={recipeName(transition.order)}
          units={units}
          yieldUomId={
            recipesById.get(transition.order.recipeId)?.yieldUomId ?? ""
          }
          onOpenChange={(open) => {
            if (!open) setTransition(null);
          }}
        />
      )}
    </div>
  );
}
