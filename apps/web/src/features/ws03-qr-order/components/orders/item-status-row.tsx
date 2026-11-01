// One item of an order: name x quantity, modifiers and note as secondary text,
// the status pill (icon + text) and the four-step progress.
import { Ban } from "lucide-react";
import type { QrOrderItem } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { itemStep } from "../../domain";
import { OrderStepper } from "./order-stepper";

export function ItemStatusRow({ item }: { item: QrOrderItem }) {
  const t = useT();
  const step = itemStep(item.status);
  const details = [
    ...item.modifiers.map((modifier) => modifier.name),
    ...(item.note ? [t("qrOrders.status.item.note", { note: item.note })] : []),
  ];
  return (
    <li className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p
            className={
              step === null
                ? "text-(length:--density-text) leading-6 font-semibold text-muted-foreground line-through"
                : "text-(length:--density-text) leading-6 font-semibold"
            }
          >
            {item.name}{" "}
            <span className="tabular font-medium text-muted-foreground">
              {t("qrOrders.status.order.quantity", { quantity: item.quantity })}
            </span>
          </p>
          {details.length > 0 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {details.join(", ")}
            </p>
          )}
        </div>
        {step === null ? (
          <Badge tone="danger">
            <Ban aria-hidden="true" />
            {t("qrOrders.status.item.voided")}
          </Badge>
        ) : (
          <StatusPill status={step} />
        )}
      </div>
      {step !== null && <OrderStepper step={step} />}
    </li>
  );
}
