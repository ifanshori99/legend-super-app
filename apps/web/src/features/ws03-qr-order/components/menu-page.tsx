// The QR menu (PRD §3 F10 "Menu & Keranjang"), "final arah A + liquid glass"
// (design/mockups/final-a-menu-*.png). Mobile: one glass header (brand, table,
// search, category chips, filter), inline guest count (founder Q5), a 2-column
// photo grid and the glass cart bar. Desktop (lg): left index, centered grid,
// and a right column with the search field above the table nota. Sold-out
// items are shown but not addable; filters live in the URL so a filtered view
// survives reload and can be shared at the table.
import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, TriangleAlert, UtensilsCrossed, X } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTableJourney } from "../context";
import { useAddToCart, useChangeCartLine, useRemoveCartLine } from "../hooks";
import {
  countItems,
  filterMenu,
  isFiltering,
  menuLabels,
  type MenuFilter,
} from "../lib/menu-filter.ts";
import { menuQuery } from "../queries";
import { QrFrameNotices } from "./glass/qr-frame-notices";
import { qrTextLink } from "./glass/qr-primitives";
import { ItemCard, type ItemCartSummary } from "./item-card";
import { ItemSheet } from "./item-sheet";
import { QrCartBar } from "./menu/cart-bar";
import { GuestPanel, GuestRow } from "./menu/guest-count";
import { LabelFilterPanel } from "./menu/label-filter";
import { MenuHeader } from "./menu/menu-header";
import { MenuSidebar } from "./menu/menu-sidebar";
import { TableNota } from "./menu/table-nota";
import { Notice } from "./notice";
import {
  MenuLoadState,
  PendingConfirmationNotice,
  SessionEnded,
} from "./session-states";

export type MenuSearch = {
  q?: string;
  cat?: string;
  labels?: string;
  item?: string;
};

function MenuSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only">{t("qrMenu.states.loading")}</span>
      <Skeleton className="h-32 w-full rounded-qr-float lg:hidden" />
      <Skeleton className="h-14 w-full rounded-qr-media lg:hidden" />
      {/* Mirrors the photo-first grid: a 1:1 plate and two text lines. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 lg:gap-x-6">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid content-start gap-2">
            <Skeleton className="aspect-card w-full rounded-qr-media" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MenuPage({
  search,
  onSearchChange,
}: {
  search: MenuSearch;
  onSearchChange: (patch: Partial<MenuSearch>) => void;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const journey = useTableJourney();
  const {
    qrToken,
    menu,
    menuError,
    sessionId,
    view,
    guest,
    ended,
    joinOpen,
    openJoin,
    pendingItemId,
    clearPendingItem,
  } = journey;
  const add = useAddToCart(sessionId ?? "none");
  const change = useChangeCartLine(sessionId ?? "none");
  const remove = useRemoveCartLine(sessionId ?? "none");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [steppingLineId, setSteppingLineId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(Boolean(search.q));
  const [filterOpen, setFilterOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const filterId = useId();

  // After the guest joined from a tapped item, show that item's sheet.
  useEffect(() => {
    if (guest && pendingItemId) {
      onSearchChange({ item: pendingItemId });
      clearPendingItem();
    }
  }, [guest, pendingItemId, onSearchChange, clearPendingItem]);

  if (!menu)
    return menuError ? (
      <MenuLoadState
        error={menuError}
        onRetry={() => window.location.reload()}
      />
    ) : (
      <MenuSkeleton />
    );

  const labels = search.labels ? search.labels.split(",").filter(Boolean) : [];
  const filter: MenuFilter = {
    q: search.q ?? "",
    category: search.cat ?? null,
    labels,
  };
  const sections = filterMenu(menu, filter);
  const available = menuLabels(menu);
  const openItem = search.item
    ? (menu.items.find((entry) => entry.id === search.item) ?? null)
    : null;
  const pax = view?.session.pax ?? guest?.pax ?? null;
  const joined = guest !== null;
  const canOrder = menu.orderingOpen && !ended;
  const taxNote =
    menu.pricing.taxPriceMode === "mixed"
      ? t("qrGlass.menu.pricingNoteMixed")
      : menu.pricing.pricesIncludeTaxAndService
        ? t("qrGlass.menu.pricingNoteInclusive")
        : t("qrGlass.menu.pricingNote");
  const pricingNote =
    menu.zone.minimumSpendIdr > 0
      ? `${taxNote} ${t("qrMenu.pricing.minimumSpend", { amount: formatRupiah(menu.zone.minimumSpendIdr) })}`
      : taxNote;

  // What the table cart holds per item; a card steps in place only when the
  // item sits on exactly one line.
  const cartByItem = new Map<string, ItemCartSummary>();
  for (const line of view?.cart.lines ?? []) {
    const known = cartByItem.get(line.menuItemId);
    cartByItem.set(line.menuItemId, {
      quantity: (known?.quantity ?? 0) + line.quantity,
      line: known ? null : { id: line.id, quantity: line.quantity },
    });
  }

  const setLabels = (next: string[]) =>
    onSearchChange({ labels: next.length ? next.join(",") : undefined });
  const toggleLabel = (label: string) =>
    setLabels(
      labels.includes(label)
        ? labels.filter((entry) => entry !== label)
        : [...labels, label],
    );

  const failureTitle = (error: unknown, name?: string) =>
    error instanceof ApiError && error.code === "CONFLICT"
      ? t("qrMenu.sheet.error.conflict")
      : error instanceof ApiError && error.code === "ITEM_SOLD_OUT" && name
        ? t("qrMenu.sheet.error.itemSoldOut", { name })
        : t("qrMenu.sheet.error.generic");

  const quickAdd = (item: QrMenuItem) => {
    if (!guest || !sessionId) return openJoin(item.id);
    if (!view) return;
    setAddingId(item.id);
    add.mutate(
      {
        cartVersion: view.cart.version,
        line: {
          menuItemId: item.id,
          variantId: null,
          quantity: 1,
          modifierIds: [],
        },
      },
      {
        onSuccess: () =>
          toast({
            title: t("qrMenu.toast.added", { name: item.name }),
            description: t("qrMenu.toast.addedHint"),
            tone: "success",
          }),
        onError: (error) =>
          toast({ title: failureTitle(error, item.name), tone: "danger" }),
        onSettled: () => setAddingId(null),
      },
    );
  };

  const step = (lineId: string, quantity: number) => {
    if (!view) return;
    setSteppingLineId(lineId);
    const handlers = {
      onError: (error: unknown) =>
        toast({ title: failureTitle(error), tone: "danger" as const }),
      onSettled: () => setSteppingLineId(null),
    };
    if (quantity <= 0)
      remove.mutate({ lineId, cartVersion: view.cart.version }, handlers);
    else
      change.mutate(
        { lineId, cartVersion: view.cart.version, patch: { quantity } },
        handlers,
      );
  };

  const retryMenu = () => {
    setRetrying(true);
    void queryClient
      .refetchQueries({ queryKey: menuQuery(qrToken).queryKey })
      .finally(() => setRetrying(false));
  };

  const openFromCart = (itemId: string) => onSearchChange({ item: itemId });
  const changeCategory = (cat: string | undefined) => onSearchChange({ cat });
  const toggleFilter = () => setFilterOpen((open) => !open);
  const canFilter = available.length > 0;

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_minmax(0,28rem)] lg:items-start lg:gap-12">
        <div className="hidden lg:sticky lg:top-32 lg:block lg:self-start">
          <MenuSidebar
            menu={menu}
            qrToken={qrToken}
            pax={joined ? pax : null}
            category={search.cat}
            onCategoryChange={changeCategory}
            filterId={filterId}
            filterOpen={filterOpen}
            filterCount={labels.length}
            canFilter={canFilter}
            onFilterToggle={toggleFilter}
            pricingNote={pricingNote}
          />
        </div>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
          {/* Mobile: the glass header and any panel opened from it stick
              together; desktop has no sticky header here. */}
          <div className="sticky top-3 z-30 grid grid-cols-[minmax(0,1fr)] gap-2 lg:static">
            <MenuHeader
              menu={menu}
              pax={joined ? pax : null}
              q={search.q ?? ""}
              onQChange={(q) => onSearchChange({ q })}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              category={search.cat}
              onCategoryChange={changeCategory}
              filterId={filterId}
              filterOpen={filterOpen}
              filterCount={labels.length}
              canFilter={canFilter}
              onFilterToggle={toggleFilter}
              sample={API_MOCK}
            />
            {joinOpen && !joined && canOrder && <GuestPanel />}
            {filterOpen && canFilter && (
              <LabelFilterPanel
                id={filterId}
                available={available}
                selected={labels}
                onToggle={toggleLabel}
                onClear={() => setLabels([])}
                onClose={() => setFilterOpen(false)}
              />
            )}
          </div>
          <QrFrameNotices />

          <header className="hidden gap-1 lg:grid">
            <h1 className="type-display-xl">{t("qrGlass.menu.title")}</h1>
            <p className="text-lg text-muted-foreground">
              {t("qrGlass.menu.subtitle")}
            </p>
          </header>

          {!joined && !joinOpen && canOrder && (
            <GuestRow className="lg:hidden" />
          )}
          {!menu.orderingOpen && (
            <Notice tone="warning" title={t("qrMenu.closedNow.title")}>
              {t("qrMenu.closedNow.hint")}
            </Notice>
          )}
          {ended ? <SessionEnded /> : <PendingConfirmationNotice />}
          <p className="text-base leading-snug text-muted-foreground lg:hidden">
            {pricingNote}
          </p>

          <div aria-live="polite" className="sr-only">
            {isFiltering(filter)
              ? t("qrMenu.filter.results", { count: countItems(sections) })
              : ""}
          </div>

          {menu.items.length === 0 ? (
            <EmptyState
              icon={UtensilsCrossed}
              title={t("qrMenu.states.emptyTitle")}
              description={t("qrMenu.states.emptyHint")}
            />
          ) : sections.length === 0 ? (
            <EmptyState
              icon={Search}
              title={t("qrMenu.states.noResultsTitle")}
              description={t("qrMenu.states.noResultsHint")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    onSearchChange({ q: "", cat: undefined, labels: undefined })
                  }
                >
                  {t("qrMenu.filter.clear")}
                </Button>
              }
            />
          ) : (
            sections.map(({ category, items }) => (
              <section
                key={category.id}
                aria-labelledby={`cat-${category.id}`}
                className="grid gap-3"
              >
                {/* The mockup shows one continuous grid; the category name
                    stays for screen readers. */}
                <h2 id={`cat-${category.id}`} className="sr-only">
                  {category.name}
                </h2>
                <ul className="grid grid-cols-2 gap-x-3 gap-y-6 lg:gap-x-6 lg:gap-y-8">
                  {items.map((item) => {
                    const cart = cartByItem.get(item.id);
                    return (
                      <ItemCard
                        key={item.id}
                        item={item}
                        orderingOpen={canOrder}
                        adding={addingId === item.id}
                        cart={cart}
                        stepBusy={
                          cart?.line ? steppingLineId === cart.line.id : false
                        }
                        onStep={step}
                        onOpen={(entry) => onSearchChange({ item: entry.id })}
                        onQuickAdd={quickAdd}
                      />
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="hidden gap-6 lg:sticky lg:top-32 lg:grid lg:self-start">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-1 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              role="searchbox"
              aria-label={t("qrMenu.search.label")}
              placeholder={t("qrGlass.menu.search.allMenu")}
              value={search.q ?? ""}
              onChange={(event) => onSearchChange({ q: event.target.value })}
              className="rounded-none border-0 border-b bg-transparent px-9 text-base shadow-none [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
              autoComplete="off"
              enterKeyHint="search"
            />
            {search.q && (
              <button
                type="button"
                onClick={() => onSearchChange({ q: "" })}
                className="absolute top-1/2 right-0 inline-grid size-11 -translate-y-1/2 place-items-center rounded-full hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X className="size-5" aria-hidden="true" />
                <span className="sr-only">{t("qrMenu.search.clear")}</span>
              </button>
            )}
          </div>
          <TableNota onOpenItem={openFromCart} />
        </div>
      </div>

      <ItemSheet
        item={openItem}
        onClose={() => onSearchChange({ item: undefined })}
      />

      {menuError && (
        <div
          role="status"
          className="qr-paper sticky bottom-[calc(var(--toast-inset-bottom,0px)+0.75rem)] z-20 flex items-center gap-3 rounded-qr-media p-3 shadow-raised lg:bottom-6 lg:mx-auto lg:w-full lg:max-w-xl"
        >
          <TriangleAlert
            className="size-5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-base leading-snug">
            {t("qrGlass.menu.stale.message")}
          </p>
          <button
            type="button"
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={retryMenu}
            className={`${qrTextLink} min-h-11 shrink-0 disabled:opacity-50`}
          >
            {t("qrGlass.menu.stale.retry")}
          </button>
        </div>
      )}
      <QrCartBar onOpenItem={openFromCart} />
    </>
  );
}
