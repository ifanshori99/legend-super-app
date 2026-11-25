import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { FacilityBookingScreen } from "@/features/facility/components/booking-screen";
import { showerGate } from "@/lib/areas/shower-gate";

// "/f/[facility]" — the facility QR entry, e.g. the shower room (PRD §5:
// dynamic SSR, availability never cached; noindex via the customer area). The
// segment is what the QR at the door encodes; the API resolves it to one
// facility and tenant (TEN-02), so the page never trusts it for anything else.
// The resolve endpoint does not exist yet (follow-up bead), so the fixtures use
// the facility id itself.
const t = createTranslator();

export const Route = createFileRoute("/_customer/f/$facility")({
  beforeLoad: showerGate,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("facility.entry.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FacilityEntryPage,
});

function FacilityEntryPage() {
  const { facility } = Route.useParams();
  return <FacilityBookingScreen facilityId={facility} />;
}
