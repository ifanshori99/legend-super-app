// Mobile menu header: ONE glass region holding the brand, "Meja A01 · 2 tamu",
// the round search button (reveals a search field), the category chips and the
// filter button. The search field itself is a solid paper input inside it:
// glass is never the background of a form field's own surface.
import { useEffect, useRef } from "react";
import { ListFilter, Search, X } from "lucide-react";
import type { QrMenu } from "@starter/shared/qr-order";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { qrRoundIcon } from "../glass/qr-primitives";
import { CategoryChips } from "./category-index";

export function MenuHeader({
  menu,
  pax,
  q,
  onQChange,
  searchOpen,
  onSearchOpenChange,
  category,
  onCategoryChange,
  filterId,
  filterOpen,
  filterCount,
  canFilter,
  onFilterToggle,
  sample,
}: {
  menu: QrMenu;
  pax: number | null;
  q: string;
  onQChange: (value: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  category: string | undefined;
  onCategoryChange: (category: string | undefined) => void;
  filterId: string;
  filterOpen: boolean;
  filterCount: number;
  canFilter: boolean;
  onFilterToggle: () => void;
  /** Mock API in use: the sample-data badge stays visible. */
  sample: boolean;
}) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const opened = useRef(searchOpen);
  useEffect(() => {
    if (searchOpen && !opened.current) field.current?.focus();
    opened.current = searchOpen;
  }, [searchOpen]);
  const tableLine =
    pax === null
      ? t("qrGlass.menu.table", { table: menu.table.code })
      : t("qrGlass.menu.tableGuests", {
          table: menu.table.code,
          count: pax,
        });
  return (
    <header className="qr-glass grid grid-cols-[minmax(0,1fr)] gap-2 rounded-qr-float px-4 pt-3 pb-2 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate type-title">{menu.brand.name}</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-qr-glass-muted">
            <span>{tableLine}</span>
            {sample && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={searchOpen}
          onClick={() => onSearchOpenChange(!searchOpen)}
          className={qrRoundIcon}
        >
          {searchOpen ? (
            <X aria-hidden="true" />
          ) : (
            <Search aria-hidden="true" />
          )}
          <span className="sr-only">
            {searchOpen
              ? t("qrGlass.menu.search.close")
              : t("qrGlass.menu.search.open")}
          </span>
        </button>
      </div>
      {searchOpen && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={field}
            type="search"
            role="searchbox"
            aria-label={t("qrMenu.search.label")}
            placeholder={t("qrMenu.search.placeholder")}
            value={q}
            onChange={(event) => onQChange(event.target.value)}
            className="bg-card px-10 text-base [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
            autoComplete="off"
            enterKeyHint="search"
          />
          {q && (
            <button
              type="button"
              onClick={() => onQChange("")}
              className="absolute top-1/2 right-1 inline-grid size-11 -translate-y-1/2 place-items-center rounded-full hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X className="size-5" aria-hidden="true" />
              <span className="sr-only">{t("qrMenu.search.clear")}</span>
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-qr-glass-muted/25 pt-1">
        <CategoryChips
          categories={menu.categories}
          active={category}
          onChange={onCategoryChange}
        />
        {canFilter && (
          <button
            type="button"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? filterId : undefined}
            onClick={onFilterToggle}
            className={cn(
              "relative inline-grid size-11 shrink-0 place-items-center rounded-full pressable hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-5",
              filterOpen && "bg-qr-selection",
            )}
          >
            <ListFilter aria-hidden="true" />
            {filterCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-qr-coffee text-xs font-bold text-qr-on-dark"
              >
                {filterCount}
              </span>
            )}
            <span className="sr-only">
              {filterCount > 0
                ? t("qrGlass.menu.filter.openActive", { count: filterCount })
                : t("qrGlass.menu.filter.open")}
            </span>
          </button>
        )}
      </div>
    </header>
  );
}
