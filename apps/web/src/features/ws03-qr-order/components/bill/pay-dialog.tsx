// Starts a guest payment (ORD-02: the intent turns paid only from the verified
// gateway callback) and hands off to the payment screen, which polls it. The
// method list comes from the payment options (never hard-coded): a method the
// API adds later shows up with a fallback label and icon. A response that
// carries an https redirectUrl (e-wallet, card) sends the guest there.
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RadioGroup } from "radix-ui";
import {
  Banknote,
  CircleAlert,
  CreditCard,
  Landmark,
  QrCode,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type {
  GuestPaymentOption,
  GuestPaymentTarget,
} from "@starter/shared/qr-order";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useGuestPaymentOptions, useStartPayment } from "../../hooks";
import { idempotencyKey } from "../../lib/ids";

// Keyed by plain string on purpose: an unknown method falls back below.
const METHOD_ICON: Record<string, LucideIcon> = {
  qris: QrCode,
  va: Landmark,
  ewallet: Wallet,
  card: CreditCard,
};
const METHOD_LABEL: Record<string, MessageKey> = {
  qris: "qrOrders.bill.methodQris",
  va: "payment.methodVa",
  ewallet: "qrOrders.bill.methodEwallet",
  card: "payment.methodCard",
};
const METHOD_HINT: Record<string, MessageKey> = {
  qris: "qrOrders.bill.methodQrisHint",
  va: "payment.methodVaHint",
  ewallet: "qrOrders.bill.methodEwalletHint",
};

// Method and bank rows share one look; a disabled method dims only its icon
// and title (group-disabled), so the reason text stays at full contrast.
const ITEM_CLASS = cn(
  "group flex min-h-14 items-center gap-3 rounded-qr-media border-(length:--border-w) border-input bg-card p-2.5 text-left transition-colors duration-(--duration-fast) hover:bg-qr-selection",
  "data-[state=checked]:border-primary data-[state=checked]:bg-qr-selection data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
  "disabled:hover:bg-card",
);

/** Only a plain https URL is followed; anything else keeps the guest in the app. */
function safeRedirectUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function reasonKey(option: GuestPaymentOption): MessageKey {
  // The reason texts are written for the bank (VA) list; other methods get the
  // generic line until the catalog has their own.
  if (option.method !== "va") return "payment.methodUnavailable";
  switch (option.unavailableReason) {
    case "gateway_down":
      return "qrGlass.pay.va.unavailableGatewayDown";
    case "no_channels":
      return "qrGlass.pay.va.unavailableNoChannels";
    default:
      return "qrGlass.pay.va.unavailableRoutingDisabled";
  }
}

export function PayDialog({
  open,
  onOpenChange,
  qrToken,
  sessionId,
  target,
  amountIdr,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qrToken: string;
  sessionId: string;
  target: GuestPaymentTarget | null;
  amountIdr: number;
}) {
  const t = useT();
  const navigate = useNavigate();
  const start = useStartPayment(sessionId);
  const options = useGuestPaymentOptions(open ? sessionId : null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedBank, setPickedBank] = useState<string | null>(null);
  // The idempotency key stays with one exact request (target, method, bank,
  // amount): a double tap or a retry never creates two intents, and a changed
  // request never reuses the key of a failed one.
  const [attempt, setAttempt] = useState<{
    signature: string;
    key: string;
  } | null>(null);
  // The parent opens this dialog through the `open` prop, which Radix does not
  // report through onOpenChange: reset the form on every false -> true flip.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPicked(null);
      setPickedBank(null);
      setAttempt(null);
    }
  }
  const resetStart = start.reset;
  useEffect(() => {
    if (open) resetStart();
  }, [open, resetStart]);

  const methods = options.data?.data.methods ?? [];
  // The pick stands only while that method is still offered and enabled;
  // otherwise the first enabled one is chosen.
  const current =
    methods.find((item) => item.method === picked && item.enabled) ??
    methods.find((item) => item.enabled);
  // The CTO names the chosen method with its catalog label, like the list row.
  const currentMethodKey = current ? METHOD_LABEL[current.method] : undefined;
  const currentLabel = current
    ? currentMethodKey
      ? t(currentMethodKey)
      : current.method.toUpperCase()
    : "";
  const needsBank = current !== undefined && current.banks.length > 0;
  const bank =
    current?.banks.find((item) => item.code === pickedBank)?.code ??
    (current?.banks.length === 1 ? current.banks[0]!.code : null);
  // Nothing to choose (options failed or the list is empty): the only honest
  // action is to close, so no disabled pay button is shown.
  const nothingToPay =
    options.isError || (options.data !== undefined && methods.length === 0);
  const canSubmit =
    target !== null && current !== undefined && (!needsBank || bank !== null);

  function handleOpenChange(next: boolean) {
    // Escape, the backdrop, and Cancel must not close the dialog while the
    // request is in flight: the guest would never see the redirect.
    if (!next && start.isPending) return;
    onOpenChange(next);
  }

  function submit() {
    if (!target || !current) return;
    const bankCode = needsBank && bank ? bank : null;
    const signature = JSON.stringify([
      target,
      current.method,
      bankCode,
      amountIdr,
    ]);
    const key =
      attempt?.signature === signature ? attempt.key : idempotencyKey("pay");
    setAttempt({ signature, key });
    start.mutate(
      {
        target,
        method: current.method,
        ...(bankCode ? { bankCode } : {}),
        idempotencyKey: key,
      },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          const redirect = safeRedirectUrl(result.data.redirectUrl);
          if (redirect) {
            window.location.assign(redirect);
            return;
          }
          void navigate({
            to: "/t/$token/pay/$paymentId",
            params: { token: qrToken, paymentId: result.data.id },
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent hideClose={start.isPending}>
        <DialogHeader>
          <DialogTitle>{t("qrOrders.bill.payDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("qrOrders.bill.payDialogAmount", {
              amount: formatRupiah(amountIdr),
            })}
          </DialogDescription>
        </DialogHeader>
        {options.isError ? (
          <ErrorState
            title={t("qrGlass.pay.va.optionsErrorTitle")}
            description={t("qrGlass.pay.va.optionsErrorHint")}
            onRetry={() => void options.refetch()}
            error={options.error}
            className="py-4"
          />
        ) : !options.data ? (
          <div aria-busy="true" className="grid gap-2">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-14 w-full rounded-qr-media" />
            <Skeleton className="h-14 w-full rounded-qr-media" />
          </div>
        ) : methods.length === 0 ? (
          <EmptyState
            icon={TriangleAlert}
            title={t("qrOrders.bill.payNoMethods")}
            description=""
            className="py-4"
          />
        ) : (
          <div className="-mx-1 grid max-h-[55dvh] gap-3 overflow-y-auto px-1 py-1">
            <RadioGroup.Root
              disabled={start.isPending}
              value={current?.method ?? ""}
              onValueChange={(next) => {
                setPicked(next);
                setPickedBank(null);
              }}
              aria-label={t("qrOrders.bill.payMethodLabel")}
              className="grid gap-2"
            >
              {methods.map((option) => {
                const Icon = METHOD_ICON[option.method] ?? Banknote;
                const label = METHOD_LABEL[option.method];
                const hint = METHOD_HINT[option.method];
                return (
                  <RadioGroup.Item
                    key={option.method}
                    value={option.method}
                    disabled={!option.enabled}
                    className={ITEM_CLASS}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background group-disabled:opacity-60">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span className="font-semibold group-disabled:opacity-60">
                        {label ? t(label) : option.method.toUpperCase()}
                      </span>
                      {(!option.enabled || hint) && (
                        <span className="text-sm leading-5 text-muted-foreground">
                          {!option.enabled
                            ? t(reasonKey(option))
                            : hint
                              ? t(hint)
                              : null}
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden="true"
                      className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-input group-data-[state=checked]:border-primary"
                    >
                      <RadioGroup.Indicator className="size-3 rounded-full bg-primary" />
                    </span>
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.Root>
            {current && needsBank && (
              <fieldset className="grid min-w-0 gap-2">
                <legend
                  id="pay-bank-legend"
                  className="mb-1 text-sm font-semibold"
                >
                  {t("qrGlass.pay.va.bankLegend")}
                </legend>
                <RadioGroup.Root
                  disabled={start.isPending}
                  value={bank ?? ""}
                  onValueChange={setPickedBank}
                  aria-labelledby="pay-bank-legend"
                  className="grid gap-2"
                >
                  {current.banks.map((item) => (
                    <RadioGroup.Item
                      key={item.code}
                      value={item.code}
                      className={ITEM_CLASS}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background">
                        <Landmark className="size-5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 font-semibold">
                        {item.name}
                      </span>
                      <span
                        aria-hidden="true"
                        className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-input group-data-[state=checked]:border-primary"
                      >
                        <RadioGroup.Indicator className="size-3 rounded-full bg-primary" />
                      </span>
                    </RadioGroup.Item>
                  ))}
                </RadioGroup.Root>
              </fieldset>
            )}
          </div>
        )}
        <div aria-live="polite">
          {start.isError && (
            <p className="flex items-start gap-2 rounded-qr-media border-l-[3px] border-danger bg-danger-subtle p-3 text-sm font-medium text-foreground">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-danger"
                aria-hidden="true"
              />
              {t("qrOrders.bill.payFailed")}
            </p>
          )}
        </div>
        {needsBank && bank === null && (
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.payPickBankFirst")}
          </p>
        )}
        <DialogFooter>
          <Button
            variant={nothingToPay ? "default" : "outline"}
            onClick={() => handleOpenChange(false)}
            disabled={start.isPending}
            type="button"
          >
            {nothingToPay ? t("common.close") : t("common.cancel")}
          </Button>
          {!nothingToPay && (
            <Button
              onClick={submit}
              loading={start.isPending}
              disabled={!canSubmit}
              type="button"
            >
              {amountIdr > 0 && current
                ? t("qrOrders.bill.payWith", {
                    amount: formatRupiah(amountIdr),
                    method: currentLabel,
                  })
                : t("qrOrders.bill.payContinue")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
