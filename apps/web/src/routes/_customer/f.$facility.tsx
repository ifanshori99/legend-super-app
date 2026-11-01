import { createFileRoute } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { EmptyState } from "@/components/ui/feedback-state";
import { QrCode } from "lucide-react";

// "/f/[facility]" — facility QR entry, e.g. shower room (PRD §5: dynamic SSR,
// availability never cached, noindex via the customer area).
export const Route = createFileRoute("/_customer/f/$facility")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: FacilityEntry,
});

function FacilityEntry() {
  const t = useT();
  return (
    <section>
      <h1 className="sr-only">{t("area.customer.facilityTitle")}</h1>
      <EmptyState
        icon={QrCode}
        title={t("area.customer.facilityTitle")}
        description={t("area.customer.facilityHint")}
      />
    </section>
  );
}
