import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ForgotPasswordScreen } from "@/features/ws01-login/components/forgot-password";

// "/forgot-password" — asks for the reset mail (legend-1255).
const t = createTranslator();

export const Route = createFileRoute("/_auth/forgot-password")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.resetPassword.forgotHeading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ForgotPasswordScreen,
});
