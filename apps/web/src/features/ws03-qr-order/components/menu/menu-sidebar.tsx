// Desktop left index (lg): where the guest sits, the guest chip, the category
// list, the label-filter button, the pricing note and the shared-cart note.
import { ListFilter } from "lucide-react";
import type { QrMenu } from "@starter/shared/qr-order";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { RouterShellLink } from "@/components/layout/router-link";
import { qrTextLink } from "../glass/qr-primitives";
import { CategoryList } from "./category-index";
import { GuestChip } from "./guest-count";

export function MenuSidebar({
  menu,
  qrToken,
  pax,
  category,
  onCategoryChange,
  filterId,
  filterOpen,
  filterCount,
  canFilter,
  onFilterToggle,
  pricingNote,
}: {
  menu: QrMenu;
  qrToken: string;
  pax: number | null;
  category: string | undefined;
  onCategoryChange: (category: string | undefined) => void;
  filterId: string;
  filterOpen: boolean;
  filterCount: number;
  canFilter: boolean;
  onFilterToggle: () => void;
  pricingNote: string;
}) {
  const t = useT();
  return (
    <aside className="hidden content-start gap-6 lg:grid">
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          {t("qrGlass.menu.sitAt")}
        </p>
        <p className="type-title">
          {t("qrGlass.menu.table", { table: menu.table.code })}
        </p>
        {(pax !== null || menu.orderingOpen) && (
          <GuestChip pax={pax} className="mt-2" />
        )}
      </div>
      <CategoryList
        categories={menu.categories}
        active={category}
        onChange={onCategoryChange}
      />
      <div className="grid gap-4 border-t border-border pt-4">
        {canFilter && (
          <button
            type="button"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? filterId : undefined}
            onClick={onFilterToggle}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-qr-cta px-3 text-left text-base font-medium pressable hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              filterOpen && "bg-qr-selection",
            )}
          >
            <ListFilter className="size-5 shrink-0" aria-hidden="true" />
            <span>{t("qrGlass.menu.filter.open")}</span>
            {filterCount > 0 && (
              <span className="ms-auto grid size-6 place-items-center rounded-full bg-qr-coffee text-xs font-bold text-qr-on-dark">
                <span className="sr-only">
                  {t("qrGlass.menu.filter.openActive", { count: filterCount })}
                </span>
                <span aria-hidden="true">{filterCount}</span>
              </span>
            )}
          </button>
        )}
        <p className="px-3 text-base leading-snug text-muted-foreground">
          {pricingNote}
        </p>
      </div>
      <div className="grid justify-items-start gap-1 px-3 text-base leading-snug text-muted-foreground">
        <p>{t("qrGlass.menu.shared.note")}</p>
        <RouterShellLink
          href={`/t/${encodeURIComponent(qrToken)}/orders`}
          className={cn(qrTextLink, "text-foreground")}
        >
          {t("qrGlass.table.nav.orders")}
        </RouterShellLink>
      </div>
    </aside>
  );
}
