// The pending code: QRIS, Virtual Account or bank transfer instructions. The
// code's status is the provider's, polled by the page; this card only shows
// what to do and how long the code lives (PRD §3.13 "QRIS Dinamis", ~10 min).
import { Clock, Lock } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import type { CustomerPaymentIntent } from "@starter/shared/payment";
import { paymentMethodLabelKey } from "../labels";
import { formatCountdown } from "../status";
import { CopyField } from "./copy-field";
import { LinkGatewayOpening } from "./link-gateway";

/** QRIS needs black-on-white to scan in both themes; the shared renderer plate does. */
function QrisCode({
  payload,
  label,
  referenceOnly,
}: {
  payload: string;
  label: string;
  referenceOnly: boolean;
}) {
  const t = useT();
  return (
    <div className="grid justify-items-center gap-3">
      <QrCode
        value={payload}
        label={label}
        size={236}
        className="rounded-container border-(length:--border-w) border-border p-3"
      />
      {!referenceOnly && (
        <p className="max-w-sm text-center text-sm leading-5 text-muted-foreground">
          {t("payment.qrisHint")}
        </p>
      )}
    </div>
  );
}

export function PaymentCode({
  token,
  intent,
  remaining,
  refreshing,
  onChangeMethod,
  referenceOnly = false,
}: {
  /** The payment link token, stored for the Duitku return page (C2b). */
  token: string;
  intent: CustomerPaymentIntent;
  /** Milliseconds left on the code, server-clock corrected. */
  remaining: number;
  refreshing: boolean;
  onChangeMethod: () => void;
  /** Previous code kept for tracing parked funds, without a new payment prompt. */
  referenceOnly?: boolean;
}) {
  const t = useT();
  const time = formatCountdown(remaining);
  const instructions = intent.instructions;
  const methodLabel =
    instructions.method === "ewallet"
      ? instructions.channelName
      : t(paymentMethodLabelKey(intent.method));

  return (
    <Card>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!referenceOnly && (
            <StatusPill status="warning" icon={Clock}>
              {t("payment.statusPending")}
            </StatusPill>
          )}
          {!referenceOnly && remaining > 0 && !refreshing && (
            <p
              className="text-sm leading-5 text-muted-foreground tabular"
              aria-label={t("payment.expiresInLong", { time })}
            >
              {t("payment.expiresIn", { time })}
            </p>
          )}
        </div>
        <h2 className="type-title">
          {t(
            referenceOnly
              ? "payment.previousCodeReference"
              : "payment.pendingTitle",
          )}
        </h2>
      </div>

      {instructions.method === "qris" && (
        <>
          <QrisCode
            payload={instructions.qrPayload}
            label={t("payment.qrisTitle")}
            referenceOnly={referenceOnly}
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {t("payment.amount")}
            </span>
            <Money amount={intent.amountIdr} size="lg" />
          </div>
        </>
      )}

      {(instructions.method === "ewallet" || instructions.method === "card") &&
        !referenceOnly && (
          <LinkGatewayOpening
            token={token}
            intentId={intent.id}
            amountIdr={intent.amountIdr}
            instructions={instructions}
          />
        )}

      {instructions.method === "va" && (
        <div className="grid gap-3">
          <CopyField
            label={t("payment.vaTitleWithBank", {
              bank: instructions.channelName,
            })}
            value={instructions.virtualAccountNumber}
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {t("payment.amount")}
            </span>
            <Money amount={intent.amountIdr} size="lg" />
          </div>
          {!referenceOnly && (
            <>
              <ol className="grid list-decimal gap-1 pl-5 text-sm leading-5 text-muted-foreground">
                <li>{t("payment.vaStep1")}</li>
                <li>{t("payment.vaStep2")}</li>
                <li>{t("payment.vaStep3")}</li>
              </ol>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("payment.vaHint")}
              </p>
            </>
          )}
        </div>
      )}

      {instructions.method === "bank_transfer" && (
        <div className="grid gap-3">
          <p className="text-sm leading-5 text-muted-foreground">
            {instructions.channelName} · {t("payment.transferTitle")}
          </p>
          <CopyField
            label={t("payment.accountNumber")}
            value={instructions.accountNumber}
          />
          <p className="text-sm leading-5">
            <span className="text-muted-foreground">
              {t("payment.accountHolder")}:{" "}
            </span>
            <span className="font-semibold">{instructions.accountHolder}</span>
          </p>
          <CopyField
            label={t("payment.uniqueCode")}
            value={instructions.uniqueCode}
          />
          <div className="rounded-container bg-surface-2 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">
                {t("payment.transferTotal")}
              </span>
              <Money amount={instructions.transferTotalIdr} size="lg" />
            </div>
            {!referenceOnly && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("payment.transferHint")}
              </p>
            )}
          </div>
        </div>
      )}

      {!referenceOnly && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {refreshing ? t("payment.refreshingCode") : t("payment.checkingAuto")}
        </p>
      )}

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("payment.secureNote")}
      </p>

      {!referenceOnly && (
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="w-full">
              {t("payment.changeMethod")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("payment.changeMethodTitle")}</DialogTitle>
              <DialogDescription>
                {t("payment.changeMethodBody", {
                  method: methodLabel,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("payment.changeMethodCancel")}
                </Button>
              </DialogClose>
              <DialogClose asChild>
                <Button type="button" onClick={onChangeMethod}>
                  {t("payment.changeMethodConfirm")}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
