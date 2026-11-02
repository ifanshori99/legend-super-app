import { Heart } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { CustomerFavoriteItem } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { formatMemberDate } from "../format";

// Favorite menu items, most ordered first (PRD §3.21 "menu favorit", shown on
// the member page per PRD §3.20). Read-only: ordering happens through the
// menu, so the card does not invent an "order again" action.
export function FavoriteList({
  favorites,
}: {
  favorites: readonly CustomerFavoriteItem[];
}) {
  const t = useT();
  return (
    <ol className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
      {favorites.map((item, index) => (
        <li key={item.menuItemId} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-container bg-surface-3 text-xs font-semibold tabular">
            {formatNumber(index + 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-(length:--density-text) leading-6 font-medium">
              {item.name}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("member.favorites.ordered", {
                count: formatNumber(item.quantity),
              })}
              {" · "}
              {t("member.favorites.lastOrdered", {
                date: formatMemberDate(item.lastOrderedAt),
              })}
            </p>
          </div>
          <Heart
            className="mt-1 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </li>
      ))}
    </ol>
  );
}
