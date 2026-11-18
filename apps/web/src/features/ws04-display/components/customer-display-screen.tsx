// Customer display (PRD §3 F11 "Customer Display"): the second screen at the
// cashier shows the items, the total and the dynamic QRIS of the bill the
// paired terminal is working on. It is read-only — pairing and payment happen
// on the terminal — and polls the snapshot, refreshing the QRIS at expiry.
// States: loading, idle (no bill), live bill (ordering / awaiting payment —
// code loading, payable, expired or unavailable — / paid), error and offline (docs/frontend.md; every screen has them).
import { Clock, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors.ts";
import { useTenantContext } from "@/lib/tenant-context";
import { useCustomerDisplay, useDisplayDeposit } from "../hooks.ts";
import {
  displayBalance,
  displayPayMode,
  isQrisExpired,
  totalQuantity,
} from "../lib.ts";
import { useNowMs } from "../use-now.ts";
import { BillLines } from "./bill-lines.tsx";
import { BillTotals } from "./bill-totals.tsx";
import { DisplayHeader } from "./display-header.tsx";
import { IdleSlide } from "./idle-slide.tsx";
import { PaidPanel } from "./paid-panel.tsx";
import { QrisPanel } from "./qris-panel.tsx";
import { QrisStatusPanel } from "./qris-status-panel.tsx";
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

function CustomerDisplayContent() {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const display = useCustomerDisplay(outlet?.id);
  const state = display.data ?? null;
  const now = useNowMs();
  // The display QRIS is always the full total, so an order with a DP is read
  // from the order itself and never shows a code (sub-539-u2).
  const deposit = useDisplayDeposit(
    outlet?.id,
    state?.orderId ?? null,
    state?.state === "awaiting_payment",
  );
  const header = (
    <DisplayHeader
      updatedAt={state?.updatedAt ?? null}
      refreshPending={display.isFetching}
      onRefresh={() => void display.refetch()}
    />
  );

  if (outlet !== null && display.isPending)
    return (
      <div className="flex h-full flex-1 flex-col gap-4">
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
      <div className="flex h-full flex-1 flex-col gap-4">
        {header}
        <ErrorState
          error={display.error}
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
      <div className="flex h-full flex-1 flex-col gap-4">
        {header}
        <IdleSlide />
      </div>
    );

  // While the customer pays, the QR owns the right column and the totals move
  // under the lines: a 1366×768 second screen (common for customer displays)
  // then shows the whole code without scrolling (Opus review legend-azt).
  const paying = state.state === "awaiting_payment";
  const payMode = displayPayMode(state, deposit);
  const atCashier = payMode === "pay_at_cashier";
  // A failed read or an expired code leaves the payment status unknown: the
  // old code is never shown and the amount is labelled as unchecked.
  const unverified =
    paying &&
    !atCashier &&
    (display.isError ||
      (state.qris !== null && isQrisExpired(state.qris, now)));
  const paid = state.state === "paid";
  const remaining = displayBalance(state).remainingIdr;
  return (
    <div className="flex h-full flex-1 flex-col gap-4">
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
        <div className="grid min-w-0 gap-4">
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
          {(paying || paid) && (
            <BillTotals
              state={state}
              unverified={unverified}
              hideRemaining={payMode !== "qris"}
            />
          )}
        </div>
        {/* Paid: the confirmation leads the page (first on narrow screens too),
            the bill details stay under the lines. */}
        <aside
          className={
            paid
              ? "order-first grid min-w-0 gap-4 lg:order-none"
              : "grid min-w-0 gap-4"
          }
        >
          {!paying && !paid && <BillTotals state={state} />}
          {paid ? (
            <PaidPanel state={state} />
          ) : paying && display.isError ? (
            // Terminal unreachable: no QR and, unless the DP is known to be 0,
            // no amount either.
            <QrisStatusPanel
              kind="error"
              amountIdr={payMode === "qris" ? remaining : null}
            />
          ) : atCashier ? (
            <QrisStatusPanel kind="cashier" amountIdr={null} />
          ) : paying && (payMode === "loading" || state.qris === null) ? (
            <QrisStatusPanel kind="loading" amountIdr={null} />
          ) : paying && payMode === "qris" && state.qris ? (
            <QrisPanel qris={state.qris} />
          ) : (
            <OrderingHint />
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell drops the previous outlet's
 * bill so it cannot stay on the customer's screen.
 */
export function CustomerDisplayScreen() {
  const { outlet } = useTenantContext();
  return <CustomerDisplayContent key={outlet?.id ?? "none"} />;
}
