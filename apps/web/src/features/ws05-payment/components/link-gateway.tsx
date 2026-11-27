// E-wallet or card on a payment link (C2b, legend-osqou.4): the intent carries
// Duitku's page. Store which payment it is for `/bayar/kembali`, open the page
// once automatically, and keep a manual button (the browser may block it, or
// the guest came back with the back button). Nothing here settles the screen:
// the page keeps polling the server (PAY-02).
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { PaymentInstructions } from "@starter/shared/payment";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  claimAutoOpen,
  isOpenablePaymentUrl,
  openPaymentUrl,
  saveReturnRecord,
} from "../return-record";

type RedirectInstructions = Extract<
  PaymentInstructions,
  { method: "ewallet" | "card" }
>;

export function LinkGatewayOpening({
  token,
  intentId,
  amountIdr,
  instructions,
}: {
  token: string;
  intentId: string;
  amountIdr: number;
  instructions: RedirectInstructions;
}) {
  const t = useT();
  const card = instructions.method === "card";
  const page = card ? t("payment.redirect.cardPage") : instructions.channelName;
  const url = instructions.paymentUrl;
  const openable = isOpenablePaymentUrl(url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!openable) return;
    saveReturnRecord({
      kind: "link",
      paymentId: intentId,
      linkToken: token,
      method: instructions.method,
      channelCode: card ? null : instructions.channelCode,
      channelName: card ? null : instructions.channelName,
      amountIdr,
      placeName: null,
      timeZone: null,
      theme: null,
    });
    if (!claimAutoOpen(intentId)) return;
    const timer = window.setTimeout(() => {
      if (!openPaymentUrl(url)) setFailed(true);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [openable, intentId, token, instructions, card, amountIdr, url]);

  if (!openable || failed)
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-sm leading-5 text-danger">
          {t("payment.redirect.opening.failedTitle", { method: page })}.{" "}
          {t("payment.redirect.opening.failedLeadLink")}
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            // A refused address will not change by itself: ask the server again.
            if (!openable) window.location.reload();
            else if (openPaymentUrl(url)) setFailed(false);
          }}
        >
          <RefreshCw aria-hidden="true" />
          {t("payment.redirect.opening.retry")}
        </Button>
      </div>
    );

  return (
    <div className="grid gap-3">
      <ol className="grid list-decimal gap-1 pl-5 text-sm leading-5 text-muted-foreground">
        <li>
          {card
            ? t("payment.redirect.opening.step1Card")
            : t("payment.redirect.opening.step1Wallet", { wallet: page })}
          {". "}
          {t("payment.redirect.opening.step1Hint", {
            total: formatRupiah(amountIdr),
          })}
        </li>
        <li>
          {t("payment.redirect.opening.step2")}.{" "}
          {t("payment.redirect.opening.step2Hint")}
        </li>
        <li>
          {t("payment.redirect.opening.step3Link")}.{" "}
          {t("payment.redirect.opening.step3Hint")}
        </li>
      </ol>
      <Button
        type="button"
        className="w-full"
        onClick={() => {
          if (!openPaymentUrl(url)) setFailed(true);
        }}
      >
        {t("payment.redirect.opening.open", { method: page })}
        <ExternalLink aria-hidden="true" />
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("payment.redirect.opening.partnerNoPlace")}
      </p>
    </div>
  );
}
