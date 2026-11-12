import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PublicReceiptPage } from "@/features/ws04-receipt-public/components/receipt-page";

const t = createTranslator();

// "/r/:token" — the public e-receipt behind the link or QR on a POS receipt
// (PRD §3 F11, POS-07). No sign-in: the token is the credential, so the page
// is never indexed and reads the document in the browser only (the API answers
// `private, no-store`). The frame is the bare reading column in _public.tsx.
export const Route = createFileRoute("/_public/r/$token")({
  head: () => ({
    meta: [
      { title: t("posReceiptPublic.pageTitle") },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicReceipt,
});

function PublicReceipt() {
  const { token } = Route.useParams();
  return <PublicReceiptPage token={token} />;
}
