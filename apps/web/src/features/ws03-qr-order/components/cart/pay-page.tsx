// Payment step (PRD §3 F13 QRIS dinamis). The page polls the payment until the
// gateway confirms; it never marks anything paid itself (ORD-02). QRIS shows a
// code to scan, e-wallet shows a hand-off link.
import { useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleCheck, Clock, ExternalLink, TriangleAlert } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { useGuestPayment, useRefreshSession } from "../../hooks";

function timeOf(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}.${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function PayPage({ paymentId }: { paymentId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { qrToken, sessionId } = useTableJourney();
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
      <div aria-busy="true" className="grid justify-items-center gap-3">
        <span className="sr-only">{t("qrCart.pay.loadingTitle")}</span>
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="size-64 rounded-xl" />
      </div>
    );

  const share = payment.target.kind === "split";
  const back = share ? "/t/$token/bill" : "/t/$token/orders";

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

  return (
    <div className="grid justify-items-center gap-5 text-center">
      <header className="grid gap-1">
        <h1 className="text-3xl leading-9 font-bold tracking-tight">
          {t("qrCart.pay.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("qrCart.pay.amount")}
        </p>
        <Money amount={payment.amountIdr} size="xl" />
      </header>

      {payment.method === "qris" && payment.qrisPayload ? (
        <section className="grid justify-items-center gap-3">
          <h2 className="text-lg leading-7 font-semibold">
            {t("qrCart.pay.qrisTitle")}
          </h2>
          <QrCode
            value={payment.qrisPayload}
            label={t("qrCart.pay.qrisAlt", {
              amount: formatRupiah(payment.amountIdr),
            })}
            margin={3}
            svgClassName="size-full"
            className="size-64 rounded-xl border p-2"
          />
          <p className="max-w-xs text-sm leading-5 text-muted-foreground">
            {t("qrCart.pay.qrisHint")}
          </p>
        </section>
      ) : (
        <section className="grid justify-items-center gap-3">
          <h2 className="text-lg leading-7 font-semibold">
            {t("qrCart.pay.ewalletTitle")}
          </h2>
          <p className="max-w-xs text-sm leading-5 text-muted-foreground">
            {t("qrCart.pay.ewalletHint")}
          </p>
          {payment.redirectUrl && (
            <Button asChild size="lg">
              <a href={payment.redirectUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                {t("qrCart.pay.ewalletOpen")}
              </a>
            </Button>
          )}
        </section>
      )}

      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 rounded-xl bg-info-subtle p-3 text-left"
      >
        <Clock
          className="mt-0.5 size-5 shrink-0 text-info"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold">{t("qrCart.pay.waiting")}</p>
          <p className="text-sm leading-5">{t("qrCart.pay.waitingHint")}</p>
          <p className="mt-1 text-sm text-muted-foreground tabular">
            {t("qrCart.pay.expires", { time: timeOf(payment.expiresAt) })}
          </p>
        </div>
      </div>
    </div>
  );
}
