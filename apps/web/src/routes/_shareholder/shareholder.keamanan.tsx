import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { SecurityPage } from "@/features/ws01-auth/components/security-page";

const t = createTranslator();

// Shareholder's own second factor and sessions (bead legend-9bh; PRD §3 F6,
// AUTH-05: shareholder dashboards are MFA-guarded).
export const Route = createFileRoute("/_shareholder/shareholder/keamanan")({
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
