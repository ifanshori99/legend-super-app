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
import { useTableJourney } from "@/features/ws03-qr-order/context";
import { useOrderEtas, useSessionView } from "@/features/ws03-qr-order/hooks";
import { useOnline } from "@/lib/use-online";
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
        <div key={key} className="grid gap-4 rounded-xl border p-card">
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

  let body: React.ReactNode;
  if (guest === null || sessionId === null) {
    body = (
      <EmptyState
        icon={ClipboardList}
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
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-2xl leading-8 font-bold tracking-tight">
          {t("qrOrders.status.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(
            paymentMode === "pay_first"
              ? "qrOrders.status.contextPayFirst"
              : "qrOrders.status.contextOpenBill",
            { table: menu?.table.code ?? "-" },
          )}
        </p>
      </header>
      {!online && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm leading-5"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("qrOrders.status.offlineNotice")}
        </p>
      )}
      {body}
    </section>
  );
}
