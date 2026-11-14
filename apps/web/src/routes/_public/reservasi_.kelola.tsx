import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { GuestManagePage } from "@/features/ws08-reservation-guest/components/guest-manage-page";

const t = createTranslator();

// "/reservasi/kelola#<token>" — the guest's page to review, reschedule or
// cancel one reservation (bead legend-g12il). Not nested in `reservasi.tsx`
// (the trailing underscore breaks the nesting): this page shares nothing with
// the booking form. The token is the credential and lives in the URL fragment,
// which never reaches a server, so the page is never indexed, sends no
// referrer, and reads the reservation in the browser only.
export const Route = createFileRoute("/_public/reservasi_/kelola")({
  head: () => ({
    meta: [
      { title: t("reservationGuest.pageTitle") },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: GuestManagePage,
});
