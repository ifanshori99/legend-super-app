// Guest service fee ("Biaya layanan", 1272 K4) on the cashier's VA and
// e-wallet screens: under each priced bank or wallet before the cashier
// starts, and with the live code. Not part of the bill: the tender stays the
// bill, the guest pays the gateway bill + fee. Renders nothing at fee 0.
import { Info } from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";

/** True when a fee above zero was priced (absent means "not priced"). */
export function hasGuestFee(
  feeIdr: number | null | undefined,
): feeIdr is number {
  return typeof feeIdr === "number" && feeIdr > 0;
}

/** Fee and guest total of one bank or wallet, before the cashier starts. */
export function FeeQuote({
  feeIdr,
  totalIdr,
}: {
  feeIdr: number | undefined;
  totalIdr: number | undefined;
}) {
  const t = useT();
  if (!hasGuestFee(feeIdr) || typeof totalIdr !== "number") return null;
  return (
    <span className="grid text-sm leading-5 font-normal text-muted-foreground tabular">
      <span>
        {t("posKasirGateway.fee.line", { fee: formatRupiah(feeIdr) })}
      </span>
      <span>
        {t("posKasirGateway.fee.total", { total: formatRupiah(totalIdr) })}
      </span>
    </span>
  );
}

/** Said to the guest whenever the chosen method carries a fee. */
export function FeeNoRefund({
  feeIdr,
  className,
}: {
  feeIdr: number | undefined;
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
      {t("posKasirGateway.fee.noRefund")}
    </p>
  );
}

/** The live code's fee and what the guest pays, with the no-refund note. */
export function CodeFee({
  feeIdr,
  chargedIdr,
}: {
  feeIdr: number | undefined;
  chargedIdr: number | undefined;
}) {
  const t = useT();
  if (!hasGuestFee(feeIdr) || typeof chargedIdr !== "number") return null;
  return (
    <div className="grid w-full max-w-3xl gap-2 rounded-container border-(length:--border-w) border-border p-4">
      <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
        <span>{t("posKasirGateway.fee.label")}</span>
        <Money amount={feeIdr} className="font-semibold" />
      </div>
      <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
        <span className="font-semibold">
          {t("posKasirGateway.fee.totalLabel")}
        </span>
        <Money amount={chargedIdr} className="font-bold" />
      </div>
      <FeeNoRefund feeIdr={feeIdr} />
    </div>
  );
}
