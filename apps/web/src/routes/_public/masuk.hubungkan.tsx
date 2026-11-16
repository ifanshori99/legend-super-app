import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import {
  linkWhatsAppSearch,
  memberReturnPath,
} from "@/features/ws01-login/flow";
import { LinkWhatsAppScreen } from "@/features/ws01-login/components/link-whatsapp";

// "/masuk/hubungkan" — attach a WhatsApp number to the signed-in account (PRD
// v1.7 §3 F3 "Penautan WhatsApp", AUTH-07). A guest who came in with email or
// Google lands here before collecting or redeeming points.
const t = createTranslator();

export const Route = createFileRoute("/_public/masuk/hubungkan")({
  validateSearch: linkWhatsAppSearch,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.link.heading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LinkRoute,
});

function LinkRoute() {
  const search = Route.useSearch();
  return <LinkWhatsAppScreen returnTo={memberReturnPath(search.lanjut)} />;
}
