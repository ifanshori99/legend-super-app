// "Bayar di kasir" waiting screen (founder Q3, legend-2re1). The pay-first
// order is placed and held; the guest shows its number to the cashier, who
// takes the money. The kitchen gets it only then. The contract has no cashier
// payment, so the page just reads the order from the session view: success is
// shown only once the server says the order left awaiting_payment.
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Clock, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useTableJourney } from "../../context";
import { useRefreshSession } from "../../hooks";
import { QrFooter, QrTopBar, qrRoundIcon } from "../glass/qr-primitives";
import { SessionEnded } from "../session-states";
import { PaymentSuccess } from "./payment-success";

export function CashierPage({ orderId }: { orderId: string }) {
  const t = useT();
  const { qrToken, menu, guest, sessionId, view, viewError, ended, openJoin } =
    useTableJourney();
  const refresh = useRefreshSession(sessionId);
  const [check, setCheck] = useState<"idle" | "busy" | "waiting" | "failed">(
    "idle",
  );

  const back = (
    <Link
      to="/t/$token/orders"
      params={{ token: qrToken }}
      className={qrRoundIcon}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="sr-only">{t("qrGlass.pay.cashier.back")}</span>
    </Link>
  );

  // Every state sits under the same top bar, so none is a dead end.
  const shell = (children: ReactNode) => (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar title={t("qrGlass.pay.cashier.title")} leading={back} />
      {children}
    </div>
  );

  if (ended) return <SessionEnded />;
  if (!guest || sessionId === null)
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.noSessionTitle")}
        description={t("qrGlass.pay.cashier.noSessionHint")}
        action={
          <Button type="button" onClick={() => openJoin()}>
            {t("qrCart.cart.noSessionAction")}
          </Button>
        }
      />,
    );
  if (viewError)
    return shell(
      <ErrorState
        title={t("qrGlass.pay.cashier.errorTitle")}
        description={t("qrGlass.pay.cashier.errorHint")}
        onRetry={() => void refresh()}
      />,
    );
  if (!view)
    return (
      <div
        aria-busy="true"
        className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl"
      >
        <QrTopBar title={t("qrGlass.pay.cashier.title")} leading={back} />
        <span className="sr-only">{t("qrGlass.pay.cashier.loading")}</span>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-56 w-full rounded-qr-media" />
        <Skeleton className="h-32 w-full" />
      </div>
    );

  const order = view.orders.find((item) => item.id === orderId);
  if (!order)
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.notFoundTitle")}
        description={t("qrGlass.pay.cashier.notFoundHint")}
        action={
          <Button asChild>
            <Link to="/t/$token/orders" params={{ token: qrToken }}>
              {t("qrGlass.pay.cashier.toOrders")}
            </Link>
          </Button>
        }
      />,
    );
  if (order.status === "voided")
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.voidedTitle")}
        description={t("qrGlass.pay.cashier.voidedHint")}
        action={
          <Button asChild>
            <Link to="/t/$token" params={{ token: qrToken }}>
              {t("qrGlass.pay.cashier.toMenu")}
            </Link>
          </Button>
        }
      />,
    );
  if (order.status !== "awaiting_payment")
    return (
      <PaymentSuccess
        order={order}
        amountIdr={order.totalIdr}
        method="cashier"
        returnTo={`/t/${encodeURIComponent(qrToken)}/kasir/${encodeURIComponent(orderId)}`}
      />
    );

  const items = order.items
    .filter((item) => item.status !== "voided")
    .map((item) => `${item.quantity}× ${item.name}`)
    .join(", ");
  const steps = [
    {
      title: t("qrGlass.pay.cashier.step1Title"),
      hint: t("qrGlass.pay.cashier.step1Hint"),
    },
    {
      title: t("qrGlass.pay.cashier.step2Title"),
      hint: t("qrGlass.pay.cashier.step2Hint"),
    },
    {
      title: t("qrGlass.pay.cashier.step3Title"),
      hint: t("qrGlass.pay.cashier.step3Hint"),
    },
  ];

  const checkPayment = () => {
    setCheck("busy");
    refresh().then(
      () => setCheck("waiting"),
      () => setCheck("failed"),
    );
  };

  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar title={t("qrGlass.pay.cashier.title")} leading={back} />

      <header className="grid justify-items-start gap-3">
        <p className="inline-flex items-center gap-2 rounded-full bg-warning-subtle px-3 py-1.5 text-sm font-semibold">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {t("qrGlass.pay.cashier.pill")}
        </p>
        <h2 className="type-display-xl max-w-[12ch]">
          {t("qrGlass.pay.cashier.heading")}
        </h2>
        <p className="text-lg leading-7 text-muted-foreground">
          {t("qrGlass.pay.cashier.saved")}
        </p>
      </header>

      <section className="grid gap-4 rounded-qr-media bg-card p-5 shadow-raised">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <h3 className="font-semibold">
            {menu?.brand.name ?? t("app.defaultBrand")}
          </h3>
          {menu?.table.code && (
            <span className="text-muted-foreground">
              {t("qrGlass.pay.cashier.table", { table: menu.table.code })}
            </span>
          )}
        </div>
        <p
          className={cn(
            "text-center leading-none font-bold whitespace-nowrap tabular",
            // A short code reads at a glance; a long order number shrinks to
            // stay on one line so the cashier can read it in one pass.
            order.number.length <= 10
              ? "text-[2.75rem] tracking-wide"
              : "text-[clamp(1.375rem,6.8vw,2rem)] tracking-tight",
          )}
        >
          <span className="sr-only">{t("qrGlass.pay.cashier.codeLabel")} </span>
          {order.number}
        </p>
        <hr className="border-t border-dashed border-input" />
        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span>{t("qrGlass.pay.cashier.total")}</span>
            <Money
              amount={order.totalIdr}
              size="xl"
              className="text-2xl font-bold"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {t("qrGlass.pay.cashier.itemsSummary", { items })}
          </p>
        </div>
      </section>

      <ol
        aria-label={t("qrGlass.pay.cashier.stepsLabel")}
        className="grid gap-3 px-1"
      >
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full bg-qr-selection text-sm font-semibold tabular"
            >
              {index + 1}
            </span>
            <div>
              <p className="font-semibold">{step.title}</p>
              <p className="text-lg leading-7 text-muted-foreground">
                {step.hint}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <QrFooter>
        <p
          role="status"
          aria-live="polite"
          className="text-center text-sm empty:hidden"
        >
          {check === "busy"
            ? t("qrGlass.pay.cashier.checking")
            : check === "waiting"
              ? t("qrGlass.pay.cashier.stillWaiting")
              : check === "failed"
                ? t("qrGlass.pay.cashier.checkFailed")
                : null}
        </p>
        <Button
          type="button"
          aria-busy={check === "busy"}
          disabled={check === "busy"}
          onClick={checkPayment}
        >
          {t("qrGlass.pay.cashier.check")}
          <RefreshCw
            aria-hidden="true"
            className={check === "busy" ? "animate-spin" : undefined}
          />
        </Button>
      </QrFooter>
    </div>
  );
}
