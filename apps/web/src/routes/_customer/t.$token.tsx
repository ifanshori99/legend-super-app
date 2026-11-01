import { createFileRoute } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { EmptyState } from "@/components/ui/feedback-state";
import { QrCode } from "lucide-react";

// "/t/[token]" — table QR session (PRD §5: dynamic SSR, Cache-Control private,
// noindex via the customer area). The token is opaque; the API resolves it to
// a table session and the tenant (TEN-02): never trust it for anything else.
export const Route = createFileRoute("/_customer/t/$token")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: TableSession,
});

function TableSession() {
  const t = useT();
  return (
    <section>
      <h1 className="sr-only">{t("area.customer.qrTitle")}</h1>
      <EmptyState
        icon={QrCode}
        title={t("area.customer.qrTitle")}
        description={t("area.customer.qrHint")}
      />
    </section>
  );
}
