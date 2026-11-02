// The QR menu (PRD §3 F10 "Menu & Keranjang"): category chips, search, label
// filters, sold-out items shown but not addable, item sheet, suggestions.
// Server-rendered from the route loader; filters live in the URL so a filtered
// view survives reload and can be shared at the table.
import { useEffect, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { UtensilsCrossed } from "lucide-react";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTableJourney } from "../context";
import { useAddToCart } from "../hooks";
import {
  countItems,
  filterMenu,
  isFiltering,
  menuLabels,
  type MenuFilter,
} from "../lib/menu-filter.ts";
import { ItemCard, labelText } from "./item-card";
import { ItemSheet } from "./item-sheet";
import { Notice } from "./notice";
import {
  MenuLoadState,
  PendingConfirmationNotice,
  SessionEnded,
} from "./session-states";
import { SuggestionsShelf } from "./suggestions-shelf";

export type MenuSearch = {
  q?: string;
  cat?: string;
  labels?: string;
  item?: string;
};

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? "secondary" : "outline"}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(pressed && "border-(length:--border-w) border-primary")}
    >
      {pressed && <Check aria-hidden="true" />}
      {children}
    </Button>
  );
}

function MenuSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">{t("qrMenu.states.loading")}</span>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-9 w-2/3" />
      {/* Mirrors the photo-first grid: a 1:1 plate and two text lines. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-6">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid content-start gap-2">
            <Skeleton className="aspect-card w-full rounded-media" />
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
  const journey = useTableJourney();
  const {
    menu,
    menuError,
    sessionId,
    view,
    guest,
    ended,
    openJoin,
    pendingItemId,
    clearPendingItem,
  } = journey;
  const add = useAddToCart(sessionId ?? "none");
  const [addingId, setAddingId] = useState<string | null>(null);

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
  const taxRate = menu.pricing.taxes[0];

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
          toast({
            title:
              error instanceof ApiError && error.code === "CONFLICT"
                ? t("qrMenu.sheet.error.conflict")
                : error instanceof ApiError && error.code === "ITEM_SOLD_OUT"
                  ? t("qrMenu.sheet.error.itemSoldOut", { name: item.name })
                  : t("qrMenu.sheet.error.generic"),
            tone: "danger",
          }),
        onSettled: () => setAddingId(null),
      },
    );
  };

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="type-display-xl">{t("qrMenu.nav.menu")}</h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="text-muted-foreground">
          {menu.zone.name}
          {" · "}
          {menu.zone.paymentMode === "pay_first"
            ? t("qrMenu.mode.payFirst")
            : t("qrMenu.mode.openBill")}
          {view &&
            ` · ${t("qrMenu.join.paxValue", { count: view.session.pax })}`}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {taxRate
            ? t("qrMenu.pricing.note", {
                service: menu.pricing.serviceChargeBp / 100,
                tax: taxRate.rateBp / 100,
              })
            : t("qrMenu.pricing.noteNoTax", {
                service: menu.pricing.serviceChargeBp / 100,
              })}
          {menu.zone.minimumSpendIdr > 0 &&
            ` ${t("qrMenu.pricing.minimumSpend", { amount: formatRupiah(menu.zone.minimumSpendIdr) })}`}
        </p>
      </header>

      {!menu.orderingOpen && (
        <Notice tone="warning" title={t("qrMenu.closedNow.title")}>
          {t("qrMenu.closedNow.hint")}
        </Notice>
      )}
      {ended ? <SessionEnded /> : <PendingConfirmationNotice />}

      <div className="sticky top-0 z-20 -mx-gutter grid gap-2 border-b bg-background px-gutter pt-1 pb-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            role="searchbox"
            aria-label={t("qrMenu.search.label")}
            placeholder={t("qrMenu.search.placeholder")}
            value={search.q ?? ""}
            onChange={(event) => onSearchChange({ q: event.target.value })}
            className="px-10 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
            autoComplete="off"
            enterKeyHint="search"
          />
          {search.q && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => onSearchChange({ q: "" })}
            >
              <X aria-hidden="true" />
              <span className="sr-only">{t("qrMenu.search.clear")}</span>
            </Button>
          )}
        </div>
        <nav
          aria-label={t("qrMenu.category.navLabel")}
          className="-mx-gutter flex gap-2 overflow-x-auto px-gutter pb-0.5"
        >
          <Chip
            pressed={search.cat === undefined}
            onClick={() => onSearchChange({ cat: undefined })}
          >
            {t("qrMenu.category.all")}
          </Chip>
          {[...menu.categories]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((category) => (
              <Chip
                key={category.id}
                pressed={search.cat === category.id}
                onClick={() => onSearchChange({ cat: category.id })}
              >
                {category.name}
              </Chip>
            ))}
        </nav>
      </div>

      {available.length > 0 && (
        <div
          role="group"
          aria-label={t("qrMenu.filter.label")}
          className="-mx-gutter flex gap-2 overflow-x-auto px-gutter pb-0.5"
        >
          {available.map((label) => (
            <Chip
              key={label}
              pressed={labels.includes(label)}
              onClick={() => {
                const next = labels.includes(label)
                  ? labels.filter((entry) => entry !== label)
                  : [...labels, label];
                onSearchChange({
                  labels: next.length ? next.join(",") : undefined,
                });
              }}
            >
              {labelText(t, label)}
            </Chip>
          ))}
        </div>
      )}

      {!isFiltering(filter) && sessionId && !ended && (
        <SuggestionsShelf
          sessionId={sessionId}
          menu={menu}
          onPick={(id) => onSearchChange({ item: id })}
        />
      )}

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
            <div className="flex items-baseline justify-between gap-3">
              <h2 id={`cat-${category.id}`} className="type-title">
                {category.name}
              </h2>
              <Badge tone="neutral">
                {t("qrMenu.section.count", { count: items.length })}
              </Badge>
            </div>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-6">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  orderingOpen={menu.orderingOpen && !ended}
                  adding={addingId === item.id}
                  onOpen={(entry) => onSearchChange({ item: entry.id })}
                  onQuickAdd={quickAdd}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <ItemSheet
        item={openItem}
        onClose={() => onSearchChange({ item: undefined })}
      />
    </div>
  );
}
