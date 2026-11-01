// "Disarankan untuk Anda" shelf (PRD AI-01). The server applies the outlet's
// rules (margin, stock, hours) and returns only orderable items; the shelf
// just renders them and opens the same item sheet.
import { Plus } from "lucide-react";
import type { MenuSuggestion, QrMenu } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { useMenuSuggestions } from "../hooks";
import { MenuMedia } from "./menu-media";

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
    <section aria-labelledby="suggestions-title" className="grid gap-2">
      <div>
        <h2 id="suggestions-title" className="text-lg leading-7 font-semibold">
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
              className="relative grid w-44 shrink-0 snap-start content-start gap-2 rounded-2xl border bg-card p-3"
            >
              <MenuMedia
                name={item.name}
                photoUrl={item.photoUrl}
                className="aspect-[4/3] w-full"
              />
              <div className="grid min-w-0 content-start gap-1">
                {suggestion.kind === "upgrade" && (
                  <Badge tone="info" className="w-fit">
                    {t("qrMenu.suggestions.upgrade")}
                  </Badge>
                )}
                <p className="line-clamp-2 min-h-12 font-semibold">
                  <button
                    type="button"
                    onClick={() => onPick(item.id)}
                    className="rounded-xs text-left after:absolute after:inset-0 after:rounded-2xl"
                  >
                    {item.name}
                  </button>
                </p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Money
                  amount={item.priceIdr}
                  size="sm"
                  className="font-semibold"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="relative z-10"
                  onClick={() => onPick(item.id)}
                >
                  <Plus aria-hidden="true" />
                  <span className="sr-only">
                    {t("qrMenu.card.chooseAria", { name: item.name })}
                  </span>
                </Button>
              </div>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
