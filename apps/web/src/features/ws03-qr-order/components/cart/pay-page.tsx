// Payment step (PRD §3 F13 QRIS dinamis). The page polls the payment until the
// gateway confirms; it never marks anything paid itself (ORD-02). QRIS shows a
// code to scan (e-wallet apps pay by scanning it). Layout: final arah A + liquid
// glass (legend-2re1, final-a-qris-menunggu-mobile.png).
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeft,
  CircleCheck,
  Clock,
  Download,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import type { GuestPayment } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { useGuestPayment, useRefreshSession } from "../../hooks";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";
import { GatewayOpening } from "./gateway-opening";
import { PaymentSuccess } from "./payment-success";

const QR_PNG_PX = 1024;

/** "04:58" plus whether under a minute is left; null until mounted so server and browser markup agree. */
function useCountdown(
  expiresAt: string,
): { label: string; urgent: boolean } | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () =>
      setRemainingMs(Math.max(0, Date.parse(expiresAt) - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  if (remainingMs === null) return null;
  const total = Math.ceil(remainingMs / 1000);
  return {
    label: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
    urgent: total < 60,
  };
}

/**
 * Renders the on-screen QR (dark modules on its own plate) to a PNG and
 * downloads it. Colors come from the rendered plate, so no color lives here.
 */
async function downloadQrPng(plate: HTMLElement, fileName: string) {
  const svg = plate.querySelector("svg");
  if (!svg) throw new Error("QR is not rendered");
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(QR_PNG_PX));
  clone.setAttribute("height", String(QR_PNG_PX));
  clone
    .querySelector("path")
    ?.setAttribute("fill", getComputedStyle(svg).color);
  const svgUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], {
      type: "image/svg+xml",
    }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("QR image failed to load"));
      image.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = QR_PNG_PX;
    canvas.height = QR_PNG_PX;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.fillStyle = getComputedStyle(plate).backgroundColor;
    context.fillRect(0, 0, QR_PNG_PX, QR_PNG_PX);
    context.drawImage(image, 0, 0, QR_PNG_PX, QR_PNG_PX);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("PNG export failed");
    const fileUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = fileUrl;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function PayWaiting({ payment }: { payment: GuestPayment }) {
  const t = useT();
  const { qrToken, menu, view } = useTableJourney();
  const plateRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<"idle" | "done" | "failed">("idle");
  const countdown = useCountdown(payment.expiresAt);
  const qris = payment.method === "qris" && payment.qrisPayload !== null;
  const target = payment.target;
  const orderNumber =
    target.kind === "order"
      ? view?.orders.find((order) => order.id === target.orderId)?.number
      : undefined;
  const table = menu?.table.code;
  const context = !table
    ? null
    : orderNumber
      ? t("qrGlass.pay.qris.context", { table, number: orderNumber })
      : t("qrGlass.pay.qris.contextTable", { table });

  const save = () => {
    const plate = plateRef.current;
    if (!plate) return;
    downloadQrPng(
      plate,
      t("qrGlass.pay.qris.saveQrFile", { amount: payment.amountIdr }),
    ).then(
      () => setSaved("done"),
      () => setSaved("failed"),
    );
  };

  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar
        title={t("qrGlass.pay.qris.title")}
        leading={
          <Link
            to="/t/$token/checkout"
            params={{ token: qrToken }}
            className={qrRoundIcon}
          >
            <ChevronLeft aria-hidden="true" />
            <span className="sr-only">{t("qrGlass.pay.qris.back")}</span>
          </Link>
        }
      />

      <header className="grid justify-items-start gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t("qrGlass.pay.qris.eyebrow")}
        </p>
        <Money
          amount={payment.amountIdr}
          size="xl"
          className="text-[2.5rem] leading-none font-bold tracking-tight"
        />
        {countdown && (
          <p
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm",
              countdown.urgent
                ? "bg-warning-subtle text-warning"
                : "bg-qr-selection",
            )}
          >
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-medium tabular">
              {t("qrGlass.pay.qris.timeLeft", { time: countdown.label })}
            </span>
          </p>
        )}
      </header>

      {qris && payment.qrisPayload && (
        <section className="grid justify-items-center gap-1 rounded-qr-media bg-card p-5 text-center shadow-raised">
          <h2 className="type-title">
            {menu?.brand.name ?? t("app.defaultBrand")}
          </h2>
          {context && (
            <p className="text-sm text-muted-foreground tabular">{context}</p>
          )}
          <div ref={plateRef} className="mt-3">
            <QrCode
              value={payment.qrisPayload}
              label={t("qrCart.pay.qrisAlt", {
                amount: formatRupiah(payment.amountIdr),
              })}
              margin={3}
              svgClassName="size-full"
              className="size-64 bg-card p-1 text-foreground"
            />
          </div>
        </section>
      )}

      <section role="status" aria-live="polite" className="grid gap-1">
        <p className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full bg-warning"
          />
          {t("qrGlass.pay.qris.statusWaiting")}
        </p>
        <p className="text-lg leading-7 text-muted-foreground">
          {t("qrGlass.pay.qris.qrisHint")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("qrGlass.pay.qris.autoUpdate")}
        </p>
        {saved !== "idle" && (
          <p
            className={
              saved === "failed"
                ? "text-sm font-medium text-danger"
                : "text-sm font-medium"
            }
          >
            {saved === "failed"
              ? t("qrGlass.pay.qris.saveQrFailed")
              : t("qrGlass.pay.qris.saveQrDone")}
          </p>
        )}
      </section>

      <QrFooter>
        {qris && (
          <Button type="button" onClick={save}>
            <Download aria-hidden="true" />
            {t("qrGlass.pay.qris.saveQr")}
          </Button>
        )}
        <Link
          to="/t/$token/checkout"
          params={{ token: qrToken }}
          className={`${qrTextLink} justify-self-center`}
        >
          {t("qrGlass.pay.qris.changeMethod")}
        </Link>
      </QrFooter>
    </div>
  );
}

export function PayPage({ paymentId }: { paymentId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { qrToken, sessionId, view } = useTableJourney();
  const result = useGuestPayment(
    sessionId ?? "none",
    sessionId ? paymentId : null,
  );
  const refresh = useRefreshSession(sessionId);
  const payment = result.data?.data;
  const status = payment?.status;

  // Once paid, the order/bill/claim screens must show the new state.
  useEffect(() => {
    if (status === "paid") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (sessionId === null)
    return (
      <EmptyState
        icon={TriangleAlert}
        title={t("qrCart.pay.notFoundTitle")}
        description={t("qrCart.pay.notFoundHint")}
        action={
          <Button asChild>
            <Link to="/t/$token/orders" params={{ token: qrToken }}>
              {t("qrCart.pay.toOrders")}
            </Link>
          </Button>
        }
      />
    );
  if (result.isError) {
    const notFound =
      result.error instanceof ApiError && result.error.status === 404;
    return notFound ? (
      <EmptyState
        icon={TriangleAlert}
        title={t("qrCart.pay.notFoundTitle")}
        description={t("qrCart.pay.notFoundHint")}
        action={
          <Button asChild>
            <Link to="/t/$token/orders" params={{ token: qrToken }}>
              {t("qrCart.pay.toOrders")}
            </Link>
          </Button>
        }
      />
    ) : (
      <ErrorState
        title={t("qrCart.pay.errorTitle")}
        description={t("qrCart.pay.errorHint")}
        onRetry={() => void result.refetch()}
      />
    );
  }
  if (!payment)
    return (
      <div
        aria-busy="true"
        className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl"
      >
        <QrTopBar title={t("qrGlass.pay.qris.title")} />
        <span className="sr-only">{t("qrCart.pay.loadingTitle")}</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="h-96 w-full rounded-qr-media" />
      </div>
    );

  const share = payment.target.kind === "split";
  const back = share ? "/t/$token/bill" : "/t/$token/orders";

  const target = payment.target;
  if (payment.status === "paid" && !share)
    return (
      <PaymentSuccess
        order={
          target.kind === "order"
            ? (view?.orders.find((order) => order.id === target.orderId) ??
              null)
            : null
        }
        amountIdr={payment.amountIdr}
        method={payment.method}
        returnTo={`/t/${encodeURIComponent(qrToken)}/pay/${encodeURIComponent(paymentId)}`}
      />
    );

  if (payment.status === "paid")
    return (
      <EmptyState
        icon={CircleCheck}
        title={t("qrCart.pay.paidTitle")}
        description={
          share ? t("qrCart.pay.paidHintShare") : t("qrCart.pay.paidHint")
        }
        action={
          <div className="grid gap-2">
            <Button asChild>
              <Link to="/t/$token/orders" params={{ token: qrToken }}>
                {t("qrCart.pay.toOrders")}
              </Link>
            </Button>
            {share && (
              <Button asChild variant="outline">
                <Link to={back} params={{ token: qrToken }}>
                  {t("qrCart.pay.toBill")}
                </Link>
              </Button>
            )}
          </div>
        }
      />
    );

  if (payment.status === "expired" || payment.status === "failed")
    return (
      <EmptyState
        icon={TriangleAlert}
        title={
          payment.status === "expired"
            ? t("qrCart.pay.expiredTitle")
            : t("qrCart.pay.failedTitle")
        }
        description={
          payment.status === "expired"
            ? t("qrCart.pay.expiredHint")
            : t("qrCart.pay.failedHint")
        }
        action={
          <Button
            type="button"
            onClick={() =>
              void navigate({
                to: share ? "/t/$token/bill" : "/t/$token/checkout",
                params: { token: qrToken },
              })
            }
          >
            {t("qrCart.pay.retry")}
          </Button>
        }
      />
    );

  // C2b: e-wallet and card are paid on Duitku's page.
  if (payment.method === "ewallet" || payment.method === "card")
    return <GatewayOpening payment={payment} />;

  return <PayWaiting payment={payment} />;
}
