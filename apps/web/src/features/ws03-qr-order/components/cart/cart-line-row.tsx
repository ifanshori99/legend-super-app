// One line of the shared cart. Anyone at the table can change it; the line says
// who added it so nobody is surprised by a change.
import { Trash2 } from "lucide-react";
import type { CartLine } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Notice } from "../notice";
import { Stepper } from "../stepper";

export function CartLineRow({
  line,
  soldOut,
  mine,
  busy,
  onQuantity,
  onRemove,
}: {
  line: CartLine;
  soldOut: boolean;
  /** True: added from this phone. False: another guest. Null: unknown. */
  mine: boolean | null;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const options = line.modifiers.map((modifier) => modifier.name).join(", ");
  return (
    <li className="grid gap-3 rounded-2xl border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="font-semibold">{line.name}</p>
          {options && (
            <p className="text-sm leading-5 text-muted-foreground">{options}</p>
          )}
          {line.note && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("qrCart.cart.note", { note: line.note })}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {soldOut && <Badge tone="danger">{t("qrCart.cart.soldOut")}</Badge>}
            {mine !== null && (
              <Badge tone="neutral">
                {mine
                  ? t("qrCart.cart.addedBy.you")
                  : t("qrCart.cart.addedBy.other")}
              </Badge>
            )}
          </div>
        </div>
        <Money amount={line.lineTotalIdr} className="font-semibold" />
      </div>
      {soldOut && (
        <Notice tone="warning" title={t("qrCart.cart.soldOutLine")} />
      )}
      <div className="flex items-center justify-between gap-3">
        {soldOut ? (
          <span />
        ) : (
          <Stepper
            value={line.quantity}
            min={1}
            max={99}
            disabled={busy}
            onChange={onQuantity}
            decreaseLabel={t("qrCart.cart.decrease", { name: line.name })}
            increaseLabel={t("qrCart.cart.increase", { name: line.name })}
            valueLabel={`${line.name} ${line.quantity}`}
          />
        )}
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
      </div>
    </li>
  );
}
