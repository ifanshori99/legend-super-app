// The table checkout's confirm step (1272 K3): the order is placed, the fee is
// read for it, and the guest sees fee and total before Duitku's page opens.
import { useT } from "@/components/i18n";
import {
  FeeConfirmActions,
  FeeConfirmBody,
} from "@/features/ws05-payment/components/fee-confirm";
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
      <FeeConfirmBody
        methodName={names.page}
        amountIdr={amountIdr}
        feeIdr={feeIdr}
        chargedIdr={chargedIdr}
        extraRows={orderRow ? [orderRow] : []}
      />
      <QrFooter>
        <FeeConfirmActions
          feeIdr={feeIdr}
          chargedIdr={chargedIdr}
          linkClassName={`${qrTextLink} min-h-11 justify-self-center`}
          onPay={onPay}
          onOtherMethod={onOtherMethod}
        />
      </QrFooter>
    </div>
  );
}
