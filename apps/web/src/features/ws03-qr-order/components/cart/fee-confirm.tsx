// The step before Duitku's page when the chosen e-wallet or card carries a
// service fee (1272 K3): the order is placed, the fee is read for it, and the
// guest sees the fee and the total before anything opens at the gateway. A
// method without a fee never comes here.
import { Info } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  AmountPaper,
  StateHeader,
  StatusPill,
} from "@/features/ws05-payment/components/redirect-parts";
import { FeeNoRefund } from "@/features/ws05-payment/components/fee-parts";
import { QrFooter, QrTopBar, qrTextLink } from "../glass/qr-primitives";
import { useOrderRow, useRedirectNames } from "./gateway-opening";

export function FeeConfirm({
  method,
  walletName,
  orderId,
  amountIdr,
  feeIdr,
  chargedIdr,
  onPay,
  onOtherMethod,
}: {
  method: "ewallet" | "card";
  walletName: string | null;
  orderId: string;
  /** The bill, without the fee. */
  amountIdr: number;
  feeIdr: number;
  chargedIdr: number;
  onPay: () => void;
  onOtherMethod: () => void;
}) {
  const t = useT();
  const names = useRedirectNames(method, walletName);
  const orderRow = useOrderRow(orderId);
  return (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar
        title={t("payment.redirect.opening.title", { method: names.title })}
      />
      <div className="grid gap-5">
        <StateHeader
          focusTitle
          pill={
            <StatusPill tone="neutral" icon={<Info />}>
              {t("payment.redirect.fee.confirmPill")}
            </StatusPill>
          }
          title={t("payment.redirect.fee.confirmTitle")}
          lead={t("payment.redirect.fee.confirmLead", { method: names.page })}
        />
        <AmountPaper
          label={t("payment.redirect.fee.totalLabel")}
          amountIdr={chargedIdr}
          rows={[
            ...(orderRow ? [orderRow] : []),
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
        <FeeNoRefund feeIdr={feeIdr} />
      </div>
      <QrFooter>
        <Button type="button" onClick={onPay}>
          {t("payment.redirect.fee.confirmPay", {
            total: formatRupiah(chargedIdr),
          })}
        </Button>
        <button
          type="button"
          onClick={onOtherMethod}
          className={`${qrTextLink} min-h-11 justify-self-center`}
        >
          {t("payment.redirect.opening.otherMethod")}
        </button>
      </QrFooter>
    </div>
  );
}
