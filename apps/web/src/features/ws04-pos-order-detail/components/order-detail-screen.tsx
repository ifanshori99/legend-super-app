import { Link } from "@tanstack/react-router";
import { ArrowLeft, RotateCw } from "lucide-react";
import type { PosOrderDetail } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useOutletClock } from "@/lib/tenant-context";
import {
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
  type StatusPillTone,
} from "@/features/ws04-pos-kasir/components/shared";
import { useKitchenVoids, useOrderDetail } from "../hooks";
import {
  billRows,
  capturedTendersIdr,
  formatClock,
  kitchenVoidedItemIds,
  openKitchenVoidNotices,
} from "../kitchen-void";
import { KitchenNotices } from "./kitchen-notices";
import { OrderLines } from "./order-lines";

const STATUS_TONE: Record<PosOrderDetail["status"], StatusPillTone> = {
  draft: "neutral",
  sent: "neutral",
  awaiting_payment: "warning",
  completed: "success",
  voided: "danger",
};

function BackLink() {
  const t = useT();
  return (
    <Button asChild variant="outline">
      <Link to="/pos/meja">
        <ArrowLeft aria-hidden="true" />
        {t("posOrderDetail.screen.back")}
      </Link>
    </Button>
  );
}

function LoadingShape() {
  const t = useT();
  return (
    <div aria-busy="true" role="status" className="grid gap-4">
      <span className="sr-only">{t("posOrderDetail.screen.loading")}</span>
      <Skeleton className="h-16 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22.5rem)]">
        <Skeleton className="h-[26rem] rounded-container" />
        <Skeleton className="h-[20rem] rounded-container" />
      </div>
    </div>
  );
}

// /pos/pesanan/$orderId: the order's lines and bill, with the kitchen notices
// (legend-0ixe). A kitchen void does not change the bill; the cashier reads the
// notice here and starts a POS void, which needs a reason and a supervisor.
export function OrderDetailScreen({ orderId }: { orderId: string }) {
  return (
    <div data-density="kontras" className="grid gap-4">
      <OrderDetailBody orderId={orderId} />
    </div>
  );
}

function OrderDetailBody({ orderId }: { orderId: string }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const order = useOrderDetail(orderId);
  const voids = useKitchenVoids(orderId);

  if (order.isLoading) return <LoadingShape />;

  if (order.error) {
    const missing =
      order.error instanceof ApiError && order.error.status === 404;
    if (missing)
      return (
        <EmptyState
          title={t("posOrderDetail.screen.emptyTitle")}
          description={t("posOrderDetail.screen.emptyHint")}
          action={<BackLink />}
        />
      );
    return (
      <ErrorState
        error={order.error}
        title={t("posOrderDetail.screen.errorTitle")}
        description={t("posOrderDetail.screen.errorHint")}
        action={
          <div className="flex flex-wrap gap-3">
            <Button
              loading={order.isFetching}
              onClick={() => void order.refetch()}
            >
              <RotateCw aria-hidden="true" />
              {t("common.retry")}
            </Button>
            <BackLink />
          </div>
        }
      />
    );
  }

  const data = order.data;
  if (!data)
    return (
      <EmptyState
        title={t("posOrderDetail.screen.emptyTitle")}
        description={t("posOrderDetail.screen.emptyHint")}
        action={<BackLink />}
      />
    );

  const notices = openKitchenVoidNotices(voids.data ?? [], data.items);
  const kitchenVoided = kitchenVoidedItemIds(notices);
  const completed = data.status === "completed";
  const canVoid = data.status !== "voided" && !completed;
  // The void action waits only while the kitchen history is unknown: the
  // cashier checks it first. With the history read (notice or none) it is open.
  const historyKnown = !voids.isLoading && !voids.isError;
  const rows = billRows({
    ...data,
    capturedIdr: capturedTendersIdr(data.tenders),
  });

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posOrderDetail.screen.title", { number: data.number })}
        subtitle={t("posOrderDetail.screen.subtitle", {
          service: t(`posOrderDetail.service.${data.serviceType}`),
          time: formatClock(data.createdAt, timeZone),
        })}
        action={<BackLink />}
      />
      <PosTwoPane
        sidePosition="end"
        side={
          <PosPanel title={t("posOrderDetail.summary.title")}>
            <div className="grid gap-2">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className={
                    row.key === "total"
                      ? "mt-2 flex items-center justify-between gap-3 border-t-2 border-border pt-4 text-lg font-semibold"
                      : row.key === "remaining"
                        ? "flex items-center justify-between gap-3 py-1 text-lg font-semibold"
                        : "flex items-center justify-between gap-3 py-1"
                  }
                >
                  <span>{t(`posOrderDetail.summary.${row.key}`)}</span>
                  <Money amount={row.amountIdr} className="font-semibold" />
                </div>
              ))}
              {kitchenVoided.size > 0 && (
                <p className="mt-2 text-base text-muted-foreground">
                  {t("posOrderDetail.summary.kitchenVoidKept")}
                </p>
              )}
              {completed && (
                <Button asChild size="lg" className="mt-2 w-full">
                  <Link
                    to="/pos/pesanan/$orderId/koreksi"
                    params={{ orderId }}
                    search={{ mode: "refund" }}
                  >
                    {t("posOrderDetail.summary.refundAction")}
                  </Link>
                </Button>
              )}
              {canVoid &&
                (historyKnown ? (
                  <>
                    <Button asChild size="lg" className="mt-2 w-full">
                      <Link
                        to="/pos/pesanan/$orderId/koreksi"
                        params={{ orderId }}
                        search={{ mode: "void" }}
                      >
                        {t("posOrderDetail.summary.action")}
                      </Link>
                    </Button>
                    <p className="text-base text-muted-foreground">
                      {t("posOrderDetail.summary.approvalNote")}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-base text-muted-foreground">
                    {t("posOrderDetail.summary.checkFirst")}
                  </p>
                ))}
            </div>
          </PosPanel>
        }
      >
        <PosPanel
          title={t("posOrderDetail.panel.title")}
          aside={
            <StatusPill tone={STATUS_TONE[data.status]}>
              {t(`posOrderDetail.status.${data.status}`)}
            </StatusPill>
          }
        >
          <div className="grid gap-4">
            <p className="text-base text-muted-foreground">
              {t("posOrderDetail.panel.count", { count: data.items.length })}
            </p>
            <KitchenNotices
              isLoading={voids.isLoading}
              isError={voids.isError}
              notices={notices}
              onRetry={() => void voids.refetch()}
              isRetrying={voids.isFetching}
            />
            {data.items.length === 0 ? (
              <p className="text-base text-muted-foreground">
                {t("posOrderDetail.panel.noItems")}
              </p>
            ) : (
              <OrderLines items={data.items} kitchenVoided={kitchenVoided} />
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}
