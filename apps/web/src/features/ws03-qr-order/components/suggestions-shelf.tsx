// "Disarankan untuk Anda" shelf (PRD AI-01). The server applies the outlet's
// rules (margin, stock, hours) and returns only orderable items; the shelf just
// renders them and opens the same item sheet. It is the page's 4:5 carousel on
// the surface-2 band (DESIGN.md v2 §4 "Media", §5 "Surface composition").
import { Plus } from "lucide-react";
import type { MenuSuggestion, QrMenu } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { useMenuSuggestions } from "../hooks";
import { PhotoBadge } from "./photo-badge";

export function SuggestionsShelf({
  sessionId,
  menu,
  menuItemId,
  title,
  onPick,
}: {
  sessionId: string | null;
  menu: QrMenu;
  menuItemId?: string;
  title?: string;
  onPick: (itemId: string) => void;
}) {
  const t = useT();
  const { data } = useMenuSuggestions(sessionId, menuItemId);
  const picks = (data?.data ?? [])
    .map((suggestion: MenuSuggestion) => ({
      suggestion,
      item: menu.items.find((entry) => entry.id === suggestion.menuItemId),
    }))
    .filter(
      (entry) => entry.item !== undefined && entry.item.status === "available",
    );
  if (picks.length === 0) return null;
  return (
    <section
      aria-labelledby="suggestions-title"
      className="-mx-gutter grid gap-3 bg-surface-2 px-gutter py-4"
    >
      <div>
        <h2 id="suggestions-title" className="type-heading">
          {title ?? t("qrMenu.suggestions.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("qrMenu.suggestions.hint")}
        </p>
      </div>
      <ul className="-mx-gutter flex snap-x gap-3 overflow-x-auto px-gutter pb-1">
        {picks.map(({ suggestion, item }) =>
          item ? (
            <li
              key={item.id}
              className="relative grid w-[148px] shrink-0 snap-start content-start gap-1.5"
            >
              <div className="relative">
                <MediaPlate
                  ratio="thumb"
                  src={item.photoUrl}
                  alt=""
                  topStart={
                    suggestion.kind === "upgrade" ? (
                      <PhotoBadge>{t("qrMenu.suggestions.upgrade")}</PhotoBadge>
                    ) : undefined
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  onClick={() => onPick(item.id)}
                  className="absolute end-2.5 bottom-2.5 z-10 size-10 rounded-full bg-card text-foreground shadow-card hover:bg-card/90"
                >
                  <Plus aria-hidden="true" />
                  <span className="sr-only">
                    {t("qrMenu.card.chooseAria", { name: item.name })}
                  </span>
                </Button>
              </div>
              <p className="line-clamp-1 font-semibold">
                <button
                  type="button"
                  onClick={() => onPick(item.id)}
                  className="rounded-xs text-left after:absolute after:inset-0"
                >
                  {item.name}
                </button>
              </p>
              <Money amount={item.priceIdr} size="sm" className="font-medium" />
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
