// E-wallet and card for a QR order (C2b, legend-osqou.4;
// design/mockups/c2b-tamu-bayar "membuka" and "membuka-gagal"). The server
// opened the payment and answered with Duitku's page; this screen stores
// which payment it is (for `/bayar/kembali`), then sends the guest there once.
// Coming back with the browser's back button shows the manual button instead.
// Nothing here marks anything paid (ORD-02): the return page asks the server.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeft,
  ExternalLink,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { GuestPayment } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  AmountPaper,
  NumberedSteps,
  Spinner,
  StateHeader,
  StatusPill,
} from "@/features/ws05-payment/components/redirect-parts";
import {
  FeeNoRefund,
  hasGuestFee,
} from "@/features/ws05-payment/components/fee-parts";
import {
  claimAutoOpen,
  isOpenablePaymentUrl,
  openPaymentUrl,
  saveReturnRecord,
} from "@/features/ws05-payment/return-record";
import { useTableJourney } from "../../context";
import { outletTimeZone } from "../../lib/outlet-time-zone.ts";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";

/** "DANA" or "kartu" (title) and "DANA" or "pembayaran kartu" (page). */
export function useRedirectNames(
  method: GuestPayment["method"],
  walletName: string | null,
) {
  const t = useT();
  const wallet = walletName ?? t("payment.redirect.method.ewallet");
  return method === "card"
    ? {
        title: t("payment.redirect.cardName"),
        page: t("payment.redirect.cardPage"),
      }
    : { title: wallet, page: wallet };
}

export function useOrderRow(orderId: string | null) {
  const t = useT();
  const { menu, view } = useTableJourney();
  const number = orderId
    ? view?.orders.find((order) => order.id === orderId)?.number
    : undefined;
  const table = menu?.table.code;
  if (!number) return null;
  return {
    label: t("payment.redirect.opening.orderRow"),
    value: table
      ? t("payment.redirect.opening.orderValue", { number, table })
      : number,
  };
}

/** 1272 K3: the bill and the service fee behind the total, when there is a fee. */
function useFeeRows(amountIdr: number, feeIdr: number) {
  const t = useT();
  if (!hasGuestFee(feeIdr)) return [];
  return [
    {
      label: t("payment.redirect.fee.billRow"),
      value: formatRupiah(amountIdr),
    },
    { label: t("payment.redirect.fee.label"), value: formatRupiah(feeIdr) },
  ];
}

function Layout({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const t = useT();
  const { qrToken } = useTableJourney();
  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar
        title={title}
        leading={
          <Link
            to="/t/$token/checkout"
            params={{ token: qrToken }}
            className={qrRoundIcon}
          >
            <ChevronLeft aria-hidden="true" />
            <span className="sr-only">
              {t("payment.redirect.opening.cancelOrder")}
            </span>
          </Link>
        }
      />
      {children}
      <QrFooter>{footer}</QrFooter>
    </div>
  );
}

/** The gateway page could not be opened: nothing was paid yet. */
export function GatewayOpenFailed({
  method,
  walletName,
  amountIdr,
  orderId,
  onRetry,
  retrying,
  onOtherMethod,
}: {
  method: "ewallet" | "card";
  walletName: string | null;
  amountIdr: number;
  orderId: string | null;
  onRetry: () => void;
  retrying: boolean;
  onOtherMethod: () => void;
}) {
  const t = useT();
  const names = useRedirectNames(method, walletName);
  const orderRow = useOrderRow(orderId);
  return (
    <Layout
      title={t("payment.redirect.opening.title", { method: names.title })}
      footer={
        <>
          <Button type="button" loading={retrying} onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("payment.redirect.opening.retry")}
          </Button>
          <button
            type="button"
            onClick={onOtherMethod}
            className={`${qrTextLink} min-h-11 justify-self-center`}
          >
            {t("payment.redirect.opening.otherMethod")}
          </button>
        </>
      }
    >
      <div className="grid gap-5">
        <StateHeader
          alert
          focusTitle
          pill={
            <StatusPill tone="bad" icon={<TriangleAlert />}>
              {t("payment.redirect.opening.failedPill")}
            </StatusPill>
          }
          title={t("payment.redirect.opening.failedTitle", {
            method: names.page,
          })}
          lead={t("payment.redirect.opening.failedLeadOrder")}
        />
        <AmountPaper
          label={t("payment.redirect.opening.totalLabel")}
          amountIdr={amountIdr}
          rows={orderRow ? [orderRow] : []}
        />
      </div>
    </Layout>
  );
}

/** A pending e-wallet or card payment: open Duitku's page. */
export function GatewayOpening({ payment }: { payment: GuestPayment }) {
  const t = useT();
  const navigate = useNavigate();
  const { qrToken, sessionId, menu, view } = useTableJourney();
  const method = payment.method === "card" ? "card" : "ewallet";
  const names = useRedirectNames(method, payment.bankName);
  const target = payment.target;
  const orderId = target.kind === "order" ? target.orderId : null;
  const orderRow = useOrderRow(orderId);
  const feeRows = useFeeRows(payment.amountIdr, payment.guestFeeIdr);
  const url = payment.redirectUrl;
  const openable = url !== null && isOpenablePaymentUrl(url);
  // Opened automatically once per payment and tab (never rendered on the
  // server: the payment is read with the tab's session credential).
  const [autoOpen] = useState(
    () => openable && sessionId !== null && claimAutoOpen(payment.id),
  );
  const [left, setLeft] = useState(false);
  const state = autoOpen && !left ? "opening" : "ready";
  const place = menu?.brand.name ?? null;
  const orderNumber = orderId
    ? (view?.orders.find((order) => order.id === orderId)?.number ?? null)
    : null;

  // Stored before leaving, so /bayar/kembali knows which payment to ask about.
  useEffect(() => {
    if (!sessionId || !openable) return;
    saveReturnRecord({
      kind: "table",
      paymentId: payment.id,
      qrToken,
      sessionId,
      orderId,
      orderNumber,
      tableCode: menu?.table.code ?? null,
      method,
      channelCode: payment.bankCode,
      channelName: payment.bankName,
      // What the guest pays the gateway, with the service fee inside it.
      amountIdr: payment.chargedIdr,
      ...(payment.guestFeeIdr > 0 ? { guestFeeIdr: payment.guestFeeIdr } : {}),
      placeName: place,
      timeZone: outletTimeZone(menu),
      theme: menu?.theme
        ? {
            tokens: menu.theme.tokens,
            fontFamily: menu.theme.fontFamily,
            corners: menu.theme.corners,
            logoUrl: menu.theme.logoUrl,
          }
        : null,
    });
  }, [
    sessionId,
    openable,
    payment,
    qrToken,
    orderId,
    orderNumber,
    menu,
    method,
    place,
  ]);

  useEffect(() => {
    if (!autoOpen || !url) return;
    // Leaves the app; if the browser stays (blocked), the button remains.
    const timer = window.setTimeout(() => {
      openPaymentUrl(url);
      setLeft(true);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [autoOpen, url]);

  if (!openable)
    return (
      <GatewayOpenFailed
        method={method}
        walletName={payment.bankName}
        amountIdr={payment.chargedIdr}
        orderId={orderId}
        onRetry={() => window.location.reload()}
        retrying={false}
        onOtherMethod={() =>
          void navigate({
            to: "/t/$token/checkout",
            params: { token: qrToken },
          })
        }
      />
    );

  const total = formatRupiah(payment.chargedIdr);
  return (
    <Layout
      title={t("payment.redirect.opening.title", { method: names.title })}
      footer={
        <>
          <Button type="button" onClick={() => url && openPaymentUrl(url)}>
            {t("payment.redirect.opening.open", { method: names.page })}
            <ExternalLink aria-hidden="true" />
          </Button>
          <Link
            to="/t/$token/checkout"
            params={{ token: qrToken }}
            className={`${qrTextLink} min-h-11 justify-self-center`}
          >
            {t("payment.redirect.opening.cancelOrder")}
          </Link>
        </>
      }
    >
      <div
        aria-live="polite"
        aria-busy={state === "opening"}
        className="grid gap-5"
      >
        <div className="flex items-center gap-3">
          {state === "opening" && <Spinner />}
          <h2 className="type-title">
            {state === "opening"
              ? t("payment.redirect.opening.heading", { method: names.page })
              : t("payment.redirect.opening.readyHeading", {
                  method: names.page,
                })}
          </h2>
        </div>
        <AmountPaper
          label={t("payment.redirect.opening.totalLabel")}
          amountIdr={payment.chargedIdr}
          rows={[...(orderRow ? [orderRow] : []), ...feeRows]}
        />
        <FeeNoRefund feeIdr={payment.guestFeeIdr} />
        <NumberedSteps
          steps={[
            {
              title:
                method === "card"
                  ? t("payment.redirect.opening.step1Card")
                  : t("payment.redirect.opening.step1Wallet", {
                      wallet: names.page,
                    }),
              hint: t("payment.redirect.opening.step1Hint", { total }),
            },
            {
              title: t("payment.redirect.opening.step2"),
              hint: t("payment.redirect.opening.step2Hint"),
            },
            {
              title: t("payment.redirect.opening.step3Order"),
              hint: t("payment.redirect.opening.step3Hint"),
            },
          ]}
        />
        <p className="text-sm leading-5 text-muted-foreground">
          {place
            ? t("payment.redirect.opening.partner", { place })
            : t("payment.redirect.opening.partnerNoPlace")}
        </p>
      </div>
    </Layout>
  );
}
