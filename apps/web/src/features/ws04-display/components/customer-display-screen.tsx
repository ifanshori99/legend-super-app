// Customer display (PRD §3 F11 "Customer Display"): the second screen at the
// cashier shows the items, the total and the dynamic QRIS of the bill the
// paired terminal is working on. It is read-only — pairing and payment happen
// on the terminal — and polls the snapshot, refreshing the QRIS at expiry.
// States: loading, idle (no bill), live bill (ordering / awaiting payment /
// paid), error and offline (docs/frontend.md; every screen has them).
import { Clock, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors.ts";
import { useCustomerDisplay } from "../hooks.ts";
import { totalQuantity } from "../lib.ts";
import { BillLines } from "./bill-lines.tsx";
import { BillTotals } from "./bill-totals.tsx";
import { DisplayHeader } from "./display-header.tsx";
import { IdleSlide } from "./idle-slide.tsx";
import { PaidPanel } from "./paid-panel.tsx";
import { QrisPanel } from "./qris-panel.tsx";
import { DisplayStateBadge } from "./state-badge.tsx";

function OrderingHint() {
  const t = useT();
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Clock
          className="mt-0.5 size-5 shrink-0 text-info"
          aria-hidden="true"
        />
        <p className="text-sm leading-5 text-muted-foreground">
          {t("posDisplay.orderingHint")}
        </p>
      </div>
    </Card>
  );
}

export function CustomerDisplayScreen() {
  const t = useT();
  const display = useCustomerDisplay();
  const state = display.data ?? null;
  const header = (
    <DisplayHeader
      updatedAt={state?.updatedAt ?? null}
      refreshPending={display.isFetching}
      onRefresh={() => void display.refetch()}
    />
  );

  if (display.isPending)
    return (
      <div className="flex h-full flex-col gap-4">
        {header}
        <div
          aria-busy="true"
          className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]"
        >
          <span className="sr-only">{t("posDisplay.loading")}</span>
          <Skeleton className="h-80 w-full rounded-container" />
          <Skeleton className="h-80 w-full rounded-container" />
        </div>
      </div>
    );

  if (display.isError && !state) {
    const offline =
      display.error instanceof ApiError &&
      display.error.code === "NETWORK_ERROR";
    return (
      <div className="flex h-full flex-col gap-4">
        {header}
        <ErrorState
          title={t(
            offline ? "posDisplay.offlineTitle" : "posDisplay.errorTitle",
          )}
          description={t(
            offline ? "posDisplay.offlineHint" : "posDisplay.errorHint",
          )}
          onRetry={() => void display.refetch()}
        />
      </div>
    );
  }

  if (!state || state.state === "idle")
    return (
      <div className="flex h-full flex-col gap-4">
        {header}
        <IdleSlide />
      </div>
    );

  return (
    <div className="flex h-full flex-col gap-4">
      {header}
      {display.isError && (
        <Badge
          tone="warning"
          role="status"
          className="px-3 py-1 text-sm whitespace-normal [&_svg]:size-4"
        >
          <WifiOff aria-hidden="true" />
          {t("posDisplay.staleNotice")}
        </Badge>
      )}
      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start 2xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
        {/* Full-bleed list header + divided rows: a plain card surface, not a
            `Card` (its `p-card` cannot be stripped by tw-merge). */}
        <section
          aria-labelledby="display-order"
          className="min-w-0 overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b-(length:--border-w) p-4">
            <h2 id="display-order" className="type-title">
              {t("posDisplay.order", { number: state.orderNumber ?? "—" })}
            </h2>
            <div className="flex items-center gap-2">
              <DisplayStateBadge state={state.state} />
              <span className="text-sm leading-5 text-muted-foreground tabular">
                {t("posDisplay.itemCount", {
                  count: totalQuantity(state.lines),
                })}
              </span>
            </div>
          </div>
          <BillLines lines={state.lines} />
        </section>
        <aside className="grid min-w-0 gap-4">
          <BillTotals state={state} />
          {state.state === "paid" ? (
            <PaidPanel state={state} />
          ) : state.state === "awaiting_payment" && state.qris ? (
            <QrisPanel qris={state.qris} />
          ) : (
            <OrderingHint />
          )}
        </aside>
      </div>
    </div>
  );
}
