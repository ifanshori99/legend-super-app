// "Pesanan": status of every order of the table session, waiter actions and
// the path to the bill (bead legend-woz, PRD §3 F10 "Status Pesanan", flows
// A and B, ORD-07). Data comes from hooks only.
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ClipboardList, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { QrSubPage } from "@/features/ws03-qr-order/components/session-states";
import { useTableJourney } from "@/features/ws03-qr-order/context";
import { useOrderEtas, useSessionView } from "@/features/ws03-qr-order/hooks";
import { useOnline } from "@/lib/use-online";
import { orderPhase } from "../../domain";
import { OrderCard, type OrderEta } from "./order-card";
import { WaiterActions } from "./waiter-actions";

function OrdersSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      {[0, 1].map((key) => (
        <div key={key} className="qr-paper grid gap-4 p-4">
          <div className="flex justify-between gap-3">
            <div className="grid gap-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  );
}

export function OrdersPage() {
  const t = useT();
  const online = useOnline();
  const { qrToken, menu, guest, sessionId, openJoin } = useTableJourney();
  const view = useSessionView(sessionId);
  // The estimate is optional: a failed or slow query never blocks the page.
  const etas = useOrderEtas(sessionId);

  const etaByOrderId = useMemo(() => {
    const map: Record<string, OrderEta> = {};
    for (const eta of etas.data?.data ?? [])
      map[eta.orderId] = {
        minMinutes: eta.minMinutes,
        maxMinutes: eta.maxMinutes,
      };
    return map;
  }, [etas.data]);

  const orders = useMemo(
    () =>
      [...(view.data?.data.orders ?? [])].sort(
        (a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt),
      ),
    [view.data],
  );

  const firstAwaitingPaymentId = orders.find(
    (order) => orderPhase(order) === "awaiting_payment",
  )?.id;

  let body: React.ReactNode;
  if (guest === null || sessionId === null) {
    body = (
      <EmptyState
        icon={ClipboardList}
        className="qr-paper"
        title={t("qrOrders.status.notJoined.title")}
        description={t("qrOrders.status.notJoined.description")}
        action={
          <Button onClick={() => openJoin()}>
            {t("qrOrders.status.notJoined.action")}
          </Button>
        }
      />
    );
  } else if (view.isPending) {
    body = <OrdersSkeleton />;
  } else if (view.isError || !view.data) {
    body = (
      <ErrorState
        className="qr-paper"
        title={t("qrOrders.status.error.title")}
        description={t("qrOrders.status.error.description")}
        onRetry={() => void view.refetch()}
      />
    );
  } else {
    const { session, openServiceRequests } = view.data.data;
    body = (
      <>
        <WaiterActions
          sessionId={sessionId}
          qrToken={qrToken}
          sessionStatus={session.status}
          openServiceRequests={openServiceRequests}
        />
        {orders.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            className="qr-paper"
            title={t("qrOrders.status.empty.title")}
            description={t("qrOrders.status.empty.description")}
            action={
              <Button asChild>
                <Link to="/t/$token" params={{ token: qrToken }}>
                  {t("qrOrders.status.empty.action")}
                </Link>
              </Button>
            }
          />
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              qrToken={qrToken}
              timeZone={menu?.outlet.timeZone ?? DEFAULT_TIME_ZONE}
              etaByOrderId={etaByOrderId}
              isPrimaryPay={order.id === firstAwaitingPaymentId}
            />
          ))
        )}
      </>
    );
  }

  const paymentMode =
    view.data?.data.session.paymentMode ??
    menu?.zone.paymentMode ??
    "pay_first";

  return (
    <QrSubPage title={t("qrOrders.status.title")}>
      <p className="px-1 leading-6 text-muted-foreground">
        {t(
          paymentMode === "pay_first"
            ? "qrOrders.status.contextPayFirst"
            : "qrOrders.status.contextOpenBill",
          { table: menu?.table.code ?? "-" },
        )}
      </p>
      {!online && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-qr-media bg-surface-2 p-3 text-sm leading-5"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("qrOrders.status.offlineNotice")}
        </p>
      )}
      {body}
    </QrSubPage>
  );
}
