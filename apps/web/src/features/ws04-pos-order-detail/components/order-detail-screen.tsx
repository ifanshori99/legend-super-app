import { Link } from "@tanstack/react-router";
import { ArrowLeft, Link2, RotateCw } from "lucide-react";
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
import { useKitchenVoids, useNow, useOrderDetail } from "../hooks";
import {
  billRows,
  capturedTendersIdr,
  formatClock,
  kitchenVoidedItemIds,
  openKitchenVoidNotices,
} from "../kitchen-void";
import {
  listAgeMs,
  oldLinkRemainingIdr,
} from "@/features/ws04-pos-open-orders/open-orders-logic";
import { useOpenOrders } from "@/features/ws04-pos-open-orders/hooks";
import { KitchenNotices } from "./kitchen-notices";
import { OrderLines } from "./order-lines";
import {
  FireConfirmDialog,
  FireNotice,
  OldLinkNotice,
  PrimaryAction,
  SecondaryPay,
  useOrderActions,
} from "./order-actions";

// The paid-link warning is re-checked this often, so it hides once the list
// it came from is older than OLD_LINK_FRESH_MS.
const OLD_LINK_CHECK_MS = 5_000;

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
      <Link to="/pos/pesanan">
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

  return <OrderDetailLoaded orderId={orderId} data={data} voids={voids} />;
}

function OrderDetailLoaded({
  orderId,
  data,
  voids,
}: {
  orderId: string;
  data: PosOrderDetail;
  voids: ReturnType<typeof useKitchenVoids>;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const actions = useOrderActions(data);
  const openOrders = useOpenOrders();
  const now = useNow(OLD_LINK_CHECK_MS);
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
  const remainingIdr =
    rows.find((row) => row.key === "remaining")?.amountIdr ?? data.totalIdr;
  const listRemainingIdr = oldLinkRemainingIdr(
    remainingIdr,
    openOrders.data?.find((row) => row.id === data.id),
    listAgeMs(now, openOrders.dataUpdatedAt),
  );
  const heldCount = actions.held.length;
  const unpaid = !completed && data.status !== "voided";

  return (
    <div className="grid gap-4 max-[700px]:pb-24">
      <PosPageHeading
        title={t("posOrderDetail.screen.title", { number: data.number })}
        subtitle={t("posOrderDetail.screen.subtitle", {
          service: t(`posOrderDetail.service.${data.serviceType}`),
          time: formatClock(data.createdAt, timeZone),
        })}
        action={<BackLink />}
      />
      <FireNotice state={actions} />
      {listRemainingIdr !== null && (
        <OldLinkNotice remainingIdr={listRemainingIdr} />
      )}
      <PosTwoPane
        sidePosition="end"
        side={
          <PosPanel
            title={t("posOrderDetail.summary.title")}
            aside={
              unpaid ? (
                listRemainingIdr !== null ? (
                  <StatusPill tone="warning" icon={Link2}>
                    {t("posOrderDetail.oldLink.pill")}
                  </StatusPill>
                ) : remainingIdr > 0 ? (
                  <StatusPill tone="warning">
                    {t("posOrderDetail.pay.unpaid")}
                  </StatusPill>
                ) : (
                  <StatusPill tone="success">
                    {t("posOrderDetail.pay.paid")}
                  </StatusPill>
                )
              ) : undefined
            }
          >
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
              {heldCount > 0 && unpaid && (
                <p className="mt-2 text-base text-muted-foreground">
                  {t("posOrderDetail.fire.completeHint")}
                </p>
              )}
              <PrimaryAction
                state={actions}
                order={data}
                remainingIdr={remainingIdr}
                className="mt-2 w-full max-[700px]:hidden"
              />
              <SecondaryPay
                state={actions}
                order={data}
                remainingIdr={remainingIdr}
              />
              {completed && (
                <Button asChild size="lg" variant="outline" className="w-full">
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
                !actions.unclear &&
                (historyKnown ? (
                  <>
                    <Button
                      asChild
                      size="lg"
                      variant="outline"
                      className="w-full"
                    >
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
              {heldCount > 0
                ? t("posOrderDetail.panel.countHeld", {
                    count: data.items.length,
                    held: heldCount,
                  })
                : t("posOrderDetail.panel.countAllSent", {
                    count: data.items.length,
                  })}
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
      <div
        data-slot="order-action-bar"
        className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] empty:hidden min-[701px]:hidden"
      >
        <PrimaryAction
          state={actions}
          order={data}
          remainingIdr={remainingIdr}
          className="w-full"
        />
      </div>
      <FireConfirmDialog state={actions} order={data} />
    </div>
  );
}
