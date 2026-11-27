// "Keranjang & bayar": the shared cart and checkout on one page (legend-2re1,
// mockup final-a-checkout-mobile; PRD §3 F10 "Mode Bayar", "Estimasi Waktu
// Saji", "Login Opsional"). Pay-first: place the order, then pay by QRIS
// or hold it for the cashier (founder Q3); the kitchen sees it only
// after payment is confirmed (ORD-02). Open bill: the order goes straight to
// the kitchen and is paid at the end. Menu prices exclude tax and service
// charge, so the breakdown shows both (owner rule, ORD-03).
import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Clock, ShoppingBasket } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { OrderId } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  FeeNoRefund,
  hasGuestFee,
} from "@/features/ws05-payment/components/fee-parts";
import { WaiterOrderNotice } from "@/features/ws02-edge/components/waiter-order-notice";
import { useTableJourney } from "../../context";
import { orderHasPaidShare } from "../../domain.ts";
import {
  useChangeCartLine,
  usePlaceOrder,
  useQuote,
  useRemoveCartLine,
  useSessionBill,
  useStartPayment,
} from "../../hooks";
import { paymentOptionsQuery } from "../../queries";
import { idempotencyKey } from "../../lib/ids.ts";
import { feeChanged, gatewayUnreachable } from "../../lib/pay-failure.ts";
import { formatAvailableFrom } from "../../lib/item-options.ts";
import { outletTimeZone } from "../../lib/outlet-time-zone.ts";
import { CompanionOffer, useCompanion } from "../glass/companion-offer";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";
import { Notice } from "../notice";
import { SessionEnded } from "../session-states";
import { CartLineRow } from "./cart-line-row";
import { CodeField } from "./code-field";
import { FeeConfirm } from "./fee-confirm";
import { GatewayOpenFailed } from "./gateway-opening";
import {
  PICK_WALLET_ID,
  PaymentMethods,
  useChosenFee,
  useCtaLabel,
  usePricedState,
  useWalletName,
  type PayChoice,
} from "./payment-methods";
import { PriceBreakdown } from "./price-breakdown";
import { SignInNudge } from "./sign-in-nudge";

const VOUCHER = /^[A-Z0-9]{3,6}(-[A-Z0-9]{4,6}){1,3}$/;

function errorText(t: ReturnType<typeof useT>, error: unknown): string {
  if (!(error instanceof ApiError)) return t("qrCart.checkout.error.generic");
  switch (error.code) {
    case "CONFLICT":
      return t("qrCart.checkout.error.conflict");
    case "SESSION_NOT_CONFIRMED":
      return t("qrCart.checkout.error.notConfirmed");
    case "MINIMUM_SPEND_NOT_MET":
      return t("qrCart.checkout.error.minimumSpend");
    case "SESSION_CLOSED":
      return t("qrCart.checkout.error.closed");
    case "CART_EMPTY":
      return t("qrCart.checkout.error.cartEmpty");
    case "BUSINESS_DAY_ALREADY_CLOSED":
      return t("qrCart.checkout.error.dayClosed");
    default:
      return t("qrCart.checkout.error.generic");
  }
}

/** The page frame: glass nav with back to the menu, then the content. */
function Shell({
  qrToken,
  children,
}: {
  qrToken: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <QrTopBar
        title={t("qrGlass.checkout.title")}
        leading={
          <Link
            to="/t/$token"
            params={{ token: qrToken }}
            className={qrRoundIcon}
          >
            <ChevronLeft aria-hidden="true" />
            <span className="sr-only">{t("qrGlass.checkout.back")}</span>
          </Link>
        }
      />
      {children}
    </div>
  );
}

// One key per order and method for the whole visit: the guest leaves for
// /pay/$id and may come back ("Ganti metode bayar", browser back), and a
// remounted page must not open a second payment intent for the same order.
const payKeys = new Map<string, string>();
function payKey(orderId: string, method: string) {
  const id = `${orderId}:${method}`;
  let key = payKeys.get(id);
  if (!key) {
    key = idempotencyKey("pay");
    payKeys.set(id, key);
  }
  return key;
}
function forgetPayKey(orderId: string, method: string) {
  payKeys.delete(`${orderId}:${method}`);
}

/** Full width; a long label ("Bayar Rp… dengan E-wallet") wraps at 320 px. */
const payCta = "h-auto min-h-control-lg w-full py-2 whitespace-normal";

export function CheckoutPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const ctaLabel = useCtaLabel();
  const { session } = useRouteContext({ strict: false }) as {
    session?: unknown;
  };
  const {
    qrToken,
    menu,
    sessionId,
    guest,
    view,
    viewError,
    participantId,
    ended,
    awaitingConfirmation,
    openJoin,
  } = useTableJourney();
  const cartVersion = view?.cart.version ?? 0;
  const [code, setCode] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [choice, setChoice] = useState<PayChoice>({
    method: "qris",
    wallet: null,
  });
  const method = choice.method;
  // 1272 K3: a placed order waiting for payment names the bill the options are
  // priced for; a cart not placed yet has no bill, so no service fee to show.
  const waitingId =
    view && view.cart.lines.length === 0
      ? view.orders.find((order) => order.status === "awaiting_payment")?.id
      : undefined;
  const feeTarget = waitingId ? { orderId: waitingId } : undefined;
  const walletName = useWalletName(choice.wallet, feeTarget);
  const chosenFee = useChosenFee(choice, feeTarget);
  // 1272 K3: an e-wallet or card on a placed order is paid only once the
  // options of that order have loaded: until then (or after an error) the fee
  // is not known, and the guest must not reach Duitku with a fee unseen.
  const priced = usePricedState(feeTarget);
  const feeUnknown =
    (method === "ewallet" || method === "card") &&
    (priced.waiting || priced.failed);
  // The guest waits while the fee of a just-placed order is read.
  const [checking, setChecking] = useState(false);
  // An e-wallet needs an app picked by the guest (nothing is preselected).
  const needsWallet = method === "ewallet" && !choice.wallet;
  // C2b: Duitku's page for e-wallet or card could not be opened for this order.
  const [openFailed, setOpenFailed] = useState<{
    orderId: OrderId;
    amountIdr: number;
  } | null>(null);
  // 1272 K3: an e-wallet or card with a service fee waits here, after the
  // order is placed and before Duitku's page opens, until the guest has seen
  // the fee and the total.
  const [confirm, setConfirm] = useState<{
    orderId: OrderId;
    amountIdr: number;
    feeIdr: number;
    chargedIdr: number;
  } | null>(null);
  const queryClient = useQueryClient();
  const codes = code
    ? VOUCHER.test(code)
      ? { voucherCode: code }
      : { promoCode: code }
    : {};
  const base = useQuote(sessionId, cartVersion, {});
  const coded = useQuote(code ? sessionId : null, cartVersion, codes);
  const place = usePlaceOrder(sessionId ?? "none");
  const start = useStartPayment(sessionId ?? "none");
  const change = useChangeCartLine(sessionId ?? "none");
  const remove = useRemoveCartLine(sessionId ?? "none");
  const companion = useCompanion();
  // Only needed to see whether a waiting pay-first order is already being paid per share.
  const bill = useSessionBill(
    view?.orders.some((order) => order.status === "awaiting_payment")
      ? sessionId
      : null,
  );
  // One key per cart state: a double tap or retry returns the same order.
  const keyRef = useRef<{ version: number; key: string } | null>(null);

  if (ended) return <SessionEnded />;
  if (!guest)
    return (
      <Shell qrToken={qrToken}>
        <EmptyState
          icon={ShoppingBasket}
          title={t("qrCart.cart.noSessionTitle")}
          description={t("qrCart.cart.noSessionHint")}
          action={
            <Button type="button" onClick={() => openJoin()}>
              {t("qrCart.cart.noSessionAction")}
            </Button>
          }
        />
      </Shell>
    );
  if (viewError)
    return (
      <Shell qrToken={qrToken}>
        <ErrorState
          title={t("qrCart.cart.errorTitle")}
          description={t("qrCart.cart.errorHint")}
          onRetry={() => window.location.reload()}
        />
      </Shell>
    );
  if (!view || !menu || !sessionId)
    return (
      <Shell qrToken={qrToken}>
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">
            {t("qrCart.checkout.breakdown.loading")}
          </span>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full rounded-qr-media" />
          <Skeleton className="h-16 w-full rounded-qr-media" />
          <Skeleton className="h-28 w-full rounded-qr-media" />
        </div>
      </Shell>
    );

  const payFirst = view.session.paymentMode === "pay_first";
  const awaitingOrder = view.orders.find(
    (order) => order.status === "awaiting_payment",
  );
  const quote =
    (code && coded.data ? coded.data.data : undefined) ??
    base.data?.data ??
    view.quote ??
    null;
  const codeInvalid = code !== null && coded.isError;
  const codeApplied = code !== null && coded.isSuccess ? code : null;
  const lines = view.cart.lines;
  const hasLines = lines.length > 0;
  const subtitle = (
    <p className="text-sm leading-5 text-muted-foreground">
      {t("qrGlass.checkout.tableShared", { table: menu.table.code })}
    </p>
  );
  const openItem = (itemId: string) =>
    void navigate({
      to: "/t/$token",
      params: { token: qrToken },
      search: { item: itemId },
    });

  // Pay an order that is already placed: gateway for QRIS, the
  // cashier code screen for "Bayar di kasir", the VA screen for Virtual
  // Account (it lists the provider's banks and opens the VA itself, since
  // the VA needs a bank before useStartPayment can run).
  const payOrder = (
    orderId: OrderId,
    amountIdr: number,
    fresh = false,
    // 1272 P2-2: what the guest confirmed (bill and the total with the fee).
    priced?: { billIdr: number; chargedIdr: number },
  ) => {
    if (method === "va") {
      void navigate({
        to: "/t/$token/bayar/$orderId",
        params: { token: qrToken, orderId },
        search: { metode: "va" },
      });
      return;
    }
    if (method === "cashier") {
      void navigate({
        to: "/t/$token/kasir/$orderId",
        params: { token: qrToken, orderId },
      });
      return;
    }
    // An e-wallet key is per app: another app is another payment.
    const keyMethod =
      method === "ewallet" ? `ewallet:${choice.wallet ?? ""}` : method;
    const redirect = method === "ewallet" || method === "card";
    if (method === "ewallet" && !choice.wallet) return;
    start.mutate(
      {
        target: { kind: "order", orderId },
        method,
        ...(method === "ewallet" && choice.wallet
          ? { bankCode: choice.wallet }
          : {}),
        ...(priced ? { expectedChargedIdr: priced.chargedIdr } : {}),
        idempotencyKey: payKey(orderId, keyMethod),
      },
      {
        onError: (error) => {
          // The price changed since it was confirmed (or a fee is new): back
          // to the confirmation step with the price read again.
          if (feeChanged(error) && redirect) {
            forgetPayKey(orderId, keyMethod);
            toast({ title: t("payment.redirect.fee.changed"), tone: "danger" });
            void payPlaced(orderId, priced?.billIdr ?? amountIdr);
            return;
          }
          // Only "no answer" or a gateway outage is "could not be opened";
          // a refusal (409, 422) shows the ordinary failure notice.
          if (redirect && gatewayUnreachable(error))
            setOpenFailed({ orderId, amountIdr });
        },
        onSuccess: (result) => {
          // A replayed key returns the same payment; once it has expired or
          // failed, retrying must open a new one (one fresh attempt).
          if (
            !fresh &&
            (result.data.status === "expired" ||
              result.data.status === "failed")
          ) {
            forgetPayKey(orderId, keyMethod);
            payOrder(orderId, amountIdr, true, priced);
            return;
          }
          setOpenFailed(null);
          void navigate({
            to: "/t/$token/pay/$paymentId",
            params: { token: qrToken, paymentId: result.data.id },
          });
        },
      },
    );
  };

  // 1272 K3: pay the order that was just placed. An e-wallet or card is priced
  // for that order first: with a service fee the guest confirms it before the
  // gateway opens; without one (or QRIS) it goes straight on, as before. A
  // method that left the options, or a list that cannot be read, never opens
  // the gateway: the guest lands on the placed order's method list.
  const payPlaced = async (orderId: OrderId, amountIdr: number) => {
    if (method !== "ewallet" && method !== "card") {
      payOrder(orderId, amountIdr);
      return;
    }
    setChecking(true);
    try {
      const options = await queryClient.fetchQuery({
        ...paymentOptionsQuery(sessionId, { orderId }),
        staleTime: 0,
        retry: false,
      });
      const entry = options.data.methods.find((item) => item.method === method);
      const pricedEntry =
        method === "ewallet"
          ? entry?.banks.find((bank) => bank.code === choice.wallet)
          : entry;
      // The method vanished: say so and land on the placed order's list.
      if (!entry?.enabled || !pricedEntry) {
        toast({
          title: t("payment.redirect.fee.gone", {
            method:
              method === "card"
                ? t("payment.redirect.cardName")
                : (walletName ?? t("payment.redirect.method.ewallet")),
          }),
          tone: "danger",
        });
        window.setTimeout(
          () => document.getElementById("method-title")?.focus(),
          400,
        );
        return;
      }
      if (
        hasGuestFee(pricedEntry.guestFeeIdr) &&
        pricedEntry.chargedIdr !== null
      ) {
        setConfirm({
          orderId,
          amountIdr,
          feeIdr: pricedEntry.guestFeeIdr,
          chargedIdr: pricedEntry.chargedIdr,
        });
        return;
      }
      payOrder(orderId, amountIdr);
    } catch {
      toast({
        title: t("payment.redirect.fee.checkFailed"),
        tone: "danger",
      });
    } finally {
      setChecking(false);
    }
  };

  if (confirm && (method === "ewallet" || method === "card"))
    return (
      <Shell qrToken={qrToken}>
        <FeeConfirm
          method={method}
          walletName={walletName}
          orderId={confirm.orderId}
          amountIdr={confirm.amountIdr}
          feeIdr={confirm.feeIdr}
          chargedIdr={confirm.chargedIdr}
          onPay={() => {
            const { orderId, chargedIdr, amountIdr: billIdr } = confirm;
            setConfirm(null);
            payOrder(orderId, chargedIdr, false, { billIdr, chargedIdr });
          }}
          onOtherMethod={() => {
            setConfirm(null);
            requestAnimationFrame(() =>
              document.getElementById("method-title")?.focus(),
            );
          }}
        />
      </Shell>
    );

  // C2b: Duitku's page could not be opened. Nothing was paid; the order and
  // the cart stay as they are (design/mockups/c2b-tamu-bayar "membuka-gagal").
  if (openFailed && (method === "ewallet" || method === "card"))
    return (
      <GatewayOpenFailed
        method={method}
        walletName={walletName}
        amountIdr={openFailed.amountIdr}
        orderId={openFailed.orderId}
        retrying={start.isPending}
        onRetry={() => payOrder(openFailed.orderId, openFailed.amountIdr)}
        onOtherMethod={() => {
          setOpenFailed(null);
          start.reset();
          // The button that had focus is gone: land on the method list.
          requestAnimationFrame(() =>
            document.getElementById("method-title")?.focus(),
          );
        }}
      />
    );

  const payFailure = start.isError && (
    <Notice tone="danger" title={t("qrOrders.bill.payFailed")} />
  );
  // `compact`: with a fee line above, the phone footer keeps its height down.
  const total = (amount: number, compact = false) => (
    <div className="flex items-baseline justify-between gap-3 px-1">
      <span>{t("qrGlass.checkout.total")}</span>
      <span
        className={cn(
          "font-bold tracking-tight tabular",
          compact ? "text-xl leading-7" : "text-[1.75rem] leading-8",
        )}
      >
        {formatRupiah(amount)}
      </span>
    </div>
  );
  // The aside card is solid paper from lg up; below it the footer floats.
  const asideClass =
    "grid content-start gap-4 lg:sticky lg:top-6 lg:rounded-qr-media lg:bg-card lg:p-5 lg:shadow-raised";

  // The cart was already placed and is waiting for payment (pay-first):
  // show the order and the same method picker, e.g. after "Ganti metode bayar".
  if (!hasLines && awaitingOrder) {
    const splitPaid = orderHasPaidShare(
      bill.data?.data.splits ?? [],
      awaitingOrder.id,
    );
    // The bill plus the service fee of the chosen method, when it has one.
    const payTotal = chosenFee?.chargedIdr ?? awaitingOrder.totalIdr;
    const action = (
      <div className="grid gap-3">
        {payFailure}
        {chosenFee && (
          <div className="flex items-baseline justify-between gap-3 px-1 text-sm">
            <span className="text-muted-foreground">
              {t("payment.redirect.fee.label")}
            </span>
            <span className="font-semibold tabular">
              {formatRupiah(chosenFee.feeIdr)}
            </span>
          </div>
        )}
        {total(payTotal, chosenFee !== null)}
        <FeeNoRefund feeIdr={chosenFee?.feeIdr} className="px-1" />
        <Button
          type="button"
          size="lg"
          className={payCta}
          loading={start.isPending || (feeUnknown && priced.waiting)}
          disabled={needsWallet || feeUnknown}
          aria-describedby={needsWallet ? PICK_WALLET_ID : undefined}
          onClick={() => payOrder(awaitingOrder.id, payTotal)}
        >
          {ctaLabel(choice, payTotal, walletName)}
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    );
    return (
      <Shell qrToken={qrToken}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-8">
          <div className="grid min-w-0 content-start gap-4">
            {subtitle}
            <section className="grid gap-3 rounded-qr-media bg-card p-4">
              <h2 className="type-heading">
                {t("qrGlass.checkout.awaitingOrderTitle", {
                  number: awaitingOrder.number,
                })}
              </h2>
              <ul className="grid gap-2">
                {awaitingOrder.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0">
                      <span className="tabular">{item.quantity}×</span>{" "}
                      {item.name}
                    </span>
                    <Money amount={item.lineTotalIdr} />
                  </li>
                ))}
              </ul>
              <p className="text-sm leading-5 text-muted-foreground">
                {splitPaid
                  ? /* ORD-06: shares are being paid; the whole order must not be charged again. */
                    t("qrCart.checkout.splitInProgress")
                  : t("qrGlass.checkout.awaitingOrderHint")}
              </p>
            </section>
            {splitPaid && (
              <Button asChild size="lg">
                <Link to="/t/$token/bill" params={{ token: qrToken }}>
                  {t("qrCart.checkout.toBill")}
                </Link>
              </Button>
            )}
          </div>
          {!splitPaid && (
            <aside className={asideClass}>
              <PaymentMethods
                value={choice}
                onChange={setChoice}
                disabled={start.isPending}
                target={feeTarget}
              />
              <div className="hidden border-t border-border pt-4 lg:block">
                {action}
              </div>
            </aside>
          )}
        </div>
        {!splitPaid && <QrFooter className="lg:hidden">{action}</QrFooter>}
      </Shell>
    );
  }

  if (!hasLines || !quote)
    return (
      <Shell qrToken={qrToken}>
        <EmptyState
          icon={ShoppingBasket}
          title={t("qrCart.cart.emptyTitle")}
          description={t("qrCart.checkout.empty")}
          action={
            <Button asChild>
              <Link to="/t/$token" params={{ token: qrToken }}>
                {t("qrCart.cart.toMenu")}
              </Link>
            </Button>
          }
        />
      </Shell>
    );

  // The order is placed without the promo / voucher code (the place contract
  // has no code field), so the charged amount and the breakdown both come
  // from the quote without the code. While that quote is still loading there
  // is nothing to pay yet: never fall back to the coded total.
  const plainQuote = codeApplied ? (base.data?.data ?? null) : quote;
  const payable = plainQuote?.totalIdr ?? null;
  const shortfall = quote.minimumSpend.shortfallIdr;
  const busy = place.isPending || start.isPending || checking;
  // WS-02: the outlet's edge link is down (the view says so, or the order was
  // just refused with EDGE_LINK_DOWN): the guest asks a waiter instead.
  const orderingAvailable =
    view.orderingAvailable !== false &&
    !(place.error instanceof ApiError && place.error.code === "EDGE_LINK_DOWN");
  const blocked =
    !orderingAvailable ||
    shortfall > 0 ||
    quote.lines.length === 0 ||
    awaitingConfirmation ||
    // Pay-first charges now: hold until the amount without the code is known.
    // Pay-later charges nothing here (the bill is computed by the server).
    (payFirst && payable === null);
  const names = quote.removedLines.map((line) => line.name).join(", ");
  const soldOutIds = new Set(
    menu.items.filter((item) => item.status !== "available").map((i) => i.id),
  );
  const availableLabelFor = (menuItemId: string): string | null => {
    const item = menu.items.find((entry) => entry.id === menuItemId);
    const time =
      item?.status === "unavailable_until" && item.availableFrom
        ? formatAvailableFrom(item.availableFrom, outletTimeZone(menu))
        : null;
    return time ? t("qrGlass.menu.card.availableFrom", { time }) : null;
  };
  const lineBusy = change.isPending || remove.isPending;
  const lineFailure = change.error ?? remove.error;
  const onLineError = (error: unknown) =>
    toast({
      title:
        error instanceof ApiError && error.status === 409
          ? t("qrCart.cart.conflict")
          : t("qrCart.cart.updateError"),
      tone: "danger",
    });

  const submit = (afterPlaced: "pay" | "split" = "pay") => {
    if (keyRef.current?.version !== cartVersion)
      keyRef.current = { version: cartVersion, key: idempotencyKey("order") };
    place.mutate(
      { expectedCartVersion: cartVersion, idempotencyKey: keyRef.current.key },
      {
        onSuccess: ({ data }) => {
          if (afterPlaced === "split") {
            void navigate({ to: "/t/$token/bill", params: { token: qrToken } });
            return;
          }
          if (data.kitchenFire === "held_for_payment")
            void payPlaced(data.order.id, data.order.totalIdr);
          else {
            toast({
              title: t("qrCart.checkout.sentToast"),
              tone: "success",
            });
            void navigate({
              to: "/t/$token/orders",
              params: { token: qrToken },
            });
          }
        },
      },
    );
  };

  const blockedReason =
    shortfall > 0
      ? t("qrGlass.checkout.blockedMinimum", {
          shortfall: formatRupiah(shortfall),
        })
      : awaitingConfirmation
        ? t("qrCart.checkout.awaitingTitle")
        : null;
  const action = (
    <div className="grid gap-3">
      {!orderingAvailable && <WaiterOrderNotice />}
      {place.isError && orderingAvailable && (
        <Notice tone="danger" title={errorText(t, place.error)} />
      )}
      {payFailure}
      {codeApplied && payable !== null && payable !== quote.totalIdr && (
        <Notice
          tone="warning"
          title={t("qrGlass.checkout.codeNotCharged", {
            total: formatRupiah(payable),
          })}
        />
      )}
      {payable === null && base.isError ? (
        <Notice
          tone="danger"
          title={t("qrGlass.checkout.plainQuoteFailed")}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void base.refetch()}
            >
              {t("common.retry")}
            </Button>
          }
        />
      ) : payable === null ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        total(payable)
      )}
      {blocked && blockedReason && (
        <p className="px-1 text-sm leading-5 text-muted-foreground">
          {blockedReason}
        </p>
      )}
      <Button
        type="button"
        size="lg"
        className={payCta}
        loading={busy || (payFirst && payable === null && !base.isError)}
        disabled={blocked || needsWallet}
        aria-describedby={needsWallet ? PICK_WALLET_ID : undefined}
        onClick={() => submit()}
      >
        {payFirst
          ? payable === null
            ? t("qrGlass.checkout.cta.held")
            : ctaLabel(choice, payable, walletName)
          : t("qrCart.checkout.openBillSubmit")}
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );

  return (
    <Shell qrToken={qrToken}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-8">
        <div className="grid min-w-0 content-start gap-4">
          {subtitle}
          {lineFailure && !lineBusy && (
            <Notice
              tone="warning"
              title={
                lineFailure instanceof ApiError && lineFailure.status === 409
                  ? t("qrCart.cart.conflict")
                  : t("qrCart.cart.updateError")
              }
            />
          )}
          {quote.removedLines.length > 0 && (
            <Notice tone="warning" title={t("qrCart.checkout.removedTitle")}>
              {t("qrCart.checkout.removedBody", { names })}
            </Notice>
          )}
          {quote.priceChanges.map((change) => (
            <Notice
              key={change.cartLineId}
              tone="info"
              title={t("qrCart.checkout.priceChangedTitle")}
            >
              {t("qrCart.checkout.priceChangedBody", {
                name: change.name,
                from: formatRupiah(change.previousUnitPriceIdr),
                to: formatRupiah(change.unitPriceIdr),
              })}
            </Notice>
          ))}
          {awaitingConfirmation && (
            <Notice tone="waiting" title={t("qrCart.checkout.awaitingTitle")}>
              {t("qrCart.checkout.awaitingHint")}
            </Notice>
          )}
          <ul className="grid gap-2">
            {lines.map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                token={qrToken}
                photoUrl={
                  menu.items.find((item) => item.id === line.menuItemId)
                    ?.photoUrl ?? null
                }
                soldOut={soldOutIds.has(line.menuItemId)}
                availableLabel={availableLabelFor(line.menuItemId)}
                mine={
                  line.addedByParticipantId === null || participantId === null
                    ? null
                    : line.addedByParticipantId === participantId
                }
                busy={busy || lineBusy}
                onQuantity={(quantity) =>
                  change.mutate(
                    {
                      lineId: line.id,
                      cartVersion,
                      patch: { quantity },
                    },
                    { onError: onLineError },
                  )
                }
                onRemove={() =>
                  remove.mutate(
                    { lineId: line.id, cartVersion },
                    {
                      onError: onLineError,
                      onSuccess: () =>
                        toast({
                          title: t("qrCart.cart.removed", { name: line.name }),
                          tone: "info",
                        }),
                    },
                  )
                }
              />
            ))}
          </ul>
          {companion && menu.orderingOpen && !awaitingConfirmation && (
            <CompanionOffer
              item={companion}
              onOpenItem={openItem}
              disabled={busy || lineBusy}
            />
          )}
          {quote.servingEstimate && (
            <p className="flex items-center gap-2 leading-6">
              <Clock className="size-5 shrink-0" aria-hidden="true" />
              <span>{t("qrCart.checkout.estimateTitle")}</span>
              <strong className="tabular">
                {t("qrCart.checkout.estimate", {
                  min: quote.servingEstimate.minMinutes,
                  max: quote.servingEstimate.maxMinutes,
                })}
              </strong>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4">
            <Link
              to="/t/$token"
              params={{ token: qrToken }}
              className={`${qrTextLink} min-h-11 text-sm`}
            >
              {t("qrGlass.checkout.addMenu")}
            </Link>
            <button
              type="button"
              aria-expanded={codeOpen}
              className={`${qrTextLink} min-h-11 text-sm`}
              onClick={() => {
                if (codeOpen && codeInvalid) setCode(null);
                setCodeOpen(!codeOpen);
              }}
            >
              {t("qrGlass.checkout.codeToggle")}
            </button>
            {payFirst && (
              <button
                type="button"
                disabled={blocked || busy}
                className={`${qrTextLink} min-h-11 text-sm disabled:opacity-50`}
                onClick={() => submit("split")}
              >
                {t("qrCart.checkout.splitSubmit")}
              </button>
            )}
          </div>
          <CodeField
            applied={codeApplied}
            invalid={codeInvalid}
            checking={coded.isFetching}
            open={codeOpen}
            onApply={setCode}
            onRemove={() => setCode(null)}
          />
          {plainQuote ? (
            <PriceBreakdown quote={plainQuote} />
          ) : (
            <Skeleton className="h-24 w-full rounded-qr-media" />
          )}
          {shortfall > 0 && (
            <Notice
              tone="danger"
              title={t("qrCart.checkout.minimumSpend", {
                required: formatRupiah(quote.minimumSpend.requiredIdr),
                shortfall: formatRupiah(shortfall),
              })}
            />
          )}
        </div>
        <aside className={asideClass}>
          {payFirst ? (
            <PaymentMethods
              value={choice}
              onChange={setChoice}
              disabled={busy}
            />
          ) : (
            <section className="grid gap-1">
              <h2 className="type-heading">
                {t("qrCart.checkout.modeOpenBill")}
              </h2>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("qrCart.checkout.modeOpenBillHint")}
              </p>
            </section>
          )}
          <div className="hidden border-t border-border pt-4 lg:block">
            {action}
          </div>
        </aside>
      </div>
      {/* PRD §3 F10 "Login Opsional": guests order without an account; this
          only invites sign-in and never gates the actions above. legend-yoo9:
          `/masuk?redirect=` resumes this checkout after sign-in. */}
      {!session && <SignInNudge returnTo={`/t/${qrToken}/checkout`} />}
      <QrFooter className="lg:hidden">{action}</QrFooter>
    </Shell>
  );
}
