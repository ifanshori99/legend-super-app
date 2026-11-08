// One optional companion suggestion ("Tambah croissant mentega? Opsional ·
// + Rp 23.000"), legend-2re1 / design/COLOR-RESEARCH.md "Pola penambahan
// pesanan". The server picks it (PRD AI-01: outlet rules, stock, hours) via
// the suggestions endpoint; the UI shows at most one, never pre-selects it,
// and never repeats an item already in the cart. Not shown on an empty cart,
// error, payment-in-progress or success screens (the callers decide).
import { useState } from "react";
import { Plus } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { useAddToCart, useMenuSuggestions } from "../../hooks";
import { isQuickAddable } from "../item-card";

/** The one companion to offer, or null. */
export function useCompanion(contextItemId?: string): QrMenuItem | null {
  const { menu, view, sessionId, ended } = useTableJourney();
  const { data } = useMenuSuggestions(ended ? null : sessionId, contextItemId);
  if (!menu || !view) return null;
  const inCart = new Set(view.cart.lines.map((line) => line.menuItemId));
  const candidates = (data?.data ?? [])
    .slice()
    .sort((a, b) => Number(b.kind === "pairing") - Number(a.kind === "pairing"))
    .map((suggestion) =>
      menu.items.find((item) => item.id === suggestion.menuItemId),
    )
    .filter(
      (item): item is QrMenuItem =>
        item !== undefined &&
        item.status === "available" &&
        item.id !== contextItemId &&
        !inCart.has(item.id),
    );
  return candidates[0] ?? null;
}

/**
 * Adds a no-choice companion straight to the shared cart; anything with
 * required choices opens its detail instead (onOpenItem).
 */
export function useCompanionAdd(onOpenItem: (itemId: string) => void) {
  const t = useT();
  const toast = useToast();
  const { sessionId, view } = useTableJourney();
  const add = useAddToCart(sessionId ?? "none");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const run = (item: QrMenuItem) => {
    if (!isQuickAddable(item) || !view || !sessionId)
      return onOpenItem(item.id);
    setPendingId(item.id);
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
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title:
              error instanceof ApiError && error.code === "ITEM_SOLD_OUT"
                ? t("qrMenu.sheet.error.itemSoldOut", { name: item.name })
                : t("qrMenu.sheet.error.generic"),
            tone: "danger",
          }),
        onSettled: () => setPendingId(null),
      },
    );
  };
  return { run, pendingId };
}

/**
 * The suggestion row. `tone="paper"` on the canvas (item detail, checkout);
 * `tone="nota"` is the white card inside the dark desktop nota.
 */
export function CompanionOffer({
  item,
  onOpenItem,
  tone = "paper",
  eyebrow,
  disabled = false,
  className,
}: {
  item: QrMenuItem;
  /** Locks the add while the page is placing an order or saving a line. */
  disabled?: boolean;
  onOpenItem: (itemId: string) => void;
  tone?: "paper" | "nota";
  /** Nota only, e.g. "Pendamping kopi · Opsional". */
  eyebrow?: string;
  className?: string;
}) {
  const t = useT();
  const { run, pendingId } = useCompanionAdd(onOpenItem);
  const busy = pendingId === item.id;
  const price = t("qrGlass.shared.companion.price", {
    amount: formatRupiah(item.priceIdr),
  });
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-qr-media border p-2.5 pe-3",
        tone === "paper"
          ? "border-primary/45 bg-card"
          : "border-transparent bg-card text-foreground",
        className,
      )}
    >
      {item.photoUrl ? (
        <img
          src={item.photoUrl}
          alt=""
          width={56}
          height={56}
          loading="lazy"
          decoding="async"
          className="size-14 shrink-0 rounded-lg object-cover"
        />
      ) : null}
      <div className="grid min-w-0 flex-1 gap-0.5">
        {tone === "nota" && eyebrow ? (
          <p className="truncate text-xs leading-4 text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <p className="line-clamp-2 leading-5 font-semibold">
          {tone === "nota"
            ? item.name
            : t("qrGlass.shared.companion.title", { name: item.name })}
        </p>
        <p className="truncate text-sm leading-5 text-muted-foreground tabular">
          {tone === "nota"
            ? price
            : `${t("qrGlass.shared.companion.optional")} · ${price}`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => run(item)}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
        className="inline-grid size-11 shrink-0 place-items-center rounded-full border border-primary bg-card text-primary pressable hover:bg-primary-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 [&_svg]:size-5"
      >
        <Plus aria-hidden="true" />
        <span className="sr-only">
          {t("qrGlass.shared.companion.addAria", { name: item.name })}
        </span>
      </button>
    </div>
  );
}
