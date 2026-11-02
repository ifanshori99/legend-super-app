import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { returnPathSchema } from "@starter/shared/identity";
import { z } from "zod";
import { GoogleLoginScreen } from "@/features/ws01-login/components/google-login";

// "/masuk/google" — Google OAuth entry (PRD v1.7 §5; §3 F3). The provider
// redirects back to the API callback, which sets the session cookie.
const t = createTranslator();

const searchSchema = z.object({
  lanjut: returnPathSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_public/masuk/google")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.google.heading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GoogleRoute,
});

function GoogleRoute() {
  const { lanjut } = Route.useSearch();
  return <GoogleLoginScreen returnTo={lanjut} />;
}
