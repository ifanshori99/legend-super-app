import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PaymentReturnPage } from "@/features/ws05-payment/components/payment-return";

const t = createTranslator();

// "/bayar/kembali": the single page Duitku returns every guest to (C2b,
// legend-osqou.4; DUITKU_RETURN_URL, no token). The query Duitku appends is
// not trusted: the page asks the server for the payment's status (PAY-02).
export const Route = createFileRoute("/_customer/bayar/kembali")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [{ title: t("payment.redirect.back.headTitle") }],
  }),
  component: PaymentReturnPage,
});
