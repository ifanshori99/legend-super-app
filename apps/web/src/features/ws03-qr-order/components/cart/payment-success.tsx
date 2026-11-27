// "Pembayaran berhasil" (final arah A, legend-2re1): shared by the QRIS
// page and the cashier page. It only renders once the server says
// so (payment paid, or the order left awaiting_payment); it never decides
// success itself (ORD-02). No upsell here, only the receipt and next steps.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Check, Clock } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { QrOrder } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { safeReturnPath } from "@/features/ws01-login/flow";
import { useTableJourney } from "../../context";
import { effectiveClaimStatus } from "../../domain.ts";
import { useClaimPoints, useOrderEtas, usePointClaim } from "../../hooks";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";

export type PaymentSuccessMethod =
  "qris" | "va" | "ewallet" | "card" | "cashier";

function Points({
  sessionId,
  returnTo,
}: {
  sessionId: string;
  returnTo: string;
}) {
  const t = useT();
  const claimQuery = usePointClaim(sessionId);
  const claim = useClaimPoints(sessionId);
  // Read once per mount: the 24 h deadline does not need a ticking clock.
  const [now] = useState(() => Date.now());
  const data = claimQuery.data?.data;
  // A failed or loading claim never blocks the receipt: the block stays out.
  if (!data) return null;
  const status = effectiveClaimStatus(data, now);
  if (status === "unavailable" || status === "expired") return null;
  return (
    <section
      aria-labelledby="pay-success-points"
      className="grid gap-1 border-t border-border pt-4"
    >
      <h2 id="pay-success-points" className="text-[1.0625rem] font-bold">
        {t("qrGlass.pay.success.pointsTitle")}
      </h2>
      <div aria-live="polite" className="grid justify-items-start gap-2">
        {status === "claimed" && (
          <p className="text-muted-foreground">
            {t("qrGlass.pay.success.pointsDone")}
          </p>
        )}
        {status === "available" && data.requiresLogin && (
          <>
            <p className="text-muted-foreground">
              {t("qrGlass.pay.success.pointsLogin")}
            </p>
            <Link
              to="/masuk"
              search={{ redirect: safeReturnPath(returnTo) }}
              className={qrTextLink}
            >
              {t("qrGlass.pay.success.pointsLoginAction")}
            </Link>
          </>
        )}
        {status === "available" && !data.requiresLogin && (
          <>
            <p className="text-muted-foreground">
              {t("qrGlass.pay.success.pointsReady")}
            </p>
            <Button
              type="button"
              variant="outline"
              loading={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {t("qrOrders.bill.claimAvailable", { points: data.points })}
            </Button>
          </>
        )}
        {claim.isError && (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("qrOrders.bill.claimFailed")}
          </p>
        )}
      </div>
    </section>
  );
}

export function PaymentSuccess({
  order,
  amountIdr,
  method,
  returnTo,
}: {
  /** The paid order when it is known; the receipt rows hide without it. */
  order: QrOrder | null;
  amountIdr: number;
  method: PaymentSuccessMethod;
  /** App-local path of the page that renders this (sign-in comes back here). */
  returnTo: string;
}) {
  const t = useT();
  const { qrToken, menu, view, sessionId } = useTableJourney();
  const etas = useOrderEtas(sessionId);
  const eta = order
    ? etas.data?.data.find((item) => item.orderId === order.id)
    : undefined;
  const photoByItem = new Map(
    (menu?.items ?? []).map((item) => [item.id, item.photoUrl]),
  );
  const table = menu?.table.code;
  const pax = view?.session.pax;
  const items = order?.items.filter((item) => item.status !== "voided") ?? [];
  const methodLabel =
    method === "qris"
      ? t("qrGlass.pay.success.methodQris")
      : method === "va"
        ? t("qrGlass.pay.success.methodVa")
        : method === "ewallet"
          ? t("payment.redirect.method.ewallet")
          : method === "card"
            ? t("payment.redirect.method.card")
            : t("qrGlass.pay.success.methodCashier");

  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar
        title={menu?.brand.name ?? t("app.defaultBrand")}
        leading={
          <Link
            to="/t/$token"
            params={{ token: qrToken }}
            className={qrRoundIcon}
          >
            <ChevronLeft aria-hidden="true" />
            <span className="sr-only">{t("qrGlass.pay.success.back")}</span>
          </Link>
        }
      />

      <header className="grid gap-2">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-grid size-11 shrink-0 place-items-center rounded-full bg-success-subtle text-success"
          >
            <Check className="size-6" />
          </span>
          <h2 className="text-[1.5rem] leading-[1.875rem] font-bold tracking-[-0.9px]">
            {t("qrGlass.pay.success.title")}
          </h2>
        </div>
        <p role="status" className="text-muted-foreground">
          {t("qrGlass.pay.success.thanks")}
        </p>
      </header>

      <section className="grid gap-4 rounded-qr-media bg-card p-5 shadow-raised">
        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {t("qrGlass.pay.success.paidLabel")}
            </span>
            <span className="font-semibold">{methodLabel}</span>
          </div>
          <Money
            amount={amountIdr}
            size="xl"
            className="text-[2.5rem] leading-none font-bold tracking-tight"
          />
        </div>
        {order && (
          <>
            <hr className="border-t border-dashed border-input" />
            <dl className="grid gap-1">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("qrGlass.pay.success.orderRow")}
                </dt>
                <dd className="font-semibold tabular">{order.number}</dd>
              </div>
              {table && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t("qrGlass.pay.success.tableRow")}
                  </dt>
                  <dd className="font-semibold tabular">
                    {pax
                      ? t("qrGlass.pay.success.tableGuests", { table, pax })
                      : table}
                  </dd>
                </div>
              )}
            </dl>
            {items.length > 0 && (
              <>
                <hr className="border-t border-border" />
                <ul
                  aria-label={t("qrGlass.pay.success.itemsLabel")}
                  className="grid gap-3"
                >
                  {items.map((item) => {
                    const photo = photoByItem.get(item.menuItemId);
                    const modifiers = item.modifiers
                      .map((modifier) => modifier.name)
                      .join(", ");
                    const price = formatRupiah(
                      item.unitPriceIdr + item.modifiersTotalIdr,
                    );
                    return (
                      <li key={item.id} className="flex items-center gap-3">
                        <div className="size-16 shrink-0 overflow-hidden rounded-qr-cta bg-surface-2">
                          {photo && (
                            <img
                              src={photo}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="size-full object-cover"
                            />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold">
                            {t("qrGlass.pay.success.itemName", {
                              quantity: item.quantity,
                              name: item.name,
                            })}
                          </p>
                          <p className="text-sm text-muted-foreground tabular">
                            {modifiers
                              ? t("qrGlass.pay.success.itemDetail", {
                                  modifiers,
                                  price,
                                })
                              : price}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-sm text-muted-foreground">
                  {t("qrGlass.pay.success.taxNote")}
                </p>
              </>
            )}
          </>
        )}
      </section>

      {eta && (
        <div className="flex items-start gap-3 px-1">
          <Clock className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold tabular">
              {eta.minMinutes === eta.maxMinutes
                ? t("qrGlass.pay.success.etaSingle", {
                    minutes: eta.minMinutes,
                  })
                : t("qrGlass.pay.success.etaRange", {
                    min: eta.minMinutes,
                    max: eta.maxMinutes,
                  })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("qrGlass.pay.success.etaHint")}
            </p>
          </div>
        </div>
      )}

      {sessionId && <Points sessionId={sessionId} returnTo={returnTo} />}

      <QrFooter>
        <Button asChild>
          <Link to="/t/$token/orders" params={{ token: qrToken }}>
            {t("qrGlass.pay.success.toOrders")}
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
        <Link
          to="/t/$token/bill"
          params={{ token: qrToken }}
          className={`${qrTextLink} justify-self-center`}
        >
          {t("qrGlass.pay.success.toBill")}
        </Link>
      </QrFooter>
    </div>
  );
}
