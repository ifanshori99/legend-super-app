// Checkout (PRD §3 F10 "Mode Bayar", "Estimasi Waktu Saji", "Login Opsional").
// Pay-first: place the order, then pay; the kitchen sees it only after the
// gateway confirms (ORD-02). Open bill: the order goes straight to the kitchen
// and is paid at the end. Menu prices exclude tax and service charge, so the
// breakdown shows both before the total (owner rule, ORD-03).
import { useRef, useState } from "react";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { Clock, ShoppingBasket } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { GuestPaymentTarget } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { usePlaceOrder, useQuote } from "../../hooks";
import { idempotencyKey } from "../../lib/ids.ts";
import { PayDialog } from "../bill/pay-dialog";
import { Notice } from "../notice";
import { SessionEnded } from "../session-states";
import { CodeField } from "./code-field";
import { PriceBreakdown } from "./price-breakdown";

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
    default:
      return t("qrCart.checkout.error.generic");
  }
}

export function CheckoutPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
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
    ended,
    awaitingConfirmation,
    openJoin,
  } = useTableJourney();
  const cartVersion = view?.cart.version ?? 0;
  const [code, setCode] = useState<string | null>(null);
  const codes = code
    ? VOUCHER.test(code)
      ? { voucherCode: code }
      : { promoCode: code }
    : {};
  const base = useQuote(sessionId, cartVersion, {});
  const coded = useQuote(code ? sessionId : null, cartVersion, codes);
  const place = usePlaceOrder(sessionId ?? "none");
  const [payTarget, setPayTarget] = useState<{
    target: GuestPaymentTarget;
    amountIdr: number;
  } | null>(null);
  // One key per cart state: a double tap or retry returns the same order.
  const keyRef = useRef<{ version: number; key: string } | null>(null);

  if (ended) return <SessionEnded />;
  if (!guest)
    return (
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
    );
  if (viewError)
    return (
      <ErrorState
        title={t("qrCart.cart.errorTitle")}
        description={t("qrCart.cart.errorHint")}
        onRetry={() => window.location.reload()}
      />
    );
  if (!view || !menu || !sessionId)
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only">
          {t("qrCart.checkout.breakdown.loading")}
        </span>
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
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
  const hasLines = view.cart.lines.length > 0;

  // The cart was already placed and is waiting for payment (pay-first).
  if (!hasLines && awaitingOrder)
    return (
      <div className="grid gap-4">
        <h1 className="text-3xl leading-9 font-bold tracking-tight">
          {t("qrCart.checkout.title")}
        </h1>
        <Card>
          <CardContent className="grid gap-3">
            <p className="font-semibold">{awaitingOrder.number}</p>
            <Money amount={awaitingOrder.totalIdr} size="xl" />
            <p className="text-sm leading-5 text-muted-foreground">
              {t("qrCart.checkout.modePayFirstHint")}
            </p>
            <Button
              type="button"
              size="lg"
              onClick={() =>
                setPayTarget({
                  target: { kind: "order", orderId: awaitingOrder.id },
                  amountIdr: awaitingOrder.totalIdr,
                })
              }
            >
              {t("qrCart.checkout.payFirstSubmit", {
                total: formatRupiah(awaitingOrder.totalIdr),
              })}
            </Button>
          </CardContent>
        </Card>
        {payTarget && (
          <PayDialog
            open
            onOpenChange={(open) => !open && setPayTarget(null)}
            qrToken={qrToken}
            sessionId={sessionId}
            target={payTarget.target}
            amountIdr={payTarget.amountIdr}
          />
        )}
      </div>
    );

  if (!hasLines || !quote)
    return (
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
    );

  const shortfall = quote.minimumSpend.shortfallIdr;
  const blocked =
    shortfall > 0 || quote.lines.length === 0 || awaitingConfirmation;
  const names = quote.removedLines.map((line) => line.name).join(", ");

  const submit = () => {
    if (keyRef.current?.version !== cartVersion)
      keyRef.current = { version: cartVersion, key: idempotencyKey("order") };
    place.mutate(
      { expectedCartVersion: cartVersion, idempotencyKey: keyRef.current.key },
      {
        onSuccess: ({ data }) => {
          if (data.kitchenFire === "held_for_payment")
            setPayTarget({
              target: { kind: "order", orderId: data.order.id },
              amountIdr: data.order.totalIdr,
            });
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

  return (
    <div className="grid gap-5">
      <header className="grid gap-1">
        <h1 className="text-3xl leading-9 font-bold tracking-tight">
          {t("qrCart.checkout.title")}
        </h1>
        <Button asChild variant="link" className="w-fit">
          <Link to="/t/$token/cart" params={{ token: qrToken }}>
            {t("qrCart.checkout.backToCart")}
          </Link>
        </Button>
      </header>

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

      <section aria-labelledby="mode-title" className="grid gap-2">
        <h2 id="mode-title" className="sr-only">
          {t("qrCart.checkout.modeTitle")}
        </h2>
        <div className="rounded-xl bg-muted p-3">
          <p className="font-semibold">
            {payFirst
              ? t("qrCart.checkout.modePayFirst")
              : t("qrCart.checkout.modeOpenBill")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {payFirst
              ? t("qrCart.checkout.modePayFirstHint")
              : t("qrCart.checkout.modeOpenBillHint")}
          </p>
        </div>
      </section>

      {quote.servingEstimate && (
        <div className="flex items-center gap-3 rounded-xl border p-3">
          <Clock
            className="size-6 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm text-muted-foreground">
              {t("qrCart.checkout.estimateTitle")}
            </p>
            <p className="text-lg leading-6 font-semibold tabular">
              {t("qrCart.checkout.estimate", {
                min: quote.servingEstimate.minMinutes,
                max: quote.servingEstimate.maxMinutes,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("qrCart.checkout.estimateHint")}
            </p>
          </div>
        </div>
      )}

      <section aria-labelledby="items-title" className="grid gap-2">
        <h2 id="items-title" className="text-lg leading-7 font-semibold">
          {t("qrCart.checkout.itemsTitle")}
        </h2>
        <ul className="grid gap-2">
          {quote.lines.map((line) => (
            <li
              key={line.cartLineId}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="min-w-0">
                <span className="tabular">{line.quantity}×</span> {line.name}
              </span>
              <Money amount={line.lineSubtotalIdr} />
            </li>
          ))}
        </ul>
      </section>

      <CodeField
        applied={codeApplied}
        invalid={codeInvalid}
        checking={coded.isFetching}
        onApply={setCode}
        onRemove={() => setCode(null)}
      />

      <PriceBreakdown quote={quote} />

      {shortfall > 0 && (
        <Notice
          tone="danger"
          title={t("qrCart.checkout.minimumSpend", {
            required: formatRupiah(quote.minimumSpend.requiredIdr),
            shortfall: formatRupiah(shortfall),
          })}
        />
      )}

      {!session && (
        <Card>
          <CardContent className="grid gap-3">
            <p className="font-semibold">{t("qrCart.checkout.loginTitle")}</p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("qrCart.checkout.loginHint")}
            </p>
            <Button asChild variant="outline" className="w-fit">
              <Link to="/sign-in">{t("qrCart.checkout.signIn")}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="sticky bottom-0 z-10 -mx-gutter grid gap-2 border-t bg-background px-gutter py-3">
        {place.isError && (
          <Notice tone="danger" title={errorText(t, place.error)} />
        )}
        <Button
          type="button"
          size="lg"
          className="w-full"
          loading={place.isPending}
          disabled={blocked}
          onClick={submit}
        >
          {payFirst
            ? t("qrCart.checkout.payFirstSubmit", {
                total: formatRupiah(quote.totalIdr),
              })
            : t("qrCart.checkout.openBillSubmit")}
        </Button>
      </div>

      {payTarget && (
        <PayDialog
          open
          onOpenChange={(open) => !open && setPayTarget(null)}
          qrToken={qrToken}
          sessionId={sessionId}
          target={payTarget.target}
          amountIdr={payTarget.amountIdr}
        />
      )}
    </div>
  );
}
