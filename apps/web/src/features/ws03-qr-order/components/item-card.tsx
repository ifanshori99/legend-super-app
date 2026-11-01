// One menu item in the list (DESIGN.md §10 quick pick: rounded-2xl border
// bg-card p-3). The name is the stretched link that opens the item sheet; the
// add button sits above it so both stay separate tab stops.
import { Plus } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { hasPriceRange } from "../lib/item-options.ts";
import { MenuMedia } from "./menu-media";

export function labelText(t: ReturnType<typeof useT>, label: string): string {
  const known = ["baru", "terlaris", "pedas", "vegetarian"] as const;
  return (known as readonly string[]).includes(label)
    ? t(`qrMenu.labels.${label as (typeof known)[number]}`)
    : label;
}

/** True when a tap on "Tambah" needs no choice and can add the item directly. */
export function isQuickAddable(item: QrMenuItem): boolean {
  return (
    item.status === "available" &&
    item.variants.length === 0 &&
    item.modifierGroups.every((group) => group.minSelect === 0)
  );
}

export function ItemCard({
  item,
  onOpen,
  onQuickAdd,
  orderingOpen,
  adding = false,
}: {
  item: QrMenuItem;
  onOpen: (item: QrMenuItem) => void;
  onQuickAdd: (item: QrMenuItem) => void;
  orderingOpen: boolean;
  adding?: boolean;
}) {
  const t = useT();
  const soldOut = item.status === "sold_out";
  const quick = isQuickAddable(item);
  return (
    <li className="relative flex gap-3 rounded-2xl border bg-card p-3">
      <div className="grid min-w-0 flex-1 content-start gap-1.5">
        <h3 className="text-base leading-6 font-semibold">
          <button
            type="button"
            onClick={() => onOpen(item)}
            aria-label={
              soldOut
                ? t("qrMenu.card.soldOutAria", { name: item.name })
                : t("qrMenu.card.viewAria", { name: item.name })
            }
            className="rounded-xs text-left after:absolute after:inset-0 after:rounded-2xl"
          >
            {item.name}
          </button>
        </h3>
        {(item.labels.length > 0 || item.type === "combo" || soldOut) && (
          <div className="flex flex-wrap gap-1.5">
            {soldOut && (
              <Badge tone="neutral">{t("qrMenu.card.soldOut")}</Badge>
            )}
            {item.type === "combo" && (
              <Badge tone="info">{t("qrMenu.card.comboBadge")}</Badge>
            )}
            {item.labels.map((label) => (
              <Badge key={label} tone="brand">
                {labelText(t, label)}
              </Badge>
            ))}
          </div>
        )}
        {item.description && (
          <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
            {item.description}
          </p>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          {hasPriceRange(item) && (
            <span className="text-sm text-muted-foreground">
              {t("qrMenu.card.from")}
            </span>
          )}
          <Money amount={item.priceIdr} className="font-semibold" />
        </div>
      </div>
      <div className="relative shrink-0">
        <MenuMedia
          name={item.name}
          photoUrl={item.photoUrl}
          className="size-24"
        />
        {!soldOut && orderingOpen && (
          <Button
            type="button"
            size="icon-sm"
            variant={quick ? "default" : "outline"}
            loading={adding}
            onClick={() => (quick ? onQuickAdd(item) : onOpen(item))}
            className="absolute -right-1 -bottom-1 z-10 shadow-raised"
          >
            <Plus aria-hidden="true" />
            <span className="sr-only">
              {quick
                ? t("qrMenu.card.addAria", { name: item.name })
                : t("qrMenu.card.chooseAria", { name: item.name })}
            </span>
          </Button>
        )}
      </div>
    </li>
  );
}
