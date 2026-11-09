// Mobile cart bar (legend-2re1, mockup final-a-menu-mobile): the floating
// coffee glass card at the bottom of the menu. Subtotal + item count, the one
// way to the shared cart, and a lighter optional companion row. With an empty
// cart but orders already placed, a lighter glass bar leads to "Pesanan meja"
// (the mobile menu has no other nav). Hidden from lg: the nota replaces it.
import { Link } from "@tanstack/react-router";
import { ChevronRight, ReceiptText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { useTableJourney } from "../../context";
import { useCompanion } from "../glass/companion-offer";
import { qrTextLink, useQrToastInset } from "../glass/qr-primitives";

export function QrCartBar({
  onOpenItem,
}: {
  onOpenItem: (itemId: string) => void;
}) {
  const t = useT();
  const { qrToken, menu, view, ended } = useTableJourney();
  const lines = view?.cart.lines ?? [];
  const companion = useCompanion(lines[0]?.menuItemId);
  const insetRef = useQrToastInset();
  if (ended || !view) return null;

  if (lines.length === 0) {
    if (view.orders.length === 0) return null;
    return (
      <Link
        ref={insetRef}
        to="/t/$token/orders"
        params={{ token: qrToken }}
        className="qr-glass sticky bottom-3 z-30 flex min-h-14 items-center justify-between gap-3 rounded-qr-float px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
      >
        <span className="grid min-w-0">
          <span className="font-semibold">
            {t("qrGlass.cart.bar.ordersPrompt")}
          </span>
          <span className="truncate text-sm leading-5 text-muted-foreground">
            {t("qrGlass.cart.bar.ordersHint")}
          </span>
        </span>
        <span className="inline-grid size-11 shrink-0 place-items-center rounded-full bg-card text-foreground">
          <ReceiptText aria-hidden="true" className="size-5" />
        </span>
      </Link>
    );
  }

  const soldOutIds = new Set(
    (menu?.items ?? [])
      .filter((item) => item.status !== "available")
      .map((item) => item.id),
  );
  const subtotal = lines
    .filter((line) => !soldOutIds.has(line.menuItemId))
    .reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const contextItem = menu?.items.find(
    (item) => item.id === lines[0]?.menuItemId,
  );
  const category = menu?.categories
    .find((entry) => entry.id === contextItem?.categoryId)
    ?.name.toLowerCase();

  return (
    <section
      ref={insetRef}
      aria-label={t("qrGlass.cart.bar.label")}
      className="qr-glass-dark sticky bottom-3 z-30 grid gap-3 rounded-qr-float p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="grid min-w-0">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("qrGlass.cart.bar.subtotal", { count })}
          </p>
          <Money
            amount={subtotal}
            size="xl"
            className="text-2xl leading-8 font-bold"
          />
        </div>
        <Link
          to="/t/$token/cart"
          params={{ token: qrToken }}
          className="flex min-h-11 items-center gap-3 rounded-full font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("qrGlass.cart.bar.open")}
          <span className="inline-grid size-11 place-items-center rounded-full bg-card text-foreground">
            <ChevronRight aria-hidden="true" className="size-5" />
          </span>
        </Link>
      </div>
      {companion && category ? (
        <div className="flex items-center justify-between gap-3 border-t border-qr-on-dark-muted/30 pt-3 text-qr-on-dark-muted">
          <p className="min-w-0">
            {t("qrGlass.cart.bar.companionPrompt", { category })}
          </p>
          <button
            type="button"
            onClick={() => onOpenItem(companion.id)}
            className={`${qrTextLink} shrink-0 text-qr-on-dark`}
          >
            {t("qrGlass.cart.bar.companionAction")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
