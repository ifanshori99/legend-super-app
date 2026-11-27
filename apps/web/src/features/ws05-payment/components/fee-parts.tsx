// Guest service fee ("Biaya layanan", 1272 K3): the lines under a method or
// bank that carries one, and the note that it is not refunded. Both render
// nothing for a method without a fee (QRIS, card at 0, a bank at 0), and both
// work for a table order and a payment link alike.
import { Info } from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

/** True when the quote names a fee above zero (null means "not priced"). */
export function hasGuestFee(
  feeIdr: number | null | undefined,
): feeIdr is number {
  return typeof feeIdr === "number" && feeIdr > 0;
}

/** Fee and total of one option, before the guest chooses it. */
export function FeeQuote({
  feeIdr,
  chargedIdr,
  className,
}: {
  feeIdr: number | null | undefined;
  chargedIdr: number | null | undefined;
  className?: string;
}) {
  const t = useT();
  if (!hasGuestFee(feeIdr) || typeof chargedIdr !== "number") return null;
  return (
    <span
      className={cn(
        "grid text-sm leading-5 font-normal text-muted-foreground tabular",
        className,
      )}
    >
      <span>
        {t("payment.redirect.fee.line", { fee: formatRupiah(feeIdr) })}
      </span>
      <span>
        {t("payment.redirect.fee.total", { total: formatRupiah(chargedIdr) })}
      </span>
    </span>
  );
}

/** Shown on the pay screen only when the chosen method carries a fee. */
export function FeeNoRefund({
  feeIdr,
  className,
}: {
  feeIdr: number | null | undefined;
  className?: string;
}) {
  const t = useT();
  if (!hasGuestFee(feeIdr)) return null;
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-sm leading-5 text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {t("payment.redirect.fee.noRefund")}
    </p>
  );
}
