import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { SecurityPage } from "@/features/ws01-auth/components/security-page";

const t = createTranslator();

// Super Admin's own second factor and sessions (bead legend-9bh; PRD §3 F6,
// AUTH-05: the platform area is MFA-guarded).
export const Route = createFileRoute("/_platform/platform/keamanan")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("staffAuth.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SecurityPage,
});
