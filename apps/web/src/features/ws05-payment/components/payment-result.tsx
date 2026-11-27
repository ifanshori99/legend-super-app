// Outcomes of a payment link: paid, expired, failed, nothing to pay, gateway
// down (PRD §3.13 "Failover" → pay at cashier) and an offline notice that sits
// above the content while a code is still on screen.
import type { ReactNode } from "react";
import {
  CircleCheck,
  Clock,
  ReceiptText,
  Store,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import type {
  CustomerPaymentBill,
  CustomerPaymentIntent,
} from "@starter/shared/payment";
import { paymentErrorKey } from "../errors";
import { paymentMethodLabelKey } from "../labels";
import { formatTimeInZone, isRefunded } from "../status";

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

export function PaymentPaid({
  intent,
  returnPath,
  timeZone,
}: {
  intent: CustomerPaymentIntent;
  returnPath: string | null;
  timeZone: string;
}) {
  const t = useT();
  const labelKey = paymentMethodLabelKey(intent.method);
  const channel =
    // A card names no channel to the guest (the gateway's code stays internal).
    intent.instructions.method === "qris" ||
    intent.instructions.method === "card"
      ? null
      : intent.instructions.channelName;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-container bg-success-subtle text-success">
          <CircleCheck className="size-6" aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="type-title">{t("payment.paidTitle")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {isRefunded(intent)
              ? t("payment.refundedHint")
              : t("payment.paidHint")}
          </p>
        </div>
      </div>

      <dl className="grid gap-1.5 text-sm">
        <DetailRow label={t("payment.amount")}>
          <Money amount={intent.amountIdr} size="sm" />
        </DetailRow>
        <DetailRow label={t("payment.methodLegend")}>
          {t(labelKey)}
          {channel ? ` · ${channel}` : ""}
        </DetailRow>
        {intent.paidAt && (
          <DetailRow label={t("payment.paidAtLabel")}>
            {formatTimeInZone(intent.paidAt, timeZone)}
          </DetailRow>
        )}
      </dl>

      {intent.paidAfterExpiry && (
        <p className="rounded-container bg-warning-subtle p-3 text-sm leading-5 text-warning">
          {t("payment.paidLate")}
        </p>
      )}

      <Button asChild className="w-full">
        <a href={returnPath ?? "/"}>{t("payment.finish")}</a>
      </Button>
    </Card>
  );
}

export function PaymentRetry({
  kind,
  onRetry,
  retrying,
  error,
}: {
  kind: "expired" | "failed";
  onRetry: () => void;
  retrying: boolean;
  error: unknown;
}) {
  const t = useT();
  const failure = error ? (
    <p role="alert" className="text-sm leading-5 text-danger">
      {t(paymentErrorKey(error))}
    </p>
  ) : null;
  if (kind === "expired")
    return (
      <Card>
        <EmptyState
          icon={Clock}
          title={t("payment.expiredTitle")}
          description={t("payment.expiredHint")}
          action={
            <Button onClick={onRetry} loading={retrying}>
              {t("payment.newCode")}
            </Button>
          }
        />
        {failure}
      </Card>
    );
  return (
    <Card>
      <ErrorState
        title={t("payment.failedTitle")}
        description={t("payment.failedHint")}
        action={
          <Button onClick={onRetry} loading={retrying}>
            {t("payment.retry")}
          </Button>
        }
      />
      {failure}
    </Card>
  );
}

export function PaymentCashier({
  bill,
  gatewayDown,
  onNotify,
  notifying,
  notified,
  error,
}: {
  bill: CustomerPaymentBill;
  /** True for PRD "Failover"; false when routing leaves no online method. */
  gatewayDown: boolean;
  onNotify: () => void;
  notifying: boolean;
  notified: boolean;
  error: unknown;
}) {
  const t = useT();
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-container bg-danger-subtle text-danger">
          <TriangleAlert className="size-6" aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="type-title">
            {gatewayDown
              ? t("payment.gatewayDownTitle")
              : t("payment.unavailableTitle")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {gatewayDown
              ? t("payment.gatewayDownHint")
              : t("payment.unavailableHint")}
          </p>
        </div>
      </div>

      <p className="text-sm leading-5">
        <span className="text-muted-foreground">
          {t("payment.reference", { reference: bill.reference })}
        </span>
      </p>

      {notified ? (
        <p
          role="status"
          className="rounded-container bg-success-subtle p-3 text-sm leading-5 text-success"
        >
          {t("payment.payAtCashierDone", { reference: bill.reference })}
        </p>
      ) : (
        <Button onClick={onNotify} loading={notifying} className="w-full">
          <Store aria-hidden="true" />
          {t("payment.payAtCashier")}
        </Button>
      )}

      {error ? (
        <p role="alert" className="text-sm leading-5 text-danger">
          {t(paymentErrorKey(error))}
        </p>
      ) : null}
    </Card>
  );
}

export function PaymentEmpty() {
  const t = useT();
  return (
    <Card>
      <EmptyState
        icon={ReceiptText}
        title={t("payment.emptyTitle")}
        description={t("payment.emptyHint")}
      />
    </Card>
  );
}

/** Compact notice while a code is on screen but the device lost its network. */
export function OfflineNotice({
  onCheck,
  checking,
}: {
  onCheck: () => void;
  checking: boolean;
}) {
  const t = useT();
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3"
    >
      <WifiOff
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm leading-5 font-semibold">
          {t("payment.offlineTitle")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payment.offlineHint")}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCheck}
        loading={checking}
      >
        {t("payment.checkAgain")}
      </Button>
    </div>
  );
}

/** Full offline state when the link itself could not be loaded. */
export function PaymentOffline({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useT();
  return (
    <Card>
      <EmptyState
        icon={WifiOff}
        title={t("payment.offlineTitle")}
        description={t("payment.offlineHint")}
        action={
          <Button onClick={onRetry} loading={retrying}>
            {t("payment.checkAgain")}
          </Button>
        }
      />
    </Card>
  );
}
