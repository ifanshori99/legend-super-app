// Apology voucher shown after the guest chose "Kredit ke voucher" (PRD §3 F10
// "Voucher Permintaan Maaf"). A receipt-like paper block with a dashed edge.
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
      className="qr-paper grid gap-4 border-(length:--border-w) border-dashed border-input p-4"
    >
      <h2
        id="voucher-receipt-title"
        className="type-title flex items-center gap-2"
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

      <dl className="grid gap-2 border-t-(length:--border-w) border-border pt-3">
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
