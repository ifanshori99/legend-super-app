// One order: number, time placed, phase, items with status, summary and the
// optional serving estimate (PRD §3 F10 "Estimasi Waktu Saji"). One paper
// panel per order; rows are separated by hairline dividers, no card inside a
// card.
import { Link } from "@tanstack/react-router";
import { Ban, Wallet } from "lucide-react";
import type { QrOrder } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { orderPhase } from "../../domain";
import { ItemStatusRow } from "./item-status-row";

export type OrderEta = { minMinutes: number; maxMinutes: number };

// v3: every order phase is a StatusPill (icon + text, DESIGN.md §4). The four
// kitchen phases map to their aliases; the bill/void states reuse a tone.
function PhaseBadge({ phase }: { phase: ReturnType<typeof orderPhase> }) {
  const t = useT();
  switch (phase) {
    case "awaiting_payment":
      return (
        <StatusPill status="warning" icon={Wallet}>
          {t("qrOrders.status.phase.awaitingPayment")}
        </StatusPill>
      );
    case "voided":
      return (
        <StatusPill status="danger" icon={Ban}>
          {t("qrOrders.status.phase.voided")}
        </StatusPill>
      );
    case "completed":
      return (
        <StatusPill status="success">
          {t("qrOrders.status.phase.completed")}
        </StatusPill>
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
  isPrimaryPay = false,
}: {
  order: QrOrder;
  qrToken: string;
  /** Outlet time zone (menu.outlet.timeZone). */
  timeZone: string;
  /** Only from WS-04 order pacing (useOrderEtas); never invented here. */
  etaByOrderId?: Record<string, OrderEta>;
  /** True for the first awaiting-payment order on the page: the only rust CTA. */
  isPrimaryPay?: boolean;
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
      className="qr-paper grid gap-3 p-4"
    >
      <header className="flex flex-col items-start gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="grid gap-0.5">
          <h2 id={`order-${order.id}`} className="type-title tabular">
            {t("qrOrders.status.order.heading", { number: order.number })}
          </h2>
          <p className="tabular text-sm leading-5 text-muted-foreground">
            {t("qrOrders.status.order.placedAt", { time })}
          </p>
        </div>
        <PhaseBadge phase={phase} />
      </header>

      {phase === "awaiting_payment" && (
        <div className="grid gap-3 border-t border-border pt-3">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("qrOrders.status.order.awaitingPaymentNote")}
          </p>
          <Button
            asChild
            variant={isPrimaryPay ? "default" : "outline"}
            className="w-full sm:w-fit"
          >
            <Link to="/t/$token/checkout" params={{ token: qrToken }}>
              {t("qrOrders.status.order.payNow")}
            </Link>
          </Button>
        </div>
      )}

      {phase === "voided" && (
        <p className="border-t border-border pt-3 text-sm leading-5 text-muted-foreground">
          {t("qrOrders.status.order.voidedNote")}
        </p>
      )}

      {order.items.length > 0 && (
        <ul
          aria-label={t("qrOrders.status.order.itemsLabel", {
            number: order.number,
          })}
          className="divide-y divide-border border-t border-border pt-3"
        >
          {order.items.map((item) => (
            <ItemStatusRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      {liveItems.length > 0 && phase !== "awaiting_payment" && (
        <div className="grid gap-1 border-t border-border pt-3">
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
