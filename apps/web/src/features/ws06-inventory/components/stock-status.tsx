// Shared status renderers for the stock-control screens: the backend stores
// codes, the UI always shows icon + text (DESIGN.md, WCAG 1.4.1).
import { CalendarOff } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  ParStatus,
  StockBatchExpiryStatus,
  StockMovementType,
  StockSourceType,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";

/** PRD §6.E movement codes → catalog labels (stock card and filters). */
export const MOVEMENT_LABEL: Record<StockMovementType, MessageKey> = {
  receipt: "inventoryStock.movement.receipt",
  sale: "inventoryStock.movement.sale",
  production_in: "inventoryStock.movement.production_in",
  production_out: "inventoryStock.movement.production_out",
  transfer_in: "inventoryStock.movement.transfer_in",
  transfer_out: "inventoryStock.movement.transfer_out",
  waste: "inventoryStock.movement.waste",
  adjustment: "inventoryStock.movement.adjustment",
  duty_meal: "inventoryStock.movement.duty_meal",
  return: "inventoryStock.movement.return",
};

/** PRD §6.E source documents → catalog labels (stock card "Sumber"). */
export const SOURCE_LABEL: Record<StockSourceType, MessageKey> = {
  goods_receipt: "inventoryStock.source.goods_receipt",
  order: "inventoryStock.source.order",
  production_order: "inventoryStock.source.production_order",
  stock_transfer: "inventoryStock.source.stock_transfer",
  stock_count: "inventoryStock.source.stock_count",
  waste_log: "inventoryStock.source.waste_log",
  purchase_return: "inventoryStock.source.purchase_return",
  duty_meal: "inventoryStock.source.duty_meal",
};

export function ParStatusPill({ status }: { status: ParStatus }) {
  const t = useT();
  if (status === "below_min")
    return (
      <StatusPill status="danger">
        {t("inventoryStock.parStatus.below_min")}
      </StatusPill>
    );
  if (status === "above_max")
    return (
      <StatusPill status="info">
        {t("inventoryStock.parStatus.above_max")}
      </StatusPill>
    );
  return (
    <StatusPill status="success">
      {t("inventoryStock.parStatus.within")}
    </StatusPill>
  );
}

export function ExpiryStatusPill({
  status,
}: {
  status: StockBatchExpiryStatus;
}) {
  const t = useT();
  if (status === "expired")
    return (
      <StatusPill status="danger">
        {t("inventoryStock.expiry.status.expired")}
      </StatusPill>
    );
  if (status === "expiring_soon")
    return (
      <StatusPill status="warning">
        {t("inventoryStock.expiry.status.expiring_soon")}
      </StatusPill>
    );
  if (status === "no_expiry")
    return (
      <Badge tone="neutral">
        <CalendarOff aria-hidden="true" />
        {t("inventoryStock.expiry.status.no_expiry")}
      </Badge>
    );
  return (
    <StatusPill status="success">
      {t("inventoryStock.expiry.status.fresh")}
    </StatusPill>
  );
}
