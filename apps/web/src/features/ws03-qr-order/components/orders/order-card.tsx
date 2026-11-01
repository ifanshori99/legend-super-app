// One order: number, time placed, phase, items with status, summary and the
// optional serving estimate (PRD §3 F10 "Estimasi Waktu Saji"). One bordered
// container per order; rows are separated by dividers, no card inside a card.
import { Link } from "@tanstack/react-router";
import { Ban, CircleCheck, Wallet } from "lucide-react";
import type { QrOrder } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { orderPhase } from "../../domain";
import { ItemStatusRow } from "./item-status-row";

export type OrderEta = { minMinutes: number; maxMinutes: number };

function PhaseBadge({ phase }: { phase: ReturnType<typeof orderPhase> }) {
  const t = useT();
  switch (phase) {
    case "awaiting_payment":
      return (
        <Badge tone="warning">
          <Wallet aria-hidden="true" />
          {t("qrOrders.status.phase.awaitingPayment")}
        </Badge>
      );
    case "voided":
      return (
        <Badge tone="danger">
          <Ban aria-hidden="true" />
          {t("qrOrders.status.phase.voided")}
        </Badge>
      );
    case "completed":
      return (
        <Badge tone="success">
          <CircleCheck aria-hidden="true" />
          {t("qrOrders.status.phase.completed")}
        </Badge>
      );
    default:
      return <StatusPill status={phase} />;
  }
}

export function OrderCard({
  order,
  qrToken,
  timeZone,
  etaByOrderId,
}: {
  order: QrOrder;
  qrToken: string;
  /** Outlet time zone (menu.outlet.timeZone). */
  timeZone: string;
  /** Only from WS-04 order pacing (useOrderEtas); never invented here. */
  etaByOrderId?: Record<string, OrderEta>;
}) {
  const t = useT();
  const phase = orderPhase(order);
  const time = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(order.placedAt));

  const liveItems = order.items.filter((item) => item.status !== "voided");
  const delivered = liveItems.filter((item) => item.status === "served").length;

  const eta = etaByOrderId?.[order.id];
  const showEta =
    eta !== undefined &&
    (phase === "received" || phase === "preparing" || phase === "ready");
  const estimate =
    showEta && eta !== undefined
      ? {
          min: eta.minMinutes,
          max: eta.maxMinutes,
          range: eta.minMinutes !== eta.maxMinutes,
        }
      : null;

  return (
    <article
      aria-labelledby={`order-${order.id}`}
      className="grid gap-3 rounded-xl border bg-card p-card"
    >
      <header className="flex flex-col items-start gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="grid gap-0.5">
          <h2
            id={`order-${order.id}`}
            className="tabular text-lg leading-7 font-semibold"
          >
            {t("qrOrders.status.order.heading", { number: order.number })}
          </h2>
          <p className="tabular text-sm leading-5 text-muted-foreground">
            {t("qrOrders.status.order.placedAt", { time })}
          </p>
        </div>
        <PhaseBadge phase={phase} />
      </header>

      {phase === "awaiting_payment" && (
        <div className="grid gap-3 border-t pt-3">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("qrOrders.status.order.awaitingPaymentNote")}
          </p>
          <Button asChild className="w-full sm:w-fit">
            <Link to="/t/$token/checkout" params={{ token: qrToken }}>
              {t("qrOrders.status.order.payNow")}
            </Link>
          </Button>
        </div>
      )}

      {phase === "voided" && (
        <p className="border-t pt-3 text-sm leading-5 text-muted-foreground">
          {t("qrOrders.status.order.voidedNote")}
        </p>
      )}

      {order.items.length > 0 && (
        <ul
          aria-label={t("qrOrders.status.order.itemsLabel", {
            number: order.number,
          })}
          className="divide-y border-t pt-3"
        >
          {order.items.map((item) => (
            <ItemStatusRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      {liveItems.length > 0 && phase !== "awaiting_payment" && (
        <div className="grid gap-1 border-t pt-3">
          <p
            aria-live="polite"
            className="tabular text-sm leading-5 font-semibold"
          >
            {delivered === liveItems.length
              ? t("qrOrders.status.order.allDelivered")
              : t("qrOrders.status.order.summary", {
                  delivered,
                  total: liveItems.length,
                })}
          </p>
          {estimate !== null && (
            <p className="tabular text-sm leading-5 text-muted-foreground">
              {estimate.range
                ? t("qrOrders.status.order.eta", {
                    min: estimate.min,
                    max: estimate.max,
                  })
                : t("qrOrders.status.order.etaSingle", { min: estimate.min })}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
