import { CirclePause, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { formatRupiah } from "@starter/shared/i18n";
import { StatusPill } from "@/features/ws04-pos-kasir/components/shared";

type Line = {
  id: string;
  name: string;
  quantity: number;
  unitPriceIdr: number;
  modifiersTotalIdr: number;
  lineTotalIdr: number;
  fireStatus: "held" | "fired";
  status: string;
};

// The order's lines. A line the kitchen voided carries a warning pill (icon and
// text); its price stays, because the bill does not change until the POS void.
// A held line (not sent to the kitchen yet) carries a "Ditahan" pill.
export function OrderLines({
  items,
  kitchenVoided,
}: {
  items: readonly Line[];
  kitchenVoided: ReadonlySet<string>;
}) {
  const t = useT();
  return (
    <ul className="divide-y divide-border border-t border-border">
      {items.map((item) => {
        const unit = item.unitPriceIdr + item.modifiersTotalIdr;
        const sent = item.fireStatus === "fired";
        return (
          <li
            key={item.id}
            className="flex items-start justify-between gap-3 py-4"
          >
            <div className="grid min-w-0 gap-1">
              <strong className="font-semibold break-words">{item.name}</strong>
              <span className="text-base text-muted-foreground">
                {t("posOrderDetail.item.line", {
                  quantity: item.quantity,
                  price: formatRupiah(unit),
                })}
                {sent ? ` · ${t("posOrderDetail.item.sent")}` : ""}
              </span>
              {item.status === "voided" ? (
                <StatusPill tone="neutral" className="w-fit">
                  {t("posOrderDetail.item.voided")}
                </StatusPill>
              ) : kitchenVoided.has(item.id) ? (
                <StatusPill
                  tone="warning"
                  icon={TriangleAlert}
                  className="w-fit"
                >
                  {t("posOrderDetail.item.kitchenVoided")}
                </StatusPill>
              ) : !sent ? (
                <StatusPill tone="warning" icon={CirclePause} className="w-fit">
                  {t("posOrderDetail.item.held")}
                </StatusPill>
              ) : null}
            </div>
            <Money amount={item.lineTotalIdr} className="font-semibold" />
          </li>
        );
      })}
    </ul>
  );
}
