// The step before Duitku's page when the chosen e-wallet or card carries a
// service fee (1272 K3): the guest sees the fee and the total before anything
// opens at the gateway. A method without a fee never comes here. Two parts,
// because the table checkout and the return page lay them out differently:
// the body (header and amount) and the footer content (note and buttons).
import { Info } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FeeNoRefund } from "./fee-parts";
import { AmountPaper, StateHeader, StatusPill } from "./redirect-parts";

export function FeeConfirmBody({
  methodName,
  amountIdr,
  feeIdr,
  chargedIdr,
  extraRows = [],
}: {
  /** "DANA" or "pembayaran kartu". */
  methodName: string;
  /** The bill, without the fee. */
  amountIdr: number;
  feeIdr: number;
  chargedIdr: number;
  extraRows?: readonly { label: string; value: string }[];
}) {
  const t = useT();
  return (
    <div className="grid gap-5">
      <StateHeader
        focusTitle
        pill={
          <StatusPill tone="neutral" icon={<Info />}>
            {t("payment.redirect.fee.confirmPill")}
          </StatusPill>
        }
        title={t("payment.redirect.fee.confirmTitle")}
        lead={t("payment.redirect.fee.confirmLead", { method: methodName })}
      />
      <AmountPaper
        label={t("payment.redirect.fee.totalLabel")}
        amountIdr={chargedIdr}
        rows={[
          ...extraRows,
          {
            label: t("payment.redirect.fee.billRow"),
            value: formatRupiah(amountIdr),
          },
          {
            label: t("payment.redirect.fee.label"),
            value: formatRupiah(feeIdr),
          },
        ]}
      />
    </div>
  );
}

/** The no-refund note sits above the pay button, inside the sticky footer, so it is never covered. */
export function FeeConfirmActions({
  feeIdr,
  chargedIdr,
  linkClassName,
  onPay,
  onOtherMethod,
}: {
  feeIdr: number;
  chargedIdr: number;
  linkClassName: string;
  onPay: () => void;
  onOtherMethod: () => void;
}) {
  const t = useT();
  return (
    <>
      <FeeNoRefund feeIdr={feeIdr} />
      <Button type="button" onClick={onPay}>
        {t("payment.redirect.fee.confirmPay", {
          total: formatRupiah(chargedIdr),
        })}
      </Button>
      <button type="button" onClick={onOtherMethod} className={linkClassName}>
        {t("payment.redirect.opening.otherMethod")}
      </button>
    </>
  );
}
