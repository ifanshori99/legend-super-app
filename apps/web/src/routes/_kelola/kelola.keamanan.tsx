import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { SecurityPage } from "@/features/ws01-auth/components/security-page";

const t = createTranslator();

// "Keamanan akun" in the management area (bead legend-9bh; PRD §3 F6
// "Sesi & Perangkat", AUTH-05). The layout runs the MFA + permission guard.
export const Route = createFileRoute("/_kelola/kelola/keamanan")({
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
