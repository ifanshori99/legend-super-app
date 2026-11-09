// Payment method picker of "Keranjang & bayar" (founder Q3, legend-2re1):
// QRIS goes through the gateway (e-wallet apps pay by scanning it), "Bayar di
// kasir" holds the order until the cashier takes the money. Virtual Account has no table
// payment in the contract yet: it is a demo flow in mock mode and shown
// disabled with the real API. Radix radio group = real radio inputs.
import { Landmark, QrCode, Store } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag";

export type PayMethod = "qris" | "va" | "cashier";

const METHODS = [
  {
    value: "qris",
    icon: QrCode,
    label: "qrGlass.checkout.method.qris",
    hint: "qrGlass.checkout.method.qrisHint",
  },
  {
    value: "va",
    icon: Landmark,
    label: "qrGlass.checkout.method.va",
    hint: "qrGlass.checkout.method.vaHint",
    demoOnly: true,
  },
  {
    value: "cashier",
    icon: Store,
    label: "qrGlass.checkout.method.cashier",
    hint: "qrGlass.checkout.method.cashierHint",
  },
] as const;

/** The rust button label follows the chosen method. */
export function useCtaLabel() {
  const t = useT();
  return (method: PayMethod, totalIdr: number) =>
    method === "qris"
      ? t("qrGlass.checkout.cta.qris", { total: formatRupiah(totalIdr) })
      : method === "va"
        ? t("qrGlass.checkout.cta.va")
        : t("qrGlass.checkout.cta.cashier");
}

export function PaymentMethods({
  value,
  onChange,
  disabled = false,
}: {
  value: PayMethod;
  onChange: (method: PayMethod) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <section aria-labelledby="method-title" className="grid gap-2">
      <h2 id="method-title" className="type-heading">
        {t("qrGlass.checkout.method.title")}
      </h2>
      <RadioGroup.Root
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as PayMethod)}
        aria-labelledby="method-title"
        className="grid gap-2"
      >
        {METHODS.map((entry) => {
          const { value: method, icon: Icon, label } = entry;
          // No VA number page exists for table payments yet.
          const unavailable = "demoOnly" in entry && !API_MOCK;
          return (
            <RadioGroup.Item
              key={method}
              value={method}
              disabled={unavailable}
              className={cn(
                "group flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left pressable",
                "hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "data-[state=checked]:border-input data-[state=checked]:ring-1 data-[state=checked]:ring-input",
                "disabled:opacity-60 disabled:hover:bg-card",
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="font-bold">{t(label)}</span>
                <span className="text-sm leading-5 text-muted-foreground">
                  {unavailable
                    ? t("qrGlass.checkout.method.unavailableHint")
                    : t(entry.hint)}
                </span>
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
      <p className="text-sm leading-5 text-muted-foreground">
        {t("qrGlass.checkout.method.kitchenNote")}
      </p>
    </section>
  );
}
