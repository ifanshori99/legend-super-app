import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";

// Phones only: a fixed bar at the bottom of the menu view that shows the item
// count and subtotal and opens the cart view. Always tappable, also when the
// cart is empty (the cart view explains what to do).
export function MobileCartBar({
  itemCount,
  subtotalIdr,
  onOpen,
}: {
  itemCount: number;
  subtotalIdr: number;
  onOpen: () => void;
}) {
  const t = useT();
  const empty = itemCount === 0;
  return (
    <button
      type="button"
      data-slot="mobile-cart-bar"
      onClick={onOpen}
      className="fixed inset-x-0 bottom-0 z-30 flex min-h-19 items-center justify-between gap-3 bg-primary px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-left font-semibold text-primary-foreground min-[701px]:hidden"
    >
      <span className="grid min-w-0">
        <span className="text-sm">
          {empty
            ? t("posOrderCart.mobileBar.emptyTitle")
            : t("posOrderCart.mobileBar.summary", { count: itemCount })}
        </span>
        {empty ? (
          <span className="text-base">
            {t("posOrderCart.mobileBar.emptyHint")}
          </span>
        ) : (
          <Money amount={subtotalIdr} className="text-lg" />
        )}
      </span>
      <span className="shrink-0 text-base">
        {t("posOrderCart.mobileBar.view")}
      </span>
    </button>
  );
}
