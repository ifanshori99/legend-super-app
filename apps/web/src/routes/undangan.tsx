import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { AcceptInvitationScreen } from "@/features/ws01-login/components/accept-invitation";

// "/undangan" — first-admin invitation (legend-fy5y). Outside every area on
// purpose, like /verifikasi: the invited admin has no session yet. The secret
// is in the URL fragment, so the page sends no referrer and is never cached.
const t = createTranslator();

export const Route = createFileRoute("/undangan")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.invitation.heading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: AcceptInvitationScreen,
});
