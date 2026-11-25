import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Minus, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { ModifierDialog } from "@/features/ws04-pos-order/components/modifier-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Notice,
  StatusPill,
} from "@/features/ws04-pos-kasir/components/shared";
import { cartTotals, needsChoice } from "@/features/ws04-pos-order/cart-logic";
import { useDraftCart } from "@/features/ws04-pos-order/draft-store";
import {
  isContractPending,
  useCaptainCartKey,
  useCaptainCartLocked,
  useOrderingConnectivity,
  usePosCatalog,
  useTableOrder,
} from "@/features/ws04-pos-order/hooks";
import type { CartLine, MenuItem } from "@/features/ws04-pos-order/types";
import { CaptainShell } from "./captain-shell";
import {
  formatClock,
  lockDraft,
  tableSessionText,
} from "./captain-order-parts";

const ALL = "all";

// /pos/captain/meja/$tableId/tambah — pick menu items for the table. Items go
// to a draft per table (kept if the captain leaves); nothing reaches the
// kitchen until the review step.
export function AddOrderScreen({ tableId }: { tableId: string }) {
  const t = useT();
  const barHintId = useId();
  const navigate = useNavigate();
  const catalog = usePosCatalog();
  const connectivity = useOrderingConnectivity();
  const tableOrder = useTableOrder(tableId);
  const cartKey = useCaptainCartKey(tableId);
  const rawDraft = useDraftCart(cartKey ?? "captain:none");
  const locked = useCaptainCartLocked(cartKey);
  const draft = lockDraft(rawDraft, locked);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [picking, setPicking] = useState<MenuItem | null>(null);
  // The line the captain just took out, kept briefly so "Urungkan" can restore it.
  const [removed, setRemoved] = useState<{
    line: CartLine;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(timer);
  }, [removed]);

  const setQuantity = (lineId: string, quantity: number) => {
    if (quantity <= 0) {
      const index = draft.lines.findIndex((line) => line.lineId === lineId);
      const line = draft.lines[index];
      if (line) setRemoved({ line, index });
    }
    draft.setQuantity(lineId, quantity);
  };

  const undoRemove = () => {
    if (!removed) return;
    const next = [...draft.lines];
    next.splice(Math.min(removed.index, next.length), 0, removed.line);
    draft.replace(next);
    setRemoved(null);
  };

  const offline = connectivity.mode === "edge_only";
  const totals = cartTotals(draft.lines);
  const tableLabel = tableOrder.data?.table.label;
  const updatedAt = catalog.data?.updatedAt ?? connectivity.catalogUpdatedAt;
  const clock = updatedAt ? formatClock(updatedAt) : null;

  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    return (catalog.data?.items ?? []).filter(
      (item) =>
        (category === ALL || item.categoryId === category) &&
        (needle === "" ||
          item.name.toLocaleLowerCase("id-ID").includes(needle) ||
          (item.code?.toLocaleLowerCase("id-ID").includes(needle) ?? false)),
    );
  }, [catalog.data, query, category]);

  const tableMissing =
    tableOrder.isError &&
    !tableOrder.data &&
    tableOrder.error instanceof ApiError &&
    tableOrder.error.status === 404;
  // No session, no order: the table must be seated before items are chosen.
  const payFirst = tableOrder.data?.table.paymentMode === "pay_first";
  const unseated = Boolean(tableOrder.data) && cartKey === null && !payFirst;

  // An item without choices goes straight into the draft, as on the cashier.
  const pick = (item: MenuItem) => {
    if (!needsChoice(item)) {
      draft.add(item, { modifiers: [], note: "", quantity: 1 });
      return;
    }
    setPicking(item);
  };

  const reviewHref = "/pos/captain/meja/$tableId/tinjau" as const;

  return (
    <CaptainShell
      context={
        tableLabel
          ? t("posCaptainOrder.table.title", { table: tableLabel })
          : t("posCaptainOrder.table.loadingTitle")
      }
      contextSub={
        tableOrder.data ? tableSessionText(t, tableOrder.data.table) : undefined
      }
      title={t("posCaptainOrder.add.title")}
      subtitle={
        offline && tableLabel
          ? t("posCaptainOrder.add.subtitleOffline", { table: tableLabel })
          : t("posCaptainOrder.add.subtitle")
      }
      backTo={`/pos/captain/meja/${encodeURIComponent(tableId)}`}
      bottomBar={
        tableMissing || unseated || payFirst ? undefined : (
          <div className="grid gap-1 text-center">
            {totals.itemCount > 0 ? (
              <Button
                size="lg"
                className="w-full"
                onClick={() =>
                  void navigate({ to: reviewHref, params: { tableId } })
                }
              >
                {t("posCaptainOrder.add.review", { count: totals.itemCount })}
              </Button>
            ) : (
              <Button
                size="lg"
                aria-disabled="true"
                aria-describedby={barHintId}
                onClick={(event) => event.preventDefault()}
                className="w-full aria-disabled:opacity-60"
              >
                {t("posCaptainOrder.add.reviewEmpty")}
              </Button>
            )}
            <p id={barHintId} className="text-sm text-muted-foreground">
              {totals.itemCount > 0
                ? t("posCaptainOrder.add.reviewNote")
                : t("posCaptainOrder.add.emptyBar")}
            </p>
          </div>
        )
      }
    >
      <div data-slot="captain-add-order" className="grid content-start gap-4">
        {removed && (
          <Notice
            tone="info"
            role="status"
            title={t("posCaptainOrder.add.lineRemoved")}
          >
            <Button type="button" variant="outline" onClick={undoRemove}>
              {t("posCaptainOrder.add.undo")}
            </Button>
          </Notice>
        )}

        {locked && (
          <Notice tone="info" title={t("posCaptainOrder.locked.title")}>
            {t("posCaptainOrder.locked.body")}
          </Notice>
        )}

        {offline && (
          <Notice tone="warning" title={t("posCaptainOrder.add.offlineTitle")}>
            {clock
              ? t("posCaptainOrder.add.offlineBody", { time: clock })
              : t("posCaptainOrder.add.offlineBodyNoTime")}
          </Notice>
        )}

        {catalog.isError && catalog.data && (
          <Notice tone="warning" title={t("posCaptainOrder.stale")} />
        )}

        {tableMissing ? (
          <EmptyState
            title={t("posCaptainOrder.order.notFoundTitle")}
            description={t("posCaptainOrder.order.notFoundHint")}
            action={
              <Button asChild>
                <Link to="/pos/captain">
                  {t("posCaptainOrder.order.backToTables")}
                </Link>
              </Button>
            }
          />
        ) : payFirst ? (
          <EmptyState
            title={t("posCaptainOrder.payFirst.title")}
            description={t("posCaptainOrder.payFirst.hint")}
            action={
              <Button asChild>
                <Link to="/pos/captain/meja/$tableId" params={{ tableId }}>
                  {t("posCaptainOrder.noSession.action")}
                </Link>
              </Button>
            }
          />
        ) : unseated ? (
          <EmptyState
            title={t("posCaptainOrder.noSession.title")}
            description={t("posCaptainOrder.noSession.hint")}
            action={
              <Button asChild>
                <Link to="/pos/captain/meja/$tableId" params={{ tableId }}>
                  {t("posCaptainOrder.noSession.action")}
                </Link>
              </Button>
            }
          />
        ) : tableOrder.isError && !tableOrder.data ? (
          <ErrorState
            title={t("posCaptainOrder.review.loadFailedTitle")}
            description={
              isContractPending(tableOrder.error)
                ? t("posCaptainOrder.contractPending")
                : t("posCaptainOrder.review.loadFailedHint")
            }
            error={tableOrder.error}
            onRetry={() => void tableOrder.refetch()}
          />
        ) : catalog.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainOrder.add.loading")}
            className="grid gap-3"
          >
            <Skeleton className="h-control rounded-control" />
            <Skeleton className="h-control w-2/3 rounded-control" />
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-24 rounded-container" />
            ))}
          </div>
        ) : !catalog.data ? (
          <ErrorState
            title={t("posCaptainOrder.add.loadFailedTitle")}
            description={
              isContractPending(catalog.error)
                ? t("posCaptainOrder.contractPending")
                : t("posCaptainOrder.add.loadFailedHint")
            }
            error={catalog.error}
            onRetry={() => void catalog.refetch()}
          />
        ) : catalog.data.items.length === 0 ? (
          <EmptyState
            title={t("posCaptainOrder.add.emptyTitle")}
            description={t("posCaptainOrder.add.emptyHint")}
          />
        ) : (
          <>
            <Input
              type="search"
              inputMode="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("posCaptainOrder.add.searchLabel")}
              placeholder={t("posCaptainOrder.add.searchPlaceholder")}
              className="h-control"
            />
            <div
              role="group"
              aria-label={t("posCaptainOrder.add.categories")}
              className="-mb-1 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
            >
              {[
                { id: ALL, name: t("posCaptainOrder.add.allCategories") },
                ...catalog.data.categories,
              ].map((entry) => (
                <Button
                  key={entry.id}
                  variant="outline"
                  aria-pressed={category === entry.id}
                  onClick={() => setCategory(entry.id)}
                  className={cn(
                    "shrink-0 whitespace-nowrap",
                    category === entry.id &&
                      "border-foreground bg-surface-3 shadow-none",
                  )}
                >
                  {entry.name}
                </Button>
              ))}
            </div>

            {items.length === 0 ? (
              <EmptyState
                title={t("posCaptainOrder.add.noResultsTitle")}
                description={t("posCaptainOrder.add.noResultsHint")}
              />
            ) : (
              <ul className="grid gap-3">
                {items.map((item) => (
                  <li key={item.id}>
                    <MenuRow
                      item={item}
                      lines={draft.lines.filter(
                        (line) => line.menuItemId === item.id,
                      )}
                      locked={locked}
                      onPick={() => pick(item)}
                      onQuantity={setQuantity}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-base text-muted-foreground">
              {t("posCaptainOrder.add.hint")}
            </p>
          </>
        )}
      </div>

      <ModifierDialog
        item={picking}
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
        onConfirm={(selection) => {
          if (picking) draft.add(picking, selection);
          setPicking(null);
        }}
      />
    </CaptainShell>
  );
}

// One menu item. With exactly one draft line it carries a stepper; with none
// it offers "Tambah"; with several (same item, different choices) it offers
// "Tambah" and says how many lines exist, the review step edits each of them.
function MenuRow({
  item,
  lines,
  locked,
  onPick,
  onQuantity,
}: {
  item: MenuItem;
  lines: CartLine[];
  locked: boolean;
  onPick: () => void;
  onQuantity: (lineId: string, quantity: number) => void;
}) {
  const t = useT();
  const only = lines.length === 1 ? lines[0] : null;
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card p-card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-(length:--density-text) leading-6 font-semibold">
            {item.name}
          </h2>
          <Money amount={item.priceIdr} className="text-muted-foreground" />
          {lines.length > 1 && (
            <p className="text-sm text-muted-foreground">
              {t("posCaptainOrder.add.inOrder", { count: lines.length })}
            </p>
          )}
        </div>
        {item.soldOut ? (
          <StatusPill tone="danger">
            {t("posCaptainOrder.add.soldOut")}
          </StatusPill>
        ) : only ? (
          <div
            role="group"
            aria-label={t("posCaptainOrder.add.quantity", {
              name: item.name,
              qty: only.quantity,
            })}
            className="flex shrink-0 items-center gap-3 font-semibold"
          >
            <Button
              variant="outline"
              size="icon"
              aria-label={t("posCaptainOrder.add.decrease", {
                name: item.name,
              })}
              disabled={locked}
              onClick={() => onQuantity(only.lineId, only.quantity - 1)}
            >
              <Minus aria-hidden="true" />
            </Button>
            <span
              aria-hidden="true"
              className="min-w-6 text-center tabular-nums"
            >
              {only.quantity}
            </span>
            {/* Announces the new quantity when a stepper button is pressed. */}
            <span role="status" className="sr-only">
              {t("posCaptainOrder.add.quantity", {
                name: item.name,
                qty: only.quantity,
              })}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("posCaptainOrder.add.increase", {
                name: item.name,
              })}
              disabled={locked}
              onClick={() => onQuantity(only.lineId, only.quantity + 1)}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            aria-label={t("posCaptainOrder.add.addNamed", { name: item.name })}
            onClick={onPick}
            disabled={locked}
            className="shrink-0"
          >
            <Plus aria-hidden="true" />
            {t("posCaptainOrder.add.add")}
          </Button>
        )}
      </div>
      {!item.soldOut && only && needsChoice(item) && (
        <Button
          variant="ghost"
          aria-label={t("posCaptainOrder.add.addOther", { name: item.name })}
          onClick={onPick}
          disabled={locked}
          className="mt-2 underline underline-offset-4"
        >
          <Plus aria-hidden="true" />
          {t("posCaptainOrder.add.add")}
        </Button>
      )}
    </div>
  );
}
