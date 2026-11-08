// Starts a guest payment (ORD-02: the intent turns paid only from the verified
// gateway callback) and hands off to the payment screen, which polls it.
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RadioGroup } from "radix-ui";
import { CircleAlert, QrCode, Wallet } from "lucide-react";
import { cn } from "cn";
import type {
  GuestPaymentMethod,
  GuestPaymentTarget,
} from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
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
import { useStartPayment } from "../../hooks";
import { idempotencyKey } from "../../lib/ids";

const METHODS = [
  {
    value: "qris",
    icon: QrCode,
    label: "qrOrders.bill.methodQris",
    hint: "qrOrders.bill.methodQrisHint",
  },
  {
    value: "ewallet",
    icon: Wallet,
    label: "qrOrders.bill.methodEwallet",
    hint: "qrOrders.bill.methodEwalletHint",
  },
] as const;

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
  const [method, setMethod] = useState<GuestPaymentMethod>("qris");
  // One key per opened dialog: a double tap or a retry never creates two intents.
  const [key, setKey] = useState(() => idempotencyKey("pay"));

  function handleOpenChange(next: boolean) {
    if (next) {
      setKey(idempotencyKey("pay"));
      start.reset();
    }
    onOpenChange(next);
  }

  function submit() {
    if (!target) return;
    start.mutate(
      { target, method, idempotencyKey: key },
      {
        onSuccess: (result) => {
          onOpenChange(false);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("qrOrders.bill.payDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("qrOrders.bill.payDialogAmount", {
              amount: formatRupiah(amountIdr),
            })}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup.Root
          value={method}
          onValueChange={(next) => setMethod(next as GuestPaymentMethod)}
          aria-label={t("qrOrders.bill.payMethodLabel")}
          className="grid gap-2"
        >
          {METHODS.map(({ value, icon: Icon, label, hint }) => (
            <RadioGroup.Item
              key={value}
              value={value}
              className={cn(
                "group flex min-h-14 items-center gap-3 rounded-qr-media border-(length:--border-w) border-input bg-card p-3 text-left transition-colors duration-(--duration-fast) hover:bg-qr-selection",
                "data-[state=checked]:border-primary data-[state=checked]:bg-qr-selection data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
              )}
            >
              <Icon className="size-6 shrink-0" aria-hidden="true" />
              <span className="grid">
                <span className="font-semibold">{t(label)}</span>
                <span className="text-sm text-muted-foreground">{t(hint)}</span>
              </span>
              <span
                aria-hidden="true"
                className="ml-auto grid size-6 shrink-0 place-items-center rounded-full border-2 border-input group-data-[state=checked]:border-primary"
              >
                <RadioGroup.Indicator className="size-3 rounded-full bg-primary" />
              </span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
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
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            type="button"
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} loading={start.isPending} type="button">
            {t("qrOrders.bill.payContinue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
