// One line of the shared cart, on a paper card (legend-2re1, mockup "Keranjang
// & bayar"). Anyone at the table can change it; the line says who added it so
// nobody is surprised by a change. Lowering the quantity at 1 removes the line.
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { CartLine } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { Notice } from "../notice";
import { QrStepper, qrTextLink } from "../glass/qr-primitives";

export function CartLineRow({
  line,
  token,
  photoUrl,
  soldOut,
  availableLabel = null,
  mine,
  busy,
  onQuantity,
  onRemove,
}: {
  line: CartLine;
  /** Table QR token: "Ubah pilihan" reopens the item on the menu. */
  token: string;
  /** Photo of the menu item today; null when it has none (quiet plate). */
  photoUrl: string | null;
  soldOut: boolean;
  /** "Tersedia mulai HH:mm" for a line outside its sales window; null: sold out. */
  availableLabel?: string | null;
  /** True: added from this phone. False: another guest. Null: unknown. */
  mine: boolean | null;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const details = [
    line.modifiers.map((modifier) => modifier.name).join(", "),
    line.note ? t("qrCart.cart.note", { note: line.note }) : "",
    mine === null
      ? ""
      : mine
        ? t("qrCart.cart.addedBy.you")
        : t("qrCart.cart.addedBy.other"),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="grid gap-2 rounded-qr-media bg-card p-3">
      <div className="flex gap-3">
        <MediaPlate
          src={photoUrl}
          alt=""
          muted={soldOut}
          className="size-18 shrink-0 rounded-xl"
        />
        <div className="grid min-w-0 flex-1 content-start gap-1">
          <div className="flex items-start justify-between gap-3">
            <p className="leading-snug font-semibold">{line.name}</p>
            <Money amount={line.lineTotalIdr} className="font-bold" />
          </div>
          {(details || soldOut) && (
            <p className="text-sm leading-5 text-muted-foreground">
              {soldOut && (
                <Badge tone="danger" className="me-1.5">
                  {availableLabel ?? t("qrCart.cart.soldOut")}
                </Badge>
              )}
              {details}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            {soldOut ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onRemove}
              >
                <Trash2 aria-hidden="true" />
                <span aria-hidden="true">{t("qrCart.cart.remove")}</span>
                <span className="sr-only">
                  {t("qrCart.cart.removeAria", { name: line.name })}
                </span>
              </Button>
            ) : (
              <>
                <Link
                  to="/t/$token"
                  params={{ token }}
                  search={{ item: line.menuItemId }}
                  className={`${qrTextLink} min-h-11`}
                >
                  {t("qrGlass.checkout.editOptions")}
                  <span className="sr-only">
                    {" "}
                    {t("qrGlass.checkout.editOptionsAria", {
                      name: line.name,
                    })}
                  </span>
                </Link>
                <QrStepper
                  tone="outline"
                  value={line.quantity}
                  min={0}
                  max={99}
                  busy={busy}
                  onChange={(quantity) =>
                    quantity === 0 ? onRemove() : onQuantity(quantity)
                  }
                  decreaseLabel={
                    line.quantity <= 1
                      ? t("qrCart.cart.removeAria", { name: line.name })
                      : t("qrCart.cart.decrease", { name: line.name })
                  }
                  increaseLabel={t("qrCart.cart.increase", { name: line.name })}
                  valueLabel={`${line.name} ${line.quantity}`}
                />
              </>
            )}
          </div>
        </div>
      </div>
      {soldOut && (
        <Notice
          tone="warning"
          title={t(
            availableLabel
              ? "qrCart.cart.soldOutLineUntil"
              : "qrCart.cart.soldOutLine",
          )}
        />
      )}
    </li>
  );
}
