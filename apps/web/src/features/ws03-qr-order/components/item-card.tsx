// One menu item in the photo-first grid (DESIGN.md v2 §4 "Media"): the photo is
// the card — a 1:1 MediaPlate with the status badge top-left and the add button
// bottom-right — then name (2 lines), one-line description and price. No border
// and no padding around the plate. The name is the stretched link that opens
// the item sheet; the add button sits above it with its own tab stop.
import { Plus } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { hasPriceRange } from "../lib/item-options.ts";
import { PhotoBadge } from "./photo-badge";

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
  // One badge fits on the photo; any further labels keep a chip under the name.
  const [headline, ...otherLabels] = item.labels;
  const photoBadge = soldOut
    ? t("qrMenu.card.soldOut")
    : item.type === "combo"
      ? t("qrMenu.card.comboBadge")
      : headline
        ? labelText(t, headline)
        : null;
  return (
    <li className="relative grid min-w-0 content-start gap-2">
      {/* The plate isolates its overlays, so the add button sits beside it in a
          plain positioned wrapper to stay above the stretched link. */}
      <div className="relative">
        <MediaPlate
          ratio="card"
          src={item.photoUrl}
          alt=""
          muted={soldOut}
          topStart={
            photoBadge ? <PhotoBadge>{photoBadge}</PhotoBadge> : undefined
          }
        />
        {!soldOut && orderingOpen && (
          <Button
            type="button"
            size="icon"
            loading={adding}
            onClick={() => (quick ? onQuickAdd(item) : onOpen(item))}
            className="absolute end-2.5 bottom-2.5 z-10 size-10 rounded-full bg-card text-foreground shadow-card hover:bg-card/90"
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
      <div className="grid min-w-0 gap-0.5">
        <h3
          className={cn(
            "line-clamp-2 leading-snug font-semibold",
            soldOut && "text-muted-foreground",
          )}
        >
          <button
            type="button"
            onClick={() => onOpen(item)}
            aria-label={
              soldOut
                ? t("qrMenu.card.soldOutAria", { name: item.name })
                : t("qrMenu.card.viewAria", { name: item.name })
            }
            className="rounded-xs text-left after:absolute after:inset-0"
          >
            {item.name}
          </button>
        </h3>
        {item.description && (
          <p className="line-clamp-1 text-sm leading-5 text-muted-foreground">
            {item.description}
          </p>
        )}
        {otherLabels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {otherLabels.map((label) => (
              <Badge key={label} tone="neutral">
                {labelText(t, label)}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-0.5 flex items-baseline gap-1.5">
          {hasPriceRange(item) && (
            <span className="text-sm text-muted-foreground">
              {t("qrMenu.card.from")}
            </span>
          )}
          <Money
            amount={item.priceIdr}
            className={cn("font-semibold", soldOut && "text-muted-foreground")}
          />
        </div>
      </div>
    </li>
  );
}
