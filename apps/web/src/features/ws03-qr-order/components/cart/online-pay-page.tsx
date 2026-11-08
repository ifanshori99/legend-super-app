// Virtual Account and card screens of "Keranjang & bayar" (legend-2re1). The
// table contract has no VA number or card payment, so both are demo flows that
// the checkout only opens in mock mode: the order is placed and held, the page
// shows a demo VA number (derived from the order number, never from a gateway)
// or the card hand-off (card data is typed on the provider's page, never here).
// Success is shown only once the server says the order left awaiting_payment.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronLeft,
  Clock,
  Copy,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "cn";
import type { QrOrder } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTableJourney } from "../../context";
import { useRefreshSession } from "../../hooks";
import { Notice } from "../notice";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";
import { SessionEnded } from "../session-states";
import { PaymentSuccess } from "./payment-success";

export type OnlinePayMethod = "va" | "kartu";

// Demo list only. The prefix makes each bank's sample number look different.
const BANKS = [
  { id: "bca", prefix: "1390", label: "qrGlass.pay.va.bankBca" },
  { id: "bni", prefix: "8808", label: "qrGlass.pay.va.bankBni" },
  { id: "bri", prefix: "2620", label: "qrGlass.pay.va.bankBri" },
  { id: "mandiri", prefix: "8890", label: "qrGlass.pay.va.bankMandiri" },
] as const;
type BankId = (typeof BANKS)[number]["id"];

const DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 16 digits: bank prefix + the order number's digits, zero-padded. */
function demoVaNumber(prefix: string, orderNumber: string) {
  const digits = orderNumber.replace(/\D/g, "").padStart(12, "0").slice(-12);
  return `${prefix}${digits}`;
}

const groupBy4 = (value: string) => value.match(/.{1,4}/g)?.join(" ") ?? value;

/** "23:59:41"; null until mounted so server and browser markup agree. */
function useCountdown(windowMs: number): string | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const endsAt = Date.now() + windowMs;
    const tick = () => setRemainingMs(Math.max(0, endsAt - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [windowMs]);
  if (remainingMs === null) return null;
  const total = Math.ceil(remainingMs / 1000);
  const part = (n: number) => String(n).padStart(2, "0");
  return `${part(Math.floor(total / 3600))}:${part(Math.floor((total % 3600) / 60))}:${part(total % 60)}`;
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  // A different number (another bank) has not been copied yet.
  const [copiedValue, setCopiedValue] = useState(value);
  if (copiedValue !== value) {
    setCopiedValue(value);
    setStatus("idle");
  }
  const copy = () => {
    // navigator.clipboard is missing on insecure origins and some in-app
    // browsers; writeText can also throw synchronously.
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      navigator.clipboard.writeText(value).then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      );
    } catch {
      setStatus("failed");
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0"
        aria-label={t("qrGlass.pay.va.copyLabel")}
        onClick={copy}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {t("qrGlass.pay.va.copy")}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "basis-full text-sm empty:hidden",
          status === "failed" && "text-danger",
        )}
      >
        {status === "copied"
          ? t("qrGlass.pay.va.copied")
          : status === "failed"
            ? t("qrGlass.pay.va.copyFailed")
            : null}
      </p>
    </>
  );
}

function PillHeader({
  pill,
  heading,
  saved,
}: {
  pill: string;
  heading: string;
  saved: string;
}) {
  return (
    <header className="grid justify-items-start gap-3">
      <p className="inline-flex items-center gap-2 rounded-full bg-warning-subtle px-3 py-1.5 text-sm font-semibold">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        {pill}
      </p>
      <h2 className="type-display-xl max-w-[14ch]">{heading}</h2>
      <p className="text-lg leading-7 text-muted-foreground">{saved}</p>
    </header>
  );
}

function VaBody({
  order,
  qrToken,
  onCheck,
}: {
  order: QrOrder;
  qrToken: string;
  onCheck: () => Promise<unknown>;
}) {
  const t = useT();
  const [bank, setBank] = useState<BankId>("bca");
  const [check, setCheck] = useState<"idle" | "busy" | "waiting" | "failed">(
    "idle",
  );
  const countdown = useCountdown(DEMO_WINDOW_MS);
  const selected = BANKS.find((item) => item.id === bank) ?? BANKS[0];
  const vaNumber = demoVaNumber(selected.prefix, order.number);
  const steps = [
    t("qrGlass.pay.va.step1"),
    t("qrGlass.pay.va.step2"),
    t("qrGlass.pay.va.step3"),
    t("qrGlass.pay.va.step4"),
    t("qrGlass.pay.va.step5"),
  ];

  const checkPayment = () => {
    setCheck("busy");
    onCheck().then(
      () => setCheck("waiting"),
      () => setCheck("failed"),
    );
  };

  return (
    <>
      <PillHeader
        pill={t("qrGlass.pay.va.pill")}
        heading={t("qrGlass.pay.va.heading")}
        saved={t("qrGlass.pay.va.saved")}
      />

      <section className="grid gap-4 rounded-qr-media bg-card p-5 shadow-raised">
        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-semibold">
            {t("qrGlass.pay.va.bankLegend")}
          </legend>
          <RadioGroup.Root
            value={bank}
            onValueChange={(next) => setBank(next as BankId)}
            aria-label={t("qrGlass.pay.va.bankLegend")}
            className="flex flex-wrap gap-2"
          >
            {BANKS.map((item) => (
              <RadioGroup.Item
                key={item.id}
                value={item.id}
                className={cn(
                  "inline-flex min-h-11 min-w-16 items-center justify-center gap-1.5 rounded-full border border-input bg-card px-4 font-semibold pressable",
                  "hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  "data-[state=checked]:border-primary data-[state=checked]:bg-qr-selection data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
                )}
              >
                <RadioGroup.Indicator>
                  <Check className="size-4" aria-hidden="true" />
                </RadioGroup.Indicator>
                {t(item.label)}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </fieldset>

        <hr className="border-t border-dashed border-input" />

        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            {t("qrGlass.pay.va.bankName", { bank: t(selected.label) })} ·{" "}
            {t("qrGlass.pay.va.numberLabel")}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="text-[clamp(1.375rem,6.4vw,1.75rem)] leading-8 font-bold tracking-wide tabular">
              {groupBy4(vaNumber)}
            </p>
            <CopyButton value={vaNumber} />
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <span>{t("qrGlass.pay.va.amountLabel")}</span>
          <Money
            amount={order.totalIdr}
            size="xl"
            className="text-2xl font-bold"
          />
        </div>

        <div className="grid justify-items-start gap-1">
          {countdown && (
            <p className="inline-flex items-center gap-2 rounded-full bg-qr-selection px-3 py-1.5 text-sm">
              <Clock className="size-4 shrink-0" aria-hidden="true" />
              <span className="font-medium tabular">
                {t("qrGlass.pay.va.timeLeft", { time: countdown })}
              </span>
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {t("qrGlass.pay.va.timeNote")}
          </p>
        </div>
      </section>

      <ol
        aria-label={t("qrGlass.pay.va.stepsLabel")}
        className="grid gap-3 px-1"
      >
        {steps.map((step, index) => (
          <li key={step} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full bg-qr-selection text-sm font-semibold tabular"
            >
              {index + 1}
            </span>
            <p className="text-lg leading-7">{step}</p>
          </li>
        ))}
      </ol>

      <Notice tone="info" title={t("qrGlass.pay.va.demoNoticeTitle")}>
        {t("qrGlass.pay.va.demoNoticeBody")}
      </Notice>

      <QrFooter>
        <p
          role="status"
          aria-live="polite"
          className="text-center text-sm empty:hidden"
        >
          {check === "busy"
            ? t("qrGlass.pay.va.checking")
            : check === "waiting"
              ? t("qrGlass.pay.va.stillWaiting")
              : check === "failed"
                ? t("qrGlass.pay.va.checkFailed")
                : null}
        </p>
        <Button
          type="button"
          aria-busy={check === "busy"}
          disabled={check === "busy"}
          onClick={checkPayment}
        >
          {t("qrGlass.pay.va.check")}
          <RefreshCw
            aria-hidden="true"
            className={check === "busy" ? "animate-spin" : undefined}
          />
        </Button>
        <Link
          to="/t/$token/checkout"
          params={{ token: qrToken }}
          className={`${qrTextLink} min-h-11 justify-self-center`}
        >
          {t("qrGlass.pay.va.changeMethod")}
        </Link>
      </QrFooter>
    </>
  );
}

function CardBody({ order, qrToken }: { order: QrOrder; qrToken: string }) {
  const t = useT();
  const [tapped, setTapped] = useState(false);
  return (
    <>
      <PillHeader
        pill={t("qrGlass.pay.card.pill")}
        heading={t("qrGlass.pay.card.heading")}
        saved={t("qrGlass.pay.card.saved")}
      />

      <section className="grid gap-4 rounded-qr-media bg-card p-5 shadow-raised">
        <div className="flex items-baseline justify-between gap-3">
          <span>{t("qrGlass.pay.card.totalLabel")}</span>
          <Money
            amount={order.totalIdr}
            size="xl"
            className="text-2xl font-bold"
          />
        </div>
        <hr className="border-t border-dashed border-input" />
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-1 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="grid gap-2">
            <p className="text-lg leading-7">
              {t("qrGlass.pay.card.secureNote")}
            </p>
            <p className="text-lg leading-7 text-muted-foreground">
              {t("qrGlass.pay.card.threeDs")}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("qrGlass.pay.card.networksLabel")}:{" "}
          <span className="font-semibold text-foreground">
            {t("qrGlass.pay.card.networks")}
          </span>
        </p>
      </section>

      {tapped && (
        <Notice tone="info" title={t("qrGlass.pay.card.demoUnavailableTitle")}>
          {t("qrGlass.pay.card.demoUnavailableBody")}
        </Notice>
      )}

      <QrFooter>
        <Button type="button" onClick={() => setTapped(true)}>
          {t("qrGlass.pay.card.continue")}
        </Button>
        <Link
          to="/t/$token/checkout"
          params={{ token: qrToken }}
          className={`${qrTextLink} min-h-11 justify-self-center`}
        >
          {t("qrGlass.pay.card.changeMethod")}
        </Link>
      </QrFooter>
    </>
  );
}

export function OnlinePayPage({
  orderId,
  method,
}: {
  orderId: string;
  method: OnlinePayMethod;
}) {
  const t = useT();
  const { qrToken, guest, sessionId, view, viewError, ended, openJoin } =
    useTableJourney();
  const refresh = useRefreshSession(sessionId);

  const title =
    method === "va" ? t("qrGlass.pay.va.title") : t("qrGlass.pay.card.title");
  const back = (
    <Link
      to="/t/$token/checkout"
      params={{ token: qrToken }}
      className={qrRoundIcon}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="sr-only">
        {method === "va"
          ? t("qrGlass.pay.va.back")
          : t("qrGlass.pay.card.back")}
      </span>
    </Link>
  );

  // Every state sits under the same top bar, so none is a dead end.
  const shell = (children: ReactNode) => (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar title={title} leading={back} />
      {children}
    </div>
  );

  // The table contract has no VA / card payment: outside mock mode this page
  // (bookmark, shared link, stale tab) must never show a demo VA number.
  if (!API_MOCK)
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.online.unavailableTitle")}
        description={t("qrGlass.pay.online.unavailableHint")}
        action={
          <Button asChild>
            <Link to="/t/$token/checkout" params={{ token: qrToken }}>
              {t("qrGlass.pay.online.toCheckout")}
            </Link>
          </Button>
        }
      />,
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
        <QrTopBar title={title} leading={back} />
        <span className="sr-only">{t("qrGlass.pay.cashier.loading")}</span>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-64 w-full rounded-qr-media" />
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
        method={method === "va" ? "va" : "card"}
        returnTo={`/t/${encodeURIComponent(qrToken)}/bayar/${encodeURIComponent(orderId)}?metode=${method}`}
      />
    );

  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar title={title} leading={back} />
      {method === "va" ? (
        <VaBody order={order} qrToken={qrToken} onCheck={() => refresh()} />
      ) : (
        <CardBody order={order} qrToken={qrToken} />
      )}
    </div>
  );
}
