// Cashier VA or e-wallet code on the customer display (1269 C3a, 1272 K4):
// the VA number, or the Duitku payment page as a QR for the customer's
// phone, with the countdown. A code with a guest service fee ("Biaya
// layanan") lists the bill, the fee and what the customer pays, and says the
// fee is not refunded. An expired code is removed, never left on screen.
import { Clock, Info } from "lucide-react";
import type { CustomerDisplayOnlineCode } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import { useNowMs } from "../use-now.ts";
import { formatCountdown, secondsUntilExpiry } from "../lib.ts";
import { QrisStatusPanel } from "./qris-status-panel.tsx";

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function FeeRows({ code }: { code: CustomerDisplayOnlineCode }) {
  const t = useT();
  if (!code.guestFeeIdr || !code.chargedIdr)
    return (
      <Money amount={code.amountIdr} size="lg" className="font-semibold" />
    );
  return (
    <div className="grid w-full max-w-sm gap-2 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span>{t("posDisplay.onlineCode.bill")}</span>
        <Money amount={code.amountIdr} className="font-semibold" />
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span>{t("posDisplay.onlineCode.fee")}</span>
        <Money amount={code.guestFeeIdr} className="font-semibold" />
      </div>
      <div className="flex items-baseline justify-between gap-3 border-t-(length:--border-w) border-border pt-2">
        <span className="font-semibold">
          {t("posDisplay.onlineCode.total")}
        </span>
        <Money amount={code.chargedIdr} size="lg" className="font-bold" />
      </div>
      <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("posDisplay.onlineCode.noRefund")}
      </p>
    </div>
  );
}

export function OnlineCodePanel({ code }: { code: CustomerDisplayOnlineCode }) {
  const t = useT();
  const now = useNowMs();
  const remaining = secondsUntilExpiry(code.expiresAt, now);
  if (remaining <= 0)
    return <QrisStatusPanel kind="expired" amountIdr={code.amountIdr} />;
  const instructions = code.instructions;
  const wallet = instructions.channelName;
  const page =
    instructions.method === "ewallet" && isHttpsUrl(instructions.paymentUrl)
      ? instructions.paymentUrl
      : null;
  return (
    <Card>
      <div className="grid justify-items-center gap-3 text-center">
        <Badge tone="warning" className="px-3 py-1 text-sm [&_svg]:size-4">
          <Clock aria-hidden="true" />
          {t("posDisplay.state.awaitingPayment")}
        </Badge>
        {instructions.method === "va" ? (
          <>
            <h2 className="type-title">{t("posDisplay.onlineCode.vaTitle")}</h2>
            <p className="max-w-md text-(length:--density-text) leading-7 text-muted-foreground">
              {t("posDisplay.onlineCode.vaHint", { bank: wallet })}
            </p>
            <div className="w-full max-w-sm rounded-container bg-muted p-4">
              <p className="text-sm text-muted-foreground">
                {t("posDisplay.onlineCode.vaNumber")}
              </p>
              <p className="tabular text-2xl font-semibold break-all">
                {instructions.virtualAccountNumber}
              </p>
            </div>
          </>
        ) : (
          <>
            <h2 className="type-title">
              {t("posDisplay.onlineCode.walletTitle", { wallet })}
            </h2>
            <p className="max-w-md text-(length:--density-text) leading-7 text-muted-foreground">
              {t("posDisplay.onlineCode.walletHint", { wallet })}
            </p>
            {page && (
              <QrCode
                value={page}
                label={t("posDisplay.onlineCode.walletAlt", { wallet })}
                size={288}
                svgClassName="size-52 sm:size-56 2xl:size-72"
                className="rounded-container border-(length:--border-w) border-border p-3"
              />
            )}
          </>
        )}
        <FeeRows code={code} />
        <Badge tone="neutral" className="px-3 py-1 text-sm [&_svg]:size-4">
          <Clock aria-hidden="true" />
          {t("posDisplay.qris.countdown", {
            time: formatCountdown(remaining),
          })}
        </Badge>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("posDisplay.qris.wait")}
        </p>
      </div>
    </Card>
  );
}
