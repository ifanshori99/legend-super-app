import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { CirclePause, Inbox, Plus, RotateCw } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import {
  Notice,
  PosPageHeading,
  StatusPill,
  type StatusPillTone,
} from "@/features/ws04-pos-kasir/components/shared";
import { formatClock } from "@/features/ws04-pos-order-detail/kitchen-void";
import { useOpenOrders, useParkedOrders } from "../hooks";
import {
  minutesAgo,
  ordersWithHeldItems,
  type OpenOrderRow,
  type OpenOrderStatus,
  type ParkedRow,
} from "../open-orders-logic";

export type OpenOrdersTab = "open" | "parked";

const STATUS_TONE: Record<OpenOrderStatus, StatusPillTone> = {
  draft: "neutral",
  awaiting_payment: "warning",
  sent: "neutral",
};

// /pos/pesanan: every order of the outlet that is not finished, and the carts
// parked at the till (brief 1268 W5, founder-approved mockup
// design/mockups/pos/1268-pesanan-terbuka). Without it an unpaid order left
// behind on the payment screen cannot be reached again.
export function OpenOrdersScreen({ tab }: { tab: OpenOrdersTab }) {
  const t = useT();
  const orders = useOpenOrders();
  const parked = useParkedOrders();
  const empty = tab === "open" && orders.data?.length === 0;
  return (
    <div data-density="kontras" className="grid gap-4">
      <PosPageHeading
        title={t("posOpenOrders.title")}
        subtitle={t("posOpenOrders.subtitle")}
        action={
          empty ? undefined : (
            <Button asChild size="lg" variant="outline">
              <Link to="/pos/kasir">
                <Plus aria-hidden="true" />
                {t("posOpenOrders.newOrder")}
              </Link>
            </Button>
          )
        }
        className="max-[700px]:[&>div:last-child]:w-full max-[700px]:[&>div:last-child>a]:w-full"
      />
      <nav
        aria-label={t("posOpenOrders.tabs.label")}
        className="grid grid-cols-2 gap-2 sm:flex"
      >
        <TabLink
          to="open"
          current={tab}
          label={t("posOpenOrders.tabs.open")}
          count={orders.data?.length}
        />
        <TabLink
          to="parked"
          current={tab}
          label={t("posOpenOrders.tabs.parked")}
          count={parked.data?.length}
        />
      </nav>
      {tab === "open" ? <OpenList /> : <ParkedList />}
    </div>
  );
}

function TabLink({
  to,
  current,
  label,
  count,
}: {
  to: OpenOrdersTab;
  current: OpenOrdersTab;
  label: string;
  count: number | undefined;
}) {
  const active = to === current;
  return (
    <Link
      to="/pos/pesanan"
      search={to === "parked" ? { tab: "ditahan" } : {}}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-14 items-center justify-center gap-2 rounded-control border-(length:--border-w) border-border bg-background px-6 text-(length:--density-text) font-semibold transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-w-52",
        active && "border-foreground bg-surface-3",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "inline-flex min-w-7 items-center justify-center rounded-full px-2 text-base leading-7 font-semibold tabular-nums",
            active
              ? "bg-foreground text-background"
              : "bg-surface-3 text-foreground",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

function ListSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-busy="true" className="grid gap-3">
      <span className="sr-only">{t("posOpenOrders.open.loading")}</span>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-24 rounded-container" />
      ))}
    </div>
  );
}

function RetryButton({
  onRetry,
  busy,
}: {
  onRetry: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Button size="lg" loading={busy} onClick={onRetry}>
      <RotateCw aria-hidden="true" />
      {t("common.retry")}
    </Button>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3">{children}</ul>;
}

function OpenList() {
  const t = useT();
  const orders = useOpenOrders();
  if (orders.isLoading) return <ListSkeleton />;
  if (orders.error && !orders.data)
    return (
      <ErrorState
        error={orders.error}
        title={t("posOpenOrders.open.errorTitle")}
        description={t("posOpenOrders.open.errorHint")}
        action={
          <RetryButton
            busy={orders.isFetching}
            onRetry={() => void orders.refetch()}
          />
        }
      />
    );
  const rows = orders.data ?? [];
  if (rows.length === 0)
    return (
      <EmptyState
        icon={Inbox}
        title={t("posOpenOrders.open.emptyTitle")}
        description={t("posOpenOrders.open.emptyHint")}
        action={
          <Button asChild size="lg">
            <Link to="/pos/kasir">
              <Plus aria-hidden="true" />
              {t("posOpenOrders.open.emptyAction")}
            </Link>
          </Button>
        }
      />
    );
  const held = ordersWithHeldItems(rows);
  return (
    <>
      {held > 0 && (
        <Notice
          tone="warning"
          title={t("posOpenOrders.open.heldTitle", { count: held })}
        >
          <p>{t("posOpenOrders.open.heldHint")}</p>
        </Notice>
      )}
      <Rows>
        {rows.map((row) => (
          <OrderRow key={row.id} row={row} />
        ))}
      </Rows>
    </>
  );
}

const rowClass =
  "grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-4 sm:px-5";

function OrderRow({ row }: { row: OpenOrderRow }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const ago = minutesAgo(row.createdAt, new Date());
  const place = row.tableLabel ?? t(`posOpenOrders.service.${row.serviceType}`);
  return (
    <li
      className={cn(
        rowClass,
        "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-6",
      )}
    >
      <div className="grid min-w-0 gap-0.5">
        <h2 className="text-(length:--density-text) leading-7 font-semibold break-words">
          {t("posOpenOrders.open.rowTitle", { place, number: row.number })}
        </h2>
        <p className="text-base text-muted-foreground">
          {t("posOpenOrders.open.items", { count: row.itemCount })}
          <span className="max-md:hidden">
            {" · "}
            {t("posOpenOrders.open.openedAt", {
              time: formatClock(row.createdAt, timeZone),
            })}
          </span>
          {ago &&
            ` · ${t(
              ago.unit === "minute"
                ? "posOpenOrders.open.minutesAgo"
                : "posOpenOrders.open.hoursAgo",
              { count: ago.count },
            )}`}
        </p>
      </div>
      <div className="col-span-2 flex flex-wrap gap-2 md:col-span-1 md:row-start-1 md:col-start-2 md:justify-end">
        {row.heldItemCount > 0 && (
          <StatusPill tone="warning" icon={CirclePause}>
            {t("posOpenOrders.open.held", { count: row.heldItemCount })}
          </StatusPill>
        )}
        <StatusPill tone={STATUS_TONE[row.status]}>
          {t(`posOpenOrders.status.${row.status}`)}
        </StatusPill>
      </div>
      <div className="row-start-1 col-start-2 grid justify-items-end text-right md:col-start-3">
        <span className="text-sm text-muted-foreground">
          {t("posOpenOrders.open.total")}
        </span>
        <Money amount={row.totalIdr} className="text-lg font-semibold" />
        {row.partlyPaid && (
          <span className="text-sm text-muted-foreground">
            {t("posOpenOrders.open.remaining", {
              amount: formatRupiah(row.remainingIdr),
            })}
          </span>
        )}
      </div>
      <Button
        asChild
        size="lg"
        variant="outline"
        className="col-span-2 md:col-span-1 md:col-start-4 md:row-start-1"
      >
        <Link
          to="/pos/pesanan/$orderId"
          params={{ orderId: row.id }}
          aria-label={t("posOpenOrders.open.openLabel", {
            number: row.number,
          })}
        >
          {t("posOpenOrders.open.open")}
        </Link>
      </Button>
    </li>
  );
}

function ParkedList() {
  const t = useT();
  const parked = useParkedOrders();
  if (parked.isLoading) return <ListSkeleton />;
  if (parked.error && !parked.data)
    return (
      <ErrorState
        error={parked.error}
        title={t("posOpenOrders.parked.errorTitle")}
        description={t("posOpenOrders.open.errorHint")}
        action={
          <RetryButton
            busy={parked.isFetching}
            onRetry={() => void parked.refetch()}
          />
        }
      />
    );
  const rows = parked.data ?? [];
  if (rows.length === 0)
    return (
      <EmptyState
        icon={Inbox}
        title={t("posOpenOrders.parked.emptyTitle")}
        description={t("posOpenOrders.parked.emptyHint")}
      />
    );
  return (
    <>
      <Notice tone="info" title={t("posOpenOrders.parked.noticeTitle")}>
        <p>{t("posOpenOrders.parked.noticeHint")}</p>
      </Notice>
      <Rows>
        {rows.map((row) => (
          <ParkedOrderRow key={row.id} row={row} />
        ))}
      </Rows>
    </>
  );
}

// No price: a parked cart is priced only when it is resumed and sent.
function ParkedOrderRow({ row }: { row: ParkedRow }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  return (
    <li
      className={cn(
        rowClass,
        "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6",
      )}
    >
      <div className="grid min-w-0 gap-0.5">
        <h2 className="text-(length:--density-text) leading-7 font-semibold break-words">
          {row.label}
        </h2>
        <p className="text-base text-muted-foreground">
          {t("posOpenOrders.parked.meta", {
            count: row.itemCount,
            service: t(`posOpenOrders.service.${row.serviceType}`),
            time: formatClock(row.parkedAt, timeZone),
          })}
        </p>
      </div>
      <Button asChild size="lg" variant="outline">
        <Link
          to="/pos/kasir"
          search={{ ditahan: "1" }}
          aria-label={t("posOpenOrders.parked.resumeLabel", {
            label: row.label,
          })}
        >
          {t("posOpenOrders.parked.resume")}
        </Link>
      </Button>
    </li>
  );
}
