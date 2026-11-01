// Apology voucher shown after the guest chose "Kredit ke voucher" (PRD §3 F10
// "Voucher Permintaan Maaf"). A receipt-like bordered block, not a card.
import { useState } from "react";
import { Check, Copy, Ticket } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";

type VoucherReceiptProps = {
  voucher: { code: string; valueIdr: number; expiresAt: string };
  /** Outlet time zone (menu.outlet.timeZone): the expiry date is shown there. */
  timeZone: string | undefined;
};

function formatExpiry(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "long",
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("id-ID", { dateStyle: "long" }).format(date);
  }
}

export function VoucherReceipt({ voucher, timeZone }: VoucherReceiptProps) {
  const t = useT();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(voucher.code);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section
      aria-labelledby="voucher-receipt-title"
      className="grid gap-4 rounded-xl border-(length:--border-w) border-dashed border-input p-card"
    >
      <h2
        id="voucher-receipt-title"
        className="flex items-center gap-2 text-lg leading-7 font-semibold"
      >
        <Ticket className="size-icon" aria-hidden="true" />
        {t("qrRecovery.voucher.title")}
      </h2>

      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          {t("qrRecovery.voucher.code")}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-2xl font-semibold tracking-wider break-all text-foreground tabular select-all">
            {voucher.code}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyCode()}
          >
            {copy === "copied" ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {t("qrRecovery.voucher.copy")}
          </Button>
        </div>
        <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {copy === "copied" && t("qrRecovery.voucher.copied")}
          {copy === "failed" && t("qrRecovery.voucher.copyFailed")}
        </p>
      </div>

      <dl className="grid gap-2 border-t-(length:--border-w) pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-sm text-muted-foreground">
            {t("qrRecovery.voucher.value")}
          </dt>
          <dd>
            <Money amount={voucher.valueIdr} className="font-semibold" />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-sm text-muted-foreground">
            {t("qrRecovery.voucher.expires")}
          </dt>
          <dd className="tabular font-semibold">
            <time dateTime={voucher.expiresAt}>
              {formatExpiry(voucher.expiresAt, timeZone)}
            </time>
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        {t("qrRecovery.voucher.hint")}
      </p>
    </section>
  );
}
