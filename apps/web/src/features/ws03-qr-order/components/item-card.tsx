// One menu item in the photo-first grid ("final arah A + liquid glass",
// design/mockups/final-a-menu-*.png): the photo is the card, a 1:1 plate with
// a 44px round paper add button bottom-right. When the item has exactly one
// cart line, that button becomes a paper stepper on the photo; desktop adds an
// "N di keranjang" chip top-left. Labels and the sold-out status are neutral
// chips under the name (status never by color alone). The name is the
// stretched link that opens the item sheet; add / stepper sit above it.
import { useEffect, useRef } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { hasPriceRange } from "../lib/item-options.ts";
import { QrStepper, qrRoundIcon } from "./glass/qr-primitives";

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

/** What the table cart holds of one item: total quantity and, when it is a
 * single line, that line (the only case the card can step in place). */
export type ItemCartSummary = {
  quantity: number;
  line: { id: string; quantity: number } | null;
};

export function ItemCard({
  item,
  onOpen,
  onQuickAdd,
  orderingOpen,
  adding = false,
  cart,
  onStep,
  stepBusy = false,
}: {
  item: QrMenuItem;
  onOpen: (item: QrMenuItem) => void;
  onQuickAdd: (item: QrMenuItem) => void;
  orderingOpen: boolean;
  adding?: boolean;
  cart?: ItemCartSummary;
  /** New quantity for the single cart line; 0 removes it. */
  onStep?: (lineId: string, quantity: number) => void;
  stepBusy?: boolean;
}) {
  const t = useT();
  const soldOut = item.status === "sold_out";
  const quick = isQuickAddable(item);
  const inCart = cart && cart.quantity > 0 ? cart : null;
  const steppable = !soldOut && orderingOpen && inCart?.line && onStep;
  // Stepping 1 -> 0 swaps the stepper for the add button; hand focus over so
  // keyboard users keep their place.
  const addRef = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  const hasStepper = Boolean(steppable);
  useEffect(() => {
    if (hasStepper) return;
    if (refocusAdd.current) addRef.current?.focus();
    refocusAdd.current = false;
  }, [hasStepper]);
  const chips = [
    ...(item.type === "combo" ? [t("qrMenu.card.comboBadge")] : []),
    ...item.labels.map((label) => labelText(t, label)),
  ];
  return (
    <li className="relative grid min-w-0 content-start gap-2">
      {/* The plate isolates its overlays, so the controls sit beside it in a
          plain positioned wrapper to stay above the stretched link. */}
      <div className="relative">
        <MediaPlate
          ratio="card"
          src={item.photoUrl}
          alt=""
          muted={soldOut}
          className="rounded-qr-media!"
          topStart={
            inCart && !soldOut ? (
              <span
                aria-hidden="true"
                className="inline-flex items-center rounded-full bg-card px-2.5 py-1 text-xs leading-4 font-semibold text-foreground shadow-raised max-lg:hidden"
              >
                {t("qrGlass.menu.card.inCart", { count: inCart.quantity })}
              </span>
            ) : undefined
          }
        />
        {steppable && inCart.line ? (
          <div className="absolute inset-x-2.5 bottom-2.5 z-10 flex justify-center">
            <QrStepper
              tone="paper"
              value={inCart.line.quantity}
              min={0}
              busy={stepBusy}
              onChange={(next) => {
                refocusAdd.current = next === 0;
                onStep(inCart.line!.id, next);
              }}
              decreaseLabel={t("qrGlass.menu.card.stepDecrease", {
                name: item.name,
              })}
              increaseLabel={t("qrGlass.menu.card.stepIncrease", {
                name: item.name,
              })}
              valueLabel={t("qrGlass.menu.card.inCart", {
                count: inCart.line.quantity,
              })}
              className="max-lg:w-full max-lg:justify-between"
            />
          </div>
        ) : (
          !soldOut &&
          orderingOpen && (
            <button
              ref={addRef}
              type="button"
              disabled={adding}
              aria-busy={adding || undefined}
              onClick={() => (quick ? onQuickAdd(item) : onOpen(item))}
              className={cn(qrRoundIcon, "absolute end-2.5 bottom-2.5 z-10")}
            >
              {adding ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              <span className="sr-only">
                {quick
                  ? t("qrMenu.card.addAria", { name: item.name })
                  : t("qrMenu.card.chooseAria", { name: item.name })}
              </span>
            </button>
          )
        )}
      </div>
      <div className="grid min-w-0 gap-1">
        <h3
          className={cn(
            "line-clamp-2 text-[1.0625rem] leading-snug font-bold lg:text-[1.375rem] lg:tracking-tight",
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
            className="rounded-xs text-left after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {item.name}
          </button>
        </h3>
        {(soldOut || chips.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {soldOut && (
              <Badge tone="neutral">
                {t("qrGlass.menu.card.soldOutLabel")}
              </Badge>
            )}
            {chips.map((chip) => (
              <Badge key={chip} tone="neutral">
                {chip}
              </Badge>
            ))}
          </div>
        )}
        {soldOut ? (
          <p className="text-base leading-snug text-muted-foreground">
            {t("qrGlass.menu.card.soldOutHint")}
          </p>
        ) : (
          item.description && (
            <p className="line-clamp-2 text-base leading-snug text-muted-foreground lg:hidden">
              {item.description}
            </p>
          )
        )}
        <div className="flex items-baseline gap-1.5">
          {hasPriceRange(item) && (
            <span className="text-sm text-muted-foreground">
              {t("qrMenu.card.from")}
            </span>
          )}
          <Money
            amount={item.priceIdr}
            className={cn("font-bold", soldOut && "text-muted-foreground")}
          />
        </div>
      </div>
    </li>
  );
}
