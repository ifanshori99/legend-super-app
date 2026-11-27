// Payment method picker of "Keranjang & bayar" (founder Q3, legend-2re1):
// QRIS goes through the gateway (e-wallet apps pay by scanning it), "Bayar di
// kasir" holds the order until the cashier takes the money. Virtual Account,
// e-wallet and card follow the payment options (legend-3160, C2b
// legend-osqou.4): a method the outlet or gateway has off is not shown at all
// (design/mockups/c2b-tamu-bayar "Metode sebagian"), so a guest never picks
// one that cannot be used. E-wallet opens its app list once chosen. Radix
// radio group = real radio inputs.
import { useEffect, useState } from "react";
import {
  CreditCard,
  ExternalLink,
  Landmark,
  QrCode,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "cn";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import type { GuestPaymentOptions } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { useTableJourney } from "../../context";
import { useGuestPaymentOptions } from "../../hooks";

export type PayMethod = "qris" | "ewallet" | "va" | "card" | "cashier";

/** The guest's choice: a method, plus the e-wallet app for `ewallet`. */
export type PayChoice = { method: PayMethod; wallet: string | null };

type Channel = { code: string; name: string };

const METHODS: readonly {
  value: PayMethod;
  icon: typeof QrCode;
  label: MessageKey;
  hint: MessageKey | null;
}[] = [
  {
    value: "qris",
    icon: QrCode,
    label: "qrGlass.checkout.method.qris",
    hint: "qrGlass.checkout.method.qrisHint",
  },
  {
    value: "ewallet",
    icon: Wallet,
    label: "payment.redirect.method.ewallet",
    // The hint lists the outlet's e-wallets.
    hint: null,
  },
  {
    value: "va",
    icon: Landmark,
    label: "qrGlass.checkout.method.va",
    hint: "qrGlass.checkout.method.vaHint",
  },
  {
    value: "card",
    icon: CreditCard,
    label: "payment.redirect.method.card",
    hint: "payment.redirect.method.cardHint",
  },
  {
    value: "cashier",
    icon: Store,
    label: "qrGlass.checkout.method.cashier",
    hint: "qrGlass.checkout.method.cashierHint",
  },
];

/**
 * Which gated methods the options turn on. Unknown options (loading, error)
 * keep VA selectable, as before (the VA page shows its own state); e-wallet
 * and card only appear once the server says they are on.
 */
export function availableMethods(options: GuestPaymentOptions | undefined): {
  hidden: ReadonlySet<PayMethod>;
  wallets: Channel[];
} {
  const find = (method: string) =>
    options?.methods.find((item) => item.method === method);
  const va = find("va");
  const ewallet = find("ewallet");
  const card = find("card");
  const hidden = new Set<PayMethod>();
  if (options !== undefined && (!va?.enabled || va.banks.length === 0))
    hidden.add("va");
  const wallets = ewallet?.enabled ? ewallet.banks : [];
  if (wallets.length === 0) hidden.add("ewallet");
  if (!card?.enabled) hidden.add("card");
  return { hidden, wallets };
}

/** E-wallet app name for a channel code, from the payment options. */
export function useWalletName(wallet: string | null): string | null {
  const { sessionId } = useTableJourney();
  const options = useGuestPaymentOptions(sessionId);
  if (!wallet) return null;
  return (
    availableMethods(options.data?.data).wallets.find(
      (item) => item.code === wallet,
    )?.name ?? null
  );
}

/** The rust button label follows the chosen method. */
export function useCtaLabel() {
  const t = useT();
  return (choice: PayChoice, totalIdr: number, walletName: string | null) => {
    const total = formatRupiah(totalIdr);
    switch (choice.method) {
      case "qris":
        return t("qrGlass.checkout.cta.qris", { total });
      case "va":
        return t("qrGlass.checkout.cta.va");
      case "ewallet":
        return t("payment.redirect.method.ctaWallet", {
          total,
          wallet: walletName ?? t("payment.redirect.method.ewallet"),
        });
      case "card":
        return t("payment.redirect.method.ctaCard", { total });
      default:
        return t("qrGlass.checkout.cta.cashier");
    }
  };
}

const choiceClass = cn(
  "group flex min-h-12 items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 text-left font-semibold pressable",
  "hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  "data-[state=checked]:border-primary data-[state=checked]:bg-qr-selection",
);

function RadioMark({ small = false }: { small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full border-2 border-input group-data-[state=checked]:border-primary",
        small ? "size-5" : "size-6",
      )}
    >
      <RadioGroup.Indicator
        className={cn("rounded-full bg-primary", small ? "size-2.5" : "size-3")}
      />
    </span>
  );
}

function WalletChoices({
  wallets,
  value,
  onChange,
  disabled,
}: {
  wallets: Channel[];
  value: string | null;
  onChange: (code: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  const name = wallets.find((item) => item.code === value)?.name;
  return (
    <div className="grid gap-3 px-2.5 pb-3">
      <RadioGroup.Root
        value={value ?? ""}
        disabled={disabled}
        onValueChange={onChange}
        aria-label={t("payment.redirect.method.ewalletLegend")}
        className="grid grid-cols-2 gap-2"
      >
        {wallets.map((wallet) => (
          <RadioGroup.Item
            key={wallet.code}
            value={wallet.code}
            className={choiceClass}
          >
            <span className="min-w-0 truncate">{wallet.name}</span>
            <RadioMark small />
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
        <ExternalLink className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {name
          ? t("payment.redirect.method.ewalletNote", { wallet: name })
          : t("payment.redirect.method.pickWallet")}
      </p>
    </div>
  );
}

function CardNote() {
  const t = useT();
  const { menu } = useTableJourney();
  const place = menu?.brand.name;
  return (
    <p className="flex items-start gap-2 px-2.5 pb-3 text-sm leading-5 text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {place
        ? t("payment.redirect.method.cardNote", { place })
        : t("payment.redirect.method.cardNoteNoPlace")}
    </p>
  );
}

export function PaymentMethods({
  value,
  onChange,
  disabled = false,
}: {
  value: PayChoice;
  onChange: (choice: PayChoice) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const { sessionId } = useTableJourney();
  const options = useGuestPaymentOptions(sessionId);
  const { hidden, wallets } = availableMethods(options.data?.data);
  const method = value.method;
  const chosenOff = hidden.has(method);
  // A chosen method turned off: fall back to QRIS and say which one.
  const [reset, setReset] = useState<PayMethod | null>(null);
  if (chosenOff && reset !== method) setReset(method);
  useEffect(() => {
    if (chosenOff) onChange({ method: "qris", wallet: null });
  }, [chosenOff, onChange]);
  // A wallet that left the list is dropped; the guest picks the app
  // explicitly (no preselected one, so no payment opens in the wrong app).
  const walletOk = wallets.some((item) => item.code === value.wallet);
  useEffect(() => {
    if (method === "ewallet" && value.wallet && !walletOk && wallets.length > 0)
      onChange({ method, wallet: null });
  }, [method, value.wallet, walletOk, wallets, onChange]);
  const loading = options.data === undefined && !options.isError;
  // While the options load, e-wallet and card keep their place as skeleton
  // rows, so the list does not jump when they appear.
  const placeholder = (option: PayMethod) =>
    loading && (option === "ewallet" || option === "card");
  const shown = METHODS.filter(
    (entry) => !hidden.has(entry.value) || placeholder(entry.value),
  );
  const resetLabel =
    reset === null
      ? null
      : reset === "va"
        ? t("qrGlass.checkout.method.vaReset")
        : t("payment.redirect.method.reset", {
            method: t(METHODS.find((item) => item.value === reset)!.label),
          });

  return (
    <section
      aria-labelledby="method-title"
      aria-busy={loading}
      className="grid gap-2"
    >
      <h2 id="method-title" tabIndex={-1} className="type-heading outline-none">
        {t("qrGlass.checkout.method.title")}
      </h2>
      <RadioGroup.Root
        value={method}
        disabled={disabled}
        onValueChange={(next) => {
          // A new choice ends the "switched to QRIS" notice.
          setReset(null);
          onChange({ method: next as PayMethod, wallet: null });
        }}
        aria-labelledby="method-title"
        className="grid gap-2"
      >
        {shown.map(({ value: option, icon: Icon, label, hint }) => {
          if (placeholder(option))
            return (
              <Skeleton
                key={option}
                aria-hidden="true"
                className="h-14 w-full rounded-xl"
              />
            );
          const selected = option === method;
          return (
            <div
              key={option}
              className={cn(
                "grid rounded-xl border border-border bg-card",
                selected && "border-input ring-1 ring-input",
              )}
            >
              <RadioGroup.Item
                value={option}
                className={cn(
                  "group flex min-h-14 items-center gap-3 rounded-xl p-2.5 text-left pressable",
                  "hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  "disabled:opacity-60 disabled:hover:bg-card",
                )}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="grid min-w-0 flex-1">
                  <span className="font-bold">{t(label)}</span>
                  <span className="text-sm leading-5 text-muted-foreground">
                    {hint
                      ? t(hint)
                      : wallets.map((item) => item.name).join(", ")}
                  </span>
                </span>
                <RadioMark />
              </RadioGroup.Item>
              {selected && option === "ewallet" && (
                <WalletChoices
                  wallets={wallets}
                  value={walletOk ? value.wallet : null}
                  onChange={(wallet) => {
                    setReset(null);
                    onChange({ method, wallet });
                  }}
                  disabled={disabled}
                />
              )}
              {selected && option === "card" && <CardNote />}
            </div>
          );
        })}
      </RadioGroup.Root>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("qrGlass.checkout.method.kitchenNote")}
      </p>
      <p
        role="status"
        aria-live="polite"
        className="text-sm leading-5 empty:hidden"
      >
        {resetLabel}
      </p>
    </section>
  );
}
